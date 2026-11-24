package ledger

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/apperr"
	"factual/apps/api/internal/shared/reqctx"
)

// Schedules (M9, ADR-084..086): kept as a rule plus the entries of one
// transaction, posted as transactions on their dates by RunScheduler.

// Calendar says which days are off (ADR-087).
type Calendar interface {
	DaysOff(ctx context.Context, from, to time.Time) (func(time.Time) bool, error)
}

// upcomingLimit is how far ahead occurrences can be listed.
const upcomingLimit = 400 * 24 * time.Hour

// today is the current date where the server runs (TZ).
func (s *Service) today() time.Time {
	y, m, dd := s.now().Date()
	return time.Date(y, m, dd, 0, 0, 0, 0, time.UTC)
}

// daysOff loads the calendar around the dates from..to.
func (s *Service) daysOff(ctx context.Context, from, to time.Time) (func(time.Time) bool, error) {
	if s.cal == nil {
		return weekend, nil
	}
	return s.cal.DaysOff(ctx, from.Add(-shiftPad-24*time.Hour), to.Add(shiftPad+24*time.Hour))
}

func weekend(t time.Time) bool { return t.Weekday() == time.Saturday || t.Weekday() == time.Sunday }

func pgDate(t time.Time) pgtype.Date { return pgtype.Date{Time: t, Valid: true} }

func apiDate(t time.Time) openapi_types.Date { return openapi_types.Date{Time: t} }

var shiftToDB = map[api.HolidayShift]db.HolidayShift{
	api.NoShift: db.HolidayShiftNone, api.NextWorkday: db.HolidayShiftNextWorkday, api.PrevWorkday: db.HolidayShiftPrevWorkday,
}

var modeToDB = map[api.BudgetMode]db.BudgetMode{
	api.BudgetModeNotBudgeted: db.BudgetModeNone, api.BudgetModeFull: db.BudgetModeFull, api.BudgetModeSpread: db.BudgetModeSpread,
}

func shiftFromDB(v db.HolidayShift) api.HolidayShift {
	for k, x := range shiftToDB {
		if x == v {
			return k
		}
	}
	return api.NoShift
}

func modeFromDB(v db.BudgetMode) api.BudgetMode {
	for k, x := range modeToDB {
		if x == v {
			return k
		}
	}
	return api.BudgetModeNotBudgeted
}

// scheduleEntry is one entry of the transaction a schedule posts.
type scheduleEntry struct {
	AccountID  uuid.UUID
	CategoryID uuid.NullUUID
	Amount     int64
	Memo       string
}

// lines turns a schedule's entries into the page's fields: the account it
// is on, the other account of a transfer, its category and amount. A
// transfer is shown from the side money leaves.
func lines(es []scheduleEntry) (account uuid.UUID, transfer, category *uuid.UUID, amount int64) {
	if len(es) == 0 {
		return uuid.Nil, nil, nil, 0
	}
	main := 0
	for i, e := range es {
		if e.CategoryID.Valid {
			main = i
			break
		}
		if e.Amount < es[main].Amount {
			main = i
		}
	}
	m := es[main]
	for i, e := range es {
		if i != main {
			id := e.AccountID
			transfer = &id
			break
		}
	}
	return m.AccountID, transfer, idPtr(m.CategoryID), m.Amount
}

// scheduleData is everything about a budget's schedules.
type scheduleData struct {
	rows    []db.ListSchedulesRow
	entries map[uuid.UUID][]scheduleEntry
	skips   map[uuid.UUID]map[time.Time]bool
}

func (s *Service) loadSchedules(ctx context.Context, budgetID uuid.UUID) (scheduleData, error) {
	rows, err := s.q.ListSchedules(ctx, budgetID)
	if err != nil {
		return scheduleData{}, err
	}
	es, err := s.q.ListScheduleEntries(ctx, budgetID)
	if err != nil {
		return scheduleData{}, err
	}
	sk, err := s.q.ListScheduleSkips(ctx, budgetID)
	if err != nil {
		return scheduleData{}, err
	}
	d := scheduleData{rows: rows, entries: map[uuid.UUID][]scheduleEntry{}, skips: map[uuid.UUID]map[time.Time]bool{}}
	for _, e := range es {
		d.entries[e.ScheduleID] = append(d.entries[e.ScheduleID], scheduleEntry{e.AccountID, e.CategoryID, e.Amount, e.Memo})
	}
	for _, k := range sk {
		if d.skips[k.ScheduleID] == nil {
			d.skips[k.ScheduleID] = map[time.Time]bool{}
		}
		d.skips[k.ScheduleID][day(k.OccurrenceDate)] = true
	}
	return d, nil
}

