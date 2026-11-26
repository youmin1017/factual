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

// Friends (M12, ADR-104, ADR-106): users the caller splits with. A friend
// added by name is a placeholder member (ADR-016), a user without a
// password that only the caller sees; their friend account in the caller's
// default budget holds what they owe (ADR-036).

const maxFriendNameLen = 64

func (h *Handlers) ListFriends(ctx context.Context, _ api.ListFriendsRequestObject) (api.ListFriendsResponseObject, error) {
	rows, err := h.s.q.ListFriends(ctx, db.ListFriendsParams{UserID: reqctx.Caller(ctx).UserID})
	if err != nil {
		return nil, err
	}
	out := make(api.ListFriends200JSONResponse, 0, len(rows))
	for _, r := range rows {
		out = append(out, friendResponse(r))
	}
	return out, nil
}

func (h *Handlers) CreateFriend(ctx context.Context, req api.CreateFriendRequestObject) (api.CreateFriendResponseObject, error) {
	caller := reqctx.Caller(ctx).UserID
	name, err := friendName(req.Body.DisplayName)
	if err != nil {
		return nil, err
	}
	budget, err := h.s.splittingBudget(ctx, caller)
	if err != nil {
		return nil, err
	}
	var id uuid.UUID
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		var err error
		id, err = q.CreatePlaceholder(ctx, db.CreatePlaceholderParams{
			DisplayName: name, CreatedBy: uuid.NullUUID{UUID: caller, Valid: true},
		})
		if err != nil {
			return err
		}
		if err := q.CreateFriendship(ctx, db.CreateFriendshipParams{UserID: caller, FriendID: id}); err != nil {
			return err
		}
		_, err = q.CreateFriendAccount(ctx, db.CreateFriendAccountParams{
			BudgetID: budget.ID, Name: name, FriendUserID: uuid.NullUUID{UUID: id, Valid: true},
		})
		return err
	})
	if isUniqueViolation(err) {
		return nil, nameTaken()
	}
	if err != nil {
		return nil, err
	}
	f, err := h.s.friend(ctx, caller, id)
	if err != nil {
		return nil, err
	}
	return api.CreateFriend201JSONResponse(f), nil
}

func (h *Handlers) UpdateFriend(ctx context.Context, req api.UpdateFriendRequestObject) (api.UpdateFriendResponseObject, error) {
	caller := reqctx.Caller(ctx).UserID
	name, err := friendName(req.Body.DisplayName)
	if err != nil {
		return nil, err
	}
	f, err := h.s.friend(ctx, caller, req.FriendId)
	if err != nil {
		return nil, err
	}
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		n, err := q.RenamePlaceholder(ctx, db.RenamePlaceholderParams{ID: f.Id, CreatedBy: uuid.NullUUID{UUID: caller, Valid: true}, DisplayName: name})
		if err != nil {
			return err
		}
		if n == 0 {
			// Registered users name themselves (ADR-102).
			return apperr.New(http.StatusConflict, "not_placeholder", "only a friend without an account can be renamed")
		}
		if f.BudgetId == nil {
			return nil
		}
		return q.RenameFriendAccount(ctx, db.RenameFriendAccountParams{
			BudgetID: *f.BudgetId, FriendUserID: uuid.NullUUID{UUID: f.Id, Valid: true}, Name: name,
		})
	})
	if isUniqueViolation(err) {
		return nil, nameTaken()
	}
	if err != nil {
		return nil, err
	}
	out, err := h.s.friend(ctx, caller, f.Id)
	if err != nil {
		return nil, err
	}
	return api.UpdateFriend200JSONResponse(out), nil
}

func (h *Handlers) DeleteFriend(ctx context.Context, req api.DeleteFriendRequestObject) (api.DeleteFriendResponseObject, error) {
	caller := reqctx.Caller(ctx).UserID
	f, err := h.s.friend(ctx, caller, req.FriendId)
	if err != nil {
		return nil, err
	}
	if f.ExpenseCount > 0 {
		return nil, apperr.New(http.StatusConflict, "friend_in_use", "shared expenses with this friend remain")
	}
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		if err := q.PurgeDeletedExpensesWith(ctx, db.PurgeDeletedExpensesWithParams{UserID: caller, FriendID: f.Id}); err != nil {
			return err
		}
		if f.BudgetId != nil {
			err := q.DeleteFriendAccount(ctx, db.DeleteFriendAccountParams{BudgetID: *f.BudgetId, FriendUserID: uuid.NullUUID{UUID: f.Id, Valid: true}})
			if err != nil {
				return err
			}
		}
		if err := q.DeleteFriendship(ctx, db.DeleteFriendshipParams{UserID: caller, FriendID: f.Id}); err != nil {
			return err
		}
		return q.DeletePlaceholder(ctx, db.DeletePlaceholderParams{ID: f.Id, CreatedBy: uuid.NullUUID{UUID: caller, Valid: true}})
	})
	if isForeignKeyViolation(err) {
		// Something else still refers to them, such as a group (M13).
		return nil, apperr.New(http.StatusConflict, "friend_in_use", "this friend is still in use")
	}
	if err != nil {
		return nil, err
	}
	return api.DeleteFriend204Response{}, nil
}

// friend is one of the user's friends, or 404.
func (s *Service) friend(ctx context.Context, userID, friendID uuid.UUID) (api.Friend, error) {
	rows, err := s.q.ListFriends(ctx, db.ListFriendsParams{UserID: userID, FriendID: uuid.NullUUID{UUID: friendID, Valid: true}})
	if err != nil {
		return api.Friend{}, err
	}
	if len(rows) == 0 {
		return api.Friend{}, notFound("friend")
	}
	return friendResponse(rows[0]), nil
}

// splittingBudget is the user's default budget, which receives their side
// of shared expenses (ADR-018); they must be able to write in it.
func (s *Service) splittingBudget(ctx context.Context, userID uuid.UUID) (db.GetSplittingBudgetRow, error) {
	b, err := s.q.GetSplittingBudget(ctx, userID)
	if isNoRows(err) {
		return b, apperr.New(http.StatusConflict, "no_default_budget", "splitting needs a budget to record your side in")
	}
	if err != nil {
		return b, err
	}
	if !Role(b.Role).Can(Write) {
		return b, apperr.New(http.StatusForbidden, "forbidden", "you cannot write in your default budget")
	}
	return b, nil
}

func friendName(s string) (string, error) {
	name := strings.TrimSpace(s)
	n := utf8.RuneCountInString(name)
	if n == 0 || n > maxFriendNameLen {
		return "", apperr.BadRequest("invalid_name", "a name is 1 to 64 characters")
	}
	return name, nil
}

func nameTaken() error {
	return apperr.New(http.StatusConflict, "name_taken", "an account of that name already exists")
}

func friendResponse(r db.ListFriendsRow) api.Friend {
	return api.Friend{
		Id: r.ID, DisplayName: r.DisplayName, Placeholder: r.Placeholder, BudgetId: idPtr(r.BudgetID),
		AccountId: idPtr(r.AccountID), Balance: r.Balance, ExpenseCount: r.ExpenseCount,
	}
}
