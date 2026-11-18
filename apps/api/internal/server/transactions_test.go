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

// Integration tests of the account register and the :w batch (ADR-044).

type ledgerFixture struct {
	budget          api.Budget
	bank, card      api.Account
	loan            api.Account
	food, principal api.Category
}

func newLedgerFixture(t *testing.T, b *browser) ledgerFixture {
	t.Helper()
	budget := createBudget(t, b, "家用", false)
	f := ledgerFixture{budget: budget}
	f.bank = createAccount(t, b, budget, accountInput("台新", api.Bank, true, 50000))
	f.card = createAccount(t, b, budget, accountInput("玉山卡", api.CreditCard, true, 0))
	f.loan = createAccount(t, b, budget, accountInput("車貸", api.Loan, false, -600000))
	mk := func(name string) api.Category {
		rec := createCategory(t, b, budget, nil, name, api.Expense)
		wantStatus(t, rec, http.StatusCreated)
		var c api.Category
		decode(t, rec, &c)
		return c
	}
	f.food = mk("飲食")
	f.principal = mk("車貸本金")
	return f
}

func day(d int) openapi_types.Date {
	return openapi_types.Date{Time: time.Date(2026, 11, d, 0, 0, 0, 0, time.UTC)}
}

func entry(account uuid.UUID, category *uuid.UUID, amount int64) api.EntryInput {
	return api.EntryInput{AccountId: account, CategoryId: category, Amount: amount, Cleared: api.Uncleared}
}

func save(b *browser, budget api.Budget, upserts []api.TransactionInput, deletes ...uuid.UUID) *httptest.ResponseRecorder {
	if upserts == nil {
		upserts = []api.TransactionInput{}
	}
	if deletes == nil {
		deletes = []uuid.UUID{}
	}
	return b.do(http.MethodPost, budgetPath(budget, "/transactions/batch"), api.TransactionBatch{Upserts: upserts, Deletes: deletes})
}

func register(t *testing.T, b *browser, budget api.Budget, account api.Account) []api.Transaction {
	t.Helper()
	rec := b.do(http.MethodGet, budgetPath(budget, "/accounts/"+account.Id.String()+"/register"), nil)
	wantStatus(t, rec, http.StatusOK)
	var out []api.Transaction
	decode(t, rec, &out)
	return out
}

// wantProblems checks a 422 and returns the problems by transaction id.
func wantProblems(t *testing.T, rec *httptest.ResponseRecorder) map[uuid.UUID]api.BatchProblem {
	t.Helper()
	wantStatus(t, rec, http.StatusUnprocessableEntity)
	var out api.BatchErrors
	decode(t, rec, &out)
	byID := map[uuid.UUID]api.BatchProblem{}
	for _, p := range out.Errors {
		byID[p.Id] = p
	}
	return byID
}

