package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"factual/apps/api/internal/api"
)

// Integration tests of schedules (M9, ADR-084..087). The ledger's today is
// testToday, 2026-11-20 (a Friday).

func date(y int, m time.Month, d int) openapi_types.Date {
	return openapi_types.Date{Time: time.Date(y, m, d, 0, 0, 0, 0, time.UTC)}
}

func monthly(id uuid.UUID, account uuid.UUID, category *uuid.UUID, dayOfMonth string, start openapi_types.Date, amount int64) api.ScheduleInput {
	return api.ScheduleInput{
		Id: id, Source: "每月 " + dayOfMonth + " 日", Rule: "FREQ=MONTHLY;BYMONTHDAY=" + dayOfMonth, Start: start,
		HolidayShift: api.NoShift, Payee: "訂閱", AccountId: account, CategoryId: category, Amount: amount,
		BudgetMode: api.Full,
	}
}

func saveSchedules(b *browser, budget api.Budget, upserts []api.ScheduleInput, deletes ...uuid.UUID) *httptest.ResponseRecorder {
	if upserts == nil {
		upserts = []api.ScheduleInput{}
	}
	if deletes == nil {
		deletes = []uuid.UUID{}
	}
	return b.do(http.MethodPost, budgetPath(budget, "/schedules/batch"), api.ScheduleBatch{Upserts: upserts, Deletes: deletes})
}

func mustSaveSchedules(t *testing.T, b *browser, budget api.Budget, upserts ...api.ScheduleInput) api.ScheduleBatchSaved {
	t.Helper()
	rec := saveSchedules(b, budget, upserts)
	wantStatus(t, rec, http.StatusOK)
	var out api.ScheduleBatchSaved
	decode(t, rec, &out)
	return out
}

func listSchedules(t *testing.T, b *browser, budget api.Budget) map[uuid.UUID]api.Schedule {
	t.Helper()
	rec := b.do(http.MethodGet, budgetPath(budget, "/schedules"), nil)
	wantStatus(t, rec, http.StatusOK)
	var out []api.Schedule
	decode(t, rec, &out)
	byID := map[uuid.UUID]api.Schedule{}
	for _, s := range out {
		byID[s.Id] = s
	}
	return byID
}

func upcoming(t *testing.T, b *browser, budget api.Budget, until string) []api.Occurrence {
	t.Helper()
	rec := b.do(http.MethodGet, budgetPath(budget, "/schedules/upcoming?until="+until), nil)
	wantStatus(t, rec, http.StatusOK)
	var out []api.Occurrence
	decode(t, rec, &out)
	return out
}

func wantNext(t *testing.T, s api.Schedule, occurrence, posted string) {
	t.Helper()
	if s.NextOccurrence == nil || s.NextOccurrence.String() != occurrence || s.NextDate.String() != posted {
		t.Fatalf("next = %v / %v, want %s / %s", s.NextOccurrence, s.NextDate, occurrence, posted)
	}
}

