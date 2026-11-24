package ledger

// Loans (ADR-096..098): a loan account's terms, the table worked out from
// them (loantable.go) and the ledger, the schedule that pays it, and
// aligning what it owes with the bank.

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/apperr"
	"factual/apps/api/internal/shared/reqctx"
)

// alignPayee is the payee of an alignment (ADR-098).
const alignPayee = "貸款調整"

func rateToAPI(r int64) float64 { return float64(r) / 10000 }

func rateFromAPI(x float64) int64 { return int64(math.Round(x * 10000)) }

func loanProblem(code, field, message string) error {
	return apperr.WithDetails(http.StatusBadRequest, code, message, map[string]any{"field": field})
}

func notALoan() error {
	return apperr.BadRequest("not_a_loan", "only a loan account has loan terms")
}

// loanSetup is a loan as stored: its terms, and the schedule that pays it
// (uuid.Nil without one).
type loanSetup struct {
	row      db.GetLoanRow
	terms    loanTerms
	schedule uuid.UUID
}

func termsFromDB(r db.GetLoanRow, rates []db.ListLoanRatesRow) loanTerms {
	t := loanTerms{
		principal: r.Principal, months: int(r.TermMonths), start: day(r.StartDate),
		firstPayment: day(r.FirstPaymentDate), equalPrincipal: r.Method == db.LoanMethodEqualPrincipal,
		grace: int(r.GraceMonths), reducePayment: r.PrepayMode == db.PrepayModeReducePayment,
	}
	for _, x := range rates {
		t.rates = append(t.rates, loanRate{from: day(x.EffectiveFrom), rate: x.Rate})
	}
	return t
}

// termsFromAPI checks terms as typed and turns them into the table's; the
// first rate applies from 撥款日.
func termsFromAPI(in api.LoanTerms) (loanTerms, error) {
	t := loanTerms{
		principal: in.Principal, months: int(in.TermMonths), start: day(in.StartDate.Time),
		firstPayment: day(in.FirstPaymentDate.Time), equalPrincipal: in.Method == api.EqualPrincipal,
		grace: int(in.GraceMonths), reducePayment: in.PrepayMode == api.ReducePayment,
	}
	switch {
	case t.principal <= 0:
		return t, loanProblem("amount_required", "principal", "a loan needs the amount lent")
	case t.months < 1 || t.months > 600:
		return t, loanProblem("invalid_term", "termMonths", "the term is 1 to 600 months")
	case !t.firstPayment.After(t.start):
		return t, loanProblem("invalid_first_payment", "firstPaymentDate", "the first payment comes after 撥款日")
	case t.grace < 0 || t.grace >= t.months:
		return t, loanProblem("invalid_grace", "graceMonths", "the grace period is shorter than the term")
	case len(in.Rates) == 0:
		return t, loanProblem("rate_required", "rates", "a loan needs its rate")
	}
	rates := append([]api.LoanRate(nil), in.Rates...)
	sort.SliceStable(rates, func(i, j int) bool { return rates[i].EffectiveFrom.Before(rates[j].EffectiveFrom.Time) })
	if day(rates[0].EffectiveFrom.Time).After(t.start) {
		return t, loanProblem("rate_after_start", "rates", "the first rate applies from 撥款日")
	}
	for i, r := range rates {
		if r.AnnualRate < 0 || r.AnnualRate > 100 {
			return t, loanProblem("invalid_rate", "rates", "a rate is 0 to 100 percent")
		}
		from := day(r.EffectiveFrom.Time)
		if i == 0 {
			from = t.start
		} else if !from.After(t.rates[i-1].from) {
			return t, loanProblem("duplicate_rate_date", "rates", "two rates start on the same day")
		}
		t.rates = append(t.rates, loanRate{from: from, rate: rateFromAPI(r.AnnualRate)})
	}
	return t, nil
}

// trackedFrom is the first payment after the day the loan was set up: the
// first its schedule pays.
func trackedFrom(t loanTerms, after time.Time) time.Time {
	n := 1
	for ; n <= t.months+120; n++ {
		if periodDate(t.firstPayment, n).After(after) {
			break
		}
	}
	return periodDate(t.firstPayment, n)
}

