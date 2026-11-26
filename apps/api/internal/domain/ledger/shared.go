package ledger

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/reqctx"
)

// Shared expenses between the caller and one friend (M12, ADR-034..036,
// ADR-106) or among a group's members (M13, ADR-037, ADR-115). The expense
// lives outside any budget; the caller's side is one transaction in their
// default budget, on the friend or group account, written again from the
// expense whenever it is saved:
//
//	their share      (friend account, category, -share)
//	what they paid   (paying account, -paid) + (friend account, +paid)
//	a settlement     (friend account, paid - share) + (account, share - paid)
//
// so the account's balance is what the friend (or the group) owes them. An
// expense that does not involve the caller leaves them nothing.

const (
	maxDescriptionLen = 200
	maxSharedNoteLen  = 1000
)

func (h *Handlers) ListFriendExpenses(ctx context.Context, req api.ListFriendExpensesRequestObject) (api.ListFriendExpensesResponseObject, error) {
	caller := reqctx.Caller(ctx).UserID
	f, err := h.s.friend(ctx, caller, req.FriendId)
	if err != nil {
		return nil, err
	}
	rows, err := h.s.q.ListFriendExpenses(ctx, db.ListFriendExpensesParams{UserID: caller, FriendID: f.Id})
	if err != nil {
		return nil, err
	}
	out, err := h.s.expensesResponse(ctx, f.BudgetId, rows)
	if err != nil {
		return nil, err
	}
	return api.ListFriendExpenses200JSONResponse{Friend: f, Expenses: out}, nil
}

// expensesResponse is the expenses with their payers and shares, and the
// caller's side in their budget. Shares come by user id, not in the order
// they were divided in: the browser always sends them in member order.
func (s *Service) expensesResponse(ctx context.Context, budgetID *uuid.UUID, rows []db.ListFriendExpensesRow) ([]api.SharedExpense, error) {
	ids := make([]uuid.UUID, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	payers, err := s.q.ListExpensePayers(ctx, ids)
	if err != nil {
		return nil, err
	}
	shares, err := s.q.ListExpenseShares(ctx, ids)
	if err != nil {
		return nil, err
	}
	mine := map[uuid.UUID]*api.MySide{}
	if budgetID != nil {
		entries, err := s.q.ListMySharedEntries(ctx, db.ListMySharedEntriesParams{BudgetID: *budgetID, Ids: ids})
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			m := mine[e.SharedExpenseID.UUID]
			if m == nil {
				m = &api.MySide{TransactionId: &e.TransactionID}
				mine[e.SharedExpenseID.UUID] = m
			}
			switch {
			case e.AccountKind != db.AccountKindFriend:
				m.AccountId = &e.AccountID
			case e.CategoryID.Valid:
				m.CategoryId = &e.CategoryID.UUID
			}
		}
	}

	out := make([]api.SharedExpense, 0, len(rows))
	byID := make(map[uuid.UUID]int, len(rows))
	for i, r := range rows {
		x := api.SharedExpense{
			Id: r.ID, Kind: api.SharedKind(r.Kind), Date: openapi_types.Date{Time: r.Date},
			Description: r.Description, Note: r.Note, Currency: r.Currency, Total: r.TotalAmount,
			SplitMethod: api.SplitMethod(r.SplitMethod), RecordedBy: r.CreatedBy,
			Payers: []api.SharedPayer{}, Shares: []api.SharedShare{},
		}
		if r.OrigCurrency.Valid {
			fx := &api.ForeignAmount{Currency: r.OrigCurrency.String, Amount: r.OrigAmount.Int64}
			if v, err := r.FxRate.Value(); err == nil && v != nil {
				s := fmt.Sprint(v)
				fx.Rate = &s
			}
			x.Foreign = fx
		}
		if m := mine[r.ID]; m != nil {
			x.Mine = *m
		}
		out = append(out, x)
		byID[r.ID] = i
	}
	for _, p := range payers {
		x := &out[byID[p.ExpenseID]]
		x.Payers = append(x.Payers, api.SharedPayer{UserId: p.UserID, Amount: p.Amount})
	}
	for _, s := range shares {
		x := &out[byID[s.ExpenseID]]
		share := api.SharedShare{UserId: s.UserID, Amount: s.Amount}
		if w, err := s.Weight.Float64Value(); err == nil && w.Valid {
			share.Weight = &w.Float64
		}
		x.Shares = append(x.Shares, share)
	}
	return out, nil
}

