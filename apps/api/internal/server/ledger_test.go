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

// Integration tests of budget setup: budgets and their members, accounts
// with opening balances, and the category tree.

func createBudget(t *testing.T, b *browser, name string, starter bool) api.Budget {
	t.Helper()
	rec := b.do(http.MethodPost, "/api/budgets", api.BudgetCreate{Name: name, Currency: "TWD", StarterCategories: starter})
	wantStatus(t, rec, http.StatusCreated)
	var out api.Budget
	decode(t, rec, &out)
	return out
}

func budgetPath(b api.Budget, rest string) string { return "/api/budgets/" + b.Id.String() + rest }

func accountInput(name string, kind api.NewAccountKind, onBudget bool, opening int64) api.AccountCreate {
	return api.AccountCreate{
		Name: name, Kind: kind, OnBudget: onBudget, OpeningBalance: opening,
		OpeningDate: openapi_types.Date{Time: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)},
	}
}

func createAccount(t *testing.T, b *browser, budget api.Budget, in api.AccountCreate) api.Account {
	t.Helper()
	rec := b.do(http.MethodPost, budgetPath(budget, "/accounts"), in)
	wantStatus(t, rec, http.StatusCreated)
	var out api.Account
	decode(t, rec, &out)
	return out
}

func summary(t *testing.T, b *browser, budget api.Budget) api.BudgetSummary {
	t.Helper()
	rec := b.do(http.MethodGet, budgetPath(budget, "/summary"), nil)
	wantStatus(t, rec, http.StatusOK)
	var out api.BudgetSummary
	decode(t, rec, &out)
	return out
}

func listCategories(t *testing.T, b *browser, budget api.Budget) []api.Category {
	t.Helper()
	rec := b.do(http.MethodGet, budgetPath(budget, "/categories"), nil)
	wantStatus(t, rec, http.StatusOK)
	var out []api.Category
	decode(t, rec, &out)
	return out
}

func createCategory(t *testing.T, b *browser, budget api.Budget, parent *uuid.UUID, name string, kind api.CategoryKind) *httptest.ResponseRecorder {
	t.Helper()
	return b.do(http.MethodPost, budgetPath(budget, "/categories"), api.CategoryCreate{ParentId: parent, Name: name, Kind: kind})
}

func TestBudgetSetup(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)

	first := createBudget(t, admin, "  我的帳本 ", true)
	if first.Name != "我的帳本" || first.Role != api.Owner || !first.IsDefault || first.MinorUnits != 0 || first.Currency != "TWD" {
		t.Fatalf("first budget = %+v", first)
	}
	second := createBudget(t, admin, "旅行", false)
	if second.IsDefault {
		t.Fatal("only the first budget becomes the default")
	}

	var list []api.Budget
	rec := admin.do(http.MethodGet, "/api/budgets", nil)
	wantStatus(t, rec, http.StatusOK)
	decode(t, rec, &list)
	if len(list) != 2 || list[0].Id != first.Id {
		t.Fatalf("budgets = %+v", list)
	}

	// Every budget has the opening balance category; the starter set only when asked.
	countSystem := func(cats []api.Category) (system, other int) {
		for _, c := range cats {
			if c.IsSystem {
				system++
			} else {
				other++
			}
		}
		return
	}
	starter := listCategories(t, admin, first)
	if system, other := countSystem(starter); system != 1 || other != 24 {
		t.Fatalf("starter budget has %d system and %d other categories, want 1 and 24", system, other)
	}
	// Expense categories share their budget by default; income ones cannot.
	for _, c := range starter {
		if !c.IsSystem && c.Pooled != (c.Kind == api.CategoryKindExpense) {
			t.Fatalf("starter category %q (%s) pooled = %v", c.Name, c.Kind, c.Pooled)
		}
	}
	if system, other := countSystem(listCategories(t, admin, second)); system != 1 || other != 0 {
		t.Fatalf("empty budget has %d system and %d other categories, want 1 and 0", system, other)
	}

	rec = admin.do(http.MethodPut, budgetPath(first, ""), api.BudgetUpdate{Name: "家用"})
	wantStatus(t, rec, http.StatusOK)
	var renamed api.Budget
	decode(t, rec, &renamed)
	if renamed.Name != "家用" {
		t.Fatalf("renamed budget = %+v", renamed)
	}

	wantStatus(t, admin.do(http.MethodPost, "/api/budgets", api.BudgetCreate{Name: "x", Currency: "twd"}), http.StatusBadRequest)
	usd := admin.do(http.MethodPost, "/api/budgets", api.BudgetCreate{Name: "US", Currency: "USD"})
	wantStatus(t, usd, http.StatusCreated)
	var usdBudget api.Budget
	decode(t, usd, &usdBudget)
	if usdBudget.MinorUnits != 2 {
		t.Fatalf("USD minor units = %d, want 2", usdBudget.MinorUnits)
	}
}