func (s *Service) loadLoan(ctx context.Context, q *db.Queries, budgetID, account uuid.UUID) (loanSetup, error) {
	row, err := q.GetLoan(ctx, db.GetLoanParams{BudgetID: budgetID, AccountID: account})
	if isNoRows(err) {
		return loanSetup{}, notFound("loan")
	}
	if err != nil {
		return loanSetup{}, err
	}
	rates, err := q.ListLoanRates(ctx, account)
	if err != nil {
		return loanSetup{}, err
	}
	l := loanSetup{row: row, terms: termsFromDB(row, rates)}
	id, err := q.GetLoanSchedule(ctx, uuid.NullUUID{UUID: account, Valid: true})
	switch {
	case err == nil:
		l.schedule = id
	case !isNoRows(err):
		return loanSetup{}, err
	}
	return l, nil
}

// loanLedger is the loan account's entries: those not posted by its
// schedule as moves, and what each posted occurrence paid.
func (s *Service) loanLedger(ctx context.Context, q *db.Queries, budgetID uuid.UUID, l loanSetup) (*loanActual, []db.ListLoanEntriesRow, error) {
	entries, err := q.ListLoanEntries(ctx, db.ListLoanEntriesParams{BudgetID: budgetID, AccountID: l.row.AccountID})
	if err != nil {
		return nil, nil, err
	}
	a := &loanActual{
		from:    trackedFrom(l.terms, day(l.row.TrackedAfter)),
		posted:  map[time.Time]loanPaid{},
		skipped: map[time.Time]bool{},
	}
	for _, e := range entries {
		if l.schedule != uuid.Nil && e.ScheduleID.Valid && e.ScheduleID.UUID == l.schedule && e.OccurrenceDate.Valid {
			continue
		}
		a.moves = append(a.moves, loanMove{date: day(e.Date), amount: e.Amount})
	}
	if l.schedule != uuid.Nil {
		paid, err := q.ListLoanPayments(ctx, db.ListLoanPaymentsParams{
			AccountID: l.row.AccountID, BudgetID: budgetID, ScheduleID: uuid.NullUUID{UUID: l.schedule, Valid: true},
		})
		if err != nil {
			return nil, nil, err
		}
		for _, p := range paid {
			a.posted[day(p.OccurrenceDate)] = loanPaid{principal: p.Principal, interest: p.Paid - p.Principal}
		}
		if a.skipped, err = skipSet(ctx, q, l.schedule); err != nil {
			return nil, nil, err
		}
	}
	return a, entries, nil
}

// loanDue is the period the loan's payment on the occurrence pays and
// whether there is something to post; ended when the loan owes nothing
// from then on.
func (s *Service) loanDue(ctx context.Context, q *db.Queries, budgetID, account uuid.UUID, occ time.Time) (l loanSetup, p loanPeriod, ok, ended bool, err error) {
	l, err = s.loadLoan(ctx, q, budgetID, account)
	if err != nil {
		return l, p, false, false, err
	}
	a, _, err := s.loanLedger(ctx, q, budgetID, l)
	if err != nil {
		return l, p, false, false, err
	}
	ended = true
	for _, x := range loanTable(l.terms, a) {
		if !x.tracked || x.date.Before(occ) {
			continue
		}
		ended = false
		if x.date.Equal(occ) {
			return l, x, !x.posted && !x.skipped && x.principal+x.interest > 0, false, nil
		}
		break
	}
	return l, p, false, ended, nil
}

// loanEntries is what a payment posts (ADR-097): the paying account gives
// the principal and the interest in their categories, the loan account
// receives the principal.
func loanEntries(l loanSetup, p loanPeriod) []db.ScheduleEntriesOfRow {
	from := l.row.PayFromAccountID.UUID
	var es []db.ScheduleEntriesOfRow
	if p.principal > 0 {
		es = append(es,
			db.ScheduleEntriesOfRow{AccountID: from, CategoryID: l.row.PrincipalCategoryID, Amount: -p.principal, Memo: "本金"},
			db.ScheduleEntriesOfRow{AccountID: l.row.AccountID, Amount: p.principal, Memo: "本金"},
		)
	}
	if p.interest > 0 {
		es = append(es, db.ScheduleEntriesOfRow{AccountID: from, CategoryID: l.row.InterestCategoryID, Amount: -p.interest, Memo: "利息"})
	}
	return es
}

func periodNote(l loanSetup, p loanPeriod) string {
	return fmt.Sprintf("第 %d/%d 期", p.n, l.terms.months)
}