// postedSince is the occurrences of the budget's schedules posted on or
// after a date, per schedule.
func (s *Service) postedSince(ctx context.Context, q *db.Queries, budgetID uuid.UUID, from time.Time) (map[uuid.UUID]map[time.Time]bool, error) {
	rows, err := q.PostedOccurrences(ctx, db.PostedOccurrencesParams{BudgetID: budgetID, OccurrenceDate: pgDate(from)})
	if err != nil {
		return nil, err
	}
	out := map[uuid.UUID]map[time.Time]bool{}
	for _, r := range rows {
		if out[r.ScheduleID] == nil {
			out[r.ScheduleID] = map[time.Time]bool{}
		}
		out[r.ScheduleID][day(r.OccurrenceDate)] = true
	}
	return out, nil
}

func (h *Handlers) ListSchedules(ctx context.Context, req api.ListSchedulesRequestObject) (api.ListSchedulesResponseObject, error) {
	d, err := h.s.loadSchedules(ctx, req.BudgetId)
	if err != nil {
		return nil, err
	}
	from, to := h.s.today(), h.s.today()
	for _, r := range d.rows {
		if r.NextOccurrence.Valid {
			if r.NextOccurrence.Time.Before(from) {
				from = r.NextOccurrence.Time
			}
			if r.NextOccurrence.Time.After(to) {
				to = r.NextOccurrence.Time
			}
		}
	}
	off, err := h.s.daysOff(ctx, from, to)
	if err != nil {
		return nil, err
	}
	out := make([]api.Schedule, 0, len(d.rows))
	for _, r := range d.rows {
		// A card's autopay is set with the card (ADR-090).
		if r.CardID.Valid {
			continue
		}
		account, transfer, category, amount := lines(d.entries[r.ID])
		sc := api.Schedule{
			Id: r.ID, Source: r.Source, Rule: r.Rrule, Start: apiDate(r.StartDate),
			HolidayShift: shiftFromDB(r.HolidayShift), Note: r.Note, AccountId: account,
			TransferAccountId: transfer, CategoryId: category, Amount: amount, Estimate: r.AmountIsEstimate,
			BudgetMode: modeFromDB(r.BudgetMode), Paused: r.Paused, Skips: []openapi_types.Date{},
		}
		if r.PayeeName.Valid {
			sc.Payee = r.PayeeName.String
		}
		if r.NextOccurrence.Valid {
			n := day(r.NextOccurrence.Time)
			next := apiDate(n)
			date := apiDate(rule{shift: r.HolidayShift, off: off}.move(n))
			sc.NextOccurrence, sc.NextDate = &next, &date
		}
		for k := range d.skips[r.ID] {
			sc.Skips = append(sc.Skips, apiDate(k))
		}
		sort.Slice(sc.Skips, func(i, j int) bool { return sc.Skips[i].Before(sc.Skips[j].Time) })
		out = append(out, sc)
	}
	return api.ListSchedules200JSONResponse(out), nil
}

// scheduleEntries is the transaction a schedule posts.
func scheduleEntries(u api.ScheduleInput) []api.EntryInput {
	es := []api.EntryInput{{AccountId: u.AccountId, CategoryId: u.CategoryId, Amount: u.Amount, Cleared: api.Uncleared}}
	if u.TransferAccountId != nil {
		es = append(es, api.EntryInput{AccountId: *u.TransferAccountId, Amount: -u.Amount, Cleared: api.Uncleared})
	}
	return es
}