func dates(occ []api.Occurrence) []string {
	out := []string{}
	for _, o := range occ {
		out = append(out, o.Occurrence.String()+">"+o.Date.String())
	}
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestSchedulesPostSkipAndUpcoming(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin)

	// Every 5th, moved to the next working day; started before today, so
	// November's occurrence is posted when it is saved.
	id := uuid.New()
	sc := monthly(id, f.card.Id, &f.food.Id, "5", date(2026, 11, 5), -500)
	sc.HolidayShift = api.NextWorkday
	if got := mustSaveSchedules(t, admin, f.budget, sc); got.Posted != 1 {
		t.Fatalf("posted = %d, want November's", got.Posted)
	}
	txs := register(t, admin, f.budget, f.card)
	if len(txs) != 1 || txs[0].Date.String() != "2026-11-05" || txs[0].Entries[0].Amount != -500 || txs[0].NeedsReview {
		t.Fatalf("card register = %+v", txs)
	}
	wantNext(t, listSchedules(t, admin, f.budget)[id], "2026-12-05", "2026-12-07") // a Saturday

	if got := dates(upcoming(t, admin, f.budget, "2027-01-10")); !equal(got, []string{"2026-12-05>2026-12-07", "2027-01-05>2027-01-05"}) {
		t.Fatalf("upcoming = %v", got)
	}

	// Skipping December moves the next one to January; bringing it back
	// undoes that.
	skip := admin.do(http.MethodPost, budgetPath(f.budget, "/schedules/"+id.String()+"/skips"), api.OccurrenceRef{Occurrence: date(2026, 12, 5)})
	wantStatus(t, skip, http.StatusNoContent)
	if got := dates(upcoming(t, admin, f.budget, "2027-01-10")); !equal(got, []string{"2027-01-05>2027-01-05"}) {
		t.Fatalf("upcoming after skip = %v", got)
	}
	s := listSchedules(t, admin, f.budget)[id]
	wantNext(t, s, "2027-01-05", "2027-01-05")
	if len(s.Skips) != 1 || s.Skips[0].String() != "2026-12-05" {
		t.Fatalf("skips = %v", s.Skips)
	}
	wantStatus(t, admin.do(http.MethodDelete, budgetPath(f.budget, "/schedules/"+id.String()+"/skips/2026-12-05"), nil), http.StatusNoContent)
	wantNext(t, listSchedules(t, admin, f.budget)[id], "2026-12-05", "2026-12-07")
	wantStatus(t, admin.do(http.MethodDelete, budgetPath(f.budget, "/schedules/"+id.String()+"/skips/2026-12-05"), nil), http.StatusNotFound)
	wantError(t, admin.do(http.MethodPost, budgetPath(f.budget, "/schedules/"+id.String()+"/skips"), api.OccurrenceRef{Occurrence: date(2026, 12, 6)}),
		http.StatusBadRequest, "not_an_occurrence")
	wantError(t, admin.do(http.MethodPost, budgetPath(f.budget, "/schedules/"+id.String()+"/skips"), api.OccurrenceRef{Occurrence: date(2026, 11, 5)}),
		http.StatusConflict, "already_posted")

	// Posting December now, as it is; it cannot be posted twice.
	post := admin.do(http.MethodPost, budgetPath(f.budget, "/schedules/"+id.String()+"/post"), api.OccurrenceRef{Occurrence: date(2026, 12, 5)})
	wantStatus(t, post, http.StatusOK)
	wantError(t, admin.do(http.MethodPost, budgetPath(f.budget, "/schedules/"+id.String()+"/post"), api.OccurrenceRef{Occurrence: date(2026, 12, 5)}),
		http.StatusConflict, "already_posted")
	wantNext(t, listSchedules(t, admin, f.budget)[id], "2027-01-05", "2027-01-05")

	// Editing the schedule changes what is not posted yet and posts nothing again.
	sc.Amount = -600
	if got := mustSaveSchedules(t, admin, f.budget, sc); got.Posted != 0 {
		t.Fatalf("posted again = %d", got.Posted)
	}
	if got := upcoming(t, admin, f.budget, "2027-01-10"); len(got) != 1 || got[0].Amount != -600 || got[0].CategoryId == nil || *got[0].CategoryId != f.food.Id {
		t.Fatalf("upcoming after edit = %+v", got)
	}
	if n := len(register(t, admin, f.budget, f.card)); n != 2 {
		t.Fatalf("card register has %d transactions, want 2", n)
	}

	// An edited 預定 row posts its occurrence with the change.
	feb := uuid.New()
	rec := save(admin, f.budget, []api.TransactionInput{{
		Id: feb, Date: date(2027, 2, 4), Payee: "訂閱", Entries: []api.EntryInput{entry(f.card.Id, &f.food.Id, -650)},
		Occurrence: &api.ScheduledOccurrence{ScheduleId: id, Occurrence: date(2027, 2, 5)},
	}})
	wantStatus(t, rec, http.StatusOK)
	if got := dates(upcoming(t, admin, f.budget, "2027-03-10")); !equal(got, []string{"2027-01-05>2027-01-05", "2027-03-05>2027-03-05"}) {
		t.Fatalf("upcoming after posting February = %v", got)
	}
	again := uuid.New()
	probs := wantProblems(t, save(admin, f.budget, []api.TransactionInput{{
		Id: again, Date: date(2027, 2, 5), Entries: []api.EntryInput{entry(f.card.Id, &f.food.Id, -600)},
		Occurrence: &api.ScheduledOccurrence{ScheduleId: id, Occurrence: date(2027, 2, 5)},
	}}))
	if probs[again].Code != "already_posted" {
		t.Fatalf("posting February twice: %+v", probs)
	}
	probs = wantProblems(t, save(admin, f.budget, []api.TransactionInput{{
		Id: again, Date: date(2027, 2, 6), Entries: []api.EntryInput{entry(f.card.Id, &f.food.Id, -600)},
		Occurrence: &api.ScheduledOccurrence{ScheduleId: id, Occurrence: date(2027, 2, 6)},
	}}))
	if probs[again].Code != "not_an_occurrence" {
		t.Fatalf("a date the rule does not give: %+v", probs)
	}

	// The job posts what has come due by then, and only once.
	hs.ledger.SetClock(func() time.Time { return time.Date(2027, 1, 6, 9, 0, 0, 0, time.UTC) })
	defer hs.ledger.SetClock(func() time.Time { return testToday })
	for want := 1; want >= 0; want-- {
		n, err := hs.ledger.PostAllDue(context.Background())
		if err != nil || n != want {
			t.Fatalf("PostAllDue = %d, %v; want %d", n, err, want)
		}
	}
	wantNext(t, listSchedules(t, admin, f.budget)[id], "2027-03-05", "2027-03-05")

	// Deleting the schedule keeps what it posted.
	wantStatus(t, saveSchedules(admin, f.budget, nil, id), http.StatusOK)
	if n := len(register(t, admin, f.budget, f.card)); n != 4 {
		t.Fatalf("card register has %d transactions after deleting the schedule, want 4", n)
	}
}

