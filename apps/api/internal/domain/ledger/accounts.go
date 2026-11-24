package ledger

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/apperr"
	"factual/apps/api/internal/shared/reqctx"
)

// onBudgetFor is whether an account of this kind counts toward the budget
// (ADR-024): credit cards always do, loans and investments never, cash and
// bank accounts as the user chooses.
func onBudgetFor(kind api.AccountKind, requested bool) bool {
	switch kind {
	case api.CreditCard:
		return true
	case api.Loan, api.Investment:
		return false
	}
	return requested
}

func (h *Handlers) ListAccounts(ctx context.Context, req api.ListAccountsRequestObject) (api.ListAccountsResponseObject, error) {
	rows, err := h.s.q.ListAccounts(ctx, req.BudgetId)
	if err != nil {
		return nil, err
	}
	cards, err := h.s.cardSettings(ctx, req.BudgetId)
	if err != nil {
		return nil, err
	}
	out := make(api.ListAccounts200JSONResponse, 0, len(rows))
	for _, r := range rows {
		a := accountResponse(db.GetAccountRow(r))
		a.Card = cards[r.ID]
		out = append(out, a)
	}
	return out, nil
}

func (h *Handlers) CreateAccount(ctx context.Context, req api.CreateAccountRequestObject) (api.CreateAccountResponseObject, error) {
	b := req.Body
	name := strings.TrimSpace(b.Name)
	if name == "" {
		return nil, apperr.BadRequest("invalid_name", "name is empty")
	}
	onBudget := onBudgetFor(b.Kind, b.OnBudget)
	caller := reqctx.Caller(ctx).UserID
	var off func(time.Time) bool
	if b.Card != nil {
		if b.Kind != api.CreditCard {
			return nil, notACard()
		}
		if err := h.s.checkCard(ctx, req.BudgetId, uuid.Nil, *b.Card); err != nil {
			return nil, err
		}
		var err error
		if off, err = h.s.cardDaysOff(ctx); err != nil {
			return nil, err
		}
	}
	// A loan's terms come with the account (ADR-100); its opening balance is
	// then what they leave owed.
	var terms loanTerms
	if b.Loan != nil {
		if b.Kind != api.Loan {
			return nil, notALoan()
		}
		var err error
		if terms, err = h.s.checkLoan(ctx, req.BudgetId, uuid.Nil, *b.Loan); err != nil {
			return nil, err
		}
	}

	var id uuid.UUID
	err := h.s.inTx(ctx, func(q *db.Queries) error {
		var err error
		id, err = q.CreateAccount(ctx, db.CreateAccountParams{
			BudgetID: req.BudgetId, Name: name, Kind: db.AccountKind(b.Kind), OnBudget: onBudget,
		})
		if err != nil {
			return err
		}
		if b.Card != nil {
			if err := h.s.saveCard(ctx, q, req.BudgetId, id, *b.Card, off); err != nil {
				return err
			}
		}
		if b.Loan != nil {
			_, err := h.s.saveLoan(ctx, q, req.BudgetId, id, terms, *b.Loan)
			return err
		}
		if b.OpeningBalance == 0 {
			return nil
		}

		// The opening balance is a transaction like any other. On a budget
		// account it is income (to the pool); a tracking account takes it
		// without a category (ADR-023).
		var category uuid.NullUUID
		if onBudget {
			cat, err := q.GetSystemCategory(ctx, db.GetSystemCategoryParams{
				BudgetID: req.BudgetId, SystemKey: pgtype.Text{String: openingBalanceKey, Valid: true},
			})
			if err != nil {
				return err
			}
			category = uuid.NullUUID{UUID: cat, Valid: true}
		}
		txID, err := q.CreateOpeningTransaction(ctx, db.CreateOpeningTransactionParams{
			BudgetID: req.BudgetId, Date: b.OpeningDate.Time, CreatedBy: uuid.NullUUID{UUID: caller, Valid: true},
		})
		if err != nil {
			return err
		}
		return q.CreateEntry(ctx, db.CreateEntryParams{
			BudgetID: req.BudgetId, TransactionID: txID, AccountID: id, CategoryID: category,
			Amount: b.OpeningBalance, Memo: "", Cleared: db.ClearedStateCleared,
		})
	})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	out, err := h.s.account(ctx, req.BudgetId, id)
	if err != nil {
		return nil, err
	}
	return api.CreateAccount201JSONResponse(out), nil
}

