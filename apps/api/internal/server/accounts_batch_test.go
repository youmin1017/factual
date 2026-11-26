package server

import (
	"net/http"
	"testing"

	"github.com/google/uuid"

	"factual/apps/api/internal/api"
)

// Integration tests of the accounts page's :w (ADR-108).

func saveAccounts(t *testing.T, b *browser, budget api.Budget, upserts []api.AccountInput, deletes ...uuid.UUID) (int, map[uuid.UUID]api.BatchProblem) {
	if upserts == nil {
		upserts = []api.AccountInput{}
	}
	if deletes == nil {
		deletes = []uuid.UUID{}
	}
	rec := b.do(http.MethodPost, budgetPath(budget, "/accounts/batch"), api.AccountBatch{Upserts: upserts, Deletes: deletes})
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

func TestSaveAccounts(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin) // 台新 (50,000), 玉山卡, 車貸

	input := func(a api.Account, order int32) api.AccountInput {
		return api.AccountInput{
			Id: a.Id, Name: a.Name, Kind: api.NewAccountKind(a.Kind), OnBudget: a.OnBudget,
			OpeningDate: day(1), Closed: a.Closed, SortOrder: order,
		}
	}
	wallet := api.AccountInput{
		Id: uuid.New(), Name: "錢包", Kind: api.NewAccountKindCash, OnBudget: true,
		OpeningBalance: 1200, OpeningDate: day(1), SortOrder: 0,
	}
	limit := int64(80000)
	visa := api.AccountInput{
		Id: uuid.New(), Name: "國泰卡", Kind: api.NewAccountKindCreditCard, OpeningBalance: -3000, OpeningDate: day(1),
		SortOrder: 1, Card: &api.CardSettings{StatementDay: 5, DueDay: 20, CreditLimit: &limit},
	}
	// The bank and the card swap names, and everything moves down two.
	bank := input(f.bank, 2)
	bank.Name = f.card.Name
	card := input(f.card, 3)
	card.Name = f.bank.Name
	if code, probs := saveAccounts(t, admin, f.budget, []api.AccountInput{wallet, visa, bank, card}); code != http.StatusOK {
		t.Fatalf("save = %d %+v", code, probs)
	}
	byID := map[uuid.UUID]api.Account{}
	var order []uuid.UUID
	for _, a := range listAccounts(t, admin, f.budget) {
		byID[a.Id] = a
		if a.OnBudget {
			order = append(order, a.Id)
		}
	}
	if byID[wallet.Id].Balance != 1200 || byID[visa.Id].Balance != -3000 || byID[visa.Id].Card == nil ||
		byID[visa.Id].Card.StatementDay != 5 || *byID[visa.Id].Card.CreditLimit != limit {
		t.Fatalf("new accounts = %+v %+v", byID[wallet.Id], byID[visa.Id])
	}
	if byID[f.bank.Id].Name != "玉山卡" || byID[f.card.Id].Name != "台新" {
		t.Fatalf("swapped names = %q %q", byID[f.bank.Id].Name, byID[f.card.Id].Name)
	}
	if len(order) < 4 || order[0] != wallet.Id || order[1] != visa.Id {
		t.Fatalf("order = %v", order)
	}
	s := summary(t, admin, f.budget)
	if s.OnBudgetBalance != s.Pool+s.EnvelopeBalance {
		t.Fatalf("on budget %d != pool %d + envelopes %d", s.OnBudgetBalance, s.Pool, s.EnvelopeBalance)
	}

	// Problems are reported per account, and nothing is saved.
	full := input(byID[f.bank.Id], 2)
	full.Closed = true
	twin := api.AccountInput{Id: uuid.New(), Name: "錢包", Kind: api.NewAccountKindBank, OpeningDate: day(1)}
	notCard := input(byID[wallet.Id], 0)
	notCard.Card = &api.CardSettings{StatementDay: 1, DueDay: 10}
	used := uuid.New()
	wantStatus(t, save(admin, f.budget, []api.TransactionInput{{
		Id: used, Date: day(3), Entries: []api.EntryInput{entry(f.bank.Id, &f.food.Id, -100)},
	}}), http.StatusOK)
	code, probs := saveAccounts(t, admin, f.budget, []api.AccountInput{full, notCard, twin}, f.bank.Id)
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("bad batch = %d", code)
	}
	for id, want := range map[uuid.UUID]string{
		full.Id: "duplicate_id", twin.Id: "name_taken", notCard.Id: "not_a_card",
	} {
		if probs[id].Code != want {
			t.Errorf("want %s, got %+v", want, probs[id])
		}
	}
	code, probs = saveAccounts(t, admin, f.budget, []api.AccountInput{full})
	if code != http.StatusUnprocessableEntity || probs[full.Id].Code != "account_not_empty" {
		t.Fatalf("closing a full account = %d %+v", code, probs)
	}
	code, probs = saveAccounts(t, admin, f.budget, nil, f.bank.Id)
	if code != http.StatusUnprocessableEntity || probs[f.bank.Id].Code != "account_in_use" {
		t.Fatalf("deleting a used account = %d %+v", code, probs)
	}

	// A new account without transactions can be deleted again.
	if code, probs := saveAccounts(t, admin, f.budget, nil, wallet.Id); code != http.StatusOK {
		t.Fatalf("delete = %d %+v", code, probs)
	}
	for _, a := range listAccounts(t, admin, f.budget) {
		if a.Id == wallet.Id {
			t.Fatal("the wallet is still there")
		}
	}

	// A new loan account takes its terms in the same save, and starts owing
	// what they leave owed; a bank account takes none.
	terms := api.LoanTerms{
		Principal: 1_000_000, TermMonths: 240, StartDate: ymd(2025, 1, 10), FirstPaymentDate: ymd(2025, 2, 10),
		Method: api.Annuity, PrepayMode: api.ShortenTerm, HolidayShift: api.NextWorkday,
		Rates: []api.LoanRate{{EffectiveFrom: ymd(2025, 1, 10), AnnualRate: 2}},
	}
	house := api.AccountInput{
		Id: uuid.New(), Name: "房貸", Kind: api.NewAccountKindLoan, OpeningBalance: -1, OpeningDate: day(1),
		SortOrder: 9, Loan: &terms,
	}
	notLoan := input(byID[f.card.Id], 3)
	notLoan.Loan = &terms
	code, probs = saveAccounts(t, admin, f.budget, []api.AccountInput{house, notLoan})
	if code != http.StatusUnprocessableEntity || probs[notLoan.Id].Code != "not_a_loan" {
		t.Fatalf("terms on a card = %d %+v", code, probs)
	}
	if code, probs := saveAccounts(t, admin, f.budget, []api.AccountInput{house}); code != http.StatusOK {
		t.Fatalf("loan = %d %+v", code, probs)
	}
	details := getLoan(t, admin, f.budget, api.Account{Id: house.Id})
	if details.Terms.Principal != 1_000_000 {
		t.Fatalf("terms = %+v", details.Terms)
	}
	for _, a := range listAccounts(t, admin, f.budget) {
		if a.Id == house.Id && (a.Balance >= 0 || a.Balance == -1) {
			t.Fatalf("the loan owes what the terms leave owed, not the opening balance: %d", a.Balance)
		}
	}

	// Viewers and editors cannot change accounts.
	hs.addUser("ming", "ming-password-1")
	ming := hs.browser().mustLogin("ming", "ming-password-1")
	if code, _ := saveAccounts(t, ming, f.budget, nil); code != http.StatusNotFound {
		t.Fatalf("a stranger = %d", code)
	}
}