func TestSaveAndReadTransactions(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin)

	lunch := uuid.New()
	transfer := uuid.New()
	payment := uuid.New()
	rec := save(admin, f.budget, []api.TransactionInput{
		{Id: lunch, Date: day(3), Payee: " 鼎泰豐 ", Note: "聚餐", Entries: []api.EntryInput{entry(f.card.Id, &f.food.Id, -2400)}},
		// Paying the card: a transfer between two budget accounts, no category.
		{Id: transfer, Date: day(5), Entries: []api.EntryInput{entry(f.bank.Id, nil, -2400), entry(f.card.Id, nil, 2400)}},
		// Loan principal leaves the budget, so the budget side has a category.
		{Id: payment, Date: day(10), Payee: "裕隆", Entries: []api.EntryInput{
			entry(f.bank.Id, &f.principal.Id, -8500), entry(f.loan.Id, nil, 8500),
		}},
	})
	wantStatus(t, rec, http.StatusOK)
	var saved api.BatchSaved
	decode(t, rec, &saved)
	if saved.Upserted != 3 || saved.Deleted != 0 {
		t.Fatalf("saved = %+v", saved)
	}

	card := register(t, admin, f.budget, f.card)
	if len(card) != 2 || card[0].Id != lunch || card[1].Id != transfer {
		t.Fatalf("card register = %+v", card)
	}
	if card[0].PayeeName == nil || *card[0].PayeeName != "鼎泰豐" || card[0].Note != "聚餐" {
		t.Fatalf("lunch = %+v", card[0])
	}
	if len(card[1].Entries) != 2 {
		t.Fatalf("the transfer comes with both of its entries: %+v", card[1].Entries)
	}
	bank := register(t, admin, f.budget, f.bank)
	if len(bank) != 3 || !bank[0].IsOpening {
		t.Fatalf("bank register = %+v", bank)
	}
	if s := summary(t, admin, f.budget); s.OnBudgetBalance != 50000-2400-8500 || s.OffBudgetBalance != -600000+8500 {
		t.Fatalf("summary = %+v", s)
	}

	// Payees are created by name and remember their last category.
	var payees []api.Payee
	decode(t, admin.do(http.MethodGet, budgetPath(f.budget, "/payees"), nil), &payees)
	if len(payees) != 2 {
		t.Fatalf("payees = %+v", payees)
	}
	for _, p := range payees {
		if p.Name == "鼎泰豐" && (p.LastCategoryId == nil || *p.LastCategoryId != f.food.Id) {
			t.Fatalf("鼎泰豐's last category = %v", p.LastCategoryId)
		}
	}

	// Saving a known id replaces it; deleting removes it.
	rec = save(admin, f.budget, []api.TransactionInput{
		{Id: lunch, Date: day(4), Payee: "鼎泰豐", Entries: []api.EntryInput{
			entry(f.card.Id, &f.food.Id, -1500), entry(f.card.Id, &f.principal.Id, -900),
		}},
	}, transfer)
	wantStatus(t, rec, http.StatusOK)
	card = register(t, admin, f.budget, f.card)
	if len(card) != 1 || len(card[0].Entries) != 2 || card[0].Note != "" || card[0].Date != day(4) {
		t.Fatalf("card register after edit = %+v", card)
	}
}

func TestBatchProblemsAreReportedPerTransaction(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin)
	other := newLedgerFixture(t, admin)

	good := uuid.New()
	noCategory := uuid.New()
	toLoanWithout := uuid.New()
	trackingWithCategory := uuid.New()
	unbalanced := uuid.New()
	foreignAccount := uuid.New()
	rec := save(admin, f.budget, []api.TransactionInput{
		{Id: good, Date: day(1), Entries: []api.EntryInput{entry(f.bank.Id, &f.food.Id, -100)}},
		{Id: noCategory, Date: day(1), Entries: []api.EntryInput{entry(f.bank.Id, nil, -100)}},
		{Id: toLoanWithout, Date: day(1), Entries: []api.EntryInput{entry(f.bank.Id, nil, -100), entry(f.loan.Id, nil, 100)}},
		{Id: trackingWithCategory, Date: day(1), Entries: []api.EntryInput{entry(f.loan.Id, &f.food.Id, -100)}},
		{Id: unbalanced, Date: day(1), Entries: []api.EntryInput{entry(f.bank.Id, nil, -100), entry(f.card.Id, nil, 90)}},
		{Id: foreignAccount, Date: day(1), Entries: []api.EntryInput{entry(other.bank.Id, &f.food.Id, -100)}},
	})
	probs := wantProblems(t, rec)
	want := map[uuid.UUID][2]string{
		noCategory:           {"category", "category_required"},
		toLoanWithout:        {"category", "category_required"},
		trackingWithCategory: {"category", "category_not_allowed"},
		unbalanced:           {"amount", "unbalanced"},
		foreignAccount:       {"account", "unknown_account"},
	}
	if len(probs) != len(want) {
		t.Fatalf("problems = %+v", probs)
	}
	for id, w := range want {
		if p := probs[id]; p.Field != w[0] || p.Code != w[1] {
			t.Errorf("problem for %s = %+v, want %v", id, p, w)
		}
	}
	// Nothing was saved, not even the good transaction.
	if got := register(t, admin, f.budget, f.bank); len(got) != 1 {
		t.Fatalf("a failed batch saved %d transactions", len(got)-1)
	}

	// Ids of another budget's transactions are not reachable.
	theirs := uuid.New()
	wantStatus(t, save(admin, other.budget, []api.TransactionInput{
		{Id: theirs, Date: day(1), Entries: []api.EntryInput{entry(other.bank.Id, &other.food.Id, -100)}},
	}), http.StatusOK)
	probs = wantProblems(t, save(admin, f.budget, []api.TransactionInput{
		{Id: theirs, Date: day(1), Entries: []api.EntryInput{entry(f.bank.Id, &f.food.Id, -1)}},
	}))
	if probs[theirs].Code != "not_found" {
		t.Fatalf("overwriting another budget's transaction: %+v", probs)
	}
	if probs = wantProblems(t, save(admin, f.budget, nil, theirs)); probs[theirs].Code != "not_found" {
		t.Fatalf("deleting another budget's transaction: %+v", probs)
	}

	// The same id twice.
	twice := uuid.New()
	probs = wantProblems(t, save(admin, f.budget, []api.TransactionInput{
		{Id: twice, Date: day(1), Entries: []api.EntryInput{entry(f.bank.Id, &f.food.Id, -1)}},
	}, twice))
	if probs[twice].Code != "duplicate_id" {
		t.Fatalf("saved and deleted at once: %+v", probs)
	}
}