// postLoan posts one occurrence of a loan's schedule for its period;
// ended when the loan owes nothing from then on.
func (s *Service) postLoan(ctx context.Context, q *db.Queries, sc db.LockScheduleRow, o occurrence, by uuid.NullUUID) (uuid.UUID, bool, error) {
	l, p, ok, ended, err := s.loanDue(ctx, q, sc.BudgetID, sc.LoanAccountID.UUID, o.Nominal)
	if err != nil || !ok {
		return uuid.Nil, ended, err
	}
	id, err := insertOccurrenceID(ctx, q, sc.BudgetID, sc.ID, sc.PayeeID, periodNote(l, p), false, by, o, loanEntries(l, p))
	return id, false, err
}

// loanUpcoming is the loan schedule's occurrences up to until, for the
// registers' 預定 rows.
func (s *Service) loanUpcoming(ctx context.Context, budgetID uuid.UUID, r db.ListSchedulesRow, ru rule, posted, skipped map[time.Time]bool, until time.Time) ([]api.Occurrence, error) {
	l, err := s.loadLoan(ctx, s.q, budgetID, r.LoanAccountID.UUID)
	if err != nil {
		return nil, err
	}
	if !l.row.PayFromAccountID.Valid {
		return nil, nil
	}
	a, _, err := s.loanLedger(ctx, s.q, budgetID, l)
	if err != nil {
		return nil, err
	}
	periods := map[time.Time]loanPeriod{}
	for _, p := range loanTable(l.terms, a) {
		if p.tracked && !p.posted && !p.skipped {
			periods[p.date] = p
		}
	}
	var out []api.Occurrence
	cur := day(r.NextOccurrence.Time)
	for i := 0; i < 1000; i++ {
		o, ok := ru.next(cur, posted, skipped)
		if !ok || o.Nominal.After(until.Add(shiftPad)) {
			break
		}
		cur = addDays(o.Nominal, 1)
		p, ok := periods[o.Nominal]
		if o.Date.After(until) || !ok || p.principal+p.interest == 0 {
			continue
		}
		occ := api.Occurrence{
			ScheduleId: r.ID, Occurrence: apiDate(o.Nominal), Date: apiDate(o.Date), Note: periodNote(l, p),
			AccountId: l.row.PayFromAccountID.UUID, Amount: -(p.principal + p.interest),
		}
		es := []api.OccurrenceEntry{}
		for _, e := range loanEntries(l, p) {
			es = append(es, api.OccurrenceEntry{AccountId: e.AccountID, CategoryId: idPtr(e.CategoryID), Amount: e.Amount, Memo: e.Memo})
		}
		occ.Entries = &es
		out = append(out, occ)
	}
	return out, nil
}

// ---------- the API

func periodToAPI(p loanPeriod, today time.Time) api.LoanPeriod {
	out := api.LoanPeriod{
		N: int32(p.n), Date: apiDate(p.date), AnnualRate: rateToAPI(p.rate),
		Principal: p.principal, Interest: p.interest, Balance: p.balance,
	}
	switch {
	case !p.tracked:
		out.State = api.LoanPeriodStateBefore
	case p.posted:
		out.State = api.LoanPeriodStatePosted
	case p.skipped:
		out.State = api.LoanPeriodStateSkipped
	case !p.date.After(today):
		out.State = api.LoanPeriodStatePending
	default:
		out.State = api.LoanPeriodStatePlanned
	}
	return out
}

func termsToAPI(l loanSetup) api.LoanTerms {
	r := l.row
	out := api.LoanTerms{
		Principal: r.Principal, TermMonths: r.TermMonths, StartDate: apiDate(day(r.StartDate)),
		FirstPaymentDate: apiDate(day(r.FirstPaymentDate)), Method: api.Annuity, GraceMonths: r.GraceMonths,
		PrepayMode: api.ShortenTerm, Rates: []api.LoanRate{}, PayFromAccountId: idPtr(r.PayFromAccountID),
		PrincipalCategoryId: idPtr(r.PrincipalCategoryID), InterestCategoryId: idPtr(r.InterestCategoryID),
		HolidayShift: shiftFromDB(r.HolidayShift),
	}
	if r.Method == db.LoanMethodEqualPrincipal {
		out.Method = api.EqualPrincipal
	}
	if r.PrepayMode == db.PrepayModeReducePayment {
		out.PrepayMode = api.ReducePayment
	}
	for _, x := range l.terms.rates {
		out.Rates = append(out.Rates, api.LoanRate{EffectiveFrom: apiDate(x.from), AnnualRate: rateToAPI(x.rate)})
	}
	return out
}

