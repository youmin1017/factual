package server

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"factual/apps/api/internal/api"
)

func statements(t *testing.T, b *browser, budget api.Budget, card api.Account) api.CardStatements {
	t.Helper()
	rec := b.do(http.MethodGet, budgetPath(budget, "/accounts/"+card.Id.String()+"/statements"), nil)
	wantStatus(t, rec, http.StatusOK)
	var out api.CardStatements
	decode(t, rec, &out)
	return out
}

func spend(account, category uuid.UUID, d time.Time, amount int64) api.TransactionInput {
	return api.TransactionInput{
		Id: uuid.New(), Date: date(d.Year(), d.Month(), d.Day()), Payee: "店家",
		Entries: []api.EntryInput{entry(account, &category, amount)},
	}
}

func pay(from, card uuid.UUID, d time.Time, amount int64) api.TransactionInput {
	return api.TransactionInput{
		Id: uuid.New(), Date: date(d.Year(), d.Month(), d.Day()),
		Entries: []api.EntryInput{entry(from, nil, -amount), entry(card, nil, amount)},
	}
}

func TestCardStatements(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin)
	setClock := func(d time.Time) { hs.ledger.SetClock(func() time.Time { return d }) }
	defer setClock(testToday)
	closeAll := func() int {
		t.Helper()
		n, err := hs.ledger.CloseStatements(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	update := func(a api.Account, card *api.CardSettings) *http.Response {
		rec := admin.do(http.MethodPut, budgetPath(f.budget, "/accounts/"+a.Id.String()), api.AccountUpdate{Name: a.Name, Closed: false, Card: card})
		return rec.Result()
	}
	ymdT := func(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }

	// Settings only on cards, autopay only from another budget account.
	settings := api.CardSettings{StatementDay: 5, DueDay: 25}
	if s := update(f.bank, &settings).StatusCode; s != http.StatusBadRequest {
		t.Fatalf("settings on a bank account: %d", s)
	}
	self := settings
	self.AutopayAccountId = &f.card.Id
	loanPays := settings
	loanPays.AutopayAccountId = &f.loan.Id
	for _, bad := range []api.CardSettings{self, loanPays, {StatementDay: 0, DueDay: 25}} {
		if s := update(f.card, &bad).StatusCode; s != http.StatusBadRequest {
			t.Fatalf("%+v: %d", bad, s)
		}
	}
	limit := int64(80000)
	settings.CreditLimit = &limit
	settings.AutopayAccountId = &f.bank.Id
	if s := update(f.card, &settings).StatusCode; s != http.StatusOK {
		t.Fatalf("card settings: %d", s)
	}
	for _, a := range listAccounts(t, admin, f.budget) {
		if a.Id == f.card.Id && (a.Card == nil || a.Card.StatementDay != 5 || *a.Card.CreditLimit != limit) {
			t.Fatalf("card reads back as %+v", a.Card)
		}
		if a.Id == f.bank.Id && a.Card != nil {
			t.Fatal("a bank account has card settings")
		}
	}

	// Today is 11/20: the open statement runs 11/06 to 12/05, due 12/25.
	got := statements(t, admin, f.budget, f.card)
	if got.Open == nil || got.Open.PeriodStart.String() != "2026-11-06" || got.Open.PeriodEnd.String() != "2026-12-05" || got.Open.DueDate.String() != "2026-12-25" {
		t.Fatalf("open statement %+v", got.Open)
	}
	lunch := spend(f.card.Id, f.food.Id, ymdT(2026, 11, 10), -1000)
	early := spend(f.card.Id, f.food.Id, ymdT(2026, 11, 3), -500)
	wantStatus(t, save(admin, f.budget, []api.TransactionInput{lunch, early, pay(f.bank.Id, f.card.Id, ymdT(2026, 11, 15), 300)}), http.StatusOK)
	got = statements(t, admin, f.budget, f.card)
	if got.Open.Charges != 1500 || got.Open.Payments != 300 || len(got.Statements) != 0 {
		t.Fatalf("before closing: %+v", got)
	}

	// 12/06: it closes with everything unbilled up to 12/05 (11/03 too).
	setClock(ymdT(2026, 12, 6))
	if n := closeAll(); n != 1 {
		t.Fatalf("closed %d", n)
	}
	if n := closeAll(); n != 0 {
		t.Fatalf("closed again: %d", n)
	}
	got = statements(t, admin, f.budget, f.card)
	st := got.Statements[0]
	if st.Charges != 1500 || st.Payments != 300 || st.AmountDue != 1200 || st.PreviousDue != 0 || st.State != api.Due || st.Remaining != 1200 {
		t.Fatalf("closed statement %+v", st)
	}
	if got.Open.PeriodStart.String() != "2026-12-06" || got.Open.PeriodEnd.String() != "2027-01-05" || got.Open.Charges != 0 {
		t.Fatalf("next open statement %+v", got.Open)
	}

	// A payment after closing counts toward it; a charge entered late with
	// an earlier date goes to the next one; editing a billed transaction
	// keeps it billed.
	lunch.Entries[0].Amount = -1100
	wantStatus(t, save(admin, f.budget, []api.TransactionInput{
		pay(f.bank.Id, f.card.Id, ymdT(2026, 12, 10), 500),
		spend(f.card.Id, f.food.Id, ymdT(2026, 12, 1), -200),
		lunch,
	}), http.StatusOK)
	got = statements(t, admin, f.budget, f.card)
	st = got.Statements[0]
	if st.Charges != 1600 || st.AmountDue != 1300 || st.Paid != 500 || st.Remaining != 800 || st.State != api.Partial {
		t.Fatalf("after paying part: %+v", st)
	}
	if got.Open.Charges != 200 || got.Open.Payments != 500 {
		t.Fatalf("open after a late charge: %+v", got.Open)
	}

	// Aligned with the bank's bill, then back to the computed amount.
	due := func(amount *int64) {
		t.Helper()
		rec := admin.do(http.MethodPut, budgetPath(f.budget, "/statements/"+st.Id.String()+"/due"), api.StatementDue{Amount: amount})
		wantStatus(t, rec, http.StatusNoContent)
	}
	bank := int64(1250)
	due(&bank)
	if st = statements(t, admin, f.budget, f.card).Statements[0]; st.AmountDue != 1250 || !st.Adjusted || st.Remaining != 750 || st.ComputedDue != 1300 {
		t.Fatalf("aligned: %+v", st)
	}
	due(nil)
	if st = statements(t, admin, f.budget, f.card).Statements[0]; st.AmountDue != 1300 || st.Adjusted {
		t.Fatalf("back to computed: %+v", st)
	}
	rec := admin.do(http.MethodPut, budgetPath(f.budget, "/statements/"+got.Open.Id.String()+"/due"), api.StatementDue{Amount: &bank})
	wantStatus(t, rec, http.StatusNotFound)

	// 1/26: the 1/05 statement closed with last time's rest; nothing paid
	// since and its due date (1/25) passed.
	setClock(ymdT(2027, 1, 26))
	if n := closeAll(); n != 1 {
		t.Fatalf("closed %d in January", n)
	}
	got = statements(t, admin, f.budget, f.card)
	latest, older := got.Statements[0], got.Statements[1]
	if latest.PreviousDue != 1300 || latest.Charges != 200 || latest.Payments != 500 || latest.AmountDue != 1000 || latest.State != api.Overdue {
		t.Fatalf("January statement %+v", latest)
	}
	if older.State != api.Settled {
		t.Fatalf("the older statement is %s", older.State)
	}

	// Paid in full.
	wantStatus(t, save(admin, f.budget, []api.TransactionInput{pay(f.bank.Id, f.card.Id, ymdT(2027, 1, 26), 1000)}), http.StatusOK)
	if latest = statements(t, admin, f.budget, f.card).Statements[0]; latest.State != api.Paid || latest.Remaining != 0 {
		t.Fatalf("paid: %+v", latest)
	}

	// Only cards have statements.
	wantStatus(t, admin.do(http.MethodGet, budgetPath(f.budget, "/accounts/"+f.bank.Id.String()+"/statements"), nil), http.StatusNotFound)
}

func listAccounts(t *testing.T, b *browser, budget api.Budget) []api.Account {
	t.Helper()
	rec := b.do(http.MethodGet, budgetPath(budget, "/accounts"), nil)
	wantStatus(t, rec, http.StatusOK)
	var out []api.Account
	decode(t, rec, &out)
	return out
}
