package ledger

import (
	"context"

	"github.com/google/uuid"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/reqctx"
)

// The 分帳 page saves its buffer of friends and groups in one request (:w,
// ADR-116), as the accounts page does (ADR-108): new placeholder friends
// and their friend accounts, renames, groups with their members and
// whether they are archived, and deleting either. Each change is checked
// as the single-item endpoints check it (friends.go, groups.go), and
// problems are reported per friend or group.

func (h *Handlers) SaveSplitting(ctx context.Context, req api.SaveSplittingRequestObject) (api.SaveSplittingResponseObject, error) {
	caller := reqctx.Caller(ctx).UserID
	b := req.Body
	budget, err := h.s.splittingBudget(ctx, caller)
	if err != nil {
		return nil, err
	}
	friendRows, err := h.s.q.ListFriends(ctx, db.ListFriendsParams{UserID: caller})
	if err != nil {
		return nil, err
	}
	friends := make(map[uuid.UUID]db.ListFriendsRow, len(friendRows))
	for _, f := range friendRows {
		friends[f.ID] = f
	}
	groupList, err := h.s.groups(ctx, caller, nil)
	if err != nil {
		return nil, err
	}
	groups := make(map[uuid.UUID]api.Group, len(groupList))
	ids := make([]uuid.UUID, 0, len(groupList))
	for _, g := range groupList {
		groups[g.Id] = g
		ids = append(ids, g.Id)
	}
	memberRows, err := h.s.q.ListGroupMembers(ctx, ids)
	if err != nil {
		return nil, err
	}
	members := map[uuid.UUID]map[uuid.UUID]db.ListGroupMembersRow{}
	for _, m := range memberRows {
		if members[m.GroupID] == nil {
			members[m.GroupID] = map[uuid.UUID]db.ListGroupMembersRow{}
		}
		members[m.GroupID][m.UserID] = m
	}
	// New ids must not be taken by someone else's user or group.
	var newIDs []uuid.UUID
	for _, f := range b.Friends {
		if _, ok := friends[f.Id]; !ok {
			newIDs = append(newIDs, f.Id)
		}
	}
	takenUsers, err := h.s.q.GetUsersExist(ctx, newIDs)
	if err != nil {
		return nil, err
	}
	newIDs = newIDs[:0]
	for _, g := range b.Groups {
		if _, ok := groups[g.Id]; !ok {
			newIDs = append(newIDs, g.Id)
		}
	}
	takenGroups, err := h.s.q.GetGroupsExist(ctx, newIDs)
	if err != nil {
		return nil, err
	}
	taken := map[uuid.UUID]bool{}
	for _, id := range append(takenUsers, takenGroups...) {
		taken[id] = true
	}

	var probs problems
	seen := map[uuid.UUID]bool{}
	once := func(id uuid.UUID) bool {
		if seen[id] {
			probs.add(id, "", "duplicate_id", "it appears twice in the batch")
			return false
		}
		seen[id] = true
		return true
	}
	deletedFriend := map[uuid.UUID]bool{}
	for _, id := range b.DeleteFriends {
		deletedFriend[id] = true
	}
	deletedGroup := map[uuid.UUID]bool{}
	for _, id := range b.DeleteGroups {
		deletedGroup[id] = true
	}

	// Friends: new placeholders and renames.
	type friendPlan struct {
		id   uuid.UUID
		name string
		new  bool
	}
	var friendPlans []friendPlan
	newFriend := map[uuid.UUID]bool{}
	for _, f := range b.Friends {
		if !once(f.Id) {
			continue
		}
		name, err := friendName(f.DisplayName)
		if err != nil {
			probs.add(f.Id, "name", "invalid_name", "a name is 1 to 64 characters")
			continue
		}
		cur, ok := friends[f.Id]
		switch {
		case ok && !cur.Placeholder && cur.DisplayName != name:
			probs.add(f.Id, "name", "not_placeholder", "only a friend without an account can be renamed")
			continue
		case !ok && taken[f.Id]:
			probs.add(f.Id, "", "not_found", "friend not found")
			continue
		}
		if !ok {
			newFriend[f.Id] = true
		}
		friendPlans = append(friendPlans, friendPlan{id: f.Id, name: name, new: !ok})
	}

	// Groups: the members each will have, checked against the friends the
	// caller will have after this batch.
	isFriend := func(id uuid.UUID) (placeholder, ok bool) {
		if newFriend[id] {
			return true, true
		}
		f, found := friends[id]
		if !found || deletedFriend[id] {
			return false, false
		}
		return f.Placeholder, true
	}
	type groupPlan struct {
		in      api.GroupUpsert
		name    string
		new     bool
		joining []uuid.UUID
		leaving []uuid.UUID
	}
	var groupPlans []groupPlan
	stillMember := map[uuid.UUID]bool{} // friends in a group after the batch
	for _, g := range b.Groups {
		if !once(g.Id) {
			continue
		}
		name, err := groupName(g.Name)
		if err != nil {
			probs.add(g.Id, "name", "invalid_name", "a name is 1 to 64 characters")
			continue
		}
		cur, exists := groups[g.Id]
		if !exists && taken[g.Id] {
			probs.add(g.Id, "", "not_found", "group not found")
			continue
		}
		if exists && !isAdmin(cur, caller) {
			probs.add(g.Id, "", "forbidden", "only the group's admin changes it")
			continue
		}
		current := members[g.Id]
		plan := groupPlan{in: g, name: name, new: !exists}
		want := map[uuid.UUID]bool{}
		bad := ""
		for _, id := range g.Members {
			if id == caller || want[id] {
				bad = "duplicate_member"
				break
			}
			want[id] = true
			if _, already := current[id]; already {
				continue
			}
			placeholder, ok := isFriend(id)
			switch {
			case !ok:
				bad = "not_friend"
			case !placeholder:
				bad = "registered_member"
			}
			if bad != "" {
				break
			}
			plan.joining = append(plan.joining, id)
		}
		if bad != "" {
			probs.add(g.Id, "members", bad, "the members are your friends without an account, each once")
			continue
		}
		for id, m := range current {
			if id == caller || want[id] {
				continue
			}
			if m.InUse {
				probs.add(g.Id, "members", "member_in_use", m.DisplayName+" is in shared expenses of the group")
				bad = "member_in_use"
				break
			}
			plan.leaving = append(plan.leaving, id)
		}
		if bad != "" {
			continue
		}
		if g.Archived && !cur.Archived {
			for _, m := range current {
				if m.Paid != m.Share {
					probs.add(g.Id, "archived", "group_not_settled", "settle every balance before archiving the group")
					bad = "group_not_settled"
					break
				}
			}
			if bad != "" {
				continue
			}
		}
		for id := range want {
			stillMember[id] = true
		}
		groupPlans = append(groupPlans, plan)
	}
	// Members of groups this batch leaves alone stay members.
	upserted := map[uuid.UUID]bool{}
	for _, g := range b.Groups {
		upserted[g.Id] = true
	}
	for id, ms := range members {
		if upserted[id] || deletedGroup[id] {
			continue
		}
		for uid := range ms {
			stillMember[uid] = true
		}
	}

	for _, id := range b.DeleteGroups {
		if !once(id) {
			continue
		}
		g, ok := groups[id]
		switch {
		case !ok:
			// Already gone: nothing to do.
		case !isAdmin(g, caller):
			probs.add(id, "", "forbidden", "only the group's admin changes it")
		case g.ExpenseCount > 0:
			probs.add(id, "", "group_in_use", "the group has shared expenses; archive it instead")
		}
	}
	for _, id := range b.DeleteFriends {
		if !once(id) {
			continue
		}
		f, ok := friends[id]
		switch {
		case !ok:
		case f.ExpenseCount > 0:
			probs.add(id, "", "friend_in_use", "shared expenses with this friend remain")
		case stillMember[id]:
			probs.add(id, "", "friend_in_group", "this friend is still a member of a group")
		}
	}
	if len(probs) > 0 {
		return api.SaveSplitting422JSONResponse{Errors: probs}, nil
	}

	var saved api.SplittingBatchSaved
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		creator := uuid.NullUUID{UUID: caller, Valid: true}
		for _, f := range friendPlans {
			if f.new {
				if err := q.CreatePlaceholderWithID(ctx, db.CreatePlaceholderWithIDParams{ID: f.id, DisplayName: f.name, CreatedBy: creator}); err != nil {
					return err
				}
				if err := q.CreateFriendship(ctx, db.CreateFriendshipParams{UserID: caller, FriendID: f.id}); err != nil {
					return err
				}
				if _, err := q.CreateFriendAccount(ctx, db.CreateFriendAccountParams{
					BudgetID: budget.ID, Name: f.name, FriendUserID: uuid.NullUUID{UUID: f.id, Valid: true},
				}); err != nil {
					return err
				}
			} else if cur := friends[f.id]; cur.DisplayName != f.name {
				if _, err := q.RenamePlaceholder(ctx, db.RenamePlaceholderParams{ID: f.id, CreatedBy: creator, DisplayName: f.name}); err != nil {
					return err
				}
				if cur.BudgetID.Valid {
					if err := q.RenameFriendAccount(ctx, db.RenameFriendAccountParams{
						BudgetID: cur.BudgetID.UUID, FriendUserID: uuid.NullUUID{UUID: f.id, Valid: true}, Name: f.name,
					}); err != nil {
						return err
					}
				}
			}
			saved.Upserted++
		}
		for _, g := range groupPlans {
			group := uuid.NullUUID{UUID: g.in.Id, Valid: true}
			if g.new {
				if err := q.CreateGroupWithID(ctx, db.CreateGroupWithIDParams{ID: g.in.Id, Name: g.name, Currency: budget.Currency, CreatedBy: caller}); err != nil {
					return err
				}
				if err := q.AddGroupMember(ctx, db.AddGroupMemberParams{GroupID: g.in.Id, UserID: caller, Role: db.GroupRoleAdmin}); err != nil {
					return err
				}
				if _, err := q.CreateGroupAccount(ctx, db.CreateGroupAccountParams{BudgetID: budget.ID, Name: g.name, GroupID: group}); err != nil {
					return err
				}
			} else {
				if err := q.RenameGroup(ctx, db.RenameGroupParams{ID: g.in.Id, Name: g.name}); err != nil {
					return err
				}
			}
			for _, id := range g.leaving {
				if err := q.RemoveGroupMember(ctx, db.RemoveGroupMemberParams{GroupID: g.in.Id, UserID: id}); err != nil {
					return err
				}
			}
			for _, id := range g.joining {
				if err := q.AddGroupMember(ctx, db.AddGroupMemberParams{GroupID: g.in.Id, UserID: id, Role: db.GroupRoleMember}); err != nil {
					return err
				}
			}
			if err := q.SetGroupArchived(ctx, db.SetGroupArchivedParams{ID: g.in.Id, Archived: g.in.Archived}); err != nil {
				return err
			}
			if err := q.RenameGroupAccount(ctx, db.RenameGroupAccountParams{BudgetID: budget.ID, GroupID: group, Name: g.name}); err != nil {
				return err
			}
			if err := q.SetGroupAccountClosed(ctx, db.SetGroupAccountClosedParams{BudgetID: budget.ID, GroupID: group, Closed: g.in.Archived}); err != nil {
				return err
			}
			saved.Upserted++
		}
		for _, id := range b.DeleteGroups {
			if _, ok := groups[id]; !ok {
				continue
			}
			group := uuid.NullUUID{UUID: id, Valid: true}
			if err := q.PurgeDeletedGroupExpenses(ctx, group); err != nil {
				return err
			}
			if err := q.DeleteGroupAccount(ctx, db.DeleteGroupAccountParams{BudgetID: budget.ID, GroupID: group}); err != nil {
				return err
			}
			if err := q.DeleteGroup(ctx, id); err != nil {
				return err
			}
			saved.Deleted++
		}
		for _, id := range b.DeleteFriends {
			f, ok := friends[id]
			if !ok {
				continue
			}
			if err := q.PurgeDeletedExpensesWith(ctx, db.PurgeDeletedExpensesWithParams{UserID: caller, FriendID: id}); err != nil {
				return err
			}
			if f.BudgetID.Valid {
				if err := q.DeleteFriendAccount(ctx, db.DeleteFriendAccountParams{BudgetID: f.BudgetID.UUID, FriendUserID: uuid.NullUUID{UUID: id, Valid: true}}); err != nil {
					return err
				}
			}
			if err := q.DeleteFriendship(ctx, db.DeleteFriendshipParams{UserID: caller, FriendID: id}); err != nil {
				return err
			}
			if err := q.DeletePlaceholder(ctx, db.DeletePlaceholderParams{ID: id, CreatedBy: uuid.NullUUID{UUID: caller, Valid: true}}); err != nil {
				return err
			}
			saved.Deleted++
		}
		return nil
	})
	if isUniqueViolation(err) {
		return nil, nameTaken()
	}
	if err != nil {
		return nil, err
	}
	return api.SaveSplitting200JSONResponse(saved), nil
}

func isAdmin(g api.Group, userID uuid.UUID) bool {
	for _, m := range g.Members {
		if m.UserId == userID && m.Role == api.Admin {
			return true
		}
	}
	return false
}
