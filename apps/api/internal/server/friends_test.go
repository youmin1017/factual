package server

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"factual/apps/api/internal/api"
)

// Integration tests of friends and shared expenses (M12, ADR-103..106).

func createFriend(t *testing.T, b *browser, name string) api.Friend {
	t.Helper()
	rec := b.do(http.MethodPost, "/api/friends", api.FriendInput{DisplayName: name})
	wantStatus(t, rec, http.StatusCreated)
	var f api.Friend
	decode(t, rec, &f)
	return f
}

func friendExpenses(t *testing.T, b *browser, f api.Friend) api.FriendExpenses {
	t.Helper()
	rec := b.do(http.MethodGet, "/api/friends/"+f.Id.String()+"/expenses", nil)
	wantStatus(t, rec, http.StatusOK)
	var out api.FriendExpenses
	decode(t, rec, &out)
	return out
}

func saveShared(b *browser, f api.Friend, upserts []api.SharedExpenseInput, deletes ...uuid.UUID) (int, map[uuid.UUID]api.BatchProblem) {
	if upserts == nil {
		upserts = []api.SharedExpenseInput{}
	}
	if deletes == nil {
		deletes = []uuid.UUID{}
	}
	rec := b.do(http.MethodPost, "/api/friends/"+f.Id.String()+"/expenses/batch", api.SharedExpenseBatch{Upserts: upserts, Deletes: deletes})
	var probs map[uuid.UUID]api.BatchProblem
	if rec.Code == http.StatusUnprocessableEntity {
		var errs api.BatchErrors
		_ = json.Unmarshal(rec.Body.Bytes(), &errs)
		probs = map[uuid.UUID]api.BatchProblem{}
		for _, p := range errs.Errors {
			probs[p.Id] = p
		}
	}
	return rec.Code, probs
}

func balanceOf(t *testing.T, b *browser, budget api.Budget, id uuid.UUID) int64 {
	t.Helper()
	for _, a := range listAccounts(t, b, budget) {
		if a.Id == id {
			return a.Balance
		}
	}
	t.Fatalf("account %s not listed", id)
	return 0
}