// loanCheck is what the terms leave owed before the first payment the
// schedule pays, against what the loan account says on that day.
func loanCheck(t loanTerms, from time.Time, moves []loanMove) api.LoanCheck {
	date, computed := t.start, t.principal
	for _, p := range loanTable(t, nil) {
		if !p.date.Before(from) {
			break
		}
		date, computed = p.date, p.balance
	}
	var recorded int64
	for _, m := range moves {
		if !m.date.After(date) {
			recorded -= m.amount
		}
	}
	return api.LoanCheck{Date: apiDate(date), Computed: computed, Recorded: recorded}
}

func (s *Service) loanDetails(ctx context.Context, budgetID, account uuid.UUID) (api.LoanDetails, error) {
	l, err := s.loadLoan(ctx, s.q, budgetID, account)
	if err != nil {
		return api.LoanDetails{}, err
	}
	a, entries, err := s.loanLedger(ctx, s.q, budgetID, l)
	if err != nil {
		return api.LoanDetails{}, err
	}
	today := s.today()
	var owed int64
	for _, e := range entries {
		if !day(e.Date).After(today) {
			owed -= e.Amount
		}
	}
	from := apiDate(a.from)
	check := loanCheck(l.terms, a.from, a.moves)
	out := api.LoanDetails{
		AccountId: account, Terms: termsToAPI(l), TrackedFrom: &from, PrincipalLeft: owed,
		PrincipalRepaid: l.terms.principal - owed, Periods: []api.LoanPeriod{}, Check: &check,
	}
	if l.schedule != uuid.Nil {
		id := l.schedule
		out.ScheduleId = &id
	}
	periods := loanTable(l.terms, a)
	for _, p := range periods {
		ap := periodToAPI(p, today)
		out.Periods = append(out.Periods, ap)
		switch ap.State {
		case api.LoanPeriodStateBefore, api.LoanPeriodStatePosted:
			out.InterestPaid += p.interest
		case api.LoanPeriodStatePending, api.LoanPeriodStatePlanned:
			out.PeriodsLeft++
			if out.NextPayment == nil {
				next := ap
				out.NextPayment = &next
			}
		}
	}
	if n := len(periods); n > 0 && periods[n-1].balance == 0 {
		end := apiDate(periods[n-1].date)
		out.PayoffDate = &end
	}
	return out, nil
}

// loanAccount is the budget's loan account, or a 404 or not_a_loan.
func (s *Service) loanAccount(ctx context.Context, q *db.Queries, budgetID, account uuid.UUID) error {
	acc, err := q.GetAccount(ctx, db.GetAccountParams{BudgetID: budgetID, ID: account})
	if isNoRows(err) {
		return notFound("account")
	}
	if err != nil {
		return err
	}
	if acc.Kind != db.AccountKindLoan {
		return notALoan()
	}
	return nil
}

func (h *Handlers) GetLoan(ctx context.Context, req api.GetLoanRequestObject) (api.GetLoanResponseObject, error) {
	out, err := h.s.loanDetails(ctx, req.BudgetId, req.AccountId)
	if err != nil {
		return nil, err
	}
	return api.GetLoan200JSONResponse(out), nil
}

func (h *Handlers) PreviewLoan(ctx context.Context, req api.PreviewLoanRequestObject) (api.PreviewLoanResponseObject, error) {
	if err := h.s.loanAccount(ctx, h.s.q, req.BudgetId, req.AccountId); err != nil {
		return nil, err
	}
	t, err := termsFromAPI(*req.Body)
	if err != nil {
		return nil, err
	}
	today := h.s.today()
	out := api.LoanPreview{Periods: []api.LoanPeriod{}}
	for _, p := range loanTable(t, nil) {
		ap := periodToAPI(p, today)
		if !p.date.After(today) {
			ap.State = api.LoanPeriodStateBefore
		}
		out.Periods = append(out.Periods, ap)
		out.TotalInterest += p.interest
		if p.n == t.grace+1 {
			out.Payment = p.principal + p.interest
		}
	}
	return api.PreviewLoan200JSONResponse(out), nil
}

