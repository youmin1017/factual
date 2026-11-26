package ledger

import (
	"cmp"
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/apperr"
	"factual/apps/api/internal/shared/reqctx"
)

// The budget page saves its buffer in one request (:w, ADR-109): the
// category tree as the page left it, the allocations changed in any month
// and the envelopes' base amounts. The tree is checked as a whole before
// anything is written, so the page can rearrange it freely in between.

// stillInUse names a category a save was asked to delete that still holds
// something (ADR-079): money recorded or budgeted in it, schedules, a goal.
type stillInUse struct{ id uuid.UUID }

func (e stillInUse) Error() string { return "category in use: " + e.id.String() }

func (h *Handlers) SaveBudget(ctx context.Context, req api.SaveBudgetRequestObject) (api.SaveBudgetResponseObject, error) {
	budgetID := req.BudgetId
	b := req.Body
	caller := reqctx.Caller(ctx).UserID
	if len(b.Categories) > 0 || len(b.DeleteCategories) > 0 {
		role, err := h.s.MemberRole(ctx, budgetID, caller)
		if err != nil {
			return nil, err
		}
		if !role.Can(Manage) {
			return nil, apperr.New(http.StatusForbidden, "forbidden", "only the budget's owner changes its categories")
		}
	}
	rows, err := h.s.q.ListCategories(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	saved := make(map[uuid.UUID]db.ListCategoriesRow, len(rows))
	final := make(map[uuid.UUID]db.ListCategoriesRow, len(rows))
	for _, r := range rows {
		saved[r.ID] = r
		final[r.ID] = r
	}
	ids := make([]uuid.UUID, 0, len(b.Categories)+len(b.DeleteCategories))
	for _, c := range b.Categories {
		ids = append(ids, c.Id)
	}
	ids = append(ids, b.DeleteCategories...)
	owners, err := h.s.q.GetCategoryOwners(ctx, ids)
	if err != nil {
		return nil, err
	}
	elsewhere := map[uuid.UUID]bool{}
	for _, o := range owners {
		if o.BudgetID != budgetID {
			elsewhere[o.ID] = true
		}
	}

	var probs problems
	seen := map[uuid.UUID]bool{}
	upserted := map[uuid.UUID]bool{}
	for _, c := range b.Categories {
		if seen[c.Id] {
			probs.add(c.Id, "", "duplicate_id", "the category appears twice in the batch")
			continue
		}
		seen[c.Id] = true
		if elsewhere[c.Id] {
			probs.add(c.Id, "", "not_found", "category not found")
			continue
		}
		cur, exists := saved[c.Id]
		if exists && cur.IsSystem {
			probs.add(c.Id, "", "system_category", "this category is managed by the app")
			continue
		}
		name, err := categoryName(c.Name)
		if err != nil {
			probs.add(c.Id, "name", "invalid_category_name", "a category name cannot be empty or contain /")
			continue
		}
		kind := db.CategoryKind(c.Kind)
		if exists {
			kind = cur.Kind // a category keeps its kind
		}
		final[c.Id] = db.ListCategoriesRow{
			ID: c.Id, ParentID: nullID(c.ParentId), Name: name, Kind: kind, Pooled: c.Pooled,
			SortOrder: c.SortOrder, Archived: c.Archived, BudgetBase: cur.BudgetBase,
		}
		upserted[c.Id] = true
	}
	deleted := map[uuid.UUID]bool{}
	for _, id := range b.DeleteCategories {
		if seen[id] {
			probs.add(id, "", "duplicate_id", "the category is both saved and deleted")
			continue
		}
		seen[id] = true
		cur, ok := saved[id]
		switch {
		case elsewhere[id] || !ok:
			probs.add(id, "", "not_found", "category not found")
		case cur.IsSystem:
			probs.add(id, "", "system_category", "this category is managed by the app")
		default:
			deleted[id] = true
			delete(final, id)
		}
	}
	checkTree(&probs, final, upserted, deleted)
	if len(probs) > 0 {
		return api.SaveBudget422JSONResponse{Errors: probs}, nil
	}

	finalRows := make([]db.ListCategoriesRow, 0, len(final))
	for _, c := range final {
		finalRows = append(finalRows, c)
	}
	envelopes := envelopeSet(finalRows)
	months := make([]time.Time, len(b.Allocations))
	for i, a := range b.Allocations {
		m, err := time.Parse("2006-01", a.Month)
		if err != nil {
			probs.add(a.CategoryId, "allocation", "invalid_month", "month is YYYY-MM")
			continue
		}
		months[i] = m
		// Clearing is always allowed, also in a category the save deletes.
		_, existed := saved[a.CategoryId]
		if !envelopes[a.CategoryId] && (a.Amount != 0 || !existed) {
			probs.add(a.CategoryId, "allocation", "not_an_envelope", "only envelopes take allocations")
		}
	}
	for _, x := range b.Bases {
		if !envelopes[x.CategoryId] {
			probs.add(x.CategoryId, "base", "not_an_envelope", "only envelopes have a base amount")
		}
	}
	if len(probs) > 0 {
		return api.SaveBudget422JSONResponse{Errors: probs}, nil
	}

	by := uuid.NullUUID{UUID: caller, Valid: true}
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		// Saved categories step aside first, so the tree can be rebuilt in
		// any order and names can swap.
		for id := range upserted {
			if _, ok := saved[id]; ok {
				if err := q.RenameCategoryTemporarily(ctx, db.RenameCategoryTemporarilyParams{BudgetID: budgetID, ID: id}); err != nil {
					return err
				}
			}
		}
		// Then parents before children.
		order := make([]uuid.UUID, 0, len(upserted))
		for id := range upserted {
			order = append(order, id)
		}
		slices.SortFunc(order, func(a, b uuid.UUID) int { return cmp.Compare(depthIn(final, a), depthIn(final, b)) })
		for _, id := range order {
			c := final[id]
			if _, ok := saved[id]; ok {
				err := q.SaveCategory(ctx, db.SaveCategoryParams{
					BudgetID: budgetID, ID: id, ParentID: c.ParentID, Name: c.Name, Pooled: c.Pooled,
					SortOrder: c.SortOrder, Archived: c.Archived,
				})
				if err != nil {
					return err
				}
				continue
			}
			err := q.CreateCategoryWithID(ctx, db.CreateCategoryWithIDParams{
				ID: id, BudgetID: budgetID, ParentID: c.ParentID, Name: c.Name, Kind: c.Kind, Pooled: c.Pooled,
				SortOrder: c.SortOrder, Archived: c.Archived,
			})
			if err != nil {
				return err
			}
		}
		for i, a := range b.Allocations {
			var err error
			if a.Amount == 0 {
				err = q.DeleteAllocation(ctx, db.DeleteAllocationParams{BudgetID: budgetID, CategoryID: a.CategoryId, Month: months[i]})
			} else {
				err = q.SetAllocation(ctx, db.SetAllocationParams{
					BudgetID: budgetID, CategoryID: a.CategoryId, Month: months[i], Amount: a.Amount, UpdatedBy: by,
				})
			}
			if err != nil {
				return err
			}
		}
		// Deepest first; a category that still holds something stays.
		gone := make([]uuid.UUID, 0, len(deleted))
		for id := range deleted {
			gone = append(gone, id)
		}
		slices.SortFunc(gone, func(a, b uuid.UUID) int { return cmp.Compare(depthIn(saved, b), depthIn(saved, a)) })
		for _, id := range gone {
			inUse, err := q.CategoryInUse(ctx, db.CategoryInUseParams{BudgetID: budgetID, ID: id})
			if err != nil {
				return err
			}
			if inUse {
				return stillInUse{id}
			}
			if _, err := q.DeleteCategory(ctx, db.DeleteCategoryParams{BudgetID: budgetID, ID: id}); err != nil {
				if isForeignKeyViolation(err) {
					return stillInUse{id}
				}
				return err
			}
		}
		for _, x := range b.Bases {
			base := pgtype.Int8{}
			if x.Amount > 0 {
				base = pgtype.Int8{Int64: x.Amount, Valid: true}
			}
			if _, err := q.SetCategoryBase(ctx, db.SetCategoryBaseParams{BudgetID: budgetID, ID: x.CategoryId, BudgetBase: base}); err != nil {
				return err
			}
		}
		return nil
	})
	var used stillInUse
	if errors.As(err, &used) {
		var p problems
		p.add(used.id, "", "category_in_use", "the category has money, schedules or a goal in it; archive it instead")
		return api.SaveBudget422JSONResponse{Errors: p}, nil
	}
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	return api.SaveBudget200JSONResponse{
		Upserted: int32(len(b.Categories) + len(b.Allocations) + len(b.Bases)),
		Deleted:  int32(len(deleted)),
	}, nil
}

