package ledger

import (
	"cmp"
	"context"
	"net/http"
	"slices"
	"strings"

	"github.com/google/uuid"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/apperr"
)

// maxCategoryDepth is the deepest a category may sit (ADR-027).
const maxCategoryDepth = 3

func (h *Handlers) ListCategories(ctx context.Context, req api.ListCategoriesRequestObject) (api.ListCategoriesResponseObject, error) {
	rows, err := h.s.q.ListCategories(ctx, req.BudgetId)
	if err != nil {
		return nil, err
	}
	out := make(api.ListCategories200JSONResponse, 0, len(rows))
	for _, r := range rows {
		out = append(out, categoryResponse(db.GetCategoryRow(r)))
	}
	return out, nil
}

func (h *Handlers) CreateCategory(ctx context.Context, req api.CreateCategoryRequestObject) (api.CreateCategoryResponseObject, error) {
	b := req.Body
	name, err := categoryName(b.Name)
	if err != nil {
		return nil, err
	}
	kind := db.CategoryKind(b.Kind)
	if b.ParentId != nil {
		// A subcategory takes its parent's kind, and the tree stays shallow.
		parent, depth, err := h.categoryDepth(ctx, req.BudgetId, *b.ParentId)
		if err != nil {
			return nil, err
		}
		if parent.IsSystem {
			return nil, systemCategory()
		}
		if depth >= maxCategoryDepth {
			return nil, apperr.BadRequest("category_too_deep", "categories are at most three levels deep")
		}
		kind = parent.Kind
	}
	// Expense categories share their budget with their subcategories unless
	// told otherwise (ADR-061); income categories have no budget to share.
	pooled := kind == db.CategoryKindExpense
	if b.Pooled != nil {
		pooled = *b.Pooled
	}
	if pooled && kind == db.CategoryKindIncome {
		return nil, apperr.BadRequest("invalid_pooled", "only expense categories can share a budget")
	}
	id, err := h.s.q.CreateCategory(ctx, db.CreateCategoryParams{
		BudgetID: req.BudgetId, ParentID: nullID(b.ParentId), Name: name, Kind: kind, Pooled: pooled,
	})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	row, err := h.s.q.GetCategory(ctx, db.GetCategoryParams{BudgetID: req.BudgetId, ID: id})
	if err != nil {
		return nil, err
	}
	return api.CreateCategory201JSONResponse(categoryResponse(row)), nil
}

// categoryDepth returns the category and its depth (1 for a top-level one).
func (h *Handlers) categoryDepth(ctx context.Context, budgetID, id uuid.UUID) (db.GetCategoryRow, int, error) {
	cat, err := h.s.q.GetCategory(ctx, db.GetCategoryParams{BudgetID: budgetID, ID: id})
	if isNoRows(err) {
		return cat, 0, notFound("category")
	}
	if err != nil {
		return cat, 0, err
	}
	depth := 1
	for parent := cat.ParentID; parent.Valid && depth <= maxCategoryDepth; depth++ {
		p, err := h.s.q.GetCategory(ctx, db.GetCategoryParams{BudgetID: budgetID, ID: parent.UUID})
		if err != nil {
			return cat, 0, err
		}
		parent = p.ParentID
	}
	return cat, depth, nil
}

func (h *Handlers) UpdateCategory(ctx context.Context, req api.UpdateCategoryRequestObject) (api.UpdateCategoryResponseObject, error) {
	b := req.Body
	name, err := categoryName(b.Name)
	if err != nil {
		return nil, err
	}
	cur, err := h.s.q.GetCategory(ctx, db.GetCategoryParams{BudgetID: req.BudgetId, ID: req.CategoryId})
	if isNoRows(err) {
		return nil, notFound("category")
	}
	if err != nil {
		return nil, err
	}
	if cur.IsSystem {
		return nil, systemCategory()
	}
	if b.Pooled && cur.Kind == db.CategoryKindIncome {
		return nil, apperr.BadRequest("invalid_pooled", "only expense categories can share a budget")
	}
	err = h.s.q.UpdateCategory(ctx, db.UpdateCategoryParams{
		BudgetID: req.BudgetId, ID: req.CategoryId, Name: name, Pooled: b.Pooled, Archived: b.Archived,
	})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	row, err := h.s.q.GetCategory(ctx, db.GetCategoryParams{BudgetID: req.BudgetId, ID: req.CategoryId})
	if err != nil {
		return nil, err
	}
	return api.UpdateCategory200JSONResponse(categoryResponse(row)), nil
}

func (h *Handlers) DeleteCategory(ctx context.Context, req api.DeleteCategoryRequestObject) (api.DeleteCategoryResponseObject, error) {
	cur, err := h.s.q.GetCategory(ctx, db.GetCategoryParams{BudgetID: req.BudgetId, ID: req.CategoryId})
	if isNoRows(err) {
		return nil, notFound("category")
	}
	if err != nil {
		return nil, err
	}
	if cur.IsSystem {
		return nil, systemCategory()
	}
	// Allocations and goals would be deleted with the category; refuse
	// instead of losing them.
	inUse, err := h.s.q.CategoryInUse(ctx, db.CategoryInUseParams{BudgetID: req.BudgetId, ID: req.CategoryId})
	if err != nil {
		return nil, err
	}
	if inUse {
		return nil, categoryInUse()
	}
	_, err = h.s.q.DeleteCategory(ctx, db.DeleteCategoryParams{BudgetID: req.BudgetId, ID: req.CategoryId})
	if isForeignKeyViolation(err) {
		return nil, categoryInUse()
	}
	if err != nil {
		return nil, err
	}
	return api.DeleteCategory204Response{}, nil
}