// checkLoanRefs checks the account the loan is paid from and its
// categories: an open on-budget account of the budget, and expense
// categories it can spend in, both needed once it has the account.
func (s *Service) checkLoanRefs(ctx context.Context, budgetID, account uuid.UUID, in api.LoanTerms) error {
	if in.PayFromAccountId == nil {
		return nil
	}
	accounts, err := s.q.ListAccountRefs(ctx, budgetID)
	if err != nil {
		return err
	}
	okAccount := false
	for _, a := range accounts {
		if a.ID == *in.PayFromAccountId && a.ID != account && a.OnBudget && !a.Closed {
			okAccount = true
		}
	}
	if !okAccount {
		return loanProblem("invalid_pay_from", "payFromAccountId", "payments come from an open account on the budget")
	}
	cats, err := s.q.ListCategories(ctx, budgetID)
	if err != nil {
		return err
	}
	expense := map[uuid.UUID]bool{}
	for _, c := range cats {
		if c.Kind == db.CategoryKindExpense && !c.IsSystem && !c.Archived {
			expense[c.ID] = true
		}
	}
	for field, id := range map[string]*uuid.UUID{"principalCategoryId": in.PrincipalCategoryId, "interestCategoryId": in.InterestCategoryId} {
		if id == nil {
			return loanProblem("category_required", field, "payments need the categories they are spent in")
		}
		if !expense[*id] {
			return loanProblem("invalid_category", field, "the category is not an expense category of this budget")
		}
	}
	return nil
}

func (h *Handlers) SetLoan(ctx context.Context, req api.SetLoanRequestObject) (api.SetLoanResponseObject, error) {
	budgetID, account, in := req.BudgetId, req.AccountId, *req.Body
	if err := h.s.loanAccount(ctx, h.s.q, budgetID, account); err != nil {
		return nil, err
	}
	t, err := termsFromAPI(in)
	if err != nil {
		return nil, err
	}
	if err := h.s.checkLoanRefs(ctx, budgetID, account, in); err != nil {
		return nil, err
	}
	shift, ok := shiftToDB[in.HolidayShift]
	if !ok {
		shift = db.HolidayShiftNextWorkday
	}
	by := uuid.NullUUID{}
	if caller := reqctx.Caller(ctx).UserID; caller != uuid.Nil {
		by = uuid.NullUUID{UUID: caller, Valid: true}
	}
	today := h.s.today()
	var schedule uuid.UUID
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		trackedAfter := today
		existing, err := q.GetLoan(ctx, db.GetLoanParams{BudgetID: budgetID, AccountID: account})
		first := isNoRows(err)
		switch {
		case err == nil:
			trackedAfter = day(existing.TrackedAfter)
		case !first:
			return err
		}
		method, prepay := db.LoanMethodAnnuity, db.PrepayModeShortenTerm
		if t.equalPrincipal {
			method = db.LoanMethodEqualPrincipal
		}
		if t.reducePayment {
			prepay = db.PrepayModeReducePayment
		}
		err = q.UpsertLoan(ctx, db.UpsertLoanParams{
			AccountID: account, Principal: t.principal, TermMonths: int32(t.months), StartDate: t.start,
			FirstPaymentDate: t.firstPayment, Method: method, GraceMonths: int32(t.grace), PrepayMode: prepay,
			PayFromAccountID: nullID(in.PayFromAccountId), PrincipalCategoryID: nullID(in.PrincipalCategoryId),
			InterestCategoryID: nullID(in.InterestCategoryId), TrackedAfter: trackedAfter, HolidayShift: shift,
		})
		if err != nil {
			return err
		}
		if err := q.DeleteLoanRates(ctx, account); err != nil {
			return err
		}
		for _, r := range t.rates {
			if err := q.CreateLoanRate(ctx, db.CreateLoanRateParams{LoanAccountID: account, EffectiveFrom: r.from, Rate: r.rate}); err != nil {
				return err
			}
		}
		from := trackedFrom(t, trackedAfter)

		// An account with nothing in it starts owing what the terms leave
		// owed before the first payment it tracks (ADR-098).
		if first {
			n, err := q.CountAccountEntries(ctx, db.CountAccountEntriesParams{BudgetID: budgetID, AccountID: account})
			if err != nil {
				return err
			}
			if check := loanCheck(t, from, nil); n == 0 && check.Computed > 0 {
				tx, err := q.CreateOpeningTransaction(ctx, db.CreateOpeningTransactionParams{
					BudgetID: budgetID, Date: check.Date.Time, CreatedBy: by,
				})
				if err != nil {
					return err
				}
				err = q.CreateEntry(ctx, db.CreateEntryParams{
					BudgetID: budgetID, TransactionID: tx, AccountID: account,
					Amount: -check.Computed, Cleared: db.ClearedStateCleared,
				})
				if err != nil {
					return err
				}
			}
		}

		if in.PayFromAccountId == nil {
			return q.DeleteLoanSchedule(ctx, uuid.NullUUID{UUID: account, Valid: true})
		}
		schedule, err = q.GetLoanSchedule(ctx, uuid.NullUUID{UUID: account, Valid: true})
		if isNoRows(err) {
			schedule, err = uuid.New(), nil
		}
		if err != nil {
			return err
		}
		text := autopayRule(t.firstPayment.Day())
		r, err := h.s.scheduleRule(ctx, text, from, shift, from, from.AddDate(0, 2, 0))
		if err != nil {
			return err
		}
		skipped, err := skipSet(ctx, q, schedule)
		if err != nil {
			return err
		}
		posted, err := h.s.postedSince(ctx, q, budgetID, from)
		if err != nil {
			return err
		}
		next := pgtype.Date{}
		if o, ok := r.next(from, posted[schedule], skipped); ok {
			next = pgDate(o.Nominal)
		}
		source := fmt.Sprintf("每月 %d 日", t.firstPayment.Day())
		return q.UpsertLoanSchedule(ctx, db.UpsertLoanScheduleParams{
			ID: schedule, BudgetID: budgetID, LoanAccountID: uuid.NullUUID{UUID: account, Valid: true},
			Source: source, Rrule: text, StartDate: from, HolidayShift: shift, NextOccurrence: next, CreatedBy: by,
		})
	})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	// Periods already due (terms set again after some were missed) post now,
	// as saving a schedule does (ADR-085).
	if schedule != uuid.Nil {
		if _, err := h.s.postDue(ctx, schedule, today); err != nil {
			return nil, err
		}
	}
	out, err := h.s.loanDetails(ctx, budgetID, account)
	if err != nil {
		return nil, err
	}
	return api.SetLoan200JSONResponse(out), nil
}

