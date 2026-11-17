package ledger

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/apperr"
	"factual/apps/api/internal/shared/reqctx"
)

// openingBalanceKey identifies the system category opening balances are
// recorded in. It is an income category, so opening balances of on-budget
// accounts go to the pool like any other money coming in.
const openingBalanceKey = "opening_balance"

// starterCategories are offered when a budget is created: a common set to
// rename and prune rather than an empty page.
var starterCategories = []struct {
	name     string
	kind     db.CategoryKind
	children []string
}{
	{"收入", db.CategoryKindIncome, []string{"薪資", "獎金", "其他收入"}},
	{"飲食", db.CategoryKindExpense, []string{"外食", "食材", "飲料點心"}},
	{"居住", db.CategoryKindExpense, []string{"房租房貸", "水電瓦斯", "網路電話"}},
	{"交通", db.CategoryKindExpense, []string{"大眾運輸", "加油", "停車"}},
	{"生活", db.CategoryKindExpense, []string{"日用品", "醫療", "衣著"}},
	{"娛樂", db.CategoryKindExpense, []string{"訂閱", "旅遊", "休閒"}},
}

func (h *Handlers) ListBudgets(ctx context.Context, _ api.ListBudgetsRequestObject) (api.ListBudgetsResponseObject, error) {
	rows, err := h.s.q.ListBudgetsForUser(ctx, reqctx.Caller(ctx).UserID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListBudgets200JSONResponse, 0, len(rows))
	for _, r := range rows {
		out = append(out, budgetResponse(db.GetBudgetForUserRow(r)))
	}
	return out, nil
}

func (h *Handlers) CreateBudget(ctx context.Context, req api.CreateBudgetRequestObject) (api.CreateBudgetResponseObject, error) {
	b := req.Body
	name := strings.TrimSpace(b.Name)
	if name == "" {
		return nil, apperr.BadRequest("invalid_name", "name is empty")
	}
	userID := reqctx.Caller(ctx).UserID

	var id uuid.UUID
	err := h.s.inTx(ctx, func(q *db.Queries) error {
		var err error
		if id, err = q.CreateBudget(ctx, db.CreateBudgetParams{Name: name, Currency: b.Currency}); err != nil {
			return err
		}
		if err := q.AddBudgetMember(ctx, db.AddBudgetMemberParams{BudgetID: id, UserID: userID, Role: db.BudgetRoleOwner}); err != nil {
			return err
		}
		if err := q.SetDefaultBudgetIfUnset(ctx, db.SetDefaultBudgetIfUnsetParams{
			BudgetID: uuid.NullUUID{UUID: id, Valid: true}, UserID: userID,
		}); err != nil {
			return err
		}
		return seedCategories(ctx, q, id, b.StarterCategories)
	})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	row, err := h.s.q.GetBudgetForUser(ctx, db.GetBudgetForUserParams{BudgetID: id, UserID: userID})
	if err != nil {
		return nil, err
	}
	return api.CreateBudget201JSONResponse(budgetResponse(row)), nil
}

// seedCategories creates the system categories every budget needs and,
// when asked, the starter set.
func seedCategories(ctx context.Context, q *db.Queries, budgetID uuid.UUID, starter bool) error {
	_, err := q.CreateCategory(ctx, db.CreateCategoryParams{
		BudgetID: budgetID, Name: "期初餘額", Kind: db.CategoryKindIncome,
		IsSystem: true, SystemKey: pgtype.Text{String: openingBalanceKey, Valid: true},
	})
	if err != nil || !starter {
		return err
	}
	for _, group := range starterCategories {
		// Expense groups share one budget among their subcategories (ADR-061).
		pooled := group.kind == db.CategoryKindExpense
		parent, err := q.CreateCategory(ctx, db.CreateCategoryParams{
			BudgetID: budgetID, Name: group.name, Kind: group.kind, Pooled: pooled,
		})
		if err != nil {
			return err
		}
		for _, child := range group.children {
			_, err := q.CreateCategory(ctx, db.CreateCategoryParams{
				BudgetID: budgetID, ParentID: uuid.NullUUID{UUID: parent, Valid: true}, Name: child, Kind: group.kind,
				Pooled: pooled,
			})
			if err != nil {
				return err
			}
		}
	}
	return nil
}

func (h *Handlers) GetBudget(ctx context.Context, req api.GetBudgetRequestObject) (api.GetBudgetResponseObject, error) {
	row, err := h.s.q.GetBudgetForUser(ctx, db.GetBudgetForUserParams{BudgetID: req.BudgetId, UserID: reqctx.Caller(ctx).UserID})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	return api.GetBudget200JSONResponse(budgetResponse(row)), nil
}

func (h *Handlers) UpdateBudget(ctx context.Context, req api.UpdateBudgetRequestObject) (api.UpdateBudgetResponseObject, error) {
	name := strings.TrimSpace(req.Body.Name)
	if name == "" {
		return nil, apperr.BadRequest("invalid_name", "name is empty")
	}
	if err := h.s.q.RenameBudget(ctx, db.RenameBudgetParams{ID: req.BudgetId, Name: name}); err != nil {
		return nil, err
	}
	row, err := h.s.q.GetBudgetForUser(ctx, db.GetBudgetForUserParams{BudgetID: req.BudgetId, UserID: reqctx.Caller(ctx).UserID})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	return api.UpdateBudget200JSONResponse(budgetResponse(row)), nil
}

func (h *Handlers) GetBudgetSummary(ctx context.Context, req api.GetBudgetSummaryRequestObject) (api.GetBudgetSummaryResponseObject, error) {
	s, err := h.s.q.GetBudgetSummary(ctx, req.BudgetId)
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	return api.GetBudgetSummary200JSONResponse{
		Pool: s.Pool, OnBudgetBalance: s.OnBudgetBalance, OffBudgetBalance: s.OffBudgetBalance,
	}, nil
}

func budgetResponse(r db.GetBudgetForUserRow) api.Budget {
	return api.Budget{
		Id: r.ID, Name: r.Name, Currency: r.Currency, MinorUnits: MinorUnits(r.Currency),
		Role: api.BudgetRole(r.Role), IsDefault: r.IsDefault, CreatedAt: r.CreatedAt,
	}
}
