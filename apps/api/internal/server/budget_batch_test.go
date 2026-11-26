package server

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"factual/apps/api/internal/api"
)

// Integration tests of the budget page's :w (ADR-109).

func saveBudget(t *testing.T, b *browser, budget api.Budget, in api.BudgetBatch) (int, map[uuid.UUID]api.BatchProblem) {
	t.Helper()
	if in.Categories == nil {
		in.Categories = []api.CategoryInput{}
	}
	if in.DeleteCategories == nil {
		in.DeleteCategories = []uuid.UUID{}
	}
	if in.Allocations == nil {
		in.Allocations = []api.AllocationChange{}
	}
	if in.Bases == nil {
		in.Bases = []api.BaseChange{}
	}
	rec := b.do(http.MethodPost, budgetPath(budget, "/budget/batch"), in)
	var probs map[uuid.UUID]api.BatchProblem
	if rec.Code == http.StatusUnprocessableEntity {
		probs = map[uuid.UUID]api.BatchProblem{}
		var errs api.BatchErrors
		decode(t, rec, &errs)
		for _, p := range errs.Errors {
			probs[p.Id] = p
		}
	}
	return rec.Code, probs
}

func TestSaveBudget(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin) // 飲食, 車貸本金

	cat := func(id uuid.UUID, parent *uuid.UUID, name string, order int32) api.CategoryInput {
		return api.CategoryInput{Id: id, ParentId: parent, Name: name, Kind: api.CategoryKindExpense, Pooled: true, SortOrder: order}
	}
	// A new parent with a child that keeps its own budget, food moved under
	// it, and money given to both in November.
	home, rent := uuid.New(), uuid.New()
	homeIn := cat(home, nil, "居家", 0)
	homeIn.Pooled = false
	foodIn := cat(f.food.Id, &home, "伙食", 1)
	code, probs := saveBudget(t, admin, f.budget, api.BudgetBatch{
		Categories: []api.CategoryInput{cat(rent, &home, "房租", 0), homeIn, foodIn},
		Allocations: []api.AllocationChange{
			{CategoryId: rent, Month: "2026-11", Amount: 15000},
			{CategoryId: f.food.Id, Month: "2026-11", Amount: 6000},
		},
		Bases: []api.BaseChange{{CategoryId: rent, Amount: 15000}},
	})
	if code != http.StatusOK {
		t.Fatalf("save = %d %+v", code, probs)
	}
	byID := map[uuid.UUID]api.Category{}
	for _, c := range listCategories(t, admin, f.budget) {
		byID[c.Id] = c
	}
	if byID[f.food.Id].Name != "伙食" || *byID[f.food.Id].ParentId != home || byID[rent].BudgetBase == nil || *byID[rent].BudgetBase != 15000 {
		t.Fatalf("tree = %+v %+v", byID[f.food.Id], byID[rent])
	}
	_, envelopes := budgetMonth(t, admin, f.budget, "2026-11")
	if envelopes[rent].Allocated != 15000 || envelopes[f.food.Id].Allocated != 6000 {
		t.Fatalf("allocations = %+v", envelopes)
	}

	// Two siblings swap names in one save.
	swapA := cat(rent, &home, "伙食", 0)
	swapB := cat(f.food.Id, &home, "房租", 1)
	if code, probs := saveBudget(t, admin, f.budget, api.BudgetBatch{Categories: []api.CategoryInput{swapA, swapB}}); code != http.StatusOK {
		t.Fatalf("swap = %d %+v", code, probs)
	}

	// The tree is checked as a whole.
	deep1, deep2 := uuid.New(), uuid.New()
	salary := uuid.New()
	salaryIn := api.CategoryInput{Id: salary, Name: "薪資", Kind: api.CategoryKindIncome, Pooled: true}
	under := cat(uuid.New(), &salary, "錯放", 0)
	twin := cat(uuid.New(), nil, "車貸本金", 9)
	slash := cat(uuid.New(), nil, "a/b", 9)
	code, probs = saveBudget(t, admin, f.budget, api.BudgetBatch{Categories: []api.CategoryInput{
		cat(deep1, &rent, "一", 0), cat(deep2, &deep1, "二", 0), salaryIn, under, twin, slash,
	}})
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("bad tree = %d", code)
	}
	for id, want := range map[uuid.UUID]string{
		deep2: "category_too_deep", salary: "invalid_pooled", under.Id: "category_kind_mismatch",
		twin.Id: "duplicate", slash.Id: "invalid_category_name",
	} {
		if probs[id].Code != want {
			t.Errorf("want %s, got %+v", want, probs[id])
		}
	}
	code, probs = saveBudget(t, admin, f.budget, api.BudgetBatch{Categories: []api.CategoryInput{cat(home, &rent, "居家", 0)}})
	if code != http.StatusUnprocessableEntity || probs[home].Code != "category_cycle" {
		t.Fatalf("cycle = %d %+v", code, probs)
	}

	// A category with money stays; allocations go only to envelopes.
	code, probs = saveBudget(t, admin, f.budget, api.BudgetBatch{DeleteCategories: []uuid.UUID{rent}})
	if code != http.StatusUnprocessableEntity || probs[rent].Code != "category_in_use" {
		t.Fatalf("deleting a category with money = %d %+v", code, probs)
	}
	code, probs = saveBudget(t, admin, f.budget, api.BudgetBatch{Allocations: []api.AllocationChange{{CategoryId: home, Month: "2026-11", Amount: 1}}})
	if code != http.StatusUnprocessableEntity || probs[home].Code != "not_an_envelope" {
		t.Fatalf("allocating to a group = %d %+v", code, probs)
	}
	// Taking its money back in the same save lets it go.
	code, probs = saveBudget(t, admin, f.budget, api.BudgetBatch{
		DeleteCategories: []uuid.UUID{rent},
		Allocations:      []api.AllocationChange{{CategoryId: rent, Month: "2026-11", Amount: 0}},
	})
	if code != http.StatusOK {
		t.Fatalf("delete after clearing = %d %+v", code, probs)
	}

	// An editor allocates but does not change categories.
	hs.addUser("ming", "ming-password-1")
	ming := hs.browser().mustLogin("ming", "ming-password-1")
	me, _ := ming.me()
	if _, err := hs.pool.Exec(context.Background(),
		`insert into budget_members (budget_id, user_id, role) values ($1, $2, 'editor')`, f.budget.Id, me.Id); err != nil {
		t.Fatal(err)
	}
	if code, _ := saveBudget(t, ming, f.budget, api.BudgetBatch{
		Allocations: []api.AllocationChange{{CategoryId: f.food.Id, Month: "2026-12", Amount: 100}},
	}); code != http.StatusOK {
		t.Fatalf("editor allocating = %d", code)
	}
	if code, _ := saveBudget(t, ming, f.budget, api.BudgetBatch{
		Categories: []api.CategoryInput{cat(uuid.New(), nil, "新的", 0)},
	}); code != http.StatusForbidden {
		t.Fatalf("editor changing categories = %d", code)
	}
}