func (h *Handlers) DeleteLoan(ctx context.Context, req api.DeleteLoanRequestObject) (api.DeleteLoanResponseObject, error) {
	err := h.s.inTx(ctx, func(q *db.Queries) error {
		if _, err := q.GetLoan(ctx, db.GetLoanParams{BudgetID: req.BudgetId, AccountID: req.AccountId}); err != nil {
			if isNoRows(err) {
				return notFound("loan")
			}
			return err
		}
		if err := q.DeleteLoanSchedule(ctx, uuid.NullUUID{UUID: req.AccountId, Valid: true}); err != nil {
			return err
		}
		_, err := q.DeleteLoan(ctx, req.AccountId)
		return err
	})
	if err != nil {
		return nil, err
	}
	return api.DeleteLoan204Response{}, nil
}

func (h *Handlers) AlignLoan(ctx context.Context, req api.AlignLoanRequestObject) (api.AlignLoanResponseObject, error) {
	budgetID, account := req.BudgetId, req.AccountId
	date := day(req.Body.Date.Time)
	if req.Body.PrincipalLeft < 0 {
		return nil, loanProblem("invalid_amount", "principalLeft", "what is owed is not below zero")
	}
	out := api.AlignLoan200JSONResponse{}
	err := h.s.inTx(ctx, func(q *db.Queries) error {
		if _, err := q.GetLoan(ctx, db.GetLoanParams{BudgetID: budgetID, AccountID: account}); err != nil {
			if isNoRows(err) {
				return notFound("loan")
			}
			return err
		}
		entries, err := q.ListLoanEntries(ctx, db.ListLoanEntriesParams{BudgetID: budgetID, AccountID: account})
		if err != nil {
			return err
		}
		var owed int64
		for _, e := range entries {
			if !day(e.Date).After(date) {
				owed -= e.Amount
			}
		}
		adjust := owed - req.Body.PrincipalLeft
		if adjust == 0 {
			return nil
		}
		payee, err := q.UpsertPayee(ctx, db.UpsertPayeeParams{BudgetID: budgetID, Name: alignPayee})
		if err != nil {
			return err
		}
		by := uuid.NullUUID{UUID: reqctx.Caller(ctx).UserID, Valid: true}
		id := uuid.New()
		err = q.UpsertTransaction(ctx, db.UpsertTransactionParams{
			ID: id, BudgetID: budgetID, Date: date, PayeeID: uuid.NullUUID{UUID: payee, Valid: true},
			Note: "對齊銀行的剩餘本金", CreatedBy: by,
		})
		if err != nil {
			return err
		}
		err = q.CreateEntry(ctx, db.CreateEntryParams{
			BudgetID: budgetID, TransactionID: id, AccountID: account, Amount: adjust, Cleared: db.ClearedStateCleared,
		})
		if err != nil {
			return err
		}
		out.TransactionId, out.Adjustment = &id, adjust
		return nil
	})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	return out, nil
}