func TestScheduleValidationAndEstimates(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin)

	bad := monthly(uuid.New(), f.card.Id, &f.food.Id, "5", day(5), -100)
	bad.Rule = "FREQ=HOURLY"
	zero := monthly(uuid.New(), f.card.Id, &f.food.Id, "5", day(5), 0)
	self := monthly(uuid.New(), f.bank.Id, nil, "5", day(5), -100)
	self.TransferAccountId = &f.bank.Id
	uncategorized := monthly(uuid.New(), f.card.Id, nil, "5", day(5), -100)
	probs := wantProblems(t, saveSchedules(admin, f.budget, []api.ScheduleInput{bad, zero, self, uncategorized}))
	for id, code := range map[uuid.UUID]string{bad.Id: "invalid_rule", zero.Id: "amount_required", self.Id: "same_account", uncategorized.Id: "category_required"} {
		if probs[id].Code != code {
			t.Errorf("%s: %+v, want %s", id, probs[id], code)
		}
	}

	// A transfer to a tracking account (a loan payment) and an estimated
	// bill: the posted transaction waits for review.
	loan := monthly(uuid.New(), f.bank.Id, &f.principal.Id, "10", day(10), -8000)
	loan.TransferAccountId = &f.loan.Id
	bill := monthly(uuid.New(), f.bank.Id, &f.food.Id, "15", day(15), -1200)
	bill.Estimate = true
	bill.Paused = true
	if got := mustSaveSchedules(t, admin, f.budget, loan, bill); got.Posted != 1 {
		t.Fatalf("posted = %d, want the loan payment only (the bill is paused)", got.Posted)
	}
	bill.Paused = false
	if got := mustSaveSchedules(t, admin, f.budget, bill); got.Posted != 1 {
		t.Fatalf("posted = %d after resuming the bill", got.Posted)
	}
	var review, loanTx int
	for _, tx := range register(t, admin, f.budget, f.bank) {
		if tx.NeedsReview {
			review++
		}
		if len(tx.Entries) == 2 {
			loanTx++
		}
	}
	if review != 1 || loanTx != 1 {
		t.Fatalf("review = %d, loan payments = %d", review, loanTx)
	}
	s := listSchedules(t, admin, f.budget)[loan.Id]
	if s.AccountId != f.bank.Id || s.TransferAccountId == nil || *s.TransferAccountId != f.loan.Id || s.Amount != -8000 {
		t.Fatalf("loan schedule reads back as %+v", s)
	}

	// Viewers cannot save schedules.
	hs.addUser("viewer", "viewer-password")
	viewer := hs.browser().mustLogin("viewer", "viewer-password")
	if _, err := hs.pool.Exec(context.Background(),
		`insert into budget_members (budget_id, user_id, role) select $1, id, 'viewer' from users where username = 'viewer'`, f.budget.Id); err != nil {
		t.Fatal(err)
	}
	wantStatus(t, saveSchedules(viewer, f.budget, []api.ScheduleInput{bill}), http.StatusForbidden)
	wantStatus(t, viewer.do(http.MethodGet, budgetPath(f.budget, "/schedules"), nil), http.StatusOK)
}

