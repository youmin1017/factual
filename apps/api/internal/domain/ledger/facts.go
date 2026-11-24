package ledger

import (
	"context"
	"sort"
	"time"

	"github.com/google/uuid"

	"factual/apps/api/internal/domain/ledger/internal/db"
)

// budgetFacts loads what a budget's month, targets and goals are worked out
// from, each query at most once per request: the month response needs the
// envelopes' month, the averages and the schedules for its own lines, its
// targets (goal asks) and what is spoken for, and asking for them each time
// ran the whole-ledger aggregations three times. It belongs to one request
// and is not safe for concurrent use.
type budgetFacts struct {
	s        *Service
	budgetID uuid.UUID

	cats     []db.ListCategoriesRow
	envelope map[uuid.UUID]uuid.UUID
	goalRows []db.ListGoalsRow
	goalsSet bool
	sched    *scheduleData
	envMonth map[time.Time][]db.ListEnvelopeMonthRow
	avg      map[time.Time][2]int64
	off      map[time.Time]func(time.Time) bool
	reserve  map[time.Time]map[uuid.UUID]int64
}

func (s *Service) facts(budgetID uuid.UUID) *budgetFacts {
	return &budgetFacts{
		s: s, budgetID: budgetID,
		envMonth: map[time.Time][]db.ListEnvelopeMonthRow{},
		avg:      map[time.Time][2]int64{},
		off:      map[time.Time]func(time.Time) bool{},
		reserve:  map[time.Time]map[uuid.UUID]int64{},
	}
}

func (f *budgetFacts) categories(ctx context.Context) ([]db.ListCategoriesRow, error) {
	if f.cats == nil {
		cats, err := f.s.q.ListCategories(ctx, f.budgetID)
		if err != nil {
			return nil, err
		}
		f.cats = cats
		f.envelope = envelopeOf(cats)
	}
	return f.cats, nil
}

// envelopes maps each expense category to the envelope it is budgeted in.
func (f *budgetFacts) envelopes(ctx context.Context) (map[uuid.UUID]uuid.UUID, error) {
	if _, err := f.categories(ctx); err != nil {
		return nil, err
	}
	return f.envelope, nil
}

func (f *budgetFacts) goalList(ctx context.Context) ([]db.ListGoalsRow, error) {
	if !f.goalsSet {
		rows, err := f.s.q.ListGoals(ctx, f.budgetID)
		if err != nil {
			return nil, err
		}
		f.goalRows, f.goalsSet = rows, true
	}
	return f.goalRows, nil
}

// goals is the budget's goals in priority order, each with its envelope.
func (f *budgetFacts) goals(ctx context.Context) ([]goal, error) {
	rows, err := f.goalList(ctx)
	if err != nil {
		return nil, err
	}
	envelope, err := f.envelopes(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]goal, 0, len(rows))
	for _, r := range rows {
		out = append(out, toGoal(r, envelope))
	}
	return out, nil
}

func (f *budgetFacts) schedules(ctx context.Context) (scheduleData, error) {
	if f.sched == nil {
		d, err := f.s.loadSchedules(ctx, f.budgetID)
		if err != nil {
			return scheduleData{}, err
		}
		f.sched = &d
	}
	return *f.sched, nil
}

// daysOff is the calendar around the month, as far as its targets look.
func (f *budgetFacts) daysOff(ctx context.Context, month time.Time) (func(time.Time) bool, error) {
	if off, ok := f.off[month]; ok {
		return off, nil
	}
	off, err := f.s.daysOff(ctx, month.AddDate(0, -targetWindow-1, 0), month.AddDate(0, targetWindow+2, 0))
	if err != nil {
		return nil, err
	}
	f.off[month] = off
	return off, nil
}

// envelopeMonth is every envelope's allocation, activity and carried balance
// in the month.
func (f *budgetFacts) envelopeMonth(ctx context.Context, month time.Time) ([]db.ListEnvelopeMonthRow, error) {
	if rows, ok := f.envMonth[month]; ok {
		return rows, nil
	}
	rows, err := f.s.q.ListEnvelopeMonth(ctx, db.ListEnvelopeMonthParams{BudgetID: f.budgetID, Month: month})
	if err != nil {
		return nil, err
	}
	f.envMonth[month] = rows
	return rows, nil
}

