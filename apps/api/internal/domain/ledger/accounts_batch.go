package ledger

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/apperr"
	"factual/apps/api/internal/shared/reqctx"
)

// The accounts page saves its buffer in one request (:w, ADR-108), as the
// goals and schedules pages do: new accounts with their opening balances,
// renames, the order, card settings, closing and deleting. A loan's terms
// are still set in its own dialog (ADR-096, ADR-100).

const maxAccountNameLen = 64

func (h *Handlers) SaveAccounts(ctx context.Context, req api.SaveAccountsRequestObject) (api.SaveAccountsResponseObject, error) {
	budgetID := req.BudgetId
	b := req.Body
	heads, err := h.s.q.ListAccountHeads(ctx, budgetID)
	if err != nil {
		return nil, err
	}
	head := make(map[uuid.UUID]db.ListAccountHeadsRow, len(heads))
	for _, x := range heads {
		head[x.ID] = x
	}
	ids := make([]uuid.UUID, 0, len(b.Upserts)+len(b.Deletes))
	for _, u := range b.Upserts {
		ids = append(ids, u.Id)
	}
	ids = append(ids, b.Deletes...)
	owners, err := h.s.q.GetAccountOwners(ctx, ids)
	if err != nil {
		return nil, err
	}
	elsewhere := map[uuid.UUID]bool{}
	for _, o := range owners {
		if o.BudgetID != budgetID {
			elsewhere[o.ID] = true
		}
	}

	var probs problems
	seen := make(map[uuid.UUID]bool, len(ids))
	deleted := map[uuid.UUID]bool{}
	for _, id := range b.Deletes {
		deleted[id] = true
	}
	// The names the accounts will have, to refuse two of the same.
	names := map[string]uuid.UUID{}
	renamed := map[uuid.UUID]bool{}
	for _, u := range b.Upserts {
		renamed[u.Id] = true
	}
	for _, x := range heads {
		if !renamed[x.ID] && !deleted[x.ID] {
			names[x.Name] = x.ID
		}
	}
	var off func(time.Time) bool
	terms := map[uuid.UUID]loanTerms{}
	for _, u := range b.Upserts {
		if seen[u.Id] {
			probs.add(u.Id, "", "duplicate_id", "the account appears twice in the batch")
			continue
		}
		seen[u.Id] = true
		if elsewhere[u.Id] {
			probs.add(u.Id, "", "not_found", "account not found")
			continue
		}
		name := strings.TrimSpace(u.Name)
		if name == "" || utf8.RuneCountInString(name) > maxAccountNameLen {
			probs.add(u.Id, "name", "invalid_name", "a name is 1 to 64 characters")
			continue
		}
		if other, ok := names[name]; ok && other != u.Id {
			probs.add(u.Id, "name", "name_taken", "an account of that name already exists")
			continue
		}
		names[name] = u.Id
		cur, exists := head[u.Id]
		if exists && cur.Kind == db.AccountKindFriend {
			probs.add(u.Id, "", "friend_account", "a friend account is changed on the friend's page")
			continue
		}
		if u.Closed && (!exists || !cur.Closed) && exists && cur.Balance != 0 {
			probs.add(u.Id, "closed", "account_not_empty", "an account can only be closed with a zero balance")
			continue
		}
		if u.Closed && !exists && u.OpeningBalance != 0 {
			probs.add(u.Id, "closed", "account_not_empty", "an account can only be closed with a zero balance")
			continue
		}
		if u.Card != nil {
			kind := api.NewAccountKind(cur.Kind)
			if !exists {
				kind = u.Kind
			}
			if kind != api.NewAccountKindCreditCard {
				probs.add(u.Id, "card", "not_a_card", "only a credit card has statement settings")
				continue
			}
			if err := h.s.checkCard(ctx, budgetID, u.Id, *u.Card); err != nil {
				if code, msg, ok := problemOf(err); ok {
					probs.add(u.Id, "card", code, msg)
					continue
				}
				return nil, err
			}
			if off == nil {
				if off, err = h.s.cardDaysOff(ctx); err != nil {
					return nil, err
				}
			}
		}
	}
	for _, u := range b.Upserts {
		if u.Loan == nil || probs.has(u.Id) {
			continue
		}
		cur, exists := head[u.Id]
		isLoan := (exists && cur.Kind == db.AccountKindLoan) || (!exists && u.Kind == api.NewAccountKindLoan)
		if !isLoan {
			probs.add(u.Id, "loan", "not_a_loan", "only a loan account has loan terms")
			continue
		}
		account := u.Id
		if !exists {
			account = uuid.Nil
		}
		t, err := h.s.checkLoan(ctx, budgetID, account, *u.Loan)
		if err != nil {
			if code, msg, ok := problemOf(err); ok {
				probs.add(u.Id, "loan", code, msg)
				continue
			}
			return nil, err
		}
		terms[u.Id] = t
	}
	for _, id := range b.Deletes {
		if seen[id] {
			probs.add(id, "", "duplicate_id", "the account is both saved and deleted")
			continue
		}
		seen[id] = true
		cur, ok := head[id]
		switch {
		case elsewhere[id] || !ok:
			probs.add(id, "", "not_found", "account not found")
		case cur.Kind == db.AccountKindFriend:
			probs.add(id, "", "friend_account", "a friend account is changed on the friend's page")
		case cur.HasActivity:
			probs.add(id, "", "account_in_use", "the account has transactions; close it instead")
		}
	}
	if len(probs) > 0 {
		return api.SaveAccounts422JSONResponse{Errors: probs}, nil
	}

	caller := uuid.NullUUID{UUID: reqctx.Caller(ctx).UserID, Valid: true}
	var removed int32
	var schedules []uuid.UUID
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		for _, id := range b.Deletes {
			if err := q.DeleteOpeningTransactions(ctx, db.DeleteOpeningTransactionsParams{BudgetID: budgetID, AccountID: id}); err != nil {
				return err
			}
			n, err := q.DeleteAccount(ctx, db.DeleteAccountParams{BudgetID: budgetID, ID: id})
			if err != nil {
				return err
			}
			removed += int32(n)
		}
		// Names move first to placeholders, so that two accounts can swap
		// theirs within one save.
		for _, u := range b.Upserts {
			if _, ok := head[u.Id]; ok {
				err := q.UpdateAccount(ctx, db.UpdateAccountParams{BudgetID: budgetID, ID: u.Id, Name: u.Id.String(), Closed: head[u.Id].Closed})
				if err != nil {
					return err
				}
			}
		}
		for _, u := range b.Upserts {
			name := strings.TrimSpace(u.Name)
			if _, ok := head[u.Id]; ok {
				err := q.UpdateAccount(ctx, db.UpdateAccountParams{BudgetID: budgetID, ID: u.Id, Name: name, Closed: u.Closed})
				if err != nil {
					return err
				}
				if err := q.SetAccountOrder(ctx, db.SetAccountOrderParams{BudgetID: budgetID, ID: u.Id, SortOrder: u.SortOrder}); err != nil {
					return err
				}
			} else {
				onBudget := onBudgetFor(u.Kind, u.OnBudget)
				err := q.CreateAccountWithID(ctx, db.CreateAccountWithIDParams{
					ID: u.Id, BudgetID: budgetID, Name: name, Kind: db.AccountKind(u.Kind), OnBudget: onBudget, SortOrder: u.SortOrder,
				})
				if err != nil {
					return err
				}
				// A loan with terms starts owing what they leave owed (ADR-098).
				if _, withTerms := terms[u.Id]; !withTerms {
					if err := createOpening(ctx, q, budgetID, u.Id, onBudget, u.OpeningBalance, u.OpeningDate.Time, caller); err != nil {
						return err
					}
				}
				if u.Closed {
					if err := q.UpdateAccount(ctx, db.UpdateAccountParams{BudgetID: budgetID, ID: u.Id, Name: name, Closed: true}); err != nil {
						return err
					}
				}
			}
			if u.Card != nil {
				if err := h.s.saveCard(ctx, q, budgetID, u.Id, *u.Card, off); err != nil {
					return err
				}
			}
			if t, ok := terms[u.Id]; ok {
				schedule, err := h.s.saveLoan(ctx, q, budgetID, u.Id, t, *u.Loan)
				if err != nil {
					return err
				}
				if schedule != uuid.Nil {
					schedules = append(schedules, schedule)
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	// Loan periods already due post now, as saving the terms does (ADR-097).
	for _, schedule := range schedules {
		if _, err := h.s.postDue(ctx, schedule, h.s.today()); err != nil {
			return nil, err
		}
	}
	return api.SaveAccounts200JSONResponse{Upserted: int32(len(b.Upserts)), Deleted: removed}, nil
}

// createOpening records an account's opening balance as a transaction like
// any other (ADR-059): income to the pool on a budget account, an entry
// without a category on a tracking account (ADR-023).
func createOpening(ctx context.Context, q *db.Queries, budgetID, accountID uuid.UUID, onBudget bool, amount int64, date time.Time, caller uuid.NullUUID) error {
	if amount == 0 {
		return nil
	}
	var category uuid.NullUUID
	if onBudget {
		cat, err := q.GetSystemCategory(ctx, db.GetSystemCategoryParams{
			BudgetID: budgetID, SystemKey: pgtype.Text{String: openingBalanceKey, Valid: true},
		})
		if err != nil {
			return err
		}
		category = uuid.NullUUID{UUID: cat, Valid: true}
	}
	txID, err := q.CreateOpeningTransaction(ctx, db.CreateOpeningTransactionParams{BudgetID: budgetID, Date: date, CreatedBy: caller})
	if err != nil {
		return err
	}
	return q.CreateEntry(ctx, db.CreateEntryParams{
		BudgetID: budgetID, TransactionID: txID, AccountID: accountID, CategoryID: category,
		Amount: amount, Memo: "", Cleared: db.ClearedStateCleared,
	})
}

// problemOf is an expected failure's code and message, to report it for one
// row of a batch.
func problemOf(err error) (code, message string, ok bool) {
	e, ok := apperr.As(err)
	if !ok {
		return "", "", false
	}
	return e.Code, e.Message, true
}
