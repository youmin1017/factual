package server

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"factual/apps/api/internal/api"
)

// Integration tests of savings goals (M10, ADR-092..094). The ledger's
// today is testToday, 2026-11-20.

func saveGoals(t *testing.T, b *browser, budget api.Budget, upserts []api.GoalInput, deletes ...uuid.UUID) (int, api.GoalBatchSaved, map[uuid.UUID]api.BatchProblem) {
	if upserts == nil {
		upserts = []api.GoalInput{}
	}
	if deletes == nil {
		deletes = []uuid.UUID{}
	}
	rec := b.do(http.MethodPost, budgetPath(budget, "/goals/batch"), api.GoalBatch{Upserts: upserts, Deletes: deletes})
	var saved api.GoalBatchSaved
	var probs map[uuid.UUID]api.BatchProblem
	switch rec.Code {
	case http.StatusOK:
		decode(t, rec, &saved)
	case http.StatusUnprocessableEntity:
		var errs api.BatchErrors
		decode(t, rec, &errs)
		probs = map[uuid.UUID]api.BatchProblem{}
		for _, p := range errs.Errors {
			probs[p.Id] = p
		}
	}
	return rec.Code, saved, probs
}

func listGoals(t *testing.T, b *browser, budget api.Budget) (api.GoalList, map[uuid.UUID]api.Goal) {
	t.Helper()
	rec := b.do(http.MethodGet, budgetPath(budget, "/goals"), nil)
	wantStatus(t, rec, http.StatusOK)
	var out api.GoalList
	decode(t, rec, &out)
	byID := map[uuid.UUID]api.Goal{}
	for _, g := range out.Goals {
		byID[g.Id] = g
	}
	return out, byID
}

func monthTargetsOf(t *testing.T, b *browser, budget api.Budget, month string) map[uuid.UUID]api.EnvelopeTarget {
	t.Helper()
	m, _ := budgetMonth(t, b, budget, month)
	out := map[uuid.UUID]api.EnvelopeTarget{}
	for _, tg := range m.Targets {
		out[tg.CategoryId] = tg
	}
	return out
}

func ptr[T any](v T) *T { return &v }