func TestFriendsAndSharedExpenses(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	me, _ := admin.me()

	// Splitting records the caller's side in their default budget.
	wantError(t, admin.do(http.MethodPost, "/api/friends", api.FriendInput{DisplayName: "小明"}), http.StatusConflict, "no_default_budget")

	f := newLedgerFixture(t, admin) // the bank opens with 50,000 on 11/1
	ming := createFriend(t, admin, " 小明 ")
	if ming.DisplayName != "小明" || !ming.Placeholder || ming.AccountId == nil || *ming.BudgetId != f.budget.Id || ming.Balance != 0 {
		t.Fatalf("friend = %+v", ming)
	}
	wantError(t, admin.do(http.MethodPost, "/api/friends", api.FriendInput{DisplayName: "台新"}), http.StatusConflict, "name_taken")

	// The friend account is listed with the friend, and only changes
	// through splitting.
	var account api.Account
	for _, a := range listAccounts(t, admin, f.budget) {
		if a.Id == *ming.AccountId {
			account = a
		}
	}
	if account.Kind != api.AccountKindFriend || !account.OnBudget || account.FriendId == nil || *account.FriendId != ming.Id {
		t.Fatalf("friend account = %+v", account)
	}
	wantError(t, admin.do(http.MethodDelete, budgetPath(f.budget, "/accounts/"+account.Id.String()), nil), http.StatusConflict, "friend_account")
	byHand := uuid.New()
	probs := wantProblems(t, save(admin, f.budget, []api.TransactionInput{{
		Id: byHand, Date: day(2), Entries: []api.EntryInput{entry(f.bank.Id, nil, -100), entry(account.Id, nil, 100)},
	}}))
	if probs[byHand].Code != "unknown_account" {
		t.Fatalf("by hand = %+v", probs)
	}

	// Dinner: I paid 2,400 from the bank, split equally.
	dinner := api.SharedExpenseInput{
		Id: uuid.New(), Kind: api.SharedKindExpense, Date: day(5), Description: "晚餐", Note: "鼎泰豐", Total: 2400,
		SplitMethod: api.Equal, Payers: []api.SharedPayer{{UserId: me.Id, Amount: 2400}},
		Shares:    []api.SharedShareInput{{UserId: me.Id}, {UserId: ming.Id}},
		AccountId: &f.bank.Id, CategoryId: &f.food.Id,
	}
	// Ming paid 1,000 for a taxi, two shares mine and one his: 666.67 and
	// 333.33, the odd unit to the larger remainder (mine).
	taxi := api.SharedExpenseInput{
		Id: uuid.New(), Kind: api.SharedKindExpense, Date: day(6), Description: "計程車", Total: 1000,
		SplitMethod: api.Shares, Payers: []api.SharedPayer{{UserId: ming.Id, Amount: 1000}},
		Shares:     []api.SharedShareInput{{UserId: me.Id, Weight: ptr(2.0)}, {UserId: ming.Id, Weight: ptr(1.0)}},
		CategoryId: &f.food.Id,
	}
	if code, probs := saveShared(admin, ming, []api.SharedExpenseInput{dinner, taxi}); code != http.StatusOK {
		t.Fatalf("save = %d %+v", code, probs)
	}
	if got := balanceOf(t, admin, f.budget, account.Id); got != 1200-667 {
		t.Fatalf("friend balance = %d", got)
	}
	if got := balanceOf(t, admin, f.budget, f.bank.Id); got != 50000-2400 {
		t.Fatalf("bank = %d", got)
	}
	_, envelopes := budgetMonth(t, admin, f.budget, "2026-11")
	if got := envelopes[f.food.Id].Activity; got != -1200-667 {
		t.Fatalf("food activity = %d", got)
	}
	s := summary(t, admin, f.budget)
	if s.OnBudgetBalance != s.Pool+s.EnvelopeBalance {
		t.Fatalf("on budget %d != pool %d + envelopes %d", s.OnBudgetBalance, s.Pool, s.EnvelopeBalance)
	}

	list := friendExpenses(t, admin, ming)
	if len(list.Expenses) != 2 || list.Friend.Balance != 533 || list.Friend.ExpenseCount != 2 {
		t.Fatalf("expenses = %+v", list)
	}
	got := list.Expenses[0]
	if got.Id != dinner.Id || got.Note != "鼎泰豐" || got.Currency != "TWD" || got.RecordedBy != me.Id ||
		*got.Mine.AccountId != f.bank.Id || *got.Mine.CategoryId != f.food.Id || got.Mine.TransactionId == nil {
		t.Fatalf("dinner = %+v", got)
	}
	shares := map[uuid.UUID]api.SharedShare{}
	for _, s := range list.Expenses[1].Shares {
		shares[s.UserId] = s
	}
	if shares[me.Id].Amount != 667 || *shares[me.Id].Weight != 2 || shares[ming.Id].Amount != 333 {
		t.Fatalf("taxi shares = %+v", list.Expenses[1].Shares)
	}
	if list.Expenses[1].Mine.AccountId != nil {
		t.Fatalf("taxi paid by ming has no account of mine: %+v", list.Expenses[1].Mine)
	}

	// The register shows the generated transaction; it may be cleared there
	// but not changed.
	txID := *got.Mine.TransactionId
	var tx api.Transaction
	for _, x := range register(t, admin, f.budget, f.bank) {
		if x.Id == txID {
			tx = x
		}
	}
	if tx.SharedExpenseId == nil || *tx.SharedExpenseId != dinner.Id || tx.Note != "晚餐" {
		t.Fatalf("register row = %+v", tx)
	}
	edit := api.TransactionInput{Id: txID, Date: tx.Date, Note: tx.Note}
	for _, e := range tx.Entries {
		in := api.EntryInput{AccountId: e.AccountId, CategoryId: e.CategoryId, Amount: e.Amount, Cleared: e.Cleared}
		if e.AccountId == f.bank.Id {
			in.Cleared = api.Cleared
		}
		edit.Entries = append(edit.Entries, in)
	}
	wantStatus(t, save(admin, f.budget, []api.TransactionInput{edit}), http.StatusOK)
	changed := edit
	changed.Entries = append([]api.EntryInput{}, edit.Entries...)
	changed.Date = day(7)
	if p := wantProblems(t, save(admin, f.budget, []api.TransactionInput{changed})); p[txID].Code != "shared_transaction" {
		t.Fatalf("changed = %+v", p)
	}
	if p := wantProblems(t, save(admin, f.budget, nil, txID)); p[txID].Code != "shared_transaction" {
		t.Fatalf("deleted = %+v", p)
	}

	// Editing the expense rewrites my side and keeps what I cleared.
	dinner.Total = 3000
	dinner.Payers[0].Amount = 3000
	if code, probs := saveShared(admin, ming, []api.SharedExpenseInput{dinner}); code != http.StatusOK {
		t.Fatalf("edit = %d %+v", code, probs)
	}
	for _, x := range register(t, admin, f.budget, f.bank) {
		if x.Id != txID {
			continue
		}
		for _, e := range x.Entries {
			if e.AccountId == f.bank.Id && (e.Amount != -3000 || e.Cleared != api.Cleared) {
				t.Fatalf("edited bank entry = %+v", e)
			}
		}
	}
	if got := balanceOf(t, admin, f.budget, account.Id); got != 1500-667 {
		t.Fatalf("after edit = %d", got)
	}

	// Ming pays me back 833 into the bank.
	back := api.SharedExpenseInput{
		Id: uuid.New(), Kind: api.SharedKindSettlement, Date: day(10), Description: "還錢", Total: 833,
		SplitMethod: api.Exact, Payers: []api.SharedPayer{{UserId: ming.Id, Amount: 833}},
		Shares: []api.SharedShareInput{}, AccountId: &f.bank.Id,
	}
	if code, probs := saveShared(admin, ming, []api.SharedExpenseInput{back}); code != http.StatusOK {
		t.Fatalf("settle = %d %+v", code, probs)
	}
	if got := balanceOf(t, admin, f.budget, account.Id); got != 0 {
		t.Fatalf("settled = %d", got)
	}
	if got := balanceOf(t, admin, f.budget, f.bank.Id); got != 50000-3000+833 {
		t.Fatalf("bank after settling = %d", got)
	}

	// Problems are reported per expense and nothing is saved.
	stranger := uuid.New()
	bad := func(mod func(*api.SharedExpenseInput)) api.SharedExpenseInput {
		x := api.SharedExpenseInput{
			Id: uuid.New(), Kind: api.SharedKindExpense, Date: day(12), Description: "x", Total: 100,
			SplitMethod: api.Equal, Payers: []api.SharedPayer{{UserId: me.Id, Amount: 100}},
			Shares:    []api.SharedShareInput{{UserId: me.Id}, {UserId: ming.Id}},
			AccountId: &f.bank.Id, CategoryId: &f.food.Id,
		}
		mod(&x)
		return x
	}
	cases := map[string]api.SharedExpenseInput{
		"description_required": bad(func(x *api.SharedExpenseInput) { x.Description = " " }),
		"payers_total":         bad(func(x *api.SharedExpenseInput) { x.Payers[0].Amount = 90 }),
		"invalid_payers":       bad(func(x *api.SharedExpenseInput) { x.Payers[0].UserId = stranger }),
		"invalid_shares":       bad(func(x *api.SharedExpenseInput) { x.Shares[1].UserId = stranger }),
		"percent_total": bad(func(x *api.SharedExpenseInput) {
			x.SplitMethod = api.Percent
			x.Shares[0].Weight = ptr(50.0)
			x.Shares[1].Weight = ptr(40.0)
		}),
		"shares_total": bad(func(x *api.SharedExpenseInput) {
			x.SplitMethod = api.Exact
			x.Shares[0].Amount = ptr[int64](10)
			x.Shares[1].Amount = ptr[int64](10)
		}),
		"account_required":      bad(func(x *api.SharedExpenseInput) { x.AccountId = nil }),
		"account_not_on_budget": bad(func(x *api.SharedExpenseInput) { x.AccountId = &f.loan.Id }),
		"unknown_account":       bad(func(x *api.SharedExpenseInput) { x.AccountId = ming.AccountId }),
		"category_required":     bad(func(x *api.SharedExpenseInput) { x.CategoryId = nil }),
	}
	var batch []api.SharedExpenseInput
	want := map[uuid.UUID]string{}
	for code, x := range cases {
		batch = append(batch, x)
		want[x.Id] = code
	}
	code, probs2 := saveShared(admin, ming, batch)
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("bad batch = %d", code)
	}
	for id, code := range want {
		if probs2[id].Code != code {
			t.Errorf("want %s, got %+v", code, probs2[id])
		}
	}

	// A foreign currency is kept with its rate.
	ramen := bad(func(x *api.SharedExpenseInput) {
		x.Description = "拉麵"
		x.Total = 610
		x.Payers[0].Amount = 610
		x.Foreign = &api.ForeignAmount{Currency: "JPY", Amount: 3000}
	})
	if code, probs := saveShared(admin, ming, []api.SharedExpenseInput{ramen}); code != http.StatusOK {
		t.Fatalf("ramen = %d %+v", code, probs)
	}
	list = friendExpenses(t, admin, ming)
	last := list.Expenses[len(list.Expenses)-1]
	if last.Foreign == nil || last.Foreign.Currency != "JPY" || last.Foreign.Amount != 3000 || *last.Foreign.Rate != "0.20333333" {
		t.Fatalf("foreign = %+v", last.Foreign)
	}

	// Deleting an expense removes my transaction; a friend with expenses
	// stays until they are all gone.
	wantError(t, admin.do(http.MethodDelete, "/api/friends/"+ming.Id.String(), nil), http.StatusConflict, "friend_in_use")
	if code, probs := saveShared(admin, ming, nil, dinner.Id, taxi.Id, back.Id, ramen.Id); code != http.StatusOK {
		t.Fatalf("delete = %d %+v", code, probs)
	}
	if got := balanceOf(t, admin, f.budget, f.bank.Id); got != 50000 {
		t.Fatalf("bank after deleting = %d", got)
	}
	renamed := admin.do(http.MethodPatch, "/api/friends/"+ming.Id.String(), api.FriendInput{DisplayName: "阿明"})
	wantStatus(t, renamed, http.StatusOK)
	wantStatus(t, admin.do(http.MethodDelete, "/api/friends/"+ming.Id.String(), nil), http.StatusNoContent)
	rec := admin.do(http.MethodGet, "/api/friends", nil)
	var friends []api.Friend
	decode(t, rec, &friends)
	if len(friends) != 0 {
		t.Fatalf("friends after delete = %+v", friends)
	}
}

func TestFriendsArePrivate(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	newLedgerFixture(t, admin)
	ming := createFriend(t, admin, "小明")

	hs.addUser("hua", "hua-password-1")
	hua := hs.browser().mustLogin("hua", "hua-password-1")
	createBudget(t, hua, "華的帳本", false)
	wantError(t, hua.do(http.MethodGet, "/api/friends/"+ming.Id.String()+"/expenses", nil), http.StatusNotFound, "not_found")
	wantError(t, hua.do(http.MethodPatch, "/api/friends/"+ming.Id.String(), api.FriendInput{DisplayName: "x"}), http.StatusNotFound, "not_found")
	code, _ := saveShared(hua, ming, nil)
	if code != http.StatusNotFound {
		t.Fatalf("someone else's friend = %d", code)
	}
}
