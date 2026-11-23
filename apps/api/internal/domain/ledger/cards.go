package ledger

// Credit card statements (M8, ADR-088, ADR-089): a card's statement and due
// days give its periods; the background job closes each period the day
// after its statement day, billing the card's entries up to it; what a
// statement asks for is computed from what was billed, unless the owner
// aligned it with the bank's bill; payments count by date.

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/apperr"
)

// ---------- the cycle

func daysIn(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

// closingDay is the statement day of a month, or the month's last day when
// it has no such day. month may run past December or before January.
func closingDay(year int, month time.Month, statementDay int) time.Time {
	first := time.Date(year, month, 1, 0, 0, 0, 0, time.UTC)
	d := min(statementDay, daysIn(first.Year(), first.Month()))
	return time.Date(first.Year(), first.Month(), d, 0, 0, 0, 0, time.UTC)
}

// closingOnOrAfter is the first closing day on or after d.
func closingOnOrAfter(d time.Time, statementDay int) time.Time {
	c := closingDay(d.Year(), d.Month(), statementDay)
	if !c.Before(d) {
		return c
	}
	return closingDay(d.Year(), d.Month()+1, statementDay)
}

// dueFor is the due date of the period closing on periodEnd: the due day of
// the same month when it is later than the statement day, else of the next
// month, moved to the next working day.
func dueFor(periodEnd time.Time, statementDay, dueDay int, off func(time.Time) bool) time.Time {
	month := periodEnd.Month()
	if dueDay <= statementDay {
		month++
	}
	due := closingDay(periodEnd.Year(), month, dueDay)
	for i := 0; i < 31 && off(due); i++ {
		due = due.AddDate(0, 0, 1)
	}
	return due
}

// dueWindow is how far after a closing its due date may fall, moved off
// days off included, for loading the calendar.
const dueWindow = 70 * 24 * time.Hour

// ensureOpenStatement gives the card an open statement for its settings:
// the one there is gets its last day and due date again (its first day
// stays), or a new one runs from the day after the last closing (or the
// previous statement day) to the next statement day from today.
func (s *Service) ensureOpenStatement(ctx context.Context, q *db.Queries, budgetID, card uuid.UUID, statementDay, dueDay int, off func(time.Time) bool) error {
	today := s.today()
	open, err := q.GetOpenStatement(ctx, db.GetOpenStatementParams{BudgetID: budgetID, AccountID: card})
	if err == nil {
		end := closingOnOrAfter(later(today, open.PeriodStart), statementDay)
		return q.UpdateOpenStatement(ctx, db.UpdateOpenStatementParams{
			BudgetID: budgetID, ID: open.ID, PeriodEnd: end, DueDate: dueFor(end, statementDay, dueDay, off),
		})
	}
	if !isNoRows(err) {
		return err
	}
	var start, end time.Time
	last, err := q.LastClosingDay(ctx, card)
	switch {
	case err == nil:
		start = last.AddDate(0, 0, 1)
		end = closingOnOrAfter(later(today, start), statementDay)
	case isNoRows(err):
		end = closingOnOrAfter(today, statementDay)
		start = closingDay(end.Year(), end.Month()-1, statementDay).AddDate(0, 0, 1)
	default:
		return err
	}
	return q.CreateStatement(ctx, db.CreateStatementParams{
		BudgetID: budgetID, AccountID: card, PeriodStart: start, PeriodEnd: end,
		DueDate: dueFor(end, statementDay, dueDay, off),
	})
}

func later(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

// CloseStatements closes every open statement whose statement day has
// passed: it bills the card's entries up to that day and opens the next
// one; a card that missed several closings catches up one at a time.
func (s *Service) CloseStatements(ctx context.Context) (int, error) {
	today := s.today()
	closed := 0
	for {
		due, err := s.q.ListClosableStatements(ctx, today)
		if err != nil || len(due) == 0 {
			return closed, err
		}
		off, err := s.daysOff(ctx, due[0].PeriodEnd, today.Add(dueWindow))
		if err != nil {
			return closed, err
		}
		for _, st := range due {
			sd, dd := int(st.StatementDay), int(st.DueDay)
			err := s.inTx(ctx, func(q *db.Queries) error {
				if _, err := q.BillEntries(ctx, db.BillEntriesParams{
					StatementID: uuid.NullUUID{UUID: st.ID, Valid: true}, BudgetID: st.BudgetID,
					AccountID: st.AccountID, PeriodEnd: st.PeriodEnd,
				}); err != nil {
					return err
				}
				if err := q.CloseStatement(ctx, st.ID); err != nil {
					return err
				}
				start := st.PeriodEnd.AddDate(0, 0, 1)
				end := closingOnOrAfter(start, sd)
				return q.CreateStatement(ctx, db.CreateStatementParams{
					BudgetID: st.BudgetID, AccountID: st.AccountID, PeriodStart: start, PeriodEnd: end,
					DueDate: dueFor(end, sd, dd, off),
				})
			})
			if err != nil {
				return closed, err
			}
			closed++
		}
	}
}

// ---------- card settings

func cardResponse(c db.CreditCard) *api.CardSettings {
	out := &api.CardSettings{
		StatementDay: int32(c.StatementDay), DueDay: int32(c.DueDay), AutopayAccountId: idPtr(c.AutopayAccountID),
	}
	if c.CreditLimit.Valid {
		limit := c.CreditLimit.Int64
		out.CreditLimit = &limit
	}
	return out
}

// cardSettings are the budget's cards' settings, by account.
func (s *Service) cardSettings(ctx context.Context, budgetID uuid.UUID) (map[uuid.UUID]*api.CardSettings, error) {
	rows, err := s.q.ListCardSettings(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]*api.CardSettings, len(rows))
	for _, r := range rows {
		out[r.AccountID] = cardResponse(db.CreditCard(r))
	}
	return out, nil
}

// checkCard validates a card's settings: the days, the limit, and an
// autopay account that is another budget account of the budget.
func (s *Service) checkCard(ctx context.Context, budgetID, card uuid.UUID, c api.CardSettings) error {
	if c.StatementDay < 1 || c.StatementDay > 31 || c.DueDay < 1 || c.DueDay > 31 {
		return apperr.BadRequest("invalid_card", "statement and due days are 1 to 31")
	}
	if c.CreditLimit != nil && *c.CreditLimit < 0 {
		return apperr.BadRequest("invalid_card", "the credit limit cannot be negative")
	}
	if c.AutopayAccountId == nil {
		return nil
	}
	if *c.AutopayAccountId == card {
		return apperr.BadRequest("invalid_autopay", "a card cannot pay itself")
	}
	a, err := s.q.GetAccount(ctx, db.GetAccountParams{BudgetID: budgetID, ID: *c.AutopayAccountId})
	if isNoRows(err) {
		return apperr.BadRequest("invalid_autopay", "the autopay account is not in this budget")
	}
	if err != nil {
		return err
	}
	if !a.OnBudget || (a.Kind != db.AccountKindCash && a.Kind != db.AccountKindBank) {
		return apperr.BadRequest("invalid_autopay", "a card is paid from a cash or bank account on the budget")
	}
	return nil
}

// saveCard writes a card's settings and gives it an open statement.
func (s *Service) saveCard(ctx context.Context, q *db.Queries, budgetID, card uuid.UUID, c api.CardSettings, off func(time.Time) bool) error {
	limit := pgtype.Int8{}
	if c.CreditLimit != nil {
		limit = pgtype.Int8{Int64: *c.CreditLimit, Valid: true}
	}
	err := q.UpsertCardSettings(ctx, db.UpsertCardSettingsParams{
		AccountID: card, StatementDay: int16(c.StatementDay), DueDay: int16(c.DueDay),
		CreditLimit: limit, AutopayAccountID: nullID(c.AutopayAccountId),
	})
	if err != nil {
		return err
	}
	if err := s.ensureOpenStatement(ctx, q, budgetID, card, int(c.StatementDay), int(c.DueDay), off); err != nil {
		return err
	}
	return s.saveAutopay(ctx, q, budgetID, card, c, off)
}

// cardDaysOff is the calendar for the due dates of statements closing from today.
func (s *Service) cardDaysOff(ctx context.Context) (func(time.Time) bool, error) {
	today := s.today()
	return s.daysOff(ctx, today, today.Add(2*dueWindow))
}

func notACard() error {
	return apperr.BadRequest("not_a_card", "only a credit card has statement settings")
}

// ---------- statements

func (h *Handlers) ListStatements(ctx context.Context, req api.ListStatementsRequestObject) (api.ListStatementsResponseObject, error) {
	acct, err := h.s.q.GetAccount(ctx, db.GetAccountParams{BudgetID: req.BudgetId, ID: req.AccountId})
	if isNoRows(err) || (err == nil && acct.Kind != db.AccountKindCreditCard) {
		return nil, notFound("credit card")
	}
	if err != nil {
		return nil, err
	}
	out := api.CardStatements{Statements: []api.Statement{}}
	settings, err := h.s.q.GetCardSettings(ctx, db.GetCardSettingsParams{BudgetID: req.BudgetId, AccountID: req.AccountId})
	switch {
	case err == nil:
		out.Card = cardResponse(db.CreditCard(settings))
	case !isNoRows(err):
		return nil, err
	}

	closed, open, err := h.s.cardStatements(ctx, req.BudgetId, req.AccountId, true)
	if err != nil {
		return nil, err
	}
	out.Open = open
	out.Statements = append(out.Statements, closed...)
	return api.ListStatements200JSONResponse(out), nil
}

// cardStatements are the card's closed statements, newest first, with what
// each asks and the latest one's payments since; and its open statement
// when `withOpen`.
func (s *Service) cardStatements(ctx context.Context, budgetID, card uuid.UUID, withOpen bool) ([]api.Statement, *api.OpenStatement, error) {
	rows, err := s.q.ListStatements(ctx, db.ListStatementsParams{BudgetID: budgetID, AccountID: card})
	if err != nil {
		return nil, nil, err
	}
	var open *api.OpenStatement
	// Oldest first: each closed statement owes what was billed up to it.
	var billed, previous int64
	closed := make([]api.Statement, 0, len(rows))
	for i := len(rows) - 1; i >= 0; i-- {
		r := rows[i]
		if !r.ClosedAt.Valid {
			if !withOpen {
				continue
			}
			unbilled, err := s.q.UnbilledEntries(ctx, db.UnbilledEntriesParams{BudgetID: budgetID, AccountID: card})
			if err != nil {
				return nil, nil, err
			}
			open = &api.OpenStatement{
				Id: r.ID, PeriodStart: apiDate(r.PeriodStart), PeriodEnd: apiDate(r.PeriodEnd), DueDate: apiDate(r.DueDate),
				Charges: -unbilled.Charges, Payments: unbilled.Payments,
			}
			continue
		}
		billed += r.Payments + r.Charges
		computed := max(-billed, 0)
		due := computed
		if r.AmountDue.Valid {
			due = r.AmountDue.Int64
		}
		closed = append(closed, api.Statement{
			Id: r.ID, PeriodStart: apiDate(r.PeriodStart), PeriodEnd: apiDate(r.PeriodEnd), DueDate: apiDate(r.DueDate),
			PreviousDue: previous, Charges: -r.Charges, Payments: r.Payments,
			AmountDue: due, ComputedDue: computed, Adjusted: r.AmountDue.Valid,
			State: api.Settled,
		})
		previous = due
	}
	if n := len(closed); n > 0 {
		latest := &closed[n-1]
		paid, err := s.q.PaymentsAfter(ctx, db.PaymentsAfterParams{
			BudgetID: budgetID, AccountID: card, After: latest.PeriodEnd.Time,
		})
		if err != nil {
			return nil, nil, err
		}
		latest.Paid = paid
		latest.Remaining = max(latest.AmountDue-paid, 0)
		latest.State = statementState(*latest, s.today())
	}
	newest := make([]api.Statement, 0, len(closed))
	for i := len(closed) - 1; i >= 0; i-- {
		newest = append(newest, closed[i])
	}
	return newest, open, nil
}

// statementState says where the latest statement is (ADR-089).
func statementState(st api.Statement, today time.Time) api.StatementState {
	switch {
	case st.Remaining == 0:
		return api.Paid
	case today.After(st.DueDate.Time):
		return api.Overdue
	case st.Paid > 0:
		return api.Partial
	default:
		return api.Due
	}
}

func (h *Handlers) SetStatementDue(ctx context.Context, req api.SetStatementDueRequestObject) (api.SetStatementDueResponseObject, error) {
	amount := pgtype.Int8{}
	if a := req.Body.Amount; a != nil {
		if *a < 0 {
			return nil, apperr.BadRequest("invalid_amount", "the amount due cannot be negative")
		}
		amount = pgtype.Int8{Int64: *a, Valid: true}
	}
	n, err := h.s.q.SetStatementDue(ctx, db.SetStatementDueParams{BudgetID: req.BudgetId, ID: req.StatementId, AmountDue: amount})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, apperr.New(http.StatusNotFound, "not_found", "no closed statement with this id")
	}
	return api.SetStatementDue204Response{}, nil
}

