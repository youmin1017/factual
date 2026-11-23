package ledger

// Autopay (ADR-090): a card with an autopay account has its own schedule,
// the transfer from that account on the due day, moved to the next working
// day. Its amount is not stored: an occurrence pays the statement due on
// its date, what that statement still asks when it posts, so payments made
// before lower it and nothing is posted once it is paid.

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/reqctx"
)

// autopayRule is the RRULE of the due day: the day itself, or for days
// after the 28th the last of them the month has (as a statement's due
// date is).
func autopayRule(dueDay int) string {
	if dueDay <= 28 {
		return fmt.Sprintf("FREQ=MONTHLY;BYMONTHDAY=%d", dueDay)
	}
	days := make([]string, 0, 4)
	for d := 28; d <= dueDay; d++ {
		days = append(days, fmt.Sprint(d))
	}
	return "FREQ=MONTHLY;BYMONTHDAY=" + strings.Join(days, ",") + ";BYSETPOS=-1"
}

// saveAutopay gives the card its autopay schedule, or removes it when the
// card has no autopay account. The schedule runs from today.
func (s *Service) saveAutopay(ctx context.Context, q *db.Queries, budgetID, card uuid.UUID, c api.CardSettings, off func(time.Time) bool) error {
	if c.AutopayAccountId == nil {
		return q.DeleteAutopaySchedule(ctx, uuid.NullUUID{UUID: card, Valid: true})
	}
	id, err := q.GetAutopaySchedule(ctx, uuid.NullUUID{UUID: card, Valid: true})
	if isNoRows(err) {
		id, err = uuid.New(), nil
	}
	if err != nil {
		return err
	}
	today := s.today()
	text := autopayRule(int(c.DueDay))
	rr, err := parseRule(text, today)
	if err != nil {
		return err
	}
	next := pgtype.Date{}
	if o, ok := (rule{rr: rr, shift: db.HolidayShiftNextWorkday, off: off}).next(today, nil, nil); ok {
		next = pgDate(o.Nominal)
	}
	by := uuid.NullUUID{}
	if caller := reqctx.Caller(ctx).UserID; caller != uuid.Nil {
		by = uuid.NullUUID{UUID: caller, Valid: true}
	}
	return q.UpsertAutopaySchedule(ctx, db.UpsertAutopayScheduleParams{
		ID: id, BudgetID: budgetID, CardID: uuid.NullUUID{UUID: card, Valid: true},
		Source: fmt.Sprintf("每月 %d 日，遇假日延後", c.DueDay), Rrule: text, StartDate: today,
		NextOccurrence: next, CreatedBy: by,
	})
}

// autopayWindow is how far a statement's due date may be from an
// occurrence of its card's autopay and still be the one it pays.
const autopayWindow = 10 * 24 * time.Hour

// autopayDue is the statement an autopay occurrence pays and what it still
// asks: the latest closed one, when it is due around the occurrence's date
// (an occurrence before the first closing pays nothing).
func (s *Service) autopayDue(ctx context.Context, budgetID, card uuid.UUID, o occurrence) (uuid.UUID, int64, error) {
	closed, _, err := s.cardStatements(ctx, budgetID, card, false)
	if err != nil || len(closed) == 0 {
		return uuid.Nil, 0, err
	}
	latest := closed[0]
	due := latest.DueDate.Time
	if due.Before(o.Nominal.Add(-autopayWindow)) || due.After(o.Date.Add(autopayWindow)) {
		return uuid.Nil, 0, nil
	}
	return latest.Id, latest.Remaining, nil
}

// autopayAccount is where the card's autopay takes the money from.
func (s *Service) autopayAccount(ctx context.Context, budgetID, card uuid.UUID) (uuid.UUID, bool, error) {
	c, err := s.q.GetCardSettings(ctx, db.GetCardSettingsParams{BudgetID: budgetID, AccountID: card})
	if isNoRows(err) {
		return uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, false, err
	}
	return c.AutopayAccountID.UUID, c.AutopayAccountID.Valid, nil
}

// postAutopay posts one autopay occurrence for what its statement still
// asks, linked to it; nothing to pay records the occurrence as skipped.
// It returns the transaction (uuid.Nil when nothing was posted).
func (s *Service) postAutopay(ctx context.Context, q *db.Queries, sc db.LockScheduleRow, o occurrence, by uuid.NullUUID) (uuid.UUID, error) {
	card := sc.CardID.UUID
	from, ok, err := s.autopayAccount(ctx, sc.BudgetID, card)
	if err != nil {
		return uuid.Nil, err
	}
	statement, amount, err := s.autopayDue(ctx, sc.BudgetID, card, o)
	if err != nil {
		return uuid.Nil, err
	}
	if !ok || amount == 0 {
		return uuid.Nil, q.AddSkip(ctx, db.AddSkipParams{ScheduleID: sc.ID, OccurrenceDate: o.Nominal})
	}
	entries := []db.ScheduleEntriesOfRow{
		{AccountID: from, Amount: -amount},
		{AccountID: card, Amount: amount},
	}
	id, err := insertOccurrenceID(ctx, q, sc.BudgetID, sc.ID, sc.PayeeID, sc.Note, false, by, o, entries)
	if err != nil || id == uuid.Nil {
		return id, err
	}
	return id, q.RestoreEntryStatement(ctx, db.RestoreEntryStatementParams{
		TransactionID: id, AccountID: card, PaysStatementID: uuid.NullUUID{UUID: statement, Valid: true},
	})
}