// expensePlan is a valid upsert worked out: what to store and the caller's
// transaction.
type expensePlan struct {
	in      api.SharedExpenseInput
	method  db.SplitMethod
	foreign *api.ForeignAmount
	payers  []db.CreateExpensePayerParams
	shares  []db.CreateExpenseShareParams
	paid    int64 // by the caller
	share   int64 // the caller's
}

func (h *Handlers) SaveFriendExpenses(ctx context.Context, req api.SaveFriendExpensesRequestObject) (api.SaveFriendExpensesResponseObject, error) {
	caller := reqctx.Caller(ctx).UserID
	f, err := h.s.friend(ctx, caller, req.FriendId)
	if err != nil {
		return nil, err
	}
	budget, err := h.s.splittingBudget(ctx, caller)
	if err != nil {
		return nil, err
	}
	place := expensePlace{
		scope: splitScope{members: map[uuid.UUID]bool{caller: true, f.Id: true}, friend: f.Id},
		heads: func(ids []uuid.UUID) (map[uuid.UUID]expenseHead, error) {
			rows, err := h.s.q.GetExpenseHeads(ctx, db.GetExpenseHeadsParams{UserID: caller, FriendID: f.Id, Ids: ids})
			if err != nil {
				return nil, err
			}
			out := make(map[uuid.UUID]expenseHead, len(rows))
			for _, x := range rows {
				out[x.ID] = expenseHead{createdBy: x.CreatedBy, deleted: x.Deleted, here: !x.GroupID.Valid && x.WithUser && x.WithFriend}
			}
			return out, nil
		},
		account: func(q *db.Queries) (uuid.UUID, error) { return h.s.ensureFriendAccount(ctx, q, budget.ID, f) },
	}
	saved, probs, err := h.s.saveExpenses(ctx, caller, budget, place, *req.Body)
	if err != nil {
		return nil, err
	}
	if len(probs) > 0 {
		return api.SaveFriendExpenses422JSONResponse{Errors: probs}, nil
	}
	return api.SaveFriendExpenses200JSONResponse(saved), nil
}

// expensePlace is where a batch of shared expenses is saved: with a friend
// or in a group.
type expensePlace struct {
	scope splitScope
	group uuid.NullUUID
	// heads reports the expenses of the ids that already exist.
	heads func(ids []uuid.UUID) (map[uuid.UUID]expenseHead, error)
	// account is the friend or group account, created when missing.
	account func(q *db.Queries) (uuid.UUID, error)
}

// expenseHead is what the batch needs to know about an existing expense.
type expenseHead struct {
	createdBy uuid.UUID
	// here: it belongs to this friend or group.
	here, deleted bool
}

