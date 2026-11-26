package ledger

import (
	"context"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/apperr"
	"factual/apps/api/internal/shared/reqctx"
)

// Groups (M13, ADR-037, ADR-104, ADR-115): the caller and some of their
// friends sharing expenses. The group has one account in the caller's
// default budget, whose balance is their net position in the group; each
// member's balance is worked out from the group's expenses. Members are the
// caller's placeholder friends until registered users can be written to
// (M15); a member added by name becomes one.

const maxGroupNameLen = 64

func (h *Handlers) ListGroups(ctx context.Context, _ api.ListGroupsRequestObject) (api.ListGroupsResponseObject, error) {
	groups, err := h.s.groups(ctx, reqctx.Caller(ctx).UserID, nil)
	if err != nil {
		return nil, err
	}
	return api.ListGroups200JSONResponse(groups), nil
}

func (h *Handlers) CreateGroup(ctx context.Context, req api.CreateGroupRequestObject) (api.CreateGroupResponseObject, error) {
	caller := reqctx.Caller(ctx).UserID
	name, err := groupName(req.Body.Name)
	if err != nil {
		return nil, err
	}
	budget, err := h.s.splittingBudget(ctx, caller)
	if err != nil {
		return nil, err
	}
	wanted, err := h.s.resolveMembers(ctx, caller, req.Body.Members, nil)
	if err != nil {
		return nil, err
	}
	var id uuid.UUID
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		var err error
		if id, err = q.CreateGroup(ctx, db.CreateGroupParams{Name: name, Currency: budget.Currency, CreatedBy: caller}); err != nil {
			return err
		}
		if err := q.AddGroupMember(ctx, db.AddGroupMemberParams{GroupID: id, UserID: caller, Role: db.GroupRoleAdmin}); err != nil {
			return err
		}
		if err := addMembers(ctx, q, caller, id, wanted); err != nil {
			return err
		}
		_, err = q.CreateGroupAccount(ctx, db.CreateGroupAccountParams{
			BudgetID: budget.ID, Name: name, GroupID: uuid.NullUUID{UUID: id, Valid: true},
		})
		return err
	})
	if isUniqueViolation(err) {
		return nil, nameTaken()
	}
	if err != nil {
		return nil, err
	}
	g, err := h.s.group(ctx, caller, id)
	if err != nil {
		return nil, err
	}
	return api.CreateGroup201JSONResponse(g), nil
}

func (h *Handlers) UpdateGroup(ctx context.Context, req api.UpdateGroupRequestObject) (api.UpdateGroupResponseObject, error) {
	caller := reqctx.Caller(ctx).UserID
	g, err := h.s.adminGroup(ctx, caller, req.GroupId)
	if err != nil {
		return nil, err
	}
	name, err := groupName(req.Body.Name)
	if err != nil {
		return nil, err
	}
	members, err := h.s.q.ListGroupMembers(ctx, []uuid.UUID{g.Id})
	if err != nil {
		return nil, err
	}
	current := make(map[uuid.UUID]db.ListGroupMembersRow, len(members))
	for _, m := range members {
		current[m.UserID] = m
	}
	wanted, err := h.s.resolveMembers(ctx, caller, req.Body.Members, current)
	if err != nil {
		return nil, err
	}
	keep := map[uuid.UUID]bool{caller: true}
	for _, w := range wanted {
		if w.id != uuid.Nil {
			keep[w.id] = true
		}
	}
	var leaving []uuid.UUID
	for _, m := range members {
		if keep[m.UserID] {
			continue
		}
		if m.InUse {
			return nil, apperr.New(http.StatusConflict, "member_in_use",
				m.DisplayName+" is in shared expenses of the group; delete those first")
		}
		leaving = append(leaving, m.UserID)
	}
	archive := g.Archived
	if req.Body.Archived != nil {
		archive = *req.Body.Archived
	}
	if archive && !g.Archived {
		for _, m := range members {
			if m.Paid != m.Share {
				return nil, apperr.New(http.StatusConflict, "group_not_settled", "settle every balance before archiving the group")
			}
		}
	}

	err = h.s.inTx(ctx, func(q *db.Queries) error {
		if err := q.RenameGroup(ctx, db.RenameGroupParams{ID: g.Id, Name: name}); err != nil {
			return err
		}
		for _, id := range leaving {
			if err := q.RemoveGroupMember(ctx, db.RemoveGroupMemberParams{GroupID: g.Id, UserID: id}); err != nil {
				return err
			}
		}
		var joining []wantedMember
		for _, w := range wanted {
			if _, ok := current[w.id]; !ok {
				joining = append(joining, w)
			}
		}
		if err := addMembers(ctx, q, caller, g.Id, joining); err != nil {
			return err
		}
		if err := q.SetGroupArchived(ctx, db.SetGroupArchivedParams{ID: g.Id, Archived: archive}); err != nil {
			return err
		}
		if g.BudgetId == nil {
			return nil
		}
		group := uuid.NullUUID{UUID: g.Id, Valid: true}
		if err := q.RenameGroupAccount(ctx, db.RenameGroupAccountParams{BudgetID: *g.BudgetId, GroupID: group, Name: name}); err != nil {
			return err
		}
		return q.SetGroupAccountClosed(ctx, db.SetGroupAccountClosedParams{BudgetID: *g.BudgetId, GroupID: group, Closed: archive})
	})
	if isUniqueViolation(err) {
		return nil, nameTaken()
	}
	if err != nil {
		return nil, err
	}
	out, err := h.s.group(ctx, caller, g.Id)
	if err != nil {
		return nil, err
	}
	return api.UpdateGroup200JSONResponse(out), nil
}

