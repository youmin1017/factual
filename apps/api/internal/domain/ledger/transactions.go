package ledger

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/apperr"
	"factual/apps/api/internal/shared/reqctx"
)

const (
	maxPayeeLen = 64
	maxNoteLen  = 255
	maxMemoLen  = 255
)

func (h *Handlers) GetRegister(ctx context.Context, req api.GetRegisterRequestObject) (api.GetRegisterResponseObject, error) {
	if _, err := h.s.q.GetAccount(ctx, db.GetAccountParams{BudgetID: req.BudgetId, ID: req.AccountId}); err != nil {
		if isNoRows(err) {
			return nil, notFound("account")
		}
		return nil, err
	}
	txs, err := h.s.q.ListRegisterTransactions(ctx, db.ListRegisterTransactionsParams{BudgetID: req.BudgetId, AccountID: req.AccountId})
	if err != nil {
		return nil, err
	}
	entries, err := h.s.q.ListRegisterEntries(ctx, db.ListRegisterEntriesParams{BudgetID: req.BudgetId, AccountID: req.AccountId})
	if err != nil {
		return nil, err
	}
	return api.GetRegister200JSONResponse(transactionsOut(txs, entries)), nil
}

func (h *Handlers) GetScopeRegister(ctx context.Context, req api.GetScopeRegisterRequestObject) (api.GetScopeRegisterResponseObject, error) {
	var onBudget pgtype.Bool
	switch req.Params.Scope {
	case api.OnBudget:
		onBudget = pgtype.Bool{Bool: true, Valid: true}
	case api.OffBudget:
		onBudget = pgtype.Bool{Bool: false, Valid: true}
	case api.All:
	default:
		return nil, apperr.BadRequest("invalid_scope", "scope is all, onBudget or offBudget")
	}
	txs, err := h.s.q.ListScopeTransactions(ctx, db.ListScopeTransactionsParams{BudgetID: req.BudgetId, OnBudget: onBudget})
	if err != nil {
		return nil, err
	}
	entries, err := h.s.q.ListScopeEntries(ctx, db.ListScopeEntriesParams{BudgetID: req.BudgetId, OnBudget: onBudget})
	if err != nil {
		return nil, err
	}
	rows := make([]db.ListRegisterTransactionsRow, len(txs))
	for i, t := range txs {
		rows[i] = db.ListRegisterTransactionsRow(t)
	}
	es := make([]db.ListRegisterEntriesRow, len(entries))
	for i, e := range entries {
		es[i] = db.ListRegisterEntriesRow(e)
	}
	return api.GetScopeRegister200JSONResponse(transactionsOut(rows, es)), nil
}

// transactionsOut groups entries under their transactions, keeping the order of txs.
func transactionsOut(txs []db.ListRegisterTransactionsRow, entries []db.ListRegisterEntriesRow) []api.Transaction {
	byTx := make(map[uuid.UUID][]api.Entry, len(txs))
	for _, e := range entries {
		byTx[e.TransactionID] = append(byTx[e.TransactionID], api.Entry{
			Id: e.ID, AccountId: e.AccountID, CategoryId: idPtr(e.CategoryID), Amount: e.Amount,
			Memo: e.Memo, Cleared: api.ClearedState(e.Cleared),
		})
	}
	out := make([]api.Transaction, 0, len(txs))
	for _, t := range txs {
		tx := api.Transaction{
			Id: t.ID, Date: openapi_types.Date{Time: t.Date}, PayeeId: idPtr(t.PayeeID), Note: t.Note,
			NeedsReview: t.NeedsReview, IsOpening: t.IsOpening, Entries: byTx[t.ID],
		}
		if t.PayeeName.Valid {
			tx.PayeeName = &t.PayeeName.String
		}
		out = append(out, tx)
	}
	return out
}

// problems collects what is wrong with a batch, per transaction.
type problems []api.BatchProblem

func (p *problems) add(id uuid.UUID, field, code, message string) {
	*p = append(*p, api.BatchProblem{Id: id, Field: field, Code: code, Message: message})
}