func TestBudgetAccessByRole(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	budget := createBudget(t, admin, "家用", false)
	hs.addUser("ming", "ming-password")
	ming := hs.browser().mustLogin("ming", "ming-password")

	// Not a member: the budget does not exist for them.
	for _, path := range []string{"", "/summary", "/accounts", "/categories"} {
		wantError(t, ming.do(http.MethodGet, budgetPath(budget, path), nil), http.StatusNotFound, "not_found")
	}
	wantError(t, ming.do(http.MethodGet, "/api/budgets/"+uuid.NewString(), nil), http.StatusNotFound, "not_found")
	wantError(t, ming.do(http.MethodGet, "/api/budgets/not-a-uuid", nil), http.StatusNotFound, "not_found")
	var none []api.Budget
	decode(t, ming.do(http.MethodGet, "/api/budgets", nil), &none)
	if len(none) != 0 {
		t.Fatalf("a non-member lists %d budgets", len(none))
	}

	setRole := func(role string) {
		t.Helper()
		_, err := hs.pool.Exec(context.Background(), `
			insert into budget_members (budget_id, user_id, role)
			select $1, id, $2 from users where username = 'ming'
			on conflict (budget_id, user_id) do update set role = excluded.role`, budget.Id, role)
		if err != nil {
			t.Fatal(err)
		}
	}

	// Viewers and editors read; only owners change the structure.
	for _, role := range []string{"viewer", "editor"} {
		setRole(role)
		wantStatus(t, ming.do(http.MethodGet, budgetPath(budget, "/accounts"), nil), http.StatusOK)
		wantError(t, ming.do(http.MethodPost, budgetPath(budget, "/accounts"), accountInput("x", api.NewAccountKindBank, true, 0)),
			http.StatusForbidden, "forbidden")
		wantError(t, ming.do(http.MethodPut, budgetPath(budget, ""), api.BudgetUpdate{Name: "x"}), http.StatusForbidden, "forbidden")
	}
	setRole("owner")
	createAccount(t, ming, budget, accountInput("明的帳戶", api.NewAccountKindBank, true, 0))

	// Ids from another budget are not reachable through this one.
	other := createBudget(t, admin, "另一本", false)
	acct := createAccount(t, admin, other, accountInput("外部", api.NewAccountKindBank, true, 0))
	wantError(t, admin.do(http.MethodPut, budgetPath(budget, "/accounts/"+acct.Id.String()), api.AccountUpdate{Name: "x"}),
		http.StatusNotFound, "not_found")
	wantError(t, admin.do(http.MethodDelete, budgetPath(budget, "/accounts/"+acct.Id.String()), nil), http.StatusNotFound, "not_found")
}