func (h *Handlers) DeleteGroup(ctx context.Context, req api.DeleteGroupRequestObject) (api.DeleteGroupResponseObject, error) {
	caller := reqctx.Caller(ctx).UserID
	g, err := h.s.adminGroup(ctx, caller, req.GroupId)
	if err != nil {
		return nil, err
	}
	inUse := apperr.New(http.StatusConflict, "group_in_use", "the group has shared expenses; archive it instead")
	if g.ExpenseCount > 0 {
		return nil, inUse
	}
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		if err := q.PurgeDeletedGroupExpenses(ctx, uuid.NullUUID{UUID: g.Id, Valid: true}); err != nil {
			return err
		}
		if g.BudgetId != nil {
			err := q.DeleteGroupAccount(ctx, db.DeleteGroupAccountParams{BudgetID: *g.BudgetId, GroupID: uuid.NullUUID{UUID: g.Id, Valid: true}})
			if err != nil {
				return err
			}
		}
		return q.DeleteGroup(ctx, g.Id)
	})
	if isForeignKeyViolation(err) {
		// A group account in another budget (the default budget changed).
		return nil, inUse
	}
	if err != nil {
		return nil, err
	}
	return api.DeleteGroup204Response{}, nil
}

func (h *Handlers) ListGroupExpenses(ctx context.Context, req api.ListGroupExpensesRequestObject) (api.ListGroupExpensesResponseObject, error) {
	caller := reqctx.Caller(ctx).UserID
	g, err := h.s.group(ctx, caller, req.GroupId)
	if err != nil {
		return nil, err
	}
	rows, err := h.s.q.ListGroupExpenses(ctx, uuid.NullUUID{UUID: g.Id, Valid: true})
	if err != nil {
		return nil, err
	}
	same := make([]db.ListFriendExpensesRow, len(rows))
	for i, r := range rows {
		same[i] = db.ListFriendExpensesRow(r)
	}
	out, err := h.s.expensesResponse(ctx, g.BudgetId, same)
	if err != nil {
		return nil, err
	}
	return api.ListGroupExpenses200JSONResponse{Group: g, Expenses: out}, nil
}

func (h *Handlers) SaveGroupExpenses(ctx context.Context, req api.SaveGroupExpensesRequestObject) (api.SaveGroupExpensesResponseObject, error) {
	caller := reqctx.Caller(ctx).UserID
	g, err := h.s.group(ctx, caller, req.GroupId)
	if err != nil {
		return nil, err
	}
	if g.Archived {
		return nil, apperr.New(http.StatusConflict, "group_archived", "unarchive the group to change its expenses")
	}
	budget, err := h.s.splittingBudget(ctx, caller)
	if err != nil {
		return nil, err
	}
	members := make(map[uuid.UUID]bool, len(g.Members))
	for _, m := range g.Members {
		members[m.UserId] = true
	}
	place := expensePlace{
		scope: splitScope{members: members},
		group: uuid.NullUUID{UUID: g.Id, Valid: true},
		heads: func(ids []uuid.UUID) (map[uuid.UUID]expenseHead, error) {
			rows, err := h.s.q.GetGroupExpenseHeads(ctx, ids)
			if err != nil {
				return nil, err
			}
			out := make(map[uuid.UUID]expenseHead, len(rows))
			for _, x := range rows {
				out[x.ID] = expenseHead{createdBy: x.CreatedBy, deleted: x.Deleted, here: x.GroupID.Valid && x.GroupID.UUID == g.Id}
			}
			return out, nil
		},
		account: func(q *db.Queries) (uuid.UUID, error) {
			if g.AccountId != nil && g.BudgetId != nil && *g.BudgetId == budget.ID {
				return *g.AccountId, nil
			}
			return q.CreateGroupAccount(ctx, db.CreateGroupAccountParams{
				BudgetID: budget.ID, Name: g.Name, GroupID: uuid.NullUUID{UUID: g.Id, Valid: true},
			})
		},
	}
	saved, probs, err := h.s.saveExpenses(ctx, caller, budget, place, *req.Body)
	if err != nil {
		return nil, err
	}
	if len(probs) > 0 {
		return api.SaveGroupExpenses422JSONResponse{Errors: probs}, nil
	}
	return api.SaveGroupExpenses200JSONResponse(saved), nil
}

// wantedMember is a member to have: an existing user, or a new placeholder
// by name (id is uuid.Nil).
type wantedMember struct {
	id   uuid.UUID
	name string
}