func targetsOf(t *testing.T, b *browser, budget api.Budget, month string) map[uuid.UUID]api.EnvelopeTarget {
	t.Helper()
	m, _ := budgetMonth(t, b, budget, month)
	out := map[uuid.UUID]api.EnvelopeTarget{}
	for _, x := range m.Targets {
		out[x.CategoryId] = x
	}
	return out
}

func TestBudgetTargets(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin)
	mk := func(parent *uuid.UUID, name string, pooled bool) api.Category {
		t.Helper()
		rec := admin.do(http.MethodPost, budgetPath(f.budget, "/categories"),
			api.CategoryCreate{ParentId: parent, Name: name, Kind: api.Expense, Pooled: &pooled})
		wantStatus(t, rec, http.StatusCreated)
		var c api.Category
		decode(t, rec, &c)
		return c
	}
	transport := mk(nil, "交通", true)
	fuel := mk(&transport.Id, "加油", true)
	insurance := mk(nil, "保險", true)

	base := func(c api.Category, amount int64) *httptest.ResponseRecorder {
		return admin.do(http.MethodPut, budgetPath(f.budget, "/categories/"+c.Id.String()+"/base"), api.CategoryBase{Amount: amount})
	}
	wantStatus(t, base(f.food, 3000), http.StatusNoContent)
	wantError(t, base(fuel, 100), http.StatusBadRequest, "not_an_envelope")
	for _, c := range listCategories(t, admin, f.budget) {
		if c.Id == f.food.Id && (c.BudgetBase == nil || *c.BudgetBase != 3000) {
			t.Fatalf("food budgetBase = %v", c.BudgetBase)
		}
	}

	netflix := monthly(uuid.New(), f.card.Id, &f.food.Id, "15", date(2026, 12, 15), -390)
	spotify := monthly(uuid.New(), f.card.Id, &f.food.Id, "20", date(2026, 12, 20), -149)
	gas := monthly(uuid.New(), f.bank.Id, &fuel.Id, "1", date(2026, 12, 1), -1000)
	gym := monthly(uuid.New(), f.card.Id, &f.food.Id, "1", date(2026, 12, 1), -999)
	gym.BudgetMode = api.NotBudgeted
	paused := monthly(uuid.New(), f.card.Id, &f.food.Id, "2", date(2026, 12, 2), -777)
	paused.Paused = true
	yearly := api.ScheduleInput{
		Id: uuid.New(), Source: "每年 3/15", Rule: "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15", Start: date(2027, 3, 15),
		HolidayShift: api.NoShift, Payee: "保費", AccountId: f.bank.Id, CategoryId: &insurance.Id, Amount: -1200,
		BudgetMode: api.Spread,
	}
	mustSaveSchedules(t, admin, f.budget, netflix, spotify, gas, gym, paused, yearly)

	// 100 + (50 + 80) in the example; here 3000 + (390 + 149).
	got := targetsOf(t, admin, f.budget, "2026-12")
	food := got[f.food.Id]
	if food.Total != 3539 || food.Base == nil || *food.Base != 3000 || len(food.Schedules) != 2 {
		t.Fatalf("food target = %+v", food)
	}
	// A subcategory's schedule counts for its pooled parent's envelope.
	if got[transport.Id].Total != 1000 {
		t.Fatalf("transport target = %+v", got[transport.Id])
	}
	if _, ok := got[fuel.Id]; ok {
		t.Fatal("the subcategory has no target of its own")
	}
	// Before the schedules start, only the base.
	if got := targetsOf(t, admin, f.budget, "2026-11")[f.food.Id]; got.Total != 3000 || len(got.Schedules) != 0 {
		t.Fatalf("November food target = %+v", got)
	}
	// A yearly bill spread over the twelve months before it.
	for _, m := range []string{"2027-06", "2028-03"} {
		if got := targetsOf(t, admin, f.budget, m)[insurance.Id]; got.Total != 100 {
			t.Fatalf("%s insurance target = %+v, want 100", m, got)
		}
	}
	// Removing the base leaves the schedules.
	wantStatus(t, base(f.food, 0), http.StatusNoContent)
	if got := targetsOf(t, admin, f.budget, "2026-12")[f.food.Id]; got.Base != nil || got.Total != 539 {
		t.Fatalf("food target without base = %+v", got)
	}
}