func TestGoals(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin) // the bank opens with 50,000 on 11/1
	mk := func(parent *uuid.UUID, name string, kind api.CategoryKind) api.Category {
		t.Helper()
		rec := createCategory(t, admin, f.budget, parent, name, kind)
		wantStatus(t, rec, http.StatusCreated)
		var c api.Category
		decode(t, rec, &c)
		return c
	}
	hobby := mk(nil, "興趣", api.Expense) // shares its budget with its subcategories (ADR-061)
	badminton := mk(&hobby.Id, "羽球", api.Expense)
	salary := mk(nil, "薪資", api.Income)

	october := func(d int) openapi_types.Date { return date(2026, time.October, d) }
	wantStatus(t, save(admin, f.budget, []api.TransactionInput{
		{Id: uuid.New(), Date: october(20), Entries: []api.EntryInput{entry(f.bank.Id, &f.food.Id, -1500)}},
		{Id: uuid.New(), Date: october(25), Entries: []api.EntryInput{entry(f.bank.Id, &salary.Id, 40000)}},
		{Id: uuid.New(), Date: day(3), Entries: []api.EntryInput{entry(f.card.Id, &f.food.Id, -1200)}},
	}), http.StatusOK)
	if code := allocate(admin, f.budget, "2026-11", map[uuid.UUID]int64{hobby.Id: 5000, f.food.Id: 3000}); code != http.StatusNoContent {
		t.Fatalf("allocate = %d", code)
	}
	wantStatus(t, admin.do(http.MethodPut, budgetPath(f.budget, "/categories/"+f.food.Id.String()+"/base"),
		api.CategoryBase{Amount: 2000}), http.StatusNoContent)

	racket := api.GoalInput{
		Id: uuid.New(), CategoryId: badminton.Id, Name: "羽球拍", Kind: api.Target, TargetAmount: ptr[int64](3500),
		Url: "https://example.com/racket", WaitUntil: ptr(date(2026, time.December, 1)), SortOrder: 0,
	}
	phones := api.GoalInput{
		Id: uuid.New(), CategoryId: hobby.Id, Name: "耳機", Kind: api.Target, TargetAmount: ptr[int64](4000),
		MonthlyAmount: ptr[int64](800), TargetDate: ptr(date(2027, time.March, 1)), SortOrder: 1,
	}
	trip := api.GoalInput{
		Id: uuid.New(), CategoryId: f.food.Id, Name: "日本旅遊", Kind: api.TargetByDate, TargetAmount: ptr[int64](30000),
		TargetDate: ptr(date(2027, time.January, 31)), SortOrder: 2,
	}
	fund := api.GoalInput{
		Id: uuid.New(), CategoryId: f.food.Id, Name: "備用金", Kind: api.Maintain, MaintainMonths: ptr[int32](3), SortOrder: 3,
	}

	// Problems are reported per goal, and nothing is saved.
	noName := api.GoalInput{Id: uuid.New(), CategoryId: hobby.Id, Name: " ", Kind: api.Monthly, MonthlyAmount: ptr[int64](1)}
	noDate := api.GoalInput{Id: uuid.New(), CategoryId: hobby.Id, Name: "x", Kind: api.TargetByDate, TargetAmount: ptr[int64](1)}
	income := api.GoalInput{Id: uuid.New(), CategoryId: salary.Id, Name: "x", Kind: api.Monthly, MonthlyAmount: ptr[int64](1)}
	noAmount := api.GoalInput{Id: uuid.New(), CategoryId: hobby.Id, Name: "x", Kind: api.Monthly}
	noMonths := api.GoalInput{Id: uuid.New(), CategoryId: hobby.Id, Name: "x", Kind: api.Maintain, MaintainMonths: ptr[int32](0)}
	code, _, probs := saveGoals(t, admin, f.budget, []api.GoalInput{racket, noName, noDate, income, noAmount, noMonths})
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid batch = %d", code)
	}
	for id, want := range map[uuid.UUID]string{
		noName.Id: "name_required", noDate.Id: "date_required", income.Id: "not_an_envelope",
		noAmount.Id: "amount_required", noMonths.Id: "months_required",
	} {
		if probs[id].Code != want {
			t.Errorf("problem of %v = %+v, want %s", id, probs[id], want)
		}
	}
	if _, ok := probs[racket.Id]; ok {
		t.Errorf("racket has a problem: %+v", probs[racket.Id])
	}
	if list, _ := listGoals(t, admin, f.budget); len(list.Goals) != 0 {
		t.Fatalf("an invalid batch saved %d goals", len(list.Goals))
	}

	code, saved, _ := saveGoals(t, admin, f.budget, []api.GoalInput{racket, phones, trip, fund})
	if code != http.StatusOK || saved.Upserted != 4 {
		t.Fatalf("save = %d %+v", code, saved)
	}
	list, goals := listGoals(t, admin, f.budget)
	// October's spending and income are the only complete month with any.
	if list.Month != "2026-11" || list.AverageSpending != 1500 || list.TypicalIncome != 40000 || list.BaseTargets != 2000 {
		t.Fatalf("list = %+v", list)
	}
	for i, id := range []uuid.UUID{racket.Id, phones.Id, trip.Id, fund.Id} {
		if list.Goals[i].Id != id {
			t.Fatalf("goal %d is %s, want priority order", i, list.Goals[i].Name)
		}
	}
	// 興趣 holds 5,000: the racket (on a subcategory) is full but waits until
	// 12/1, the headphones get the rest. A target goal keeps no date.
	if g := goals[racket.Id]; g.Saved != 3500 || g.Status != api.GoalStatusWaiting || g.EnvelopeId == nil || *g.EnvelopeId != hobby.Id || g.Ask != 0 {
		t.Fatalf("racket = %+v", g)
	}
	if g := goals[phones.Id]; g.Saved != 1500 || g.Status != api.GoalStatusSaving || g.Ask != 800 || g.TargetDate != nil {
		t.Fatalf("phones = %+v", g)
	}
	// 飲食 holds -1,500 + 3,000 - 1,200 = 300, all the trip's; it asks for
	// what it needs over November to January from the -1,500 carried in.
	if g := goals[trip.Id]; g.Saved != 300 || g.Ask != 10000 || *g.Total != 30000 {
		t.Fatalf("trip = %+v", g)
	}
	// Three months of 1,500 average spending.
	if g := goals[fund.Id]; g.Saved != 0 || *g.Total != 4500 || g.Ask != 4500 {
		t.Fatalf("fund = %+v", g)
	}

	// The goals' asks join the envelopes' targets, in priority order.
	nov := monthTargetsOf(t, admin, f.budget, "2026-11")
	if tg := nov[hobby.Id]; tg.Total != 800 || len(tg.Goals) != 1 || tg.Goals[0].GoalId != phones.Id {
		t.Fatalf("hobby target = %+v", tg)
	}
	if tg := nov[f.food.Id]; tg.Total != 2000+10000+4500 || len(tg.Goals) != 2 || tg.Goals[0].GoalId != trip.Id {
		t.Fatalf("food target = %+v", tg)
	}
	// Goals made in November ask nothing before it.
	if tg, ok := monthTargetsOf(t, admin, f.budget, "2026-10")[hobby.Id]; ok {
		t.Fatalf("october hobby target = %+v", tg)
	}
	// December starts from what November leaves: 1,500 of the headphones'
	// 4,000 saved; the trip has 300 and two months to go; the level follows
	// October's and November's spending.
	dec := monthTargetsOf(t, admin, f.budget, "2026-12")
	if tg := dec[hobby.Id]; tg.Total != 800 {
		t.Fatalf("december hobby target = %+v", tg)
	}
	if tg := dec[f.food.Id]; tg.Total != 2000+14850+4050 {
		t.Fatalf("december food target = %+v", tg)
	}

	// Bought: the racket takes nothing any more, the headphones fill up.
	racket.Achieved = true
	if code, _, _ := saveGoals(t, admin, f.budget, []api.GoalInput{racket}); code != http.StatusOK {
		t.Fatalf("achieve = %d", code)
	}
	_, goals = listGoals(t, admin, f.budget)
	if g := goals[racket.Id]; g.Status != api.GoalStatusAchieved || g.Saved != 0 || g.AchievedAt == nil {
		t.Fatalf("achieved racket = %+v", g)
	}
	if g := goals[phones.Id]; g.Saved != 4000 || g.Status != api.GoalStatusFull {
		t.Fatalf("phones after the racket = %+v", g)
	}

	// Another budget's goals are not found; deleting removes one.
	other := createBudget(t, admin, "別的", true)
	if code, _, probs := saveGoals(t, admin, other, nil, phones.Id); code != http.StatusUnprocessableEntity || probs[phones.Id].Code != "not_found" {
		t.Fatalf("deleting another budget's goal = %d %+v", code, probs)
	}
	if code, _, probs := saveGoals(t, admin, other, []api.GoalInput{phones}); code != http.StatusUnprocessableEntity || probs[phones.Id].Code != "not_found" {
		t.Fatalf("saving another budget's goal = %d %+v", code, probs)
	}
	code, saved, _ = saveGoals(t, admin, f.budget, nil, phones.Id)
	if code != http.StatusOK || saved.Deleted != 1 {
		t.Fatalf("delete = %d %+v", code, saved)
	}
	if list, _ := listGoals(t, admin, f.budget); len(list.Goals) != 3 {
		t.Fatalf("after delete %d goals", len(list.Goals))
	}
}