func TestSavingNeedsWritePermission(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin)
	hs.addUser("ming", "ming-password")
	ming := hs.browser().mustLogin("ming", "ming-password")

	setRole := func(role string) {
		t.Helper()
		_, err := hs.pool.Exec(context.Background(), `
			insert into budget_members (budget_id, user_id, role)
			select $1, id, $2 from users where username = 'ming'
			on conflict (budget_id, user_id) do update set role = excluded.role`, f.budget.Id, role)
		if err != nil {
			t.Fatal(err)
		}
	}
	tx := []api.TransactionInput{{Id: uuid.New(), Date: day(1), Entries: []api.EntryInput{entry(f.bank.Id, &f.food.Id, -100)}}}

	wantError(t, save(ming, f.budget, tx), http.StatusNotFound, "not_found")
	setRole("viewer")
	register(t, ming, f.budget, f.bank)
	wantError(t, save(ming, f.budget, tx), http.StatusForbidden, "forbidden")
	setRole("editor")
	wantStatus(t, save(ming, f.budget, tx), http.StatusOK)
}

func TestScopeRegisters(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin)

	lunch, transfer, payment := uuid.New(), uuid.New(), uuid.New()
	wantStatus(t, save(admin, f.budget, []api.TransactionInput{
		{Id: lunch, Date: day(3), Payee: "鼎泰豐", Entries: []api.EntryInput{entry(f.card.Id, &f.food.Id, -2400)}},
		{Id: transfer, Date: day(5), Entries: []api.EntryInput{entry(f.bank.Id, nil, -2400), entry(f.card.Id, nil, 2400)}},
		{Id: payment, Date: day(10), Entries: []api.EntryInput{entry(f.bank.Id, &f.principal.Id, -8500), entry(f.loan.Id, nil, 8500)}},
	}), http.StatusOK)

	ids := func(scope string) map[uuid.UUID]int {
		t.Helper()
		rec := admin.do(http.MethodGet, budgetPath(f.budget, "/register?scope="+scope), nil)
		wantStatus(t, rec, http.StatusOK)
		var txs []api.Transaction
		decode(t, rec, &txs)
		out := map[uuid.UUID]int{}
		for _, tx := range txs {
			// Every entry comes along, also those outside the scope.
			out[tx.Id] = len(tx.Entries)
		}
		return out
	}
	all, on, off := ids("all"), ids("onBudget"), ids("offBudget")
	if all[lunch] != 1 || all[transfer] != 2 || all[payment] != 2 {
		t.Fatalf("all = %v", all)
	}
	if on[lunch] != 1 || on[transfer] != 2 || on[payment] != 2 {
		t.Fatalf("onBudget = %v", on)
	}
	if _, ok := off[lunch]; ok || off[payment] != 2 {
		t.Fatalf("offBudget = %v", off)
	}
	wantStatus(t, admin.do(http.MethodGet, budgetPath(f.budget, "/register?scope=nope"), nil), http.StatusBadRequest)
}