func (h *Handlers) SaveSchedules(ctx context.Context, req api.SaveSchedulesRequestObject) (api.SaveSchedulesResponseObject, error) {
	budgetID := req.BudgetId
	b := req.Body

	accounts, err := h.s.q.ListAccountRefs(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	onBudget := make(map[uuid.UUID]bool, len(accounts))
	closed := map[uuid.UUID]bool{}
	for _, a := range accounts {
		onBudget[a.ID] = a.OnBudget
		closed[a.ID] = a.Closed
	}
	cats, err := h.s.q.ListCategoryRefs(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	isCategory := make(map[uuid.UUID]bool, len(cats))
	for _, c := range cats {
		isCategory[c.ID] = true
	}
	ids := make([]uuid.UUID, 0, len(b.Upserts)+len(b.Deletes))
	for _, u := range b.Upserts {
		ids = append(ids, u.Id)
	}
	ids = append(ids, b.Deletes...)
	owners, err := h.s.q.GetScheduleOwners(ctx, ids)
	if err != nil {
		return nil, err
	}
	owner := make(map[uuid.UUID]uuid.UUID, len(owners))
	for _, o := range owners {
		owner[o.ID] = o.BudgetID
	}
	existing, err := h.s.loadSchedules(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	old := make(map[uuid.UUID]db.ListSchedulesRow, len(existing.rows))
	for _, r := range existing.rows {
		old[r.ID] = r
	}

	var probs problems
	rules := make(map[uuid.UUID]rule, len(b.Upserts))
	seen := make(map[uuid.UUID]bool, len(ids))
	for _, u := range b.Upserts {
		if seen[u.Id] {
			probs.add(u.Id, "", "duplicate_id", "the schedule appears twice in the batch")
			continue
		}
		seen[u.Id] = true
		if o, ok := owner[u.Id]; ok && o != budgetID {
			probs.add(u.Id, "", "not_found", "schedule not found")
			continue
		}
		if old[u.Id].CardID.Valid {
			probs.add(u.Id, "", "autopay_schedule", "a card's autopay is set in the card's settings")
			continue
		}
		rr, err := parseRule(u.Rule, u.Start.Time)
		if err != nil {
			probs.add(u.Id, "rule", "invalid_rule", "the rule is not a daily, weekly, monthly or yearly RRULE")
			continue
		}
		// Only the dates the rule gives matter here, not when they are posted.
		rules[u.Id] = rule{rr: rr, shift: shiftToDB[u.HolidayShift], off: weekend}
		if u.Amount == 0 {
			probs.add(u.Id, "amount", "amount_required", "a schedule needs an amount")
			continue
		}
		if u.TransferAccountId != nil && *u.TransferAccountId == u.AccountId {
			probs.add(u.Id, "payee", "same_account", "a transfer goes to another account")
			continue
		}
		bad := false
		for _, e := range scheduleEntries(u) {
			if closed[e.AccountId] {
				probs.add(u.Id, "account", "account_closed", "the account is closed")
				bad = true
				break
			}
		}
		if bad {
			continue
		}
		validateTransaction(&probs, api.TransactionInput{
			Id: u.Id, Payee: u.Payee, Note: u.Note, Entries: scheduleEntries(u),
		}, onBudget, isCategory)
	}
	for _, id := range b.Deletes {
		if seen[id] {
			probs.add(id, "", "duplicate_id", "the schedule is both saved and deleted")
			continue
		}
		seen[id] = true
		if o, ok := owner[id]; ok && o != budgetID {
			probs.add(id, "", "not_found", "schedule not found")
		} else if old[id].CardID.Valid {
			probs.add(id, "", "autopay_schedule", "a card's autopay is set in the card's settings")
		}
	}
	if len(probs) > 0 {
		return api.SaveSchedules422JSONResponse{Errors: probs}, nil
	}

	caller := uuid.NullUUID{UUID: reqctx.Caller(ctx).UserID, Valid: true}
	var deleted int32
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		for _, id := range b.Deletes {
			n, err := q.DeleteSchedule(ctx, db.DeleteScheduleParams{BudgetID: budgetID, ID: id})
			if err != nil {
				return err
			}
			deleted += int32(n)
		}
		posted, err := h.s.postedSince(ctx, q, budgetID, time.Time{})
		if err != nil {
			return err
		}
		lastPosted, err := q.LastPostedOccurrences(ctx, ids)
		if err != nil {
			return err
		}
		last := map[uuid.UUID]time.Time{}
		for _, l := range lastPosted {
			last[l.ScheduleID] = day(l.OccurrenceDate)
		}
		payees := map[string]uuid.UUID{}
		for _, u := range b.Upserts {
			payee := uuid.NullUUID{}
			if name := strings.TrimSpace(u.Payee); name != "" {
				id, ok := payees[name]
				if !ok {
					if id, err = q.UpsertPayee(ctx, db.UpsertPayeeParams{BudgetID: budgetID, Name: name}); err != nil {
						return err
					}
					payees[name] = id
				}
				payee = uuid.NullUUID{UUID: id, Valid: true}
			}
			// Occurrences already behind the schedule are never posted again.
			floor := day(u.Start.Time)
			if o, ok := old[u.Id]; ok {
				if o.NextOccurrence.Valid && day(o.NextOccurrence.Time).After(floor) {
					floor = day(o.NextOccurrence.Time)
				} else if l, ok := last[u.Id]; ok && !o.NextOccurrence.Valid && !l.Before(floor) {
					floor = addDays(l, 1)
				}
			}
			next := pgtype.Date{}
			if o, ok := rules[u.Id].next(floor, posted[u.Id], existing.skips[u.Id]); ok {
				next = pgDate(o.Nominal)
			}
			err := q.UpsertSchedule(ctx, db.UpsertScheduleParams{
				ID: u.Id, BudgetID: budgetID, Source: strings.TrimSpace(u.Source), Rrule: u.Rule,
				StartDate: day(u.Start.Time), HolidayShift: shiftToDB[u.HolidayShift], PayeeID: payee,
				Note: strings.TrimSpace(u.Note), AmountIsEstimate: u.Estimate, NextOccurrence: next,
				Paused: u.Paused, BudgetMode: modeToDB[u.BudgetMode], CreatedBy: caller,
			})
			if err != nil {
				return err
			}
			if err := q.DeleteScheduleEntriesOf(ctx, db.DeleteScheduleEntriesOfParams{BudgetID: budgetID, ScheduleID: u.Id}); err != nil {
				return err
			}
			for _, e := range scheduleEntries(u) {
				err := q.CreateScheduleEntry(ctx, db.CreateScheduleEntryParams{
					BudgetID: budgetID, ScheduleID: u.Id, AccountID: e.AccountId, CategoryID: nullID(e.CategoryId),
					Amount: e.Amount, Memo: strings.TrimSpace(e.Memo),
				})
				if err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	var postedNow int32
	for _, u := range b.Upserts {
		n, err := h.s.postDue(ctx, u.Id, h.s.today())
		if err != nil {
			return nil, err
		}
		postedNow += int32(n)
	}
	return api.SaveSchedules200JSONResponse{Upserted: int32(len(b.Upserts)), Deleted: deleted, Posted: postedNow}, nil
}

// postDue posts every occurrence of the schedule whose date has come and
// moves its next occurrence past them (ADR-085). Posting is idempotent: an
// occurrence posted before is left alone.
func (s *Service) postDue(ctx context.Context, scheduleID uuid.UUID, today time.Time) (int, error) {
	count := 0
	err := s.inTx(ctx, func(q *db.Queries) error {
		sc, err := q.LockSchedule(ctx, scheduleID)
		if isNoRows(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if sc.Paused || !sc.NextOccurrence.Valid {
			return nil
		}
		cur := day(sc.NextOccurrence.Time)
		if cur.After(today.Add(shiftPad)) {
			return nil
		}
		r, err := s.scheduleRule(ctx, sc.Rrule, sc.StartDate, sc.HolidayShift, cur, today)
		if err != nil {
			return err
		}
		entries, err := q.ScheduleEntriesOf(ctx, scheduleID)
		if err != nil {
			return err
		}
		skipped, err := skipSet(ctx, q, scheduleID)
		if err != nil {
			return err
		}
		posted, err := s.postedSince(ctx, q, sc.BudgetID, cur)
		if err != nil {
			return err
		}
		next := pgtype.Date{}
		for i := 0; i < 5000; i++ {
			o, ok := r.next(cur, posted[scheduleID], skipped)
			if !ok {
				break
			}
			if o.Date.After(today) {
				next = pgDate(o.Nominal)
				break
			}
			cur = addDays(o.Nominal, 1)
			if sc.CardID.Valid {
				id, err := s.postAutopay(ctx, q, sc, o, sc.CreatedBy)
				if err != nil {
					return err
				}
				if id != uuid.Nil {
					count++
				} else {
					skipped[o.Nominal] = true
				}
				continue
			}
			if err := insertOccurrence(ctx, q, sc.BudgetID, scheduleID, sc.PayeeID, sc.Note, sc.AmountIsEstimate, sc.CreatedBy, o, entries); err != nil {
				return err
			}
			count++
		}
		return q.SetNextOccurrence(ctx, db.SetNextOccurrenceParams{ID: scheduleID, NextOccurrence: next})
	})
	return count, err
}

// scheduleRule builds a stored schedule's rule with the calendar around from..to.
func (s *Service) scheduleRule(ctx context.Context, text string, start time.Time, shift db.HolidayShift, from, to time.Time) (rule, error) {
	rr, err := parseRule(text, start)
	if err != nil {
		return rule{}, err
	}
	off, err := s.daysOff(ctx, from, to)
	if err != nil {
		return rule{}, err
	}
	return rule{rr: rr, shift: shift, off: off}, nil
}

func skipSet(ctx context.Context, q *db.Queries, scheduleID uuid.UUID) (map[time.Time]bool, error) {
	ds, err := q.ScheduleSkipsOf(ctx, scheduleID)
	if err != nil {
		return nil, err
	}
	out := make(map[time.Time]bool, len(ds))
	for _, d := range ds {
		out[day(d)] = true
	}
	return out, nil
}

// insertOccurrence posts one occurrence; nothing when it was posted already.
func insertOccurrence(ctx context.Context, q *db.Queries, budgetID, scheduleID uuid.UUID, payee uuid.NullUUID,
	note string, estimate bool, by uuid.NullUUID, o occurrence, entries []db.ScheduleEntriesOfRow,
) error {
	_, err := insertOccurrenceID(ctx, q, budgetID, scheduleID, payee, note, estimate, by, o, entries)
	return err
}

func insertOccurrenceID(ctx context.Context, q *db.Queries, budgetID, scheduleID uuid.UUID, payee uuid.NullUUID,
	note string, estimate bool, by uuid.NullUUID, o occurrence, entries []db.ScheduleEntriesOfRow,
) (uuid.UUID, error) {
	id, err := q.InsertOccurrence(ctx, db.InsertOccurrenceParams{
		BudgetID: budgetID, Date: o.Date, PayeeID: payee, Note: note, NeedsReview: estimate,
		ScheduleID: uuid.NullUUID{UUID: scheduleID, Valid: true}, OccurrenceDate: pgDate(o.Nominal), CreatedBy: by,
	})
	if isNoRows(err) {
		return uuid.Nil, nil
	}
	if err != nil {
		return uuid.Nil, err
	}
	for _, e := range entries {
		err := q.CreateEntry(ctx, db.CreateEntryParams{
			BudgetID: budgetID, TransactionID: id, AccountID: e.AccountID, CategoryID: e.CategoryID,
			Amount: e.Amount, Memo: e.Memo, Cleared: db.ClearedStateUncleared,
		})
		if err != nil {
			return uuid.Nil, err
		}
	}
	return id, nil
}

// PostAllDue posts every due occurrence of every budget; it returns how
// many were posted.
func (s *Service) PostAllDue(ctx context.Context) (int, error) {
	today := s.today()
	due, err := s.q.ListDueSchedules(ctx, pgDate(today.Add(shiftPad)))
	if err != nil {
		return 0, err
	}
	total := 0
	for _, d := range due {
		n, err := s.postDue(ctx, d.ID, today)
		if err != nil {
			return total, err
		}
		total += n
	}
	return total, nil
}

// RunScheduler closes card statements and posts due occurrences now and
// then every interval, until ctx ends. A goroutine is enough: closing and
// posting are idempotent (ADR-085, ADR-088).
func (s *Service) RunScheduler(ctx context.Context, interval time.Duration) {
	run := func() {
		// Statements close first, so autopay sees what they ask (ADR-090).
		n, err := s.CloseStatements(ctx)
		logClosed(ctx, n, err)
		if n, err := s.PostAllDue(ctx); err != nil {
			if ctx.Err() == nil {
				slog.Error("post scheduled transactions", "err", err)
			}
		} else if n > 0 {
			slog.Info("posted scheduled transactions", "count", n)
		}
	}
	run()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			run()
		}
	}
}

func (h *Handlers) ListUpcoming(ctx context.Context, req api.ListUpcomingRequestObject) (api.ListUpcomingResponseObject, error) {
	until := day(req.Params.Until.Time)
	today := h.s.today()
	if until.After(today.Add(upcomingLimit)) {
		return nil, apperr.BadRequest("invalid_until", "until is at most 400 days ahead")
	}
	d, err := h.s.loadSchedules(ctx, req.BudgetId)
	if err != nil {
		return nil, err
	}
	from := today
	for _, r := range d.rows {
		if r.NextOccurrence.Valid && r.NextOccurrence.Time.Before(from) {
			from = day(r.NextOccurrence.Time)
		}
	}
	off, err := h.s.daysOff(ctx, from, until)
	if err != nil {
		return nil, err
	}
	posted, err := h.s.postedSince(ctx, h.s.q, req.BudgetId, from)
	if err != nil {
		return nil, err
	}
	cards, err := h.s.cardSettings(ctx, req.BudgetId)
	if err != nil {
		return nil, err
	}
	out := []api.Occurrence{}
	for _, r := range d.rows {
		if r.Paused || !r.NextOccurrence.Valid {
			continue
		}
		var autopayFrom uuid.UUID
		if r.CardID.Valid {
			c := cards[r.CardID.UUID]
			if c == nil || c.AutopayAccountId == nil {
				continue
			}
			autopayFrom = *c.AutopayAccountId
		}
		rr, err := parseRule(r.Rrule, r.StartDate)
		if err != nil {
			continue
		}
		ru := rule{rr: rr, shift: r.HolidayShift, off: off}
		account, transfer, category, amount := lines(d.entries[r.ID])
		payee := ""
		if r.PayeeName.Valid {
			payee = r.PayeeName.String
		}
		cur := day(r.NextOccurrence.Time)
		for i := 0; i < 1000; i++ {
			o, ok := ru.next(cur, posted[r.ID], d.skips[r.ID])
			if !ok || o.Nominal.After(until.Add(shiftPad)) {
				break
			}
			cur = addDays(o.Nominal, 1)
			if o.Date.After(until) {
				continue
			}
			if r.CardID.Valid {
				// Shown once its statement has closed, for what it still asks.
				_, due, err := h.s.autopayDue(ctx, req.BudgetId, r.CardID.UUID, o)
				if err != nil {
					return nil, err
				}
				if due > 0 {
					card := r.CardID.UUID
					out = append(out, api.Occurrence{
						ScheduleId: r.ID, Occurrence: apiDate(o.Nominal), Date: apiDate(o.Date), Note: r.Note,
						AccountId: autopayFrom, TransferAccountId: &card, Amount: -due,
					})
				}
				continue
			}
			out = append(out, api.Occurrence{
				ScheduleId: r.ID, Occurrence: apiDate(o.Nominal), Date: apiDate(o.Date), Payee: payee, Note: r.Note,
				AccountId: account, TransferAccountId: transfer, CategoryId: category, Amount: amount, Estimate: r.AmountIsEstimate,
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Date.Before(out[j].Date.Time) })
	return api.ListUpcoming200JSONResponse(out), nil
}

// lockOwned locks a schedule of the budget, or answers 404.
func lockOwned(ctx context.Context, q *db.Queries, budgetID, id uuid.UUID) (db.LockScheduleRow, error) {
	sc, err := q.LockSchedule(ctx, id)
	if isNoRows(err) || (err == nil && sc.BudgetID != budgetID) {
		return db.LockScheduleRow{}, notFound("schedule")
	}
	return sc, err
}

// refreshNext moves the schedule's next occurrence to the first one from
// floor that is neither posted nor skipped.
func (s *Service) refreshNext(ctx context.Context, q *db.Queries, sc db.LockScheduleRow, r rule, floor time.Time) error {
	skipped, err := skipSet(ctx, q, sc.ID)
	if err != nil {
		return err
	}
	posted, err := s.postedSince(ctx, q, sc.BudgetID, floor)
	if err != nil {
		return err
	}
	next := pgtype.Date{}
	if o, ok := r.next(floor, posted[sc.ID], skipped); ok {
		next = pgDate(o.Nominal)
	}
	return q.SetNextOccurrence(ctx, db.SetNextOccurrenceParams{ID: sc.ID, NextOccurrence: next})
}

func alreadyPosted() error {
	return apperr.New(http.StatusConflict, "already_posted", "this occurrence has been posted")
}

func notAnOccurrence() error {
	return apperr.BadRequest("not_an_occurrence", "the schedule has no occurrence on that date")
}

func (h *Handlers) SkipOccurrence(ctx context.Context, req api.SkipOccurrenceRequestObject) (api.SkipOccurrenceResponseObject, error) {
	occ := day(req.Body.Occurrence.Time)
	err := h.s.inTx(ctx, func(q *db.Queries) error {
		sc, err := lockOwned(ctx, q, req.BudgetId, req.ScheduleId)
		if err != nil {
			return err
		}
		r, err := h.s.scheduleRule(ctx, sc.Rrule, sc.StartDate, sc.HolidayShift, occ, occ)
		if err != nil {
			return err
		}
		if !r.isOccurrence(occ) {
			return notAnOccurrence()
		}
		posted, err := h.s.postedSince(ctx, q, sc.BudgetID, occ)
		if err != nil {
			return err
		}
		if posted[sc.ID][occ] {
			return alreadyPosted()
		}
		if err := q.AddSkip(ctx, db.AddSkipParams{ScheduleID: sc.ID, OccurrenceDate: occ}); err != nil {
			return err
		}
		if !sc.NextOccurrence.Valid {
			return nil
		}
		return h.s.refreshNext(ctx, q, sc, r, day(sc.NextOccurrence.Time))
	})
	if err != nil {
		return nil, err
	}
	return api.SkipOccurrence204Response{}, nil
}

func (h *Handlers) UnskipOccurrence(ctx context.Context, req api.UnskipOccurrenceRequestObject) (api.UnskipOccurrenceResponseObject, error) {
	occ := day(req.Occurrence.Time)
	err := h.s.inTx(ctx, func(q *db.Queries) error {
		sc, err := lockOwned(ctx, q, req.BudgetId, req.ScheduleId)
		if err != nil {
			return err
		}
		n, err := q.RemoveSkip(ctx, db.RemoveSkipParams{ScheduleID: sc.ID, OccurrenceDate: occ})
		if err != nil {
			return err
		}
		if n == 0 {
			return notFound("skipped occurrence")
		}
		floor := occ
		if sc.NextOccurrence.Valid && day(sc.NextOccurrence.Time).Before(floor) {
			floor = day(sc.NextOccurrence.Time)
		}
		r, err := h.s.scheduleRule(ctx, sc.Rrule, sc.StartDate, sc.HolidayShift, floor, occ)
		if err != nil {
			return err
		}
		return h.s.refreshNext(ctx, q, sc, r, floor)
	})
	if err != nil {
		return nil, err
	}
	// An occurrence brought back from the past is due at once.
	if _, err := h.s.postDue(ctx, req.ScheduleId, h.s.today()); err != nil {
		return nil, err
	}
	return api.UnskipOccurrence204Response{}, nil
}

func (h *Handlers) PostOccurrence(ctx context.Context, req api.PostOccurrenceRequestObject) (api.PostOccurrenceResponseObject, error) {
	occ := day(req.Body.Occurrence.Time)
	var id uuid.UUID
	err := h.s.inTx(ctx, func(q *db.Queries) error {
		sc, err := lockOwned(ctx, q, req.BudgetId, req.ScheduleId)
		if err != nil {
			return err
		}
		r, err := h.s.scheduleRule(ctx, sc.Rrule, sc.StartDate, sc.HolidayShift, occ, occ)
		if err != nil {
			return err
		}
		if !r.isOccurrence(occ) {
			return notAnOccurrence()
		}
		skipped, err := skipSet(ctx, q, sc.ID)
		if err != nil {
			return err
		}
		if skipped[occ] {
			return apperr.New(http.StatusConflict, "occurrence_skipped", "this occurrence is skipped")
		}
		by := uuid.NullUUID{UUID: reqctx.Caller(ctx).UserID, Valid: true}
		o := occurrence{Nominal: occ, Date: r.move(occ)}
		if sc.CardID.Valid {
			// Autopay posts what its statement still asks (ADR-090).
			_, amount, err := h.s.autopayDue(ctx, sc.BudgetID, sc.CardID.UUID, o)
			if err != nil {
				return err
			}
			if amount == 0 {
				return apperr.New(http.StatusConflict, "nothing_due", "the statement this autopay pays asks for nothing")
			}
			if id, err = h.s.postAutopay(ctx, q, sc, o, by); err != nil {
				return err
			}
		} else {
			entries, err := q.ScheduleEntriesOf(ctx, sc.ID)
			if err != nil {
				return err
			}
			if id, err = insertOccurrenceID(ctx, q, sc.BudgetID, sc.ID, sc.PayeeID, sc.Note, sc.AmountIsEstimate, by, o, entries); err != nil {
				return err
			}
		}
		if id == uuid.Nil {
			return alreadyPosted()
		}
		if !sc.NextOccurrence.Valid {
			return nil
		}
		return h.s.refreshNext(ctx, q, sc, r, day(sc.NextOccurrence.Time))
	})
	if err != nil {
		return nil, err
	}
	return api.PostOccurrence200JSONResponse{TransactionId: id}, nil
}

func (h *Handlers) SetCategoryBase(ctx context.Context, req api.SetCategoryBaseRequestObject) (api.SetCategoryBaseResponseObject, error) {
	cats, err := h.s.q.ListCategories(ctx, req.BudgetId)
	if err != nil {
		return nil, err
	}
	found := false
	for _, c := range cats {
		found = found || c.ID == req.CategoryId
	}
	if !found {
		return nil, notFound("category")
	}
	if !envelopeSet(cats)[req.CategoryId] {
		return nil, apperr.BadRequest("not_an_envelope", "only envelopes have a base amount")
	}
	base := pgtype.Int8{}
	if req.Body.Amount > 0 {
		base = pgtype.Int8{Int64: req.Body.Amount, Valid: true}
	}
	if _, err := h.s.q.SetCategoryBase(ctx, db.SetCategoryBaseParams{BudgetID: req.BudgetId, ID: req.CategoryId, BudgetBase: base}); err != nil {
		return nil, err
	}
	return api.SetCategoryBase204Response{}, nil
}

// envelopeOf maps every expense category to the envelope its money is
// budgeted in: the topmost pooled category above it, or itself when it is
// an envelope (ADR-061). Categories in no envelope are missing.
func envelopeOf(cats []db.ListCategoriesRow) map[uuid.UUID]uuid.UUID {
	byID := make(map[uuid.UUID]db.ListCategoriesRow, len(cats))
	for _, c := range cats {
		byID[c.ID] = c
	}
	envelopes := envelopeSet(cats)
	out := map[uuid.UUID]uuid.UUID{}
	for _, c := range cats {
		if c.Kind != db.CategoryKindExpense || c.IsSystem {
			continue
		}
		top := uuid.Nil
		for p := c.ParentID; p.Valid; {
			parent, ok := byID[p.UUID]
			if !ok {
				break
			}
			if parent.Pooled {
				top = parent.ID
			}
			p = parent.ParentID
		}
		switch {
		case top != uuid.Nil:
			out[c.ID] = top
		case envelopes[c.ID]:
			out[c.ID] = c.ID
		}
	}
	return out
}

// monthTargets is every envelope's target for the month (ADR-086).
func (s *Service) monthTargets(ctx context.Context, budgetID uuid.UUID, month time.Time) ([]api.EnvelopeTarget, error) {
	cats, err := s.q.ListCategories(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	envelope := envelopeOf(cats)
	envelopes := envelopeSet(cats)
	targets := map[uuid.UUID]*api.EnvelopeTarget{}
	target := func(id uuid.UUID) *api.EnvelopeTarget {
		t, ok := targets[id]
		if !ok {
			t = &api.EnvelopeTarget{CategoryId: id, Schedules: []api.ScheduleShare{}, Goals: []api.GoalShare{}}
			targets[id] = t
		}
		return t
	}
	for _, c := range cats {
		if c.BudgetBase.Valid && envelopes[c.ID] {
			t := target(c.ID)
			base := c.BudgetBase.Int64
			t.Base = &base
			t.Total += base
		}
	}

	d, err := s.loadSchedules(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	if len(d.rows) > 0 {
		off, err := s.daysOff(ctx, month.AddDate(0, -targetWindow-1, 0), month.AddDate(0, targetWindow+2, 0))
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
			shares := map[uuid.UUID]int64{}
			for _, e := range d.entries[r.ID] {
				if !e.CategoryID.Valid {
					continue
				}
				env, ok := envelope[e.CategoryID.UUID]
				if !ok {
					continue
				}
				shares[env] += monthShare(targetInput{
					rule: ru, mode: r.BudgetMode, created: r.CreatedAt, skipped: d.skips[r.ID], amount: -e.Amount,
				}, month)
			}
			for env, amount := range shares {
				if amount == 0 {
					continue
				}
				t := target(env)
				t.Schedules = append(t.Schedules, api.ScheduleShare{ScheduleId: r.ID, Amount: amount})
				t.Total += amount
			}
		}
	}

	// Goals ask after the schedules, in priority order (ADR-093).
	goals, asks, err := s.goalAsks(ctx, budgetID, month, envelope)
	if err != nil {
		return nil, err
	}
	for _, g := range goals {
		if amount := asks[g.id]; amount > 0 {
			t := target(g.envelope)
			t.Goals = append(t.Goals, api.GoalShare{GoalId: g.id, Amount: amount})
			t.Total += amount
		}
	}
	out := make([]api.EnvelopeTarget, 0, len(targets))
	for _, t := range targets {
		out = append(out, *t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CategoryId.String() < out[j].CategoryId.String() })
	return out, nil
}

// postedTwice aborts a :w that posts an occurrence posted meanwhile.
type postedTwice struct{ id uuid.UUID }

func (p postedTwice) Error() string { return "occurrence posted twice: " + p.id.String() }

func isUniqueViolation(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23505"
}

// checkOccurrences checks the 預定 rows of a :w (ADR-085): only new
// transactions post an occurrence, of a schedule of this budget, on a date
// its rule gives.
func (s *Service) checkOccurrences(ctx context.Context, budgetID uuid.UUID, upserts []api.TransactionInput,
	existing map[uuid.UUID]uuid.UUID, p *problems,
) error {
	var d *scheduleData
	for _, u := range upserts {
		o := u.Occurrence
		if o == nil {
			continue
		}
		if d == nil {
			loaded, err := s.loadSchedules(ctx, budgetID)
			if err != nil {
				return err
			}
			d = &loaded
		}
		if _, ok := existing[u.Id]; ok {
			p.add(u.Id, "", "already_saved", "only a new transaction posts a scheduled occurrence")
			continue
		}
		var row *db.ListSchedulesRow
		for i := range d.rows {
			if d.rows[i].ID == o.ScheduleId {
				row = &d.rows[i]
			}
		}
		if row == nil {
			p.add(u.Id, "", "not_found", "schedule not found")
			continue
		}
		rr, err := parseRule(row.Rrule, row.StartDate)
		if err != nil || !(rule{rr: rr, off: weekend}).isOccurrence(day(o.Occurrence.Time)) {
			p.add(u.Id, "date", "not_an_occurrence", "the schedule has no occurrence on that date")
		}
	}
	return nil
}

// advanceNext moves a schedule's next occurrence past those posted or
// skipped since.
func (s *Service) advanceNext(ctx context.Context, scheduleID uuid.UUID) error {
	return s.inTx(ctx, func(q *db.Queries) error {
		sc, err := q.LockSchedule(ctx, scheduleID)
		if isNoRows(err) {
			return nil
		}
		if err != nil || !sc.NextOccurrence.Valid {
			return err
		}
		floor := day(sc.NextOccurrence.Time)
		r, err := s.scheduleRule(ctx, sc.Rrule, sc.StartDate, sc.HolidayShift, floor, floor)
		if err != nil {
			return err
		}
		return s.refreshNext(ctx, q, sc, r, floor)
	})
}