// resolveMembers checks the members asked for: the caller's friends (or
// members already in the group), each once, and names of new placeholders.
func (s *Service) resolveMembers(ctx context.Context, caller uuid.UUID, in []api.GroupMemberInput, current map[uuid.UUID]db.ListGroupMembersRow) ([]wantedMember, error) {
	friends, err := s.q.ListFriends(ctx, db.ListFriendsParams{UserID: caller})
	if err != nil {
		return nil, err
	}
	friend := make(map[uuid.UUID]db.ListFriendsRow, len(friends))
	for _, f := range friends {
		friend[f.ID] = f
	}
	seen := map[uuid.UUID]bool{caller: true}
	out := make([]wantedMember, 0, len(in))
	for _, m := range in {
		switch {
		case m.UserId != nil:
			id := *m.UserId
			if seen[id] {
				return nil, apperr.BadRequest("duplicate_member", "a member is listed twice, or is you")
			}
			seen[id] = true
			if _, ok := current[id]; ok {
				out = append(out, wantedMember{id: id})
				continue
			}
			f, ok := friend[id]
			if !ok {
				return nil, apperr.BadRequest("not_friend", "a group's members are your friends")
			}
			if !f.Placeholder {
				return nil, apperr.New(http.StatusConflict, "registered_member",
					"friends with an account join groups once splitting with registered users exists")
			}
			out = append(out, wantedMember{id: id})
		case m.DisplayName != nil:
			name, err := friendName(*m.DisplayName)
			if err != nil {
				return nil, err
			}
			out = append(out, wantedMember{name: name})
		default:
			return nil, apperr.BadRequest("invalid_member", "a member is a friend's id or a new name")
		}
	}
	return out, nil
}

// addMembers adds the members, creating placeholder friends for new names
// (their friend account waits for a direct expense, ensureFriendAccount).
func addMembers(ctx context.Context, q *db.Queries, caller, groupID uuid.UUID, wanted []wantedMember) error {
	for _, w := range wanted {
		id := w.id
		if id == uuid.Nil {
			var err error
			id, err = q.CreatePlaceholder(ctx, db.CreatePlaceholderParams{
				DisplayName: w.name, CreatedBy: uuid.NullUUID{UUID: caller, Valid: true},
			})
			if err != nil {
				return err
			}
			if err := q.CreateFriendship(ctx, db.CreateFriendshipParams{UserID: caller, FriendID: id}); err != nil {
				return err
			}
		}
		if err := q.AddGroupMember(ctx, db.AddGroupMemberParams{GroupID: groupID, UserID: id, Role: db.GroupRoleMember}); err != nil {
			return err
		}
	}
	return nil
}

// groups are the user's groups (one, when id is given), with their members.
func (s *Service) groups(ctx context.Context, userID uuid.UUID, id *uuid.UUID) ([]api.Group, error) {
	rows, err := s.q.ListGroups(ctx, db.ListGroupsParams{UserID: userID, GroupID: nullID(id)})
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	members, err := s.q.ListGroupMembers(ctx, ids)
	if err != nil {
		return nil, err
	}
	byGroup := map[uuid.UUID][]api.GroupMember{}
	for _, m := range members {
		byGroup[m.GroupID] = append(byGroup[m.GroupID], api.GroupMember{
			UserId: m.UserID, DisplayName: m.DisplayName, Placeholder: m.Placeholder, Role: api.GroupRole(m.Role),
			Paid: m.Paid, Share: m.Share, Balance: m.Paid - m.Share,
		})
	}
	out := make([]api.Group, 0, len(rows))
	for _, r := range rows {
		ms := byGroup[r.ID]
		if ms == nil {
			ms = []api.GroupMember{}
		}
		out = append(out, api.Group{
			Id: r.ID, Name: r.Name, Currency: r.Currency, Archived: r.Archived, CreatedBy: r.CreatedBy,
			Members: ms, BudgetId: idPtr(r.BudgetID), AccountId: idPtr(r.AccountID), Balance: r.Balance,
			ExpenseCount: r.ExpenseCount,
		})
	}
	return out, nil
}

// group is one of the user's groups, or 404.
func (s *Service) group(ctx context.Context, userID, groupID uuid.UUID) (api.Group, error) {
	gs, err := s.groups(ctx, userID, &groupID)
	if err != nil {
		return api.Group{}, err
	}
	if len(gs) == 0 {
		return api.Group{}, notFound("group")
	}
	return gs[0], nil
}

// adminGroup is one of the user's groups that they administer.
func (s *Service) adminGroup(ctx context.Context, userID, groupID uuid.UUID) (api.Group, error) {
	g, err := s.group(ctx, userID, groupID)
	if err != nil {
		return g, err
	}
	if isAdmin(g, userID) {
		return g, nil
	}
	return g, apperr.New(http.StatusForbidden, "forbidden", "only the group's admin changes it")
}

func groupName(s string) (string, error) {
	name := strings.TrimSpace(s)
	n := utf8.RuneCountInString(name)
	if n == 0 || n > maxGroupNameLen {
		return "", apperr.BadRequest("invalid_name", "a name is 1 to 64 characters")
	}
	return name, nil
}
