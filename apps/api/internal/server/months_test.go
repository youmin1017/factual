package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"factual/apps/api/internal/api"
)

// Integration tests of the budget page (M6): allocations and envelopes per
// month (ADR-025, ADR-026, ADR-061).

func budgetMonth(t *testing.T, b *browser, budget api.Budget, month string) (api.BudgetMonth, map[uuid.UUID]api.EnvelopeMonth) {
	t.Helper()
	rec := b.do(http.MethodGet, budgetPath(budget, "/months/"+month), nil)
	wantStatus(t, rec, http.StatusOK)
	var out api.BudgetMonth
	decode(t, rec, &out)
	byID := map[uuid.UUID]api.EnvelopeMonth{}
	for _, e := range out.Envelopes {
		byID[e.CategoryId] = e
	}
	return out, byID
}

func allocate(b *browser, budget api.Budget, month string, amounts map[uuid.UUID]int64) int {
	in := api.AllocationBatch{}
	for id, amount := range amounts {
		in.Allocations = append(in.Allocations, api.AllocationInput{CategoryId: id, Amount: amount})
	}
	return b.do(http.MethodPut, budgetPath(budget, "/months/"+month+"/allocations"), in).Code
}

func TestEnvelopesPerMonth(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin) // the bank opens with 50,000 on 11/1
	mk := func(parent *uuid.UUID, name string, kind api.CategoryKind, pooled bool) api.Category {
		t.Helper()
		rec := admin.do(http.MethodPost, budgetPath(f.budget, "/categories"),
			api.CategoryCreate{ParentId: parent, Name: name, Kind: kind, Pooled: &pooled})
		wantStatus(t, rec, http.StatusCreated)
		var c api.Category
		decode(t, rec, &c)
		return c
	}
	transport := mk(nil, "交通", api.CategoryKindExpense, true)
	fuel := mk(&transport.Id, "加油", api.CategoryKindExpense, true)
	housing := mk(nil, "居住", api.CategoryKindExpense, false)
	rent := mk(&housing.Id, "房租", api.CategoryKindExpense, true)
	salary := mk(nil, "薪資", api.CategoryKindIncome, false)

	if code := allocate(admin, f.budget, "2026-11", map[uuid.UUID]int64{f.food.Id: 3000, transport.Id: 2000, rent.Id: 10000}); code != http.StatusNoContent {
		t.Fatalf("allocate = %d", code)
	}
	if code := allocate(admin, f.budget, "2026-12", map[uuid.UUID]int64{f.food.Id: 1000}); code != http.StatusNoContent {
		t.Fatalf("allocate December = %d", code)
	}
	// Only envelopes take money: not a subcategory of a pooled parent, not a
	// parent whose children budget separately, not income.
	for _, id := range []uuid.UUID{fuel.Id, housing.Id, salary.Id} {
		rec := admin.do(http.MethodPut, budgetPath(f.budget, "/months/2026-11/allocations"),
			api.AllocationBatch{Allocations: []api.AllocationInput{{CategoryId: id, Amount: 1}}})
		wantError(t, rec, http.StatusBadRequest, "not_an_envelope")
	}
	wantStatus(t, admin.do(http.MethodGet, budgetPath(f.budget, "/months/2026-13"), nil), http.StatusBadRequest)

	october := openapi_types.Date{Time: time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)}
	wantStatus(t, save(admin, f.budget, []api.TransactionInput{
		{Id: uuid.New(), Date: day(3), Entries: []api.EntryInput{entry(f.card.Id, &f.food.Id, -1200)}},
		{Id: uuid.New(), Date: october, Entries: []api.EntryInput{entry(f.bank.Id, &fuel.Id, -500)}},
		{Id: uuid.New(), Date: day(8), Entries: []api.EntryInput{entry(f.bank.Id, &fuel.Id, -300)}},
		{Id: uuid.New(), Date: day(25), Entries: []api.EntryInput{entry(f.bank.Id, &salary.Id, 40000)}},
	}), http.StatusOK)

	nov, env := budgetMonth(t, admin, f.budget, "2026-11")
	// The pool is not per month: December's allocation has left it too.
	if nov.Month != "2026-11" || nov.Pool != 50000+40000-3000-2000-10000-1000 || nov.Income != 90000 {
		t.Fatalf("november = %+v", nov)
	}
	if e := env[f.food.Id]; e.Allocated != 3000 || e.Activity != -1200 || e.Carried != 0 {
		t.Fatalf("food = %+v", e)
	}
	// Activity stays on the category it was recorded in; October's carries in.
	if e := env[fuel.Id]; e.Allocated != 0 || e.Activity != -300 || e.Carried != -500 {
		t.Fatalf("fuel = %+v", e)
	}
	if e := env[transport.Id]; e.Allocated != 2000 || e.Activity != 0 {
		t.Fatalf("transport = %+v", e)
	}
	if _, ok := env[salary.Id]; ok {
		t.Fatal("income categories are not envelopes")
	}
	// Income per income category, the opening balance included.
	received := map[uuid.UUID]int64{}
	var sum int64
	for _, in := range nov.Incomes {
		received[in.CategoryId] = in.Received
		sum += in.Received
	}
	if received[salary.Id] != 40000 || sum != nov.Income {
		t.Fatalf("incomes = %+v", nov.Incomes)
	}

	_, dec := budgetMonth(t, admin, f.budget, "2026-12")
	if e := dec[f.food.Id]; e.Carried != 3000-1200 || e.Allocated != 1000 || e.Activity != 0 {
		t.Fatalf("food in December = %+v", e)
	}
	_, oct := budgetMonth(t, admin, f.budget, "2026-10")
	if _, ok := oct[f.food.Id]; ok || oct[fuel.Id].Activity != -500 {
		t.Fatalf("october = %+v", oct)
	}

	// 0 removes an allocation.
	if code := allocate(admin, f.budget, "2026-12", map[uuid.UUID]int64{f.food.Id: 0}); code != http.StatusNoContent {
		t.Fatalf("clear = %d", code)
	}
	_, dec = budgetMonth(t, admin, f.budget, "2026-12")
	if dec[f.food.Id].Allocated != 0 {
		t.Fatalf("food in December after clearing = %+v", dec[f.food.Id])
	}

	// On-budget accounts = pool + envelopes (ADR-020).
	s := summary(t, admin, f.budget)
	if s.OnBudgetBalance != s.Pool+s.EnvelopeBalance {
		t.Fatalf("summary = %+v", s)
	}
}