// What schedules hold is not free, and goals share only the rest (ADR-095).
func TestSpokenFor(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin)
	rec := createCategory(t, admin, f.budget, nil, "保險", api.Expense)
	wantStatus(t, rec, http.StatusCreated)
	var insurance api.Category
	decode(t, rec, &insurance)

	// A yearly 1,200 on 3/15 spread over the year before it (this year's
	// is posted when saved), and 3,000 on the 25th budgeted in full.
	yearly := api.ScheduleInput{
		Id: uuid.New(), Source: "每年 3/15", Rule: "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15",
		Start: date(2026, time.March, 15), HolidayShift: api.NoShift, Payee: "保費", AccountId: f.bank.Id,
		CategoryId: &insurance.Id, Amount: -1200, BudgetMode: api.BudgetModeSpread,
	}
	mustSaveSchedules(t, admin, f.budget, yearly,
		monthly(uuid.New(), f.bank.Id, &insurance.Id, "25", date(2026, time.November, 25), -3000))
	if code := allocate(admin, f.budget, "2026-11", map[uuid.UUID]int64{insurance.Id: 6000}); code != http.StatusNoContent {
		t.Fatalf("allocate = %d", code)
	}
	cover := api.GoalInput{
		Id: uuid.New(), CategoryId: insurance.Id, Name: "醫療險升級", Kind: api.Target,
		TargetAmount: ptr[int64](2000), MonthlyAmount: ptr[int64](500),
	}
	if code, _, probs := saveGoals(t, admin, f.budget, []api.GoalInput{cover}); code != http.StatusOK {
		t.Fatalf("save goal = %d %+v", code, probs)
	}

	// 保險 ends November with -1,200 + 6,000 = 4,800. The schedules hold 800
	// (April to November of the yearly) and 3,000 (the 25th, not posted);
	// the goal saves 1,000 of the rest.
	nov, _ := budgetMonth(t, admin, f.budget, "2026-11")
	var held *api.SpokenFor
	for i := range nov.SpokenFor {
		if nov.SpokenFor[i].CategoryId == insurance.Id {
			held = &nov.SpokenFor[i]
		}
	}
	if held == nil || held.Schedules != 3800 || held.Goals != 1000 {
		t.Fatalf("spoken for = %+v", nov.SpokenFor)
	}
	// The target: 100 of the yearly, the 3,000 and the goal's 500.
	if tg := monthTargetsOf(t, admin, f.budget, "2026-11")[insurance.Id]; tg.Total != 100+3000+500 {
		t.Fatalf("target = %+v", tg)
	}
	list, goals := listGoals(t, admin, f.budget)
	if g := goals[cover.Id]; g.Saved != 1000 || g.Ask != 500 || g.Status != api.GoalStatusSaving {
		t.Fatalf("goal = %+v", g)
	}
	for _, e := range list.Envelopes {
		// What goals share: November's end less 3,800, and what came in
		// (-1,200) less the 700 held at October's end.
		if e.CategoryId == insurance.Id && (e.Balance != 1000 || e.Carried != -1900) {
			t.Fatalf("envelope = %+v", e)
		}
	}
	// October: the yearly holds 700; no goal yet.
	oct, _ := budgetMonth(t, admin, f.budget, "2026-10")
	if len(oct.SpokenFor) != 1 || oct.SpokenFor[0].Schedules != 700 || oct.SpokenFor[0].Goals != 0 {
		t.Fatalf("october spoken for = %+v", oct.SpokenFor)
	}
}