func (h *Handlers) UpdateAccount(ctx context.Context, req api.UpdateAccountRequestObject) (api.UpdateAccountResponseObject, error) {
	b := req.Body
	name := strings.TrimSpace(b.Name)
	if name == "" {
		return nil, apperr.BadRequest("invalid_name", "name is empty")
	}
	cur, err := h.s.q.GetAccount(ctx, db.GetAccountParams{BudgetID: req.BudgetId, ID: req.AccountId})
	if isNoRows(err) {
		return nil, notFound("account")
	}
	if err != nil {
		return nil, err
	}
	if b.Closed && !cur.Closed && cur.Balance != 0 {
		return nil, apperr.New(http.StatusConflict, "account_not_empty", "an account can only be closed with a zero balance")
	}
	var off func(time.Time) bool
	if b.Card != nil {
		if cur.Kind != db.AccountKindCreditCard {
			return nil, notACard()
		}
		if err := h.s.checkCard(ctx, req.BudgetId, req.AccountId, *b.Card); err != nil {
			return nil, err
		}
		if off, err = h.s.cardDaysOff(ctx); err != nil {
			return nil, err
		}
	}
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		err := q.UpdateAccount(ctx, db.UpdateAccountParams{BudgetID: req.BudgetId, ID: req.AccountId, Name: name, Closed: b.Closed})
		if err != nil || b.Card == nil {
			return err
		}
		return h.s.saveCard(ctx, q, req.BudgetId, req.AccountId, *b.Card, off)
	})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	out, err := h.s.account(ctx, req.BudgetId, req.AccountId)
	if err != nil {
		return nil, err
	}
	return api.UpdateAccount200JSONResponse(out), nil
}

func (h *Handlers) DeleteAccount(ctx context.Context, req api.DeleteAccountRequestObject) (api.DeleteAccountResponseObject, error) {
	cur, err := h.s.q.GetAccount(ctx, db.GetAccountParams{BudgetID: req.BudgetId, ID: req.AccountId})
	if isNoRows(err) {
		return nil, notFound("account")
	}
	if err != nil {
		return nil, err
	}
	if cur.HasActivity {
		return nil, accountInUse()
	}
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		err := q.DeleteOpeningTransactions(ctx, db.DeleteOpeningTransactionsParams{BudgetID: req.BudgetId, AccountID: req.AccountId})
		if err != nil {
			return err
		}
		_, err = q.DeleteAccount(ctx, db.DeleteAccountParams{BudgetID: req.BudgetId, ID: req.AccountId})
		return err
	})
	if isForeignKeyViolation(err) {
		return nil, accountInUse()
	}
	if err != nil {
		return nil, err
	}
	return api.DeleteAccount204Response{}, nil
}

func accountInUse() error {
	return apperr.New(http.StatusConflict, "account_in_use", "the account has transactions; close it instead")
}

func (h *Handlers) ReorderAccounts(ctx context.Context, req api.ReorderAccountsRequestObject) (api.ReorderAccountsResponseObject, error) {
	rows, err := h.s.q.ListAccounts(ctx, req.BudgetId)
	if err != nil {
		return nil, err
	}
	known := make([]uuid.UUID, 0, len(rows))
	for _, r := range rows {
		known = append(known, r.ID)
	}
	order, err := orderWithRest(req.Body.Ids, known)
	if err != nil {
		return nil, err
	}
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		for i, id := range order {
			if err := q.SetAccountOrder(ctx, db.SetAccountOrderParams{BudgetID: req.BudgetId, ID: id, SortOrder: int32(i)}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return api.ReorderAccounts204Response{}, nil
}

// orderWithRest puts ids first, in that order, followed by the other known
// ids in their current order. Every id must be known and appear once.
func orderWithRest(ids, known []uuid.UUID) ([]uuid.UUID, error) {
	isKnown := make(map[uuid.UUID]bool, len(known))
	for _, id := range known {
		isKnown[id] = true
	}
	seen := make(map[uuid.UUID]bool, len(ids))
	order := make([]uuid.UUID, 0, len(known))
	for _, id := range ids {
		if !isKnown[id] || seen[id] {
			return nil, apperr.BadRequest("invalid_order", "ids must be distinct items of this list")
		}
		seen[id] = true
		order = append(order, id)
	}
	for _, id := range known {
		if !seen[id] {
			order = append(order, id)
		}
	}
	return order, nil
}

// account is one account as the API shows it, a card with its settings.
func (s *Service) account(ctx context.Context, budgetID, id uuid.UUID) (api.Account, error) {
	row, err := s.q.GetAccount(ctx, db.GetAccountParams{BudgetID: budgetID, ID: id})
	if err != nil {
		return api.Account{}, err
	}
	out := accountResponse(row)
	if row.Kind == db.AccountKindCreditCard {
		c, err := s.q.GetCardSettings(ctx, db.GetCardSettingsParams{BudgetID: budgetID, AccountID: id})
		switch {
		case err == nil:
			out.Card = cardResponse(db.CreditCard(c))
		case !isNoRows(err):
			return api.Account{}, err
		}
	}
	return out, nil
}

func accountResponse(r db.GetAccountRow) api.Account {
	return api.Account{
		Id: r.ID, Name: r.Name, Kind: api.AccountKind(r.Kind), OnBudget: r.OnBudget, Closed: r.Closed,
		SortOrder: r.SortOrder, Balance: r.Balance, ClearedBalance: r.ClearedBalance, HasActivity: r.HasActivity,
	}
}