func TestMovingCategories(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin)
	mk := func(parent *uuid.UUID, name string, kind api.CategoryKind) api.Category {
		t.Helper()
		rec := admin.do(http.MethodPost, budgetPath(f.budget, "/categories"),
			api.CategoryCreate{ParentId: parent, Name: name, Kind: kind})
		wantStatus(t, rec, http.StatusCreated)
		var c api.Category
		decode(t, rec, &c)
		return c
	}
	move := func(id uuid.UUID, parent *uuid.UUID, index int32) *httptest.ResponseRecorder {
		return admin.do(http.MethodPost, budgetPath(f.budget, "/categories/"+id.String()+"/move"),
			api.CategoryMove{ParentId: parent, Index: index})
	}
	daily := mk(nil, "日常花費", api.CategoryKindExpense)
	transport := mk(nil, "交通", api.CategoryKindExpense)
	fuel := mk(&transport.Id, "油錢", api.CategoryKindExpense)
	parking := mk(&transport.Id, "停車", api.CategoryKindExpense)
	salary := mk(nil, "薪資", api.CategoryKindIncome)
	wantStatus(t, save(admin, f.budget, []api.TransactionInput{
		{Id: uuid.New(), Date: day(8), Entries: []api.EntryInput{entry(f.bank.Id, &fuel.Id, -300)}},
	}), http.StatusOK)

	// 交通 with its children goes under 日常花費: three levels.
	rec := move(transport.Id, &daily.Id, 0)
	wantStatus(t, rec, http.StatusOK)
	var moved api.Category
	decode(t, rec, &moved)
	if moved.ParentId == nil || *moved.ParentId != daily.Id {
		t.Fatalf("moved = %+v", moved)
	}
	// A fourth level, a cycle, another kind and system categories are refused.
	sub := mk(nil, "其他", api.CategoryKindExpense)
	wantError(t, move(sub.Id, &fuel.Id, 0), http.StatusBadRequest, "category_too_deep")
	wantError(t, move(daily.Id, &fuel.Id, 0), http.StatusBadRequest, "category_cycle")
	wantError(t, move(salary.Id, &daily.Id, 0), http.StatusBadRequest, "category_kind_mismatch")

	// Back to the top level, first; the siblings make room.
	wantStatus(t, move(parking.Id, nil, 0), http.StatusOK)
	byID := map[uuid.UUID]api.Category{}
	rec = admin.do(http.MethodGet, budgetPath(f.budget, "/categories"), nil)
	var all []api.Category
	decode(t, rec, &all)
	for _, c := range all {
		byID[c.Id] = c
	}
	if p := byID[parking.Id]; p.ParentId != nil || p.SortOrder != 0 {
		t.Fatalf("parking = %+v", p)
	}
	for _, c := range all {
		if c.ParentId == nil && c.Id != parking.Id && c.Kind == api.CategoryKindExpense && !c.IsSystem && c.SortOrder == 0 {
			t.Fatalf("two top-level categories first: %+v", c)
		}
	}
	// Spending stays with the moved category.
	_, env := budgetMonth(t, admin, f.budget, "2026-11")
	if env[fuel.Id].Activity != -300 {
		t.Fatalf("fuel = %+v", env[fuel.Id])
	}
	// The same name twice under one parent is refused.
	twin := mk(&daily.Id, "停車", api.CategoryKindExpense)
	wantError(t, move(twin.Id, nil, 0), http.StatusConflict, "duplicate")
}

func TestAllocatingNeedsWritePermission(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin)
	hs.addUser("ming", "ming-password")
	viewer := hs.browser().mustLogin("ming", "ming-password")
	if _, err := hs.pool.Exec(context.Background(), `
		insert into budget_members (budget_id, user_id, role)
		select $1, id, 'viewer' from users where username = 'ming'`, f.budget.Id); err != nil {
		t.Fatal(err)
	}

	budgetMonth(t, viewer, f.budget, "2026-11")
	if code := allocate(viewer, f.budget, "2026-11", map[uuid.UUID]int64{f.food.Id: 1}); code != http.StatusForbidden {
		t.Fatalf("viewer allocating = %d", code)
	}
}