func (h *Handlers) SaveTransactions(ctx context.Context, req api.SaveTransactionsRequestObject) (api.SaveTransactionsResponseObject, error) {
	budgetID := req.BudgetId
	b := req.Body

	accounts, err := h.s.q.ListAccountRefs(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	onBudget := make(map[uuid.UUID]bool, len(accounts))
	for _, a := range accounts {
		onBudget[a.ID] = a.OnBudget
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
	owners, err := h.s.q.GetTransactionOwners(ctx, ids)
	if err != nil {
		return nil, err
	}
	owner := make(map[uuid.UUID]uuid.UUID, len(owners))
	for _, o := range owners {
		owner[o.ID] = o.BudgetID
	}

	var probs problems
	if err := h.s.checkOccurrences(ctx, budgetID, b.Upserts, owner, &probs); err != nil {
		return nil, err
	}
	seen := make(map[uuid.UUID]bool, len(ids))
	for _, u := range b.Upserts {
		if seen[u.Id] {
			probs.add(u.Id, "", "duplicate_id", "the transaction appears twice in the batch")
			continue
		}
		seen[u.Id] = true
		if o, ok := owner[u.Id]; ok && o != budgetID {
			probs.add(u.Id, "", "not_found", "transaction not found")
			continue
		}
		validateTransaction(&probs, u, onBudget, isCategory)
	}
	for _, id := range b.Deletes {
		if seen[id] {
			probs.add(id, "", "duplicate_id", "the transaction is both saved and deleted")
			continue
		}
		seen[id] = true
		if o, ok := owner[id]; ok && o != budgetID {
			probs.add(id, "", "not_found", "transaction not found")
		}
	}
	if len(probs) > 0 {
		return api.SaveTransactions422JSONResponse{Errors: probs}, nil
	}

	caller := uuid.NullUUID{UUID: reqctx.Caller(ctx).UserID, Valid: true}
	var deleted int32
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		for _, id := range b.Deletes {
			n, err := q.DeleteTransaction(ctx, db.DeleteTransactionParams{BudgetID: budgetID, ID: id})
			if err != nil {
				return err
			}
			deleted += int32(n)
		}
		payees := map[string]uuid.UUID{}
		for _, u := range b.Upserts {
			payee := uuid.NullUUID{}
			if name := strings.TrimSpace(u.Payee); name != "" {
				id, ok := payees[name]
				if !ok {
					var err error
					if id, err = q.UpsertPayee(ctx, db.UpsertPayeeParams{BudgetID: budgetID, Name: name}); err != nil {
						return err
					}
					payees[name] = id
				}
				payee = uuid.NullUUID{UUID: id, Valid: true}
			}
			err := q.UpsertTransaction(ctx, db.UpsertTransactionParams{
				ID: u.Id, BudgetID: budgetID, Date: u.Date.Time, PayeeID: payee,
				Note: strings.TrimSpace(u.Note), CreatedBy: caller,
			})
			if err != nil {
				return err
			}
			if err := q.DeleteEntriesOf(ctx, db.DeleteEntriesOfParams{BudgetID: budgetID, TransactionID: u.Id}); err != nil {
				return err
			}
			for _, e := range u.Entries {
				err := q.CreateEntry(ctx, db.CreateEntryParams{
					BudgetID: budgetID, TransactionID: u.Id, AccountID: e.AccountId, CategoryID: nullID(e.CategoryId),
					Amount: e.Amount, Memo: strings.TrimSpace(e.Memo), Cleared: db.ClearedState(e.Cleared),
				})
				if err != nil {
					return err
				}
			}
			if o := u.Occurrence; o != nil {
				_, err := q.SetTransactionOccurrence(ctx, db.SetTransactionOccurrenceParams{
					ID: u.Id, ScheduleID: uuid.NullUUID{UUID: o.ScheduleId, Valid: true}, OccurrenceDate: pgDate(day(o.Occurrence.Time)),
				})
				if isUniqueViolation(err) {
					return postedTwice{id: u.Id}
				}
				if err != nil {
					return err
				}
			}
		}
		return nil
	})
	var twice postedTwice
	if errors.As(err, &twice) {
		var p problems
		p.add(twice.id, "", "already_posted", "this scheduled occurrence has been posted")
		return api.SaveTransactions422JSONResponse{Errors: p}, nil
	}
	if id, ok := unbalancedTransaction(err); ok {
		// The database's own check (ADR-023) caught what validation missed.
		var p problems
		p.add(id, "amount", "unbalanced", "uncategorized entries on budget accounts must sum to zero")
		return api.SaveTransactions422JSONResponse{Errors: p}, nil
	}
	if err != nil {
		return nil, err
	}
	for _, u := range b.Upserts {
		if u.Occurrence != nil {
			if err := h.s.advanceNext(ctx, u.Occurrence.ScheduleId); err != nil {
				return nil, err
			}
		}
	}
	return api.SaveTransactions200JSONResponse{Upserted: int32(len(b.Upserts)), Deleted: deleted}, nil
}