// saveExpenses applies a batch of upserts and deletes in one database
// transaction, or reports the problems of each expense and saves nothing.
func (s *Service) saveExpenses(ctx context.Context, caller uuid.UUID, budget db.GetSplittingBudgetRow, place expensePlace, b api.SharedExpenseBatch) (api.SharedExpenseBatchSaved, problems, error) {
	var saved api.SharedExpenseBatchSaved
	accounts, err := s.q.ListAccountRefs(ctx, budget.ID)
	if err != nil {
		return saved, nil, err
	}
	paysFrom := map[uuid.UUID]bool{}
	known := map[uuid.UUID]bool{}
	for _, a := range accounts {
		if a.ByHand {
			known[a.ID] = true
			paysFrom[a.ID] = a.OnBudget && !a.Closed
		}
	}
	cats, err := s.q.ListCategoryRefs(ctx, budget.ID)
	if err != nil {
		return saved, nil, err
	}
	isCategory := map[uuid.UUID]bool{}
	for _, c := range cats {
		isCategory[c.ID] = !c.IsSystem
	}

	ids := make([]uuid.UUID, 0, len(b.Upserts)+len(b.Deletes))
	for _, u := range b.Upserts {
		ids = append(ids, u.Id)
	}
	ids = append(ids, b.Deletes...)
	head, err := place.heads(ids)
	if err != nil {
		return saved, nil, err
	}
	// An existing expense must be this friend's or group's, not deleted, and
	// the caller's to change (ADR-106: only the recorder edits).
	checkHead := func(p *problems, id uuid.UUID) bool {
		x, ok := head[id]
		if !ok {
			return true
		}
		if !x.here || x.deleted {
			p.add(id, "", "not_found", "shared expense not found")
			return false
		}
		if x.createdBy != caller {
			p.add(id, "", "not_recorder", "only who recorded a shared expense changes it")
			return false
		}
		return true
	}

	var probs problems
	plans := make([]expensePlan, 0, len(b.Upserts))
	seen := make(map[uuid.UUID]bool, len(ids))
	for _, u := range b.Upserts {
		if seen[u.Id] {
			probs.add(u.Id, "", "duplicate_id", "the expense appears twice in the batch")
			continue
		}
		seen[u.Id] = true
		if !checkHead(&probs, u.Id) {
			continue
		}
		plan, ok := planExpense(&probs, u, caller, place.scope, budget.Currency)
		if !ok {
			continue
		}
		// The caller says which account when money moves on their side.
		owes := plan.paid != 0 || (plan.in.Kind == api.SharedKindSettlement && plan.share != 0)
		switch {
		case owes && u.AccountId == nil:
			probs.add(u.Id, "account", "account_required", "say which account paid or was paid")
			continue
		case owes && !known[*u.AccountId]:
			probs.add(u.Id, "account", "unknown_account", "the account does not exist in this budget")
			continue
		case owes && !paysFrom[*u.AccountId]:
			probs.add(u.Id, "account", "account_not_on_budget", "pay from an open account on the budget")
			continue
		}
		if plan.in.Kind == api.SharedKindExpense && plan.share > 0 {
			if u.CategoryId == nil {
				probs.add(u.Id, "category", "category_required", "your share needs a category")
				continue
			}
			if !isCategory[*u.CategoryId] {
				probs.add(u.Id, "category", "unknown_category", "the category does not exist in this budget")
				continue
			}
		}
		plans = append(plans, plan)
	}
	for _, id := range b.Deletes {
		if seen[id] {
			probs.add(id, "", "duplicate_id", "the expense is both saved and deleted")
			continue
		}
		seen[id] = true
		if _, ok := head[id]; ok {
			checkHead(&probs, id)
		}
	}
	if len(probs) > 0 {
		return saved, probs, nil
	}

	units := MinorUnits(budget.Currency)
	err = s.inTx(ctx, func(q *db.Queries) error {
		for _, id := range b.Deletes {
			n, err := q.SoftDeleteSharedExpense(ctx, db.SoftDeleteSharedExpenseParams{ID: id, CreatedBy: caller})
			if err != nil {
				return err
			}
			saved.Deleted += int32(n)
			if err := q.DeleteSharedTransaction(ctx, db.DeleteSharedTransactionParams{BudgetID: budget.ID, SharedExpenseID: uuid.NullUUID{UUID: id, Valid: true}}); err != nil {
				return err
			}
		}
		if len(plans) == 0 {
			return nil
		}
		account, err := place.account(q)
		if err != nil {
			return err
		}
		for _, p := range plans {
			u := p.in
			row := db.UpsertSharedExpenseParams{
				ID: u.Id, Kind: db.SharedKind(u.Kind), GroupID: place.group, Date: u.Date.Time,
				Description: strings.TrimSpace(u.Description), Note: strings.TrimSpace(u.Note),
				Currency: budget.Currency, TotalAmount: u.Total, SplitMethod: p.method, CreatedBy: caller,
			}
			if p.foreign != nil {
				row.OrigCurrency = pgtype.Text{String: p.foreign.Currency, Valid: true}
				row.OrigAmount = pgtype.Int8{Int64: p.foreign.Amount, Valid: true}
				if err := row.FxRate.Scan(fxRate(u.Total, units, p.foreign.Amount, MinorUnits(p.foreign.Currency))); err != nil {
					return err
				}
			}
			if err := q.UpsertSharedExpense(ctx, row); err != nil {
				return err
			}
			if err := q.DeleteExpensePayers(ctx, u.Id); err != nil {
				return err
			}
			if err := q.DeleteExpenseShares(ctx, u.Id); err != nil {
				return err
			}
			for _, x := range p.payers {
				if err := q.CreateExpensePayer(ctx, x); err != nil {
					return err
				}
			}
			for _, x := range p.shares {
				if err := q.CreateExpenseShare(ctx, x); err != nil {
					return err
				}
			}
			if err := writeMyTransaction(ctx, q, budget.ID, caller, account, p); err != nil {
				return err
			}
			saved.Upserted++
		}
		return nil
	})
	if isUniqueViolation(err) {
		return saved, nil, nameTaken()
	}
	return saved, nil, err
}