// checkTree checks the tree a save leaves (ADR-027): parents that exist and
// are of the same kind, no cycles, at most three levels, names unique among
// siblings, and only expense categories sharing a budget. Problems are
// reported on the categories the save changed.
func checkTree(p *problems, final map[uuid.UUID]db.ListCategoriesRow, upserted, deleted map[uuid.UUID]bool) {
	for id, c := range final {
		if c.ParentID.Valid && deleted[c.ParentID.UUID] {
			p.add(c.ParentID.UUID, "", "category_in_use", "the category has subcategories; delete or move them first")
			continue
		}
		if !upserted[id] {
			continue
		}
		if c.Pooled && c.Kind == db.CategoryKindIncome {
			p.add(id, "pooled", "invalid_pooled", "only expense categories can share a budget")
			continue
		}
		if c.ParentID.Valid {
			parent, ok := final[c.ParentID.UUID]
			switch {
			case !ok:
				p.add(id, "parent", "not_found", "the parent category does not exist")
				continue
			case parent.IsSystem:
				p.add(id, "parent", "system_category", "this category is managed by the app")
				continue
			case parent.Kind != c.Kind:
				p.add(id, "parent", "category_kind_mismatch", "a category can only be under one of the same kind")
				continue
			}
		}
		depth := depthIn(final, id)
		if depth < 0 {
			p.add(id, "parent", "category_cycle", "a category cannot be under itself")
			continue
		}
		if depth+heightIn(final, id)-1 > maxCategoryDepth {
			p.add(id, "parent", "category_too_deep", "categories are at most three levels deep")
		}
	}
	type key struct {
		parent uuid.NullUUID
		name   string
	}
	names := map[key][]uuid.UUID{}
	for id, c := range final {
		k := key{c.ParentID, c.Name}
		names[k] = append(names[k], id)
	}
	for _, list := range names {
		if len(list) < 2 {
			continue
		}
		for _, id := range list {
			if upserted[id] {
				p.add(id, "name", "duplicate", "another category under the same parent has this name")
			}
		}
	}
}

// depthIn is a category's level in the tree (1 at the top), or -1 when its
// parents run in a circle.
func depthIn(tree map[uuid.UUID]db.ListCategoriesRow, id uuid.UUID) int {
	depth := 1
	for p := tree[id].ParentID; p.Valid; p = tree[p.UUID].ParentID {
		if p.UUID == id || depth > len(tree) {
			return -1
		}
		depth++
	}
	return depth
}

// heightIn is how many levels a category takes with what is under it.
func heightIn(tree map[uuid.UUID]db.ListCategoriesRow, id uuid.UUID) int {
	height := 1
	for cid, c := range tree {
		if c.ParentID.Valid && c.ParentID.UUID == id && cid != id {
			height = max(height, 1+heightIn(tree, cid))
		}
	}
	return height
}
