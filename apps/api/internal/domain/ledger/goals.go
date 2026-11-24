package ledger

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/apperr"
)

// Savings goals (M10, ADR-092..094): several per envelope in one priority
// order per budget. What a goal has saved is never stored: its envelope's
// balance is handed down the envelope's goals in that order.

// goal is what the derivations need of a goal.
type goal struct {
	id uuid.UUID
	// envelope is where the goal's category is budgeted; uuid.Nil when in none.
	envelope uuid.UUID
	kind     db.GoalKind
	target   int64     // target, target_by_date
	date     time.Time // target_by_date
	monthly  int64     // monthly; the most a month for target and maintain
	months   int64     // maintain
	created  time.Time
	achieved time.Time // zero while not achieved
	archived time.Time // zero while not archived
}

// open says whether the goal takes money now: neither achieved nor archived.
func (g goal) open() bool { return g.achieved.IsZero() && g.archived.IsZero() }

// activeIn says whether the goal counts in the month: made in it or before,
// and not achieved or archived in it or before (ADR-093).
func (g goal) activeIn(month time.Time) bool {
	m := monthIndex(month)
	return monthIndex(g.created) <= m &&
		(g.achieved.IsZero() || monthIndex(g.achieved) > m) &&
		(g.archived.IsZero() || monthIndex(g.archived) > m)
}

// total is what the goal saves towards: its target amount, or for maintain
// its level (months of average spending); a monthly goal has none.
func (g goal) total(avgSpending int64) (int64, bool) {
	switch g.kind {
	case db.GoalKindTarget, db.GoalKindTargetByDate:
		return g.target, true
	case db.GoalKindMaintain:
		return g.months * avgSpending, true
	}
	return 0, false
}

// shareBalances hands each envelope's balance (never below zero) down its
// goals that take part, in the order given (the priority): goals with a
// total take up to it, then monthly goals take what is left (ADR-092).
func shareBalances(goals []goal, balance map[uuid.UUID]int64, takesPart func(goal) bool, avgSpending int64) map[uuid.UUID]int64 {
	left := map[uuid.UUID]int64{}
	for env, b := range balance {
		left[env] = max(b, 0)
	}
	saved := make(map[uuid.UUID]int64, len(goals))
	for _, withTotal := range []bool{true, false} {
		for _, g := range goals {
			if g.envelope == uuid.Nil || !takesPart(g) {
				continue
			}
			total, ok := g.total(avgSpending)
			if ok != withTotal {
				continue
			}
			take := left[g.envelope]
			if ok {
				take = min(take, max(total, 0))
			}
			saved[g.id] = take
			left[g.envelope] -= take
		}
	}
	return saved
}

// ask is what the goal asks of its envelope in the month, given what it had
// saved at the month's start (ADR-093).
func (g goal) ask(saved int64, month time.Time, avgSpending int64) int64 {
	total, _ := g.total(avgSpending)
	need := max(total-saved, 0)
	switch g.kind {
	case db.GoalKindTarget:
		if g.monthly > 0 {
			return min(g.monthly, need)
		}
		return 0
	case db.GoalKindTargetByDate:
		left := int64(monthIndex(g.date) - monthIndex(month) + 1)
		if left <= 1 {
			return need
		}
		return (need + left - 1) / left
	case db.GoalKindMaintain:
		if g.monthly > 0 {
			return min(g.monthly, need)
		}
		return need
	case db.GoalKindMonthly:
		return g.monthly
	}
	return 0
}

// goalStatus is how the page labels the goal today.
func goalStatus(g goal, saved int64, waitUntil pgtype.Date, today time.Time, avgSpending int64) api.GoalStatus {
	switch {
	case !g.archived.IsZero():
		return api.GoalStatusArchived
	case !g.achieved.IsZero():
		return api.GoalStatusAchieved
	}
	total, ok := g.total(avgSpending)
	if !ok || saved < total || total <= 0 {
		return api.GoalStatusSaving
	}
	if waitUntil.Valid && day(waitUntil.Time).After(today) {
		return api.GoalStatusWaiting
	}
	return api.GoalStatusFull
}