// splitScope is who may take part in an expense.
type splitScope struct {
	members map[uuid.UUID]bool
	// friend is set for an expense with a friend: the two always have a
	// share each, and a settlement's receiver may be left to be the other.
	friend uuid.UUID
}

func (sc splitScope) withFriend() bool { return sc.friend != uuid.Nil }

// planExpense checks an upsert and works out its payers and shares among
// the scope's members, dividing in the order the shares are given.
func planExpense(p *problems, u api.SharedExpenseInput, caller uuid.UUID, scope splitScope, currency string) (expensePlan, bool) {
	plan := expensePlan{in: u, method: db.SplitMethod(u.SplitMethod)}
	n := len(*p)
	desc := strings.TrimSpace(u.Description)
	switch {
	case desc == "":
		p.add(u.Id, "description", "description_required", "say what the expense was")
	case utf8.RuneCountInString(desc) > maxDescriptionLen:
		p.add(u.Id, "description", "too_long", fmt.Sprintf("a description is at most %d characters", maxDescriptionLen))
	}
	if utf8.RuneCountInString(u.Note) > maxSharedNoteLen {
		p.add(u.Id, "note", "too_long", fmt.Sprintf("a note is at most %d characters", maxSharedNoteLen))
	}
	if u.Total <= 0 {
		p.add(u.Id, "amount", "invalid_amount", "the total must be more than zero")
	}
	if u.Kind != api.SharedKindExpense && u.Kind != api.SharedKindSettlement {
		p.add(u.Id, "kind", "invalid_kind", "an expense or a settlement")
	}
	if !plan.method.Valid() {
		p.add(u.Id, "shares", "invalid_split", "unknown split method")
	}
	if f := u.Foreign; f != nil && f.Currency != currency {
		plan.foreign = f
	}
	if len(*p) > n {
		return plan, false
	}

	var paid int64
	payers := map[uuid.UUID]bool{}
	for _, x := range u.Payers {
		if !scope.members[x.UserId] || payers[x.UserId] || x.Amount <= 0 {
			p.add(u.Id, "payers", "invalid_payers", "the payers are members, each once, paying more than zero")
			return plan, false
		}
		payers[x.UserId] = true
		paid += x.Amount
		plan.payers = append(plan.payers, db.CreateExpensePayerParams{ExpenseID: u.Id, UserID: x.UserId, Amount: x.Amount})
		if x.UserId == caller {
			plan.paid = x.Amount
		}
	}
	if paid != u.Total {
		p.add(u.Id, "payers", "payers_total", "what was paid must add up to the total")
		return plan, false
	}

	share := func(user uuid.UUID, amount int64, weight pgtype.Numeric) {
		plan.shares = append(plan.shares, db.CreateExpenseShareParams{ExpenseID: u.Id, UserID: user, Amount: amount, Weight: weight})
		if user == caller {
			plan.share = amount
		}
	}

	// A settlement: the payer pays the whole amount and the receiver
	// receives it (ADR-034). With a friend the receiver is the other one.
	if u.Kind == api.SharedKindSettlement {
		if len(plan.payers) != 1 {
			p.add(u.Id, "payers", "invalid_payers", "a settlement has one payer")
			return plan, false
		}
		payer := plan.payers[0].UserID
		var receiver uuid.UUID
		switch {
		case len(u.Shares) == 1:
			receiver = u.Shares[0].UserId
		case len(u.Shares) == 0 && scope.withFriend():
			receiver = scope.friend
			if payer == scope.friend {
				receiver = caller
			}
		}
		if receiver == uuid.Nil || receiver == payer || !scope.members[receiver] {
			p.add(u.Id, "shares", "invalid_shares", "a settlement is paid to one other member")
			return plan, false
		}
		plan.method = db.SplitMethodExact
		share(payer, 0, pgtype.Numeric{})
		share(receiver, u.Total, pgtype.Numeric{})
		return plan, true
	}

	sharing := make(map[uuid.UUID]bool, len(u.Shares))
	for _, x := range u.Shares {
		if !scope.members[x.UserId] || sharing[x.UserId] {
			p.add(u.Id, "shares", "invalid_shares", "the shares are members, each once")
			return plan, false
		}
		sharing[x.UserId] = true
	}
	switch {
	case len(u.Shares) == 0:
		p.add(u.Id, "shares", "invalid_shares", "somebody needs a share")
		return plan, false
	case scope.withFriend() && len(u.Shares) != 2:
		p.add(u.Id, "shares", "invalid_shares", "both of you have a share")
		return plan, false
	}
	switch plan.method {
	case db.SplitMethodExact:
		var sum int64
		for _, x := range u.Shares {
			if x.Amount == nil || *x.Amount < 0 {
				p.add(u.Id, "shares", "invalid_shares", "each share is an amount of zero or more")
				return plan, false
			}
			sum += *x.Amount
		}
		if sum != u.Total {
			p.add(u.Id, "shares", "shares_total", "the shares must add up to the total")
			return plan, false
		}
		for _, x := range u.Shares {
			share(x.UserId, *x.Amount, pgtype.Numeric{})
		}
	case db.SplitMethodEqual:
		ones := make([]int64, len(u.Shares))
		for i := range ones {
			ones[i] = 1
		}
		parts := divide(u.Total, ones)
		for i, x := range u.Shares {
			share(x.UserId, parts[i], pgtype.Numeric{})
		}
	default: // percent, shares
		weights := make([]int64, len(u.Shares))
		var sum int64
		for i, x := range u.Shares {
			w, ok := int64(0), x.Weight != nil
			if ok {
				w, ok = scaledWeight(*x.Weight)
			}
			if !ok {
				p.add(u.Id, "shares", "invalid_shares", "each share needs a percentage or a number of shares")
				return plan, false
			}
			weights[i] = w
			sum += w
		}
		if plan.method == db.SplitMethodPercent && sum != 100*weightScale {
			p.add(u.Id, "shares", "percent_total", "the percentages must add up to 100")
			return plan, false
		}
		if sum == 0 {
			p.add(u.Id, "shares", "invalid_shares", "somebody needs a share")
			return plan, false
		}
		parts := divide(u.Total, weights)
		for i, x := range u.Shares {
			share(x.UserId, parts[i], pgtype.Numeric{Int: big.NewInt(weights[i]), Exp: -4, Valid: true})
		}
	}
	return plan, true
}