func TestAccountsAndOpeningBalances(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	budget := createBudget(t, admin, "家用", false)

	bank := createAccount(t, admin, budget, accountInput("台新", api.NewAccountKindBank, true, 50000))
	if bank.Balance != 50000 || bank.ClearedBalance != 50000 || !bank.OnBudget || bank.HasActivity {
		t.Fatalf("bank = %+v", bank)
	}
	// A card is always on budget, a loan never, whatever was asked.
	card := createAccount(t, admin, budget, accountInput("玉山卡", api.NewAccountKindCreditCard, false, -12000))
	loan := createAccount(t, admin, budget, accountInput("車貸", api.NewAccountKindLoan, true, -600000))
	if !card.OnBudget || loan.OnBudget {
		t.Fatalf("on-budget not forced by kind: card=%v loan=%v", card.OnBudget, loan.OnBudget)
	}
	cash := createAccount(t, admin, budget, accountInput("錢包", api.NewAccountKindCash, true, 0))

	// Opening balances of budget accounts are income to the pool; with nothing
	// budgeted or spent, pool and budget accounts are equal (ADR-023).
	s := summary(t, admin, budget)
	if s.Pool != 38000 || s.OnBudgetBalance != 38000 || s.OffBudgetBalance != -600000 {
		t.Fatalf("summary = %+v", s)
	}

	wantError(t, admin.do(http.MethodPost, budgetPath(budget, "/accounts"), accountInput("台新", api.NewAccountKindCash, true, 0)),
		http.StatusConflict, "duplicate")
	wantStatus(t, admin.do(http.MethodPost, budgetPath(budget, "/accounts"), accountInput("x", "friend", true, 0)), http.StatusBadRequest)

	// Closing needs a zero balance; renaming and reopening work.
	wantError(t, admin.do(http.MethodPut, budgetPath(budget, "/accounts/"+bank.Id.String()), api.AccountUpdate{Name: "台新", Closed: true}),
		http.StatusConflict, "account_not_empty")
	rec := admin.do(http.MethodPut, budgetPath(budget, "/accounts/"+cash.Id.String()), api.AccountUpdate{Name: "零錢", Closed: true})
	wantStatus(t, rec, http.StatusOK)
	var closed api.Account
	decode(t, rec, &closed)
	if closed.Name != "零錢" || !closed.Closed {
		t.Fatalf("closed account = %+v", closed)
	}
	decode(t, admin.do(http.MethodPut, budgetPath(budget, "/accounts/"+cash.Id.String()), api.AccountUpdate{Name: "零錢"}), &closed)
	if closed.Closed {
		t.Fatal("the account was not reopened")
	}

	// An account with only its opening balance can be deleted, and its
	// opening balance leaves the pool with it.
	wantStatus(t, admin.do(http.MethodDelete, budgetPath(budget, "/accounts/"+card.Id.String()), nil), http.StatusNoContent)
	if s := summary(t, admin, budget); s.Pool != 50000 || s.OnBudgetBalance != 50000 {
		t.Fatalf("summary after deleting the card = %+v", s)
	}

	// Once it has other transactions it cannot be deleted.
	_, err := hs.pool.Exec(context.Background(), `
		with t as (insert into transactions (budget_id, date) values ($1, '2026-11-02') returning id)
		insert into entries (budget_id, transaction_id, account_id, category_id, amount)
		select $1, t.id, $2, c.id, -300 from t, categories c where c.budget_id = $1 and c.is_system`,
		budget.Id, bank.Id)
	if err != nil {
		t.Fatal(err)
	}
	wantError(t, admin.do(http.MethodDelete, budgetPath(budget, "/accounts/"+bank.Id.String()), nil), http.StatusConflict, "account_in_use")

	// Reordering puts the listed accounts first.
	wantStatus(t, admin.do(http.MethodPut, budgetPath(budget, "/accounts/order"), api.Reorder{Ids: []uuid.UUID{cash.Id, bank.Id}}),
		http.StatusNoContent)
	wantError(t, admin.do(http.MethodPut, budgetPath(budget, "/accounts/order"), api.Reorder{Ids: []uuid.UUID{cash.Id, cash.Id}}),
		http.StatusBadRequest, "invalid_order")
	var accounts []api.Account
	decode(t, admin.do(http.MethodGet, budgetPath(budget, "/accounts"), nil), &accounts)
	if len(accounts) != 3 || accounts[0].Id != cash.Id || accounts[1].Id != bank.Id || accounts[2].Id != loan.Id {
		t.Fatalf("account order = %+v", accounts)
	}
	if !accounts[1].HasActivity || accounts[1].Balance != 49700 {
		t.Fatalf("bank after a transaction = %+v", accounts[1])
	}
}