func TestHolidayCalendar(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	raw, err := os.ReadFile("../domain/calendar/testdata/116_utf8bom.csv")
	if err != nil {
		t.Fatal(err)
	}
	csv := string(raw)

	hs.addUser("member", "member-password")
	member := hs.browser().mustLogin("member", "member-password")
	wantStatus(t, member.do(http.MethodPost, "/api/holidays/import", api.HolidayImport{Csv: &csv}), http.StatusForbidden)

	rec := admin.do(http.MethodPost, "/api/holidays/import", api.HolidayImport{Csv: &csv})
	wantStatus(t, rec, http.StatusOK)
	var years []api.HolidayYear
	decode(t, rec, &years)
	if len(years) != 1 || years[0].Year != 2027 || years[0].Days != 365 || years[0].DaysOff != 121 || years[0].SourceUrl != "" {
		t.Fatalf("imported = %+v", years)
	}

	rec = member.do(http.MethodGet, "/api/holidays?from=2026&to=2027", nil)
	wantStatus(t, rec, http.StatusOK)
	var cal api.HolidayCalendar
	decode(t, rec, &cal)
	byDate := map[string]api.Holiday{}
	for _, d := range cal.Days {
		byDate[d.Date.String()] = d
	}
	if len(cal.Years) != 1 || cal.Years[0] != 2027 || !byDate["2027-02-09"].Off || byDate["2027-01-01"].Note != "開國紀念日" {
		t.Fatalf("calendar = %v, 02-09 %+v, 01-01 %+v", cal.Years, byDate["2027-02-09"], byDate["2027-01-01"])
	}
	if _, ok := byDate["2027-01-02"]; ok {
		t.Fatal("an ordinary Saturday is not listed")
	}

	// Schedules move off the imported days off: 2/9 and 2/10 are 補假.
	f := newLedgerFixture(t, admin)
	sc := monthly(uuid.New(), f.bank.Id, &f.food.Id, "9", date(2027, 2, 9), -100)
	sc.HolidayShift = api.NextWorkday
	mustSaveSchedules(t, admin, f.budget, sc)
	if got := dates(upcoming(t, admin, f.budget, "2027-02-28")); !equal(got, []string{"2027-02-09>2027-02-11"}) {
		t.Fatalf("upcoming = %v", got)
	}

	// From a URL, kept with the year.
	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(raw) }))
	defer files.Close()
	url := files.URL + "/116.csv"
	rec = admin.do(http.MethodPost, "/api/holidays/import", api.HolidayImport{Url: &url})
	wantStatus(t, rec, http.StatusOK)
	decode(t, rec, &years)
	if years[0].SourceUrl != url {
		t.Fatalf("sourceUrl = %q", years[0].SourceUrl)
	}
	bad := "20270101,五,7,\n"
	wantError(t, admin.do(http.MethodPost, "/api/holidays/import", api.HolidayImport{Csv: &bad}), http.StatusBadRequest, "invalid_calendar")
	ftp := "ftp://example.com/x.csv"
	wantError(t, admin.do(http.MethodPost, "/api/holidays/import", api.HolidayImport{Url: &ftp}), http.StatusBadRequest, "invalid_url")
	wantError(t, admin.do(http.MethodPost, "/api/holidays/import", api.HolidayImport{}), http.StatusBadRequest, "invalid_import")

	wantStatus(t, admin.do(http.MethodDelete, "/api/holidays/years/2027", nil), http.StatusNoContent)
	wantStatus(t, admin.do(http.MethodDelete, "/api/holidays/years/2027", nil), http.StatusNotFound)
	if got := dates(upcoming(t, admin, f.budget, "2027-02-28")); !equal(got, []string{"2027-02-09>2027-02-09"}) {
		t.Fatalf("upcoming without the calendar = %v", got)
	}
}