// envelopeMoney is each envelope's balance at the start (carried) and the
// end of the month, its subcategories folded in as the targets are.
func (f *budgetFacts) envelopeMoney(ctx context.Context, month time.Time) (carried, balance map[uuid.UUID]int64, err error) {
	envelope, err := f.envelopes(ctx)
	if err != nil {
		return nil, nil, err
	}
	rows, err := f.envelopeMonth(ctx, month)
	if err != nil {
		return nil, nil, err
	}
	carried, balance = map[uuid.UUID]int64{}, map[uuid.UUID]int64{}
	for _, r := range rows {
		env, ok := envelope[r.CategoryID]
		if !ok {
			continue
		}
		carried[env] += r.Carried
		balance[env] += r.Carried + r.Allocated + r.Activity
	}
	return carried, balance, nil
}

// averages is the budget's average monthly spending and its typical
// (median) monthly income over the six complete months before the month,
// each over the months that have any (ADR-092, ADR-094).
func (f *budgetFacts) averages(ctx context.Context, month time.Time) (spending, income int64, err error) {
	if v, ok := f.avg[month]; ok {
		return v[0], v[1], nil
	}
	rows, err := f.s.q.MonthlyTotals(ctx, db.MonthlyTotalsParams{
		BudgetID: f.budgetID, FromDate: month.AddDate(0, -6, 0), ToDate: month,
	})
	if err != nil {
		return 0, 0, err
	}
	var spent int64
	var spentMonths int64
	var incomes []int64
	for _, r := range rows {
		switch r.Kind {
		case db.CategoryKindExpense:
			spent += -r.Amount
			spentMonths++
		case db.CategoryKindIncome:
			incomes = append(incomes, r.Amount)
		}
	}
	if spentMonths > 0 {
		spending = max(spent/spentMonths, 0)
	}
	if n := len(incomes); n > 0 {
		sort.Slice(incomes, func(i, j int) bool { return incomes[i] < incomes[j] })
		if n%2 == 1 {
			income = incomes[n/2]
		} else {
			income = (incomes[n/2-1] + incomes[n/2]) / 2
		}
	}
	f.avg[month] = [2]int64{spending, income}
	return spending, income, nil
}

// scheduleReserve is what each envelope holds at the end of the month for
// its schedules' occurrences still to come or not posted yet (ADR-095);
// envelopes holding nothing are left out. The map is shared: callers must
// not change it.
func (f *budgetFacts) scheduleReserve(ctx context.Context, month time.Time) (map[uuid.UUID]int64, error) {
	if out, ok := f.reserve[month]; ok {
		return out, nil
	}
	out := map[uuid.UUID]int64{}
	d, err := f.schedules(ctx)
	if err != nil {
		return nil, err
	}
	if len(d.rows) > 0 {
		envelope, err := f.envelopes(ctx)
		if err != nil {
			return nil, err
		}
		off, err := f.daysOff(ctx, month)
		if err != nil {
			return nil, err
		}
		posted, err := f.s.postedSince(ctx, f.s.q, f.budgetID, month.AddDate(0, -targetWindow-1, 0))
		if err != nil {
			return nil, err
		}
		for _, r := range d.rows {
			if r.Paused || r.BudgetMode == db.BudgetModeNone {
				continue
			}
			rr, err := parseRule(r.Rrule, r.StartDate)
			if err != nil {
				continue
			}
			ru := rule{rr: rr, shift: r.HolidayShift, off: off}
			for _, e := range d.entries[r.ID] {
				if !e.CategoryID.Valid {
					continue
				}
				env, ok := envelope[e.CategoryID.UUID]
				if !ok {
					continue
				}
				out[env] += setAside(targetInput{
					rule: ru, mode: r.BudgetMode, created: r.CreatedAt, skipped: d.skips[r.ID], amount: -e.Amount,
				}, month, posted[r.ID])
			}
		}
		for env, v := range out {
			if v <= 0 {
				delete(out, env)
			}
		}
	}
	f.reserve[month] = out
	return out, nil
}