var goalKindToDB = map[api.GoalKind]db.GoalKind{
	api.Target: db.GoalKindTarget, api.TargetByDate: db.GoalKindTargetByDate,
	api.Maintain: db.GoalKindMaintain, api.Monthly: db.GoalKindMonthly,
}

func goalKindFromDB(v db.GoalKind) api.GoalKind {
	for k, x := range goalKindToDB {
		if x == v {
			return k
		}
	}
	return api.Target
}

func toGoal(r db.ListGoalsRow, envelope map[uuid.UUID]uuid.UUID) goal {
	g := goal{
		id: r.ID, envelope: envelope[r.CategoryID], kind: r.Kind,
		target: r.TargetAmount.Int64, monthly: r.MonthlyAmount.Int64, months: int64(r.MaintainMonths.Int16),
		created: r.CreatedAt,
	}
	if r.TargetDate.Valid {
		g.date = day(r.TargetDate.Time)
	}
	if r.AchievedAt.Valid {
		g.achieved = r.AchievedAt.Time
	}
	if r.ArchivedAt.Valid {
		g.archived = r.ArchivedAt.Time
	}
	return g
}

// monthStart is the first day of the month t falls in.
func monthStart(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// averages is the budget's average monthly spending and its typical
// (median) monthly income over the six complete months before the month,
// each over the months that have any (ADR-092, ADR-094).
func (s *Service) averages(ctx context.Context, budgetID uuid.UUID, month time.Time) (spending, income int64, err error) {
	rows, err := s.q.MonthlyTotals(ctx, db.MonthlyTotalsParams{
		BudgetID: budgetID, FromDate: month.AddDate(0, -6, 0), ToDate: month,
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
	return spending, income, nil
}

// envelopeMoney is each envelope's balance at the start (carried) and the
// end of the month, its subcategories folded in as the targets are.
func (s *Service) envelopeMoney(ctx context.Context, budgetID uuid.UUID, month time.Time,
	envelope map[uuid.UUID]uuid.UUID,
) (carried, balance map[uuid.UUID]int64, err error) {
	rows, err := s.q.ListEnvelopeMonth(ctx, db.ListEnvelopeMonthParams{BudgetID: budgetID, Month: month})
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

// scheduleReserve is what each envelope holds at the end of the month for
// its schedules' occurrences still to come or not posted yet (ADR-095);
// envelopes holding nothing are left out.
func (s *Service) scheduleReserve(ctx context.Context, budgetID uuid.UUID, month time.Time,
	envelope map[uuid.UUID]uuid.UUID,
) (map[uuid.UUID]int64, error) {
	out := map[uuid.UUID]int64{}
	d, err := s.loadSchedules(ctx, budgetID)
	if err != nil || len(d.rows) == 0 {
		return out, err
	}
	from := month.AddDate(0, -targetWindow-1, 0)
	off, err := s.daysOff(ctx, from, month.AddDate(0, targetWindow+2, 0))
	if err != nil {
		return nil, err
	}
	posted, err := s.postedSince(ctx, s.q, budgetID, from)
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
	return out, nil
}

// less is each envelope's money less what its schedules hold: what its goals
// share (ADR-095).
func less(money, reserve map[uuid.UUID]int64) map[uuid.UUID]int64 {
	out := make(map[uuid.UUID]int64, len(money)+len(reserve))
	for env, m := range money {
		out[env] = m
	}
	for env, r := range reserve {
		out[env] -= r
	}
	return out
}

// goalAsks is what the active goals ask of their envelopes in the month, in
// priority order, worked out from the balances carried into it, less what
// the schedules held then (ADR-093, ADR-095).
func (s *Service) goalAsks(ctx context.Context, budgetID uuid.UUID, month time.Time,
	envelope map[uuid.UUID]uuid.UUID,
) ([]goal, map[uuid.UUID]int64, error) {
	rows, err := s.q.ListGoals(ctx, budgetID)
	if err != nil || len(rows) == 0 {
		return nil, nil, err
	}
	goals := make([]goal, 0, len(rows))
	for _, r := range rows {
		goals = append(goals, toGoal(r, envelope))
	}
	carried, _, err := s.envelopeMoney(ctx, budgetID, month, envelope)
	if err != nil {
		return nil, nil, err
	}
	held, err := s.scheduleReserve(ctx, budgetID, month.AddDate(0, -1, 0), envelope)
	if err != nil {
		return nil, nil, err
	}
	carried = less(carried, held)
	avg, _, err := s.averages(ctx, budgetID, month)
	if err != nil {
		return nil, nil, err
	}
	active := func(g goal) bool { return g.activeIn(month) }
	saved := shareBalances(goals, carried, active, avg)
	asks := map[uuid.UUID]int64{}
	for _, g := range goals {
		if g.envelope != uuid.Nil && active(g) {
			asks[g.id] = g.ask(saved[g.id], month, avg)
		}
	}
	return goals, asks, nil
}

func (h *Handlers) ListGoals(ctx context.Context, req api.ListGoalsRequestObject) (api.ListGoalsResponseObject, error) {
	budgetID := req.BudgetId
	cats, err := h.s.q.ListCategories(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	envelope := envelopeOf(cats)
	rows, err := h.s.q.ListGoals(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	today := h.s.today()
	month := monthStart(today)
	carried, balance, err := h.s.envelopeMoney(ctx, budgetID, month, envelope)
	if err != nil {
		return nil, err
	}
	// Goals share what the schedules do not hold (ADR-095).
	heldBefore, err := h.s.scheduleReserve(ctx, budgetID, month.AddDate(0, -1, 0), envelope)
	if err != nil {
		return nil, err
	}
	held, err := h.s.scheduleReserve(ctx, budgetID, month, envelope)
	if err != nil {
		return nil, err
	}
	carried, balance = less(carried, heldBefore), less(balance, held)
	spending, income, err := h.s.averages(ctx, budgetID, month)
	if err != nil {
		return nil, err
	}
	targets, err := h.s.monthTargets(ctx, budgetID, month)
	if err != nil {
		return nil, err
	}
	var base int64
	for _, t := range targets {
		base += t.Total
		for _, g := range t.Goals {
			base -= g.Amount
		}
	}

	goals := make([]goal, 0, len(rows))
	for _, r := range rows {
		goals = append(goals, toGoal(r, envelope))
	}
	saved := shareBalances(goals, balance, goal.open, spending)
	savedAtStart := shareBalances(goals, carried, func(g goal) bool { return g.activeIn(month) }, spending)

	out := make([]api.Goal, 0, len(rows))
	for i, r := range rows {
		g := goals[i]
		item := api.Goal{
			Id: r.ID, CategoryId: r.CategoryID, Name: r.Name, Kind: goalKindFromDB(r.Kind),
			Note: r.Note, Url: r.Url, Achieved: r.AchievedAt.Valid, Archived: r.ArchivedAt.Valid,
			SortOrder: r.SortOrder, CreatedAt: r.CreatedAt, Saved: saved[r.ID],
			Status: goalStatus(g, saved[r.ID], r.WaitUntil, today, spending),
		}
		if g.envelope != uuid.Nil {
			env := g.envelope
			item.EnvelopeId = &env
			if g.activeIn(month) {
				item.Ask = g.ask(savedAtStart[r.ID], month, spending)
			}
		}
		if r.TargetAmount.Valid {
			v := r.TargetAmount.Int64
			item.TargetAmount = &v
		}
		if r.TargetDate.Valid {
			d := apiDate(day(r.TargetDate.Time))
			item.TargetDate = &d
		}
		if r.MonthlyAmount.Valid {
			v := r.MonthlyAmount.Int64
			item.MonthlyAmount = &v
		}
		if r.MaintainMonths.Valid {
			v := int32(r.MaintainMonths.Int16)
			item.MaintainMonths = &v
		}
		if r.WaitUntil.Valid {
			d := apiDate(day(r.WaitUntil.Time))
			item.WaitUntil = &d
		}
		if r.AchievedAt.Valid {
			t := r.AchievedAt.Time
			item.AchievedAt = &t
		}
		if total, ok := g.total(spending); ok {
			item.Total = &total
		}
		out = append(out, item)
	}

	envelopes := make([]api.EnvelopeBalance, 0, len(balance))
	for env, b := range balance {
		envelopes = append(envelopes, api.EnvelopeBalance{CategoryId: env, Balance: b, Carried: carried[env]})
	}
	sort.Slice(envelopes, func(i, j int) bool { return envelopes[i].CategoryId.String() < envelopes[j].CategoryId.String() })
	return api.ListGoals200JSONResponse{
		Month: month.Format("2006-01"), Goals: out, AverageSpending: spending, TypicalIncome: income,
		BaseTargets: base, Envelopes: envelopes,
	}, nil
}

// positive is a nullable amount kept only when above zero.
func positive(v *int64) pgtype.Int8 {
	if v == nil || *v <= 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: *v, Valid: true}
}

func optionalDate(d *openapi_types.Date) pgtype.Date {
	if d == nil {
		return pgtype.Date{}
	}
	return pgDate(day(d.Time))
}

// goalParams checks a goal of the batch and keeps only the amounts its kind
// uses; it reports what is wrong instead when something is.
func goalParams(probs *problems, budgetID uuid.UUID, u api.GoalInput, envelope map[uuid.UUID]uuid.UUID, now time.Time) (db.UpsertGoalParams, bool) {
	p := db.UpsertGoalParams{
		ID: u.Id, BudgetID: budgetID, CategoryID: u.CategoryId, Name: strings.TrimSpace(u.Name),
		Note: strings.TrimSpace(u.Note), Url: strings.TrimSpace(u.Url), WaitUntil: optionalDate(u.WaitUntil),
		Achieved: u.Achieved, Archived: u.Archived, SortOrder: u.SortOrder, Now: now,
	}
	kind, ok := goalKindToDB[u.Kind]
	switch {
	case p.Name == "":
		probs.add(u.Id, "name", "name_required", "a goal needs a name")
		return p, false
	case !ok:
		probs.add(u.Id, "kind", "invalid_kind", "unknown goal kind")
		return p, false
	}
	if _, in := envelope[u.CategoryId]; !in {
		probs.add(u.Id, "category", "not_an_envelope", "the category is in no envelope")
		return p, false
	}
	p.Kind = kind
	target, monthly := positive(u.TargetAmount), positive(u.MonthlyAmount)
	switch kind {
	case db.GoalKindTarget:
		p.TargetAmount, p.MonthlyAmount = target, monthly
	case db.GoalKindTargetByDate:
		p.TargetAmount, p.TargetDate = target, optionalDate(u.TargetDate)
		if p.TargetAmount.Valid && !p.TargetDate.Valid {
			probs.add(u.Id, "date", "date_required", "a goal by a date needs the date")
			return p, false
		}
	case db.GoalKindMaintain:
		p.MonthlyAmount = monthly
		if u.MaintainMonths == nil || *u.MaintainMonths < 1 || *u.MaintainMonths > 120 {
			probs.add(u.Id, "months", "months_required", "a level is 1 to 120 months of spending")
			return p, false
		}
		p.MaintainMonths = pgtype.Int2{Int16: int16(*u.MaintainMonths), Valid: true}
	case db.GoalKindMonthly:
		p.MonthlyAmount = monthly
		if !monthly.Valid {
			probs.add(u.Id, "monthly", "amount_required", "a monthly goal needs its amount")
			return p, false
		}
	}
	if (kind == db.GoalKindTarget || kind == db.GoalKindTargetByDate) && !p.TargetAmount.Valid {
		probs.add(u.Id, "target", "amount_required", "a goal needs its amount")
		return p, false
	}
	return p, true
}

func (h *Handlers) SaveGoals(ctx context.Context, req api.SaveGoalsRequestObject) (api.SaveGoalsResponseObject, error) {
	budgetID := req.BudgetId
	b := req.Body
	cats, err := h.s.q.ListCategories(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	envelope := envelopeOf(cats)
	ids := make([]uuid.UUID, 0, len(b.Upserts)+len(b.Deletes))
	for _, u := range b.Upserts {
		ids = append(ids, u.Id)
	}
	ids = append(ids, b.Deletes...)
	owners, err := h.s.q.GetGoalOwners(ctx, ids)
	if err != nil {
		return nil, err
	}
	owner := make(map[uuid.UUID]uuid.UUID, len(owners))
	for _, o := range owners {
		owner[o.ID] = o.BudgetID
	}

	var probs problems
	seen := make(map[uuid.UUID]bool, len(ids))
	params := make([]db.UpsertGoalParams, 0, len(b.Upserts))
	for _, u := range b.Upserts {
		if seen[u.Id] {
			probs.add(u.Id, "", "duplicate_id", "the goal appears twice in the batch")
			continue
		}
		seen[u.Id] = true
		if o, ok := owner[u.Id]; ok && o != budgetID {
			probs.add(u.Id, "", "not_found", "goal not found")
			continue
		}
		if p, ok := goalParams(&probs, budgetID, u, envelope, h.s.now()); ok {
			params = append(params, p)
		}
	}
	for _, id := range b.Deletes {
		if seen[id] {
			probs.add(id, "", "duplicate_id", "the goal is both saved and deleted")
			continue
		}
		seen[id] = true
		if o, ok := owner[id]; ok && o != budgetID {
			probs.add(id, "", "not_found", "goal not found")
		}
	}
	if len(probs) > 0 {
		return api.SaveGoals422JSONResponse{Errors: probs}, nil
	}

	var deleted int32
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		for _, id := range b.Deletes {
			n, err := q.DeleteGoal(ctx, db.DeleteGoalParams{BudgetID: budgetID, ID: id})
			if err != nil {
				return err
			}
			deleted += int32(n)
		}
		for _, p := range params {
			if err := q.UpsertGoal(ctx, p); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	return api.SaveGoals200JSONResponse{Upserted: int32(len(params)), Deleted: deleted}, nil
}

// spokenFor is, per envelope, what its schedules hold and what its goals
// have saved at the end of the month (ADR-095); envelopes with neither are
// left out.
func (s *Service) spokenFor(ctx context.Context, budgetID uuid.UUID, month time.Time) ([]api.SpokenFor, error) {
	cats, err := s.q.ListCategories(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	envelope := envelopeOf(cats)
	held, err := s.scheduleReserve(ctx, budgetID, month, envelope)
	if err != nil {
		return nil, err
	}
	saved := map[uuid.UUID]int64{}
	rows, err := s.q.ListGoals(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	if len(rows) > 0 {
		_, balance, err := s.envelopeMoney(ctx, budgetID, month, envelope)
		if err != nil {
			return nil, err
		}
		avg, _, err := s.averages(ctx, budgetID, month)
		if err != nil {
			return nil, err
		}
		goals := make([]goal, 0, len(rows))
		for _, r := range rows {
			goals = append(goals, toGoal(r, envelope))
		}
		shares := shareBalances(goals, less(balance, held), func(g goal) bool { return g.activeIn(month) }, avg)
		for _, g := range goals {
			saved[g.envelope] += shares[g.id]
		}
	}
	out := []api.SpokenFor{}
	for env := range envelopeSet(cats) {
		if held[env] > 0 || saved[env] > 0 {
			out = append(out, api.SpokenFor{CategoryId: env, Schedules: held[env], Goals: saved[env]})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CategoryId.String() < out[j].CategoryId.String() })
	return out, nil
}
