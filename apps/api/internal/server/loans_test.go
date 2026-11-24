package server

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"factual/apps/api/internal/api"
)

func ymd(y int, m time.Month, d int) openapi_types.Date {
	return openapi_types.Date{Time: time.Date(y, m, d, 0, 0, 0, 0, time.UTC)}
}

func getLoan(t *testing.T, b *browser, budget api.Budget, account api.Account) api.LoanDetails {
	t.Helper()
	rec := b.do(http.MethodGet, budgetPath(budget, "/accounts/"+account.Id.String()+"/loan"), nil)
	wantStatus(t, rec, http.StatusOK)
	var out api.LoanDetails
	decode(t, rec, &out)
	return out
}

// periodOf is the period with the number n.
func periodOf(t *testing.T, l api.LoanDetails, n int32) api.LoanPeriod {
	t.Helper()
	for _, p := range l.Periods {
		if p.N == n {
			return p
		}
	}
	t.Fatalf("no period %d", n)
	return api.LoanPeriod{}
}

func TestLoans(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin)
	ctx := context.Background()
	setClock := func(d time.Time) { hs.ledger.SetClock(func() time.Time { return d }) }
	defer setClock(testToday)
	run := func() int {
		t.Helper()
		n, err := hs.ledger.PostAllDue(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	rec := createCategory(t, admin, f.budget, nil, "房貸利息", api.Expense)
	wantStatus(t, rec, http.StatusCreated)
	var interestCat api.Category
	decode(t, rec, &interestCat)
	house := createAccount(t, admin, f.budget, accountInput("房貸", api.Loan, false, 0))
	loanPath := "/accounts/" + house.Id.String() + "/loan"
	terms := api.LoanTerms{
		Principal: 1_000_000, TermMonths: 240, StartDate: ymd(2025, 1, 10), FirstPaymentDate: ymd(2025, 2, 10),
		Method: api.Annuity, PrepayMode: api.ShortenTerm, HolidayShift: api.NextWorkday,
		Rates:            []api.LoanRate{{EffectiveFrom: ymd(2025, 1, 10), AnnualRate: 2}},
		PayFromAccountId: &f.bank.Id, PrincipalCategoryId: &f.principal.Id, InterestCategoryId: &interestCat.Id,
	}

	// The preview: 1,000,000 at 2% over 20 years pays 5,059 a month.
	rec = admin.do(http.MethodPost, budgetPath(f.budget, "/loans/preview"), terms)
	wantStatus(t, rec, http.StatusOK)
	var preview api.LoanPreview
	decode(t, rec, &preview)
	if preview.Payment != 5059 || len(preview.Periods) != 240 || preview.Periods[0].State != api.LoanPeriodStateBefore ||
		preview.Periods[22].State != api.LoanPeriodStatePlanned {
		t.Fatalf("preview: payment %d, %d periods, first %+v", preview.Payment, len(preview.Periods), preview.Periods[0])
	}

	// Problems name their field; only a loan has terms.
	bad := terms
	bad.FirstPaymentDate = bad.StartDate
	rec = admin.do(http.MethodPut, budgetPath(f.budget, loanPath), bad)
	wantStatus(t, rec, http.StatusBadRequest)
	if e := decodeError(t, rec); e.Code != "invalid_first_payment" || e.Details == nil || (*e.Details)["field"] != "firstPaymentDate" {
		t.Fatalf("bad first payment: %+v", e)
	}
	bad = terms
	bad.InterestCategoryId = nil
	rec = admin.do(http.MethodPut, budgetPath(f.budget, loanPath), bad)
	if e := decodeError(t, rec); e.Code != "category_required" {
		t.Fatalf("no interest category: %+v", e)
	}
	rec = admin.do(http.MethodPut, budgetPath(f.budget, "/accounts/"+f.bank.Id.String()+"/loan"), terms)
	if e := decodeError(t, rec); e.Code != "not_a_loan" {
		t.Fatalf("terms on a bank account: %+v", e)
	}
	rec = admin.do(http.MethodGet, budgetPath(f.budget, loanPath), nil)
	wantStatus(t, rec, http.StatusNotFound)

	// Set up on 11/20/2026: 22 payments were made before (the last on
	// 11/10), the account had nothing and starts owing what they leave.
	rec = admin.do(http.MethodPut, budgetPath(f.budget, loanPath), terms)
	wantStatus(t, rec, http.StatusOK)
	var l api.LoanDetails
	decode(t, rec, &l)
	owed := periodOf(t, l, 22).Balance
	if l.TrackedFrom.String() != "2026-12-10" || l.PrincipalLeft != owed || l.Check.Computed != owed || l.Check.Recorded != owed {
		t.Fatalf("after setup: tracked from %v, left %d, check %+v (want %d)", l.TrackedFrom, l.PrincipalLeft, l.Check, owed)
	}
	if periodOf(t, l, 22).State != api.LoanPeriodStateBefore || periodOf(t, l, 23).State != api.LoanPeriodStatePlanned {
		t.Fatal("periods up to 11/10 come before, later ones are planned")
	}
	if l.NextPayment == nil || l.NextPayment.N != 23 || l.NextPayment.Principal+l.NextPayment.Interest != 5059 ||
		l.PeriodsLeft != 218 || l.PayoffDate == nil || l.PayoffDate.String() != "2045-01-10" || l.InterestPaid <= 0 {
		t.Fatalf("summary: next %+v, left %d, payoff %v, interest %d", l.NextPayment, l.PeriodsLeft, l.PayoffDate, l.InterestPaid)
	}
	if s := summary(t, admin, f.budget); s.OffBudgetBalance != -600000-owed {
		t.Fatalf("off-budget balance = %d, want the car loan and %d", s.OffBudgetBalance, owed)
	}

	// Its schedule is the loan's: not on the schedules page, not changed
	// there. The next two payments show as 預定, split in two.
	if n := len(listSchedules(t, admin, f.budget)); n != 0 {
		t.Fatalf("schedules page lists %d", n)
	}
	probs := wantProblems(t, saveSchedules(admin, f.budget, nil, *l.ScheduleId))
	if probs[*l.ScheduleId].Code != "loan_schedule" {
		t.Fatalf("deleting the loan's schedule: %+v", probs)
	}
	occ := upcoming(t, admin, f.budget, "2027-01-31")
	if len(occ) != 2 || occ[0].Occurrence.String() != "2026-12-10" || occ[1].Date.String() != "2027-01-11" ||
		occ[0].Amount != -5059 || occ[0].AccountId != f.bank.Id || occ[0].Entries == nil || len(*occ[0].Entries) != 3 {
		t.Fatalf("upcoming: %+v", occ)
	}

	// December's targets ask the 23rd payment's principal and interest in
	// their envelopes, and its schedule holds them until it posts (ADR-097);
	// November asks nothing (its payment came before the loan was set up).
	p23 := periodOf(t, l, 23)
	month := func(m string) api.BudgetMonth {
		t.Helper()
		rec := admin.do(http.MethodGet, budgetPath(f.budget, "/months/"+m), nil)
		wantStatus(t, rec, http.StatusOK)
		var out api.BudgetMonth
		decode(t, rec, &out)
		return out
	}
	loanShare := func(m api.BudgetMonth, env uuid.UUID) int64 {
		for _, tg := range m.Targets {
			for _, sc := range tg.Schedules {
				if tg.CategoryId == env && sc.LoanAccountId != nil && *sc.LoanAccountId == house.Id {
					return sc.Amount
				}
			}
		}
		return 0
	}
	held := func(m api.BudgetMonth, env uuid.UUID) int64 {
		for _, sp := range m.SpokenFor {
			if sp.CategoryId == env {
				return sp.Schedules
			}
		}
		return 0
	}
	dec := month("2026-12")
	if loanShare(dec, f.principal.Id) != p23.Principal || loanShare(dec, interestCat.Id) != p23.Interest {
		t.Fatalf("December targets: principal %d, interest %d; want %+v", loanShare(dec, f.principal.Id), loanShare(dec, interestCat.Id), p23)
	}
	if held(dec, f.principal.Id) != p23.Principal || held(dec, interestCat.Id) != p23.Interest {
		t.Fatalf("December holds %d / %d", held(dec, f.principal.Id), held(dec, interestCat.Id))
	}
	if nov := month("2026-11"); loanShare(nov, f.principal.Id) != 0 || held(nov, interestCat.Id) != 0 {
		t.Fatalf("November asks %d, holds %d", loanShare(nov, f.principal.Id), held(nov, interestCat.Id))
	}

	// 12/10: the job posts the 23rd payment, split into principal and
	// interest; the loan owes its principal less.
	setClock(time.Date(2026, 12, 10, 9, 0, 0, 0, time.UTC))
	if n := run(); n != 1 {
		t.Fatalf("posted %d on 12/10", n)
	}
	if n := run(); n != 0 {
		t.Fatalf("posted again: %d", n)
	}
	l = getLoan(t, admin, f.budget, house)
	p23 = periodOf(t, l, 23)
	if p23.State != api.LoanPeriodStatePosted || l.PrincipalLeft != owed-p23.Principal {
		t.Fatalf("after posting: %+v, left %d", p23, l.PrincipalLeft)
	}
	// Posted, it still counts in December's target but holds nothing.
	if dec = month("2026-12"); loanShare(dec, f.principal.Id) != p23.Principal || held(dec, f.principal.Id) != 0 {
		t.Fatalf("December after posting: asks %d, holds %d", loanShare(dec, f.principal.Id), held(dec, f.principal.Id))
	}
	var memo string
	var interest int64
	err := hs.pool.QueryRow(ctx, `select e.memo, -e.amount from entries e join transactions t on t.id = e.transaction_id
		where t.schedule_id = $1 and e.category_id = $2`, *l.ScheduleId, interestCat.Id).Scan(&memo, &interest)
	if err != nil || memo != "利息" || interest != p23.Interest {
		t.Fatalf("interest entry: %q %d %v, want %d", memo, interest, err, p23.Interest)
	}

	// 12/20: an extra 100,000 paid on 12/15 counts from the 25th payment
	// on, which stays 5,059 and ends the loan earlier.
	setClock(time.Date(2026, 12, 20, 9, 0, 0, 0, time.UTC))
	extra := api.TransactionInput{
		Id: uuid.New(), Date: ymd(2026, 12, 15), Payee: "",
		Entries: []api.EntryInput{entry(f.bank.Id, &f.principal.Id, -100_000), entry(house.Id, nil, 100_000)},
	}
	wantStatus(t, save(admin, f.budget, []api.TransactionInput{extra}), http.StatusOK)
	l = getLoan(t, admin, f.budget, house)
	if p := periodOf(t, l, 25); p.Principal+p.Interest != 5059 || p.Interest >= periodOf(t, l, 24).Interest {
		t.Fatalf("25th after the extra: %+v", p)
	}
	if l.PayoffDate == nil || !l.PayoffDate.Before(time.Date(2045, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("payoff after the extra = %v", l.PayoffDate)
	}

	// Aligning with the bank posts the difference on the loan alone.
	pool := summary(t, admin, f.budget).Pool
	left := l.PrincipalLeft
	align := func(principal int64) api.LoanAligned {
		t.Helper()
		rec := admin.do(http.MethodPost, budgetPath(f.budget, loanPath+"/align"), api.LoanAlign{Date: ymd(2026, 12, 20), PrincipalLeft: principal})
		wantStatus(t, rec, http.StatusOK)
		var out api.LoanAligned
		decode(t, rec, &out)
		return out
	}
	if got := align(left - 7); got.Adjustment != 7 || got.TransactionId == nil {
		t.Fatalf("align: %+v", got)
	}
	if got := align(left - 7); got.Adjustment != 0 || got.TransactionId != nil {
		t.Fatalf("aligning again: %+v", got)
	}
	if s := summary(t, admin, f.budget); s.Pool != pool {
		t.Fatalf("pool %d after aligning, was %d", s.Pool, pool)
	}
	if l = getLoan(t, admin, f.budget, house); l.PrincipalLeft != left-7 {
		t.Fatalf("left after aligning = %d, want %d", l.PrincipalLeft, left-7)
	}

	// :post on the next occurrence posts its period now; twice is refused.
	post := func() int {
		rec := admin.do(http.MethodPost, budgetPath(f.budget, "/schedules/"+l.ScheduleId.String()+"/post"), api.OccurrenceRef{Occurrence: ymd(2027, 1, 10)})
		return rec.Code
	}
	if code := post(); code != http.StatusOK {
		t.Fatalf(":post = %d", code)
	}
	if code := post(); code != http.StatusConflict {
		t.Fatalf(":post again = %d", code)
	}
	if p := periodOf(t, getLoan(t, admin, f.budget, house), 24); p.State != api.LoanPeriodStatePosted {
		t.Fatalf("24th after :post: %+v", p)
	}

	// Setting terms again keeps the day it was set up, and a car loan that
	// already has an opening balance gets none: its check shows both sides.
	rec = admin.do(http.MethodPut, budgetPath(f.budget, loanPath), terms)
	wantStatus(t, rec, http.StatusOK)
	decode(t, rec, &l)
	if l.TrackedFrom.String() != "2026-12-10" {
		t.Fatalf("tracked from after saving again: %v", l.TrackedFrom)
	}
	car := terms
	car.Principal, car.TermMonths = 800_000, 60
	car.PayFromAccountId, car.PrincipalCategoryId, car.InterestCategoryId = nil, nil, nil
	rec = admin.do(http.MethodPut, budgetPath(f.budget, "/accounts/"+f.loan.Id.String()+"/loan"), car)
	wantStatus(t, rec, http.StatusOK)
	var carLoan api.LoanDetails
	decode(t, rec, &carLoan)
	if carLoan.Check.Recorded != 600_000 || carLoan.Check.Computed == 600_000 || carLoan.ScheduleId != nil {
		t.Fatalf("car loan: check %+v, schedule %v", carLoan.Check, carLoan.ScheduleId)
	}

	// Removing the terms removes the schedule; what it posted stays.
	rec = admin.do(http.MethodDelete, budgetPath(f.budget, loanPath), nil)
	wantStatus(t, rec, http.StatusNoContent)
	var schedules, posted int
	if err := hs.pool.QueryRow(ctx, `select count(*) from schedules where loan_account_id = $1`, house.Id).Scan(&schedules); err != nil {
		t.Fatal(err)
	}
	if err := hs.pool.QueryRow(ctx, `select count(*) from transactions where note like '第 %'`).Scan(&posted); err != nil {
		t.Fatal(err)
	}
	if schedules != 0 || posted != 2 {
		t.Fatalf("after removing: %d schedules, %d payments", schedules, posted)
	}

	// A loan account can be created with its terms (ADR-100): one request,
	// its opening balance from the terms; terms on another kind, or bad
	// terms, create nothing. Back on 11/20, as when the first was set up.
	setClock(testToday)
	before := len(listAccounts(t, admin, f.budget))
	withTerms := accountInput("車貸二", api.Loan, false, -123)
	withTerms.Loan = &terms
	rec = admin.do(http.MethodPost, budgetPath(f.budget, "/accounts"), withTerms)
	wantStatus(t, rec, http.StatusCreated)
	var created api.Account
	decode(t, rec, &created)
	got := getLoan(t, admin, f.budget, created)
	if created.Balance != -owed || got.PrincipalLeft != owed || got.ScheduleId == nil || got.TrackedFrom.String() != "2026-12-10" {
		t.Fatalf("created with terms: balance %d, left %d, tracked from %v, schedule %v", created.Balance, got.PrincipalLeft, got.TrackedFrom, got.ScheduleId)
	}
	onBank := accountInput("活存", api.Bank, true, 0)
	onBank.Loan = &terms
	rec = admin.do(http.MethodPost, budgetPath(f.budget, "/accounts"), onBank)
	if e := decodeError(t, rec); e.Code != "not_a_loan" {
		t.Fatalf("terms on a bank account: %+v", e)
	}
	badTerms := terms
	badTerms.TermMonths = 0
	withBad := accountInput("車貸三", api.Loan, false, 0)
	withBad.Loan = &badTerms
	rec = admin.do(http.MethodPost, budgetPath(f.budget, "/accounts"), withBad)
	wantStatus(t, rec, http.StatusBadRequest)
	if n := len(listAccounts(t, admin, f.budget)); n != before+1 {
		t.Fatalf("accounts = %d, want %d", n, before+1)
	}
}