// SetBilling moves a card's entries out of its latest closed statement (to
// be billed at the next closing) or back into it (`:defer`, ADR-088).
func (h *Handlers) SetBilling(ctx context.Context, req api.SetBillingRequestObject) (api.SetBillingResponseObject, error) {
	acct, err := h.s.q.GetAccount(ctx, db.GetAccountParams{BudgetID: req.BudgetId, ID: req.AccountId})
	if isNoRows(err) || (err == nil && acct.Kind != db.AccountKindCreditCard) {
		return nil, notFound("credit card")
	}
	if err != nil {
		return nil, err
	}
	latest, err := h.s.q.LatestClosedStatement(ctx, db.LatestClosedStatementParams{BudgetID: req.BudgetId, AccountID: req.AccountId})
	if isNoRows(err) {
		return nil, apperr.BadRequest("no_statement", "the card has no closed statement yet")
	}
	if err != nil {
		return nil, err
	}
	statement := uuid.NullUUID{UUID: latest.ID, Valid: true}
	var n int64
	if req.Body.Billed {
		n, err = h.s.q.BillChosen(ctx, db.BillChosenParams{
			StatementID: statement, BudgetID: req.BudgetId, AccountID: req.AccountId,
			PeriodEnd: latest.PeriodEnd, Ids: req.Body.TransactionIds,
		})
	} else {
		n, err = h.s.q.UnbillChosen(ctx, db.UnbillChosenParams{
			BudgetID: req.BudgetId, AccountID: req.AccountId, StatementID: statement, Ids: req.Body.TransactionIds,
		})
	}
	if err != nil {
		return nil, err
	}
	return api.SetBilling200JSONResponse{Changed: int32(n), StatementId: latest.ID}, nil
}

// logClosed reports closings, for the scheduler.
func logClosed(ctx context.Context, n int, err error) {
	if err != nil {
		if ctx.Err() == nil {
			slog.Error("close card statements", "err", err)
		}
		return
	}
	if n > 0 {
		slog.Info("closed card statements", "count", n)
	}
}