// validateTransaction checks one transaction against the rules the database
// enforces (ADR-023), so that problems are reported per transaction and
// field instead of failing the whole commit.
func validateTransaction(p *problems, u api.TransactionInput, onBudget map[uuid.UUID]bool, isCategory map[uuid.UUID]bool) {
	if utf8.RuneCountInString(strings.TrimSpace(u.Payee)) > maxPayeeLen {
		p.add(u.Id, "payee", "too_long", fmt.Sprintf("a payee is at most %d characters", maxPayeeLen))
	}
	if utf8.RuneCountInString(u.Note) > maxNoteLen {
		p.add(u.Id, "note", "too_long", fmt.Sprintf("a note is at most %d characters", maxNoteLen))
	}
	if len(u.Entries) == 0 {
		p.add(u.Id, "entries", "no_entries", "a transaction needs at least one entry")
		return
	}

	var unbalanced int64
	uncategorizedOnBudget := 0
	for _, e := range u.Entries {
		on, ok := onBudget[e.AccountId]
		if !ok {
			p.add(u.Id, "account", "unknown_account", "the account does not exist in this budget")
			return
		}
		if e.CategoryId != nil {
			if !isCategory[*e.CategoryId] {
				p.add(u.Id, "category", "unknown_category", "the category does not exist in this budget")
				return
			}
			if !on {
				p.add(u.Id, "category", "category_not_allowed", "entries on tracking accounts have no category")
				return
			}
		} else if on {
			unbalanced += e.Amount
			uncategorizedOnBudget++
		}
		if utf8.RuneCountInString(e.Memo) > maxMemoLen {
			p.add(u.Id, "note", "too_long", fmt.Sprintf("a memo is at most %d characters", maxMemoLen))
		}
	}
	if unbalanced != 0 {
		if uncategorizedOnBudget == 1 {
			// One budget account entry without a category: an ordinary
			// income or expense, or money moving to a tracking account,
			// which has to say what it is for.
			p.add(u.Id, "category", "category_required", "transactions on budget accounts need a category")
		} else {
			p.add(u.Id, "amount", "unbalanced", "the two sides of the transfer do not match")
		}
	}
}

var unbalancedPattern = regexp.MustCompile(`transaction ([0-9a-f-]{36}):`)

// unbalancedTransaction recognises the ledger trigger's error and returns the
// transaction it names.
func unbalancedTransaction(err error) (uuid.UUID, bool) {
	var pe *pgconn.PgError
	if !errors.As(err, &pe) || pe.Code != "23514" {
		return uuid.Nil, false
	}
	m := unbalancedPattern.FindStringSubmatch(pe.Message)
	if m == nil {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(m[1])
	return id, err == nil
}

// MarkReviewed confirms transactions a schedule posted with an estimated
// amount (`:review`, ADR-085).
func (h *Handlers) MarkReviewed(ctx context.Context, req api.MarkReviewedRequestObject) (api.MarkReviewedResponseObject, error) {
	n, err := h.s.q.MarkReviewed(ctx, db.MarkReviewedParams{BudgetID: req.BudgetId, Ids: req.Body.Ids})
	if err != nil {
		return nil, err
	}
	return api.MarkReviewed200JSONResponse{Reviewed: int32(n)}, nil
}