func (h *Handlers) ReorderCategories(ctx context.Context, req api.ReorderCategoriesRequestObject) (api.ReorderCategoriesResponseObject, error) {
	rows, err := h.s.q.ListCategories(ctx, req.BudgetId)
	if err != nil {
		return nil, err
	}
	// The ids are siblings: the parent of the first one decides which.
	parentOf := make(map[uuid.UUID]uuid.NullUUID, len(rows))
	for _, r := range rows {
		parentOf[r.ID] = r.ParentID
	}
	first, ok := parentOf[req.Body.Ids[0]]
	if !ok {
		return nil, apperr.BadRequest("invalid_order", "ids must be distinct items of this list")
	}
	var siblings []uuid.UUID
	for _, r := range rows {
		if r.ParentID == first && !r.IsSystem {
			siblings = append(siblings, r.ID)
		}
	}
	order, err := orderWithRest(req.Body.Ids, siblings)
	if err != nil {
		return nil, err
	}
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		for i, id := range order {
			if err := q.SetCategoryOrder(ctx, db.SetCategoryOrderParams{BudgetID: req.BudgetId, ID: id, SortOrder: int32(i)}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return api.ReorderCategories204Response{}, nil
}

// MoveCategory puts a category, with everything under it, under another
// parent of the same kind, at a position among its new siblings.
func (h *Handlers) MoveCategory(ctx context.Context, req api.MoveCategoryRequestObject) (api.MoveCategoryResponseObject, error) {
	rows, err := h.s.q.ListCategories(ctx, req.BudgetId)
	if err != nil {
		return nil, err
	}
	byID := make(map[uuid.UUID]db.ListCategoriesRow, len(rows))
	children := map[uuid.UUID][]uuid.UUID{}
	for _, r := range rows {
		byID[r.ID] = r
		if r.ParentID.Valid {
			children[r.ParentID.UUID] = append(children[r.ParentID.UUID], r.ID)
		}
	}
	cur, ok := byID[req.CategoryId]
	if !ok {
		return nil, notFound("category")
	}
	if cur.IsSystem {
		return nil, systemCategory()
	}
	// How many levels the category takes with its subcategories.
	var height func(id uuid.UUID) int
	height = func(id uuid.UUID) int {
		levels := 1
		for _, c := range children[id] {
			levels = max(levels, 1+height(c))
		}
		return levels
	}
	parentDepth := 0
	newParent := nullID(req.Body.ParentId)
	if newParent.Valid {
		parent, ok := byID[newParent.UUID]
		if !ok {
			return nil, notFound("category")
		}
		if parent.IsSystem {
			return nil, systemCategory()
		}
		if parent.Kind != cur.Kind {
			return nil, apperr.BadRequest("category_kind_mismatch", "a category can only move under one of the same kind")
		}
		for p := newParent; p.Valid; p = byID[p.UUID].ParentID {
			if p.UUID == cur.ID {
				return nil, apperr.BadRequest("category_cycle", "a category cannot move under itself")
			}
			parentDepth++
		}
	}
	if parentDepth+height(cur.ID) > maxCategoryDepth {
		return nil, apperr.BadRequest("category_too_deep", "categories are at most three levels deep")
	}

	// Positions count the siblings of the same kind: expense and income
	// categories are listed apart.
	var siblings []db.ListCategoriesRow
	for _, r := range rows {
		if r.ParentID == newParent && r.ID != cur.ID && !r.IsSystem && r.Kind == cur.Kind {
			siblings = append(siblings, r)
		}
	}
	slices.SortStableFunc(siblings, func(a, b db.ListCategoriesRow) int { return cmp.Compare(a.SortOrder, b.SortOrder) })
	order := make([]uuid.UUID, 0, len(siblings)+1)
	for _, s := range siblings {
		order = append(order, s.ID)
	}
	at := min(int(max(req.Body.Index, 0)), len(order))
	order = slices.Insert(order, at, cur.ID)

	err = h.s.inTx(ctx, func(q *db.Queries) error {
		if err := q.SetCategoryParent(ctx, db.SetCategoryParentParams{BudgetID: req.BudgetId, ID: cur.ID, ParentID: newParent}); err != nil {
			return err
		}
		for i, id := range order {
			if err := q.SetCategoryOrder(ctx, db.SetCategoryOrderParams{BudgetID: req.BudgetId, ID: id, SortOrder: int32(i)}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	row, err := h.s.q.GetCategory(ctx, db.GetCategoryParams{BudgetID: req.BudgetId, ID: cur.ID})
	if err != nil {
		return nil, err
	}
	return api.MoveCategory200JSONResponse(categoryResponse(row)), nil
}

// categoryName trims a name and refuses `/`, the path separator in the
// editor (`交通/加油`).
func categoryName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || strings.Contains(name, "/") {
		return "", apperr.BadRequest("invalid_category_name", "a category name cannot be empty or contain /")
	}
	return name, nil
}

func systemCategory() error {
	return apperr.BadRequest("system_category", "this category is managed by the app")
}

func categoryInUse() error {
	return apperr.New(http.StatusConflict, "category_in_use", "the category has subcategories or money in it; archive it instead")
}

func categoryResponse(r db.GetCategoryRow) api.Category {
	c := api.Category{
		Id: r.ID, ParentId: idPtr(r.ParentID), Name: r.Name, Kind: api.CategoryKind(r.Kind), Pooled: r.Pooled,
		IsSystem: r.IsSystem, SortOrder: r.SortOrder, Archived: r.Archived,
	}
	if r.BudgetBase.Valid {
		base := r.BudgetBase.Int64
		c.BudgetBase = &base
	}
	return c
}
