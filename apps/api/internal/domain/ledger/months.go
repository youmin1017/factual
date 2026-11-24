package ledger

import (
	"context"
	"time"

	"github.com/google/uuid"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/apperr"
	"factual/apps/api/internal/shared/reqctx"
)

// The budget page (M6): envelopes per month and the allocations that fill
// them from the pool (ADR-025, ADR-026, ADR-061).

// parseMonth turns YYYY-MM (checked by the spec) into its first day.
func parseMonth(m api.Month) (time.Time, error) {
	t, err := time.Parse("2006-01", m)
	if err != nil {
		return time.Time{}, apperr.BadRequest("invalid_month", "month is YYYY-MM")
	}
	return t, nil
}

func (h *Handlers) GetBudgetMonth(ctx context.Context, req api.GetBudgetMonthRequestObject) (api.GetBudgetMonthResponseObject, error) {
	month, err := parseMonth(req.Month)
	if err != nil {
		return nil, err
	}
	pool, err := h.s.q.GetPool(ctx, req.BudgetId)
	if isNoRows(err) {
		return nil, notFound("budget")
	}
	if err != nil {
		return nil, err
	}
	income, err := h.s.q.GetMonthIncome(ctx, db.GetMonthIncomeParams{BudgetID: req.BudgetId, Month: month})
	if err != nil {
		return nil, err
	}
	rows, err := h.s.q.ListEnvelopeMonth(ctx, db.ListEnvelopeMonthParams{BudgetID: req.BudgetId, Month: month})
	if err != nil {
		return nil, err
	}
	envelopes := make([]api.EnvelopeMonth, 0, len(rows))
	for _, r := range rows {
		envelopes = append(envelopes, api.EnvelopeMonth{
			CategoryId: r.CategoryID, Allocated: r.Allocated, Activity: r.Activity, Carried: r.Carried,
		})
	}
	incomeRows, err := h.s.q.ListIncomeMonth(ctx, db.ListIncomeMonthParams{BudgetID: req.BudgetId, Month: month})
	if err != nil {
		return nil, err
	}
	incomes := make([]api.IncomeMonth, 0, len(incomeRows))
	for _, r := range incomeRows {
		incomes = append(incomes, api.IncomeMonth{CategoryId: r.CategoryID.UUID, Received: r.Received})
	}
	targets, err := h.s.monthTargets(ctx, req.BudgetId, month)
	if err != nil {
		return nil, err
	}
	spoken, err := h.s.spokenFor(ctx, req.BudgetId, month)
	if err != nil {
		return nil, err
	}
	return api.GetBudgetMonth200JSONResponse{
		Month: month.Format("2006-01"), Pool: pool, Income: income, Envelopes: envelopes, Incomes: incomes,
		Targets: targets, SpokenFor: spoken,
	}, nil
}

func (h *Handlers) SetAllocations(ctx context.Context, req api.SetAllocationsRequestObject) (api.SetAllocationsResponseObject, error) {
	month, err := parseMonth(req.Month)
	if err != nil {
		return nil, err
	}
	cats, err := h.s.q.ListCategories(ctx, req.BudgetId)
	if err != nil {
		return nil, err
	}
	envelopes := envelopeSet(cats)
	for _, a := range req.Body.Allocations {
		if !envelopes[a.CategoryId] {
			return nil, apperr.BadRequest("not_an_envelope", "only envelopes take allocations: "+a.CategoryId.String())
		}
	}
	by := uuid.NullUUID{UUID: reqctx.Caller(ctx).UserID, Valid: true}
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		for _, a := range req.Body.Allocations {
			var err error
			if a.Amount == 0 {
				err = q.DeleteAllocation(ctx, db.DeleteAllocationParams{BudgetID: req.BudgetId, CategoryID: a.CategoryId, Month: month})
			} else {
				err = q.SetAllocation(ctx, db.SetAllocationParams{
					BudgetID: req.BudgetId, CategoryID: a.CategoryId, Month: month, Amount: a.Amount, UpdatedBy: by,
				})
			}
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	return api.SetAllocations204Response{}, nil
}

// envelopeSet is the categories that hold a budget of their own: expense
// categories that share it with their subcategories (pooled) or have none,
// unless a pooled parent above already holds it (ADR-027, ADR-061).
func envelopeSet(cats []db.ListCategoriesRow) map[uuid.UUID]bool {
	byID := make(map[uuid.UUID]db.ListCategoriesRow, len(cats))
	hasChildren := map[uuid.UUID]bool{}
	for _, c := range cats {
		byID[c.ID] = c
		if c.ParentID.Valid {
			hasChildren[c.ParentID.UUID] = true
		}
	}
	insidePooled := func(c db.ListCategoriesRow) bool {
		for p := c.ParentID; p.Valid; {
			parent, ok := byID[p.UUID]
			if !ok {
				return false
			}
			if parent.Pooled {
				return true
			}
			p = parent.ParentID
		}
		return false
	}
	out := map[uuid.UUID]bool{}
	for _, c := range cats {
		if c.Kind != db.CategoryKindExpense || c.IsSystem || insidePooled(c) {
			continue
		}
		if c.Pooled || !hasChildren[c.ID] {
			out[c.ID] = true
		}
	}
	return out
}