// ensureFriendAccount is the friend account in the budget, created when it
// is missing (the budget became the default after the friend was added, or
// the friend was added through a group).
func (s *Service) ensureFriendAccount(ctx context.Context, q *db.Queries, budgetID uuid.UUID, f api.Friend) (uuid.UUID, error) {
	if f.AccountId != nil && f.BudgetId != nil && *f.BudgetId == budgetID {
		return *f.AccountId, nil
	}
	return q.CreateFriendAccount(ctx, db.CreateFriendAccountParams{
		BudgetID: budgetID, Name: f.DisplayName, FriendUserID: uuid.NullUUID{UUID: f.Id, Valid: true},
	})
}

// writeMyTransaction writes the caller's side of an expense into their
// budget, keeping what they cleared and the card statements its entries
// are billed in (ADR-088). An expense that leaves them nothing to record
// (a purchase they have no share of, a settlement between two others) has
// no transaction.
func writeMyTransaction(ctx context.Context, q *db.Queries, budgetID, caller, account uuid.UUID, p expensePlan) error {
	u := p.in
	type line struct {
		account  uuid.UUID
		category *uuid.UUID
		amount   int64
	}
	var lines []line
	if u.Kind == api.SharedKindSettlement {
		if net := p.paid - p.share; p.paid != 0 || p.share != 0 {
			lines = []line{{account, nil, net}, {*u.AccountId, nil, -net}}
		}
	} else {
		if p.share > 0 {
			lines = append(lines, line{account, u.CategoryId, -p.share})
		}
		if p.paid > 0 {
			lines = append(lines, line{*u.AccountId, nil, -p.paid}, line{account, nil, p.paid})
		}
	}
	expense := uuid.NullUUID{UUID: u.Id, Valid: true}
	note := strings.TrimSpace(u.Description)

	txID, err := q.GetSharedTransaction(ctx, db.GetSharedTransactionParams{BudgetID: budgetID, SharedExpenseID: expense})
	exists := err == nil
	if err != nil && !isNoRows(err) {
		return err
	}
	if len(lines) == 0 {
		if exists {
			return q.DeleteSharedTransaction(ctx, db.DeleteSharedTransactionParams{BudgetID: budgetID, SharedExpenseID: expense})
		}
		return nil
	}

	type side struct {
		account       uuid.UUID
		uncategorized bool
	}
	cleared := map[side]db.ClearedState{}
	var billed []db.ListEntryStatementsRow
	if exists {
		old, err := q.ListEntryCleared(ctx, txID)
		if err != nil {
			return err
		}
		for _, e := range old {
			cleared[side{e.AccountID, e.Uncategorized}] = e.Cleared
		}
		if billed, err = q.ListEntryStatements(ctx, []uuid.UUID{txID}); err != nil {
			return err
		}
		if err := q.UpdateSharedTransaction(ctx, db.UpdateSharedTransactionParams{BudgetID: budgetID, ID: txID, Date: u.Date.Time, Note: note}); err != nil {
			return err
		}
		if err := q.DeleteEntriesOf(ctx, db.DeleteEntriesOfParams{BudgetID: budgetID, TransactionID: txID}); err != nil {
			return err
		}
	} else {
		txID, err = q.CreateSharedTransaction(ctx, db.CreateSharedTransactionParams{
			BudgetID: budgetID, Date: u.Date.Time, Note: note, SharedExpenseID: expense,
			CreatedBy: uuid.NullUUID{UUID: caller, Valid: true},
		})
		if err != nil {
			return err
		}
	}
	for _, l := range lines {
		state, ok := cleared[side{l.account, l.category == nil}]
		if !ok {
			state = db.ClearedStateUncleared
		}
		err := q.CreateEntry(ctx, db.CreateEntryParams{
			BudgetID: budgetID, TransactionID: txID, AccountID: l.account, CategoryID: nullID(l.category),
			Amount: l.amount, Cleared: state,
		})
		if err != nil {
			return err
		}
	}
	for _, e := range billed {
		err := q.RestoreEntryStatement(ctx, db.RestoreEntryStatementParams{
			TransactionID: txID, AccountID: e.AccountID, StatementID: e.StatementID, PaysStatementID: e.PaysStatementID,
		})
		if err != nil {
			return err
		}
	}
	return nil
}
