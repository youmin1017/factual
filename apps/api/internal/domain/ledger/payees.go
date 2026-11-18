package ledger

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/apperr"
)

// Payees are created by name when transactions are saved (ADR-065); here
// they are listed, renamed, merged and deleted (ADR-069).

func (h *Handlers) ListPayees(ctx context.Context, req api.ListPayeesRequestObject) (api.ListPayeesResponseObject, error) {
	rows, err := h.s.q.ListPayees(ctx, req.BudgetId)
	if err != nil {
		return nil, err
	}
	out := make(api.ListPayees200JSONResponse, 0, len(rows))
	for _, r := range rows {
		out = append(out, payeeOut(db.GetPayeeRow(r)))
	}
	return out, nil
}

func (h *Handlers) RenamePayee(ctx context.Context, req api.RenamePayeeRequestObject) (api.RenamePayeeResponseObject, error) {
	name := strings.TrimSpace(req.Body.Name)
	if name == "" || utf8.RuneCountInString(name) > maxPayeeLen {
		return nil, apperr.BadRequest("invalid_payee_name", "a payee name is 1 to 64 characters")
	}
	n, err := h.s.q.RenamePayee(ctx, db.RenamePayeeParams{BudgetID: req.BudgetId, ID: req.PayeeId, Name: name})
	if err != nil {
		if e, ok := apperr.As(apperr.FromDB(err)); ok && e.Status == http.StatusConflict {
			return nil, apperr.New(http.StatusConflict, "payee_exists", "another payee has this name; merge them instead")
		}
		return nil, err
	}
	if n == 0 {
		return nil, notFound("payee")
	}
	p, err := h.s.q.GetPayee(ctx, db.GetPayeeParams{BudgetID: req.BudgetId, ID: req.PayeeId})
	if err != nil {
		return nil, err
	}
	return api.RenamePayee200JSONResponse(payeeOut(p)), nil
}

func (h *Handlers) MergePayees(ctx context.Context, req api.MergePayeesRequestObject) (api.MergePayeesResponseObject, error) {
	sources := slices.Clone(req.Body.SourceIds)
	slices.SortFunc(sources, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	sources = slices.Compact(sources)
	if slices.Contains(sources, req.PayeeId) {
		return nil, apperr.BadRequest("invalid_merge", "a payee cannot be merged into itself")
	}
	all := append([]uuid.UUID{req.PayeeId}, sources...)
	err := h.s.inTx(ctx, func(q *db.Queries) error {
		n, err := q.CountPayees(ctx, db.CountPayeesParams{BudgetID: req.BudgetId, Ids: all})
		if err != nil {
			return err
		}
		if int(n) != len(all) {
			return notFound("payee")
		}
		target := uuid.NullUUID{UUID: req.PayeeId, Valid: true}
		if err := q.MovePayeeTransactions(ctx, db.MovePayeeTransactionsParams{BudgetID: req.BudgetId, TargetID: target, SourceIds: sources}); err != nil {
			return err
		}
		if err := q.MovePayeeSchedules(ctx, db.MovePayeeSchedulesParams{BudgetID: req.BudgetId, TargetID: target, SourceIds: sources}); err != nil {
			return err
		}
		return q.DeletePayees(ctx, db.DeletePayeesParams{BudgetID: req.BudgetId, Ids: sources})
	})
	if err != nil {
		return nil, err
	}
	p, err := h.s.q.GetPayee(ctx, db.GetPayeeParams{BudgetID: req.BudgetId, ID: req.PayeeId})
	if err != nil {
		return nil, err
	}
	return api.MergePayees200JSONResponse(payeeOut(p)), nil
}

func (h *Handlers) DeletePayee(ctx context.Context, req api.DeletePayeeRequestObject) (api.DeletePayeeResponseObject, error) {
	if _, err := h.s.q.GetPayee(ctx, db.GetPayeeParams{BudgetID: req.BudgetId, ID: req.PayeeId}); err != nil {
		if isNoRows(err) {
			return nil, notFound("payee")
		}
		return nil, err
	}
	used, err := h.s.q.PayeeInUse(ctx, req.PayeeId)
	if err != nil {
		return nil, err
	}
	if used {
		return nil, apperr.New(http.StatusConflict, "payee_in_use", "transactions or schedules use this payee; merge it instead")
	}
	if err := h.s.q.DeletePayees(ctx, db.DeletePayeesParams{BudgetID: req.BudgetId, Ids: []uuid.UUID{req.PayeeId}}); err != nil {
		return nil, err
	}
	return api.DeletePayee204Response{}, nil
}

func payeeOut(p db.GetPayeeRow) api.Payee {
	return api.Payee{Id: p.ID, Name: p.Name, LastCategoryId: idPtr(p.LastCategoryID), TransactionCount: p.TransactionCount}
}