func TestCategoryTree(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	budget := createBudget(t, admin, "家用", false)

	create := func(parent *uuid.UUID, name string, kind api.CategoryKind) api.Category {
		t.Helper()
		rec := createCategory(t, admin, budget, parent, name, kind)
		wantStatus(t, rec, http.StatusCreated)
		var out api.Category
		decode(t, rec, &out)
		return out
	}

	transport := create(nil, "交通", api.CategoryKindExpense)
	if !transport.Pooled {
		t.Fatal("a new expense category does not share its budget by default")
	}
	// A subcategory takes its parent's kind.
	fuel := create(&transport.Id, "加油", api.CategoryKindIncome)
	if fuel.Kind != api.CategoryKindExpense || fuel.ParentId == nil || *fuel.ParentId != transport.Id || !fuel.Pooled {
		t.Fatalf("subcategory = %+v", fuel)
	}
	separate := false
	rec := admin.do(http.MethodPost, budgetPath(budget, "/categories"),
		api.CategoryCreate{Name: "各自", Kind: api.CategoryKindExpense, Pooled: &separate})
	wantStatus(t, rec, http.StatusCreated)
	var own api.Category
	decode(t, rec, &own)
	if own.Pooled {
		t.Fatal("pooled: false was ignored")
	}
	station := create(&fuel.Id, "中油", api.CategoryKindExpense)
	wantError(t, createCategory(t, admin, budget, &station.Id, "太深", api.CategoryKindExpense), http.StatusBadRequest, "category_too_deep")
	wantError(t, createCategory(t, admin, budget, nil, "交通/加油", api.CategoryKindExpense), http.StatusBadRequest, "invalid_category_name")
	wantError(t, createCategory(t, admin, budget, &transport.Id, "加油", api.CategoryKindExpense), http.StatusConflict, "duplicate")
	wantError(t, createCategory(t, admin, budget, nil, "交通", api.CategoryKindExpense), http.StatusConflict, "duplicate")

	// The same name is fine under another parent.
	food := create(nil, "飲食", api.CategoryKindExpense)
	create(&food.Id, "加油", api.CategoryKindExpense)

	// Only expense categories share an envelope.
	income := create(nil, "收入", api.CategoryKindIncome)
	if income.Pooled {
		t.Fatal("an income category shares a budget")
	}
	pooled := true
	wantError(t, admin.do(http.MethodPost, budgetPath(budget, "/categories"),
		api.CategoryCreate{Name: "獎金", Kind: api.CategoryKindIncome, Pooled: &pooled}), http.StatusBadRequest, "invalid_pooled")
	wantError(t, admin.do(http.MethodPut, budgetPath(budget, "/categories/"+income.Id.String()),
		api.CategoryUpdate{Name: "收入", Pooled: true}), http.StatusBadRequest, "invalid_pooled")
	rec = admin.do(http.MethodPut, budgetPath(budget, "/categories/"+transport.Id.String()),
		api.CategoryUpdate{Name: "交通費", Pooled: false, Archived: false})
	wantStatus(t, rec, http.StatusOK)
	var updated api.Category
	decode(t, rec, &updated)
	if updated.Name != "交通費" || updated.Pooled {
		t.Fatalf("updated category = %+v", updated)
	}

	// The system category cannot be changed, deleted or given children.
	var system api.Category
	for _, c := range listCategories(t, admin, budget) {
		if c.IsSystem {
			system = c
		}
	}
	wantError(t, admin.do(http.MethodPut, budgetPath(budget, "/categories/"+system.Id.String()),
		api.CategoryUpdate{Name: "x"}), http.StatusBadRequest, "system_category")
	wantError(t, admin.do(http.MethodDelete, budgetPath(budget, "/categories/"+system.Id.String()), nil),
		http.StatusBadRequest, "system_category")
	wantError(t, createCategory(t, admin, budget, &system.Id, "x", api.CategoryKindIncome), http.StatusBadRequest, "system_category")

	// A category with children or money is archived, not deleted.
	wantError(t, admin.do(http.MethodDelete, budgetPath(budget, "/categories/"+transport.Id.String()), nil),
		http.StatusConflict, "category_in_use")
	_, err := hs.pool.Exec(context.Background(),
		`insert into allocations (budget_id, category_id, month, amount) values ($1, $2, '2026-11-01', 3000)`, budget.Id, station.Id)
	if err != nil {
		t.Fatal(err)
	}
	wantError(t, admin.do(http.MethodDelete, budgetPath(budget, "/categories/"+station.Id.String()), nil),
		http.StatusConflict, "category_in_use")
	rec = admin.do(http.MethodPut, budgetPath(budget, "/categories/"+station.Id.String()),
		api.CategoryUpdate{Name: "中油", Archived: true})
	wantStatus(t, rec, http.StatusOK)
	decode(t, rec, &updated)
	if !updated.Archived {
		t.Fatal("the category was not archived")
	}
	bus := create(&transport.Id, "公車", api.CategoryKindExpense)
	wantStatus(t, admin.do(http.MethodDelete, budgetPath(budget, "/categories/"+bus.Id.String()), nil), http.StatusNoContent)

	// Reordering applies to the siblings of the listed categories.
	wantStatus(t, admin.do(http.MethodPut, budgetPath(budget, "/categories/order"),
		api.Reorder{Ids: []uuid.UUID{income.Id, food.Id}}), http.StatusNoContent)
	wantError(t, admin.do(http.MethodPut, budgetPath(budget, "/categories/order"),
		api.Reorder{Ids: []uuid.UUID{income.Id, fuel.Id}}), http.StatusBadRequest, "invalid_order")
	order := map[uuid.UUID]int32{}
	for _, c := range listCategories(t, admin, budget) {
		order[c.Id] = c.SortOrder
	}
	if order[income.Id] != 0 || order[food.Id] != 1 || order[transport.Id] != 2 || order[own.Id] != 3 {
		t.Fatalf("top-level order: income=%d food=%d transport=%d", order[income.Id], order[food.Id], order[transport.Id])
	}
}
