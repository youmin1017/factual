package server

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"factual/apps/api/internal/api"
)

// Integration tests of groups (M13, ADR-037, ADR-115).

func groupExpenses(t *testing.T, b *browser, g api.Group) api.GroupExpenses {
	t.Helper()
	rec := b.do(http.MethodGet, "/api/groups/"+g.Id.String()+"/expenses", nil)
	wantStatus(t, rec, http.StatusOK)
	var out api.GroupExpenses
	decode(t, rec, &out)
	return out
}

func saveGroup(b *browser, g api.Group, upserts []api.SharedExpenseInput, deletes ...uuid.UUID) (int, map[uuid.UUID]api.BatchProblem) {
	if upserts == nil {
		upserts = []api.SharedExpenseInput{}
	}
	if deletes == nil {
		deletes = []uuid.UUID{}
	}
	rec := b.do(http.MethodPost, "/api/groups/"+g.Id.String()+"/expenses/batch", api.SharedExpenseBatch{Upserts: upserts, Deletes: deletes})
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

func memberBalances(g api.Group) map[uuid.UUID]int64 {
	out := map[uuid.UUID]int64{}
	for _, m := range g.Members {
		out[m.UserId] = m.Balance
	}
	return out
}

func TestGroupsAndTheirExpenses(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	me, _ := admin.me()
	f := newLedgerFixture(t, admin) // the bank opens with 50,000 on 11/1
	ming := createFriend(t, admin, "小明")

	// A group of me, a friend and a new name, which becomes a placeholder
	// friend without a friend account yet.
	rec := admin.do(http.MethodPost, "/api/groups", api.GroupInput{
		Name:    " 花蓮 ",
		Members: []api.GroupMemberInput{{UserId: &ming.Id}, {DisplayName: ptr("小華")}},
	})
	wantStatus(t, rec, http.StatusCreated)
	var g api.Group
	decode(t, rec, &g)
	if g.Name != "花蓮" || g.Currency != "TWD" || g.Archived || g.AccountId == nil || len(g.Members) != 3 ||
		g.Members[0].UserId != me.Id || g.Members[0].Role != api.GroupRoleAdmin {
		t.Fatalf("group = %+v", g)
	}
	hua := g.Members[2]
	if hua.DisplayName != "小華" || !hua.Placeholder {
		t.Fatalf("new member = %+v", hua)
	}
	var friends []api.Friend
	decode(t, admin.do(http.MethodGet, "/api/friends", nil), &friends)
	if len(friends) != 2 || friends[0].DisplayName != "小明" || friends[1].AccountId != nil {
		t.Fatalf("friends = %+v", friends)
	}
	for _, a := range listAccounts(t, admin, f.budget) {
		if a.Id == *g.AccountId && (a.Kind != api.AccountKindFriend || a.GroupId == nil || *a.GroupId != g.Id || a.Name != "花蓮") {
			t.Fatalf("group account = %+v", a)
		}
	}
	wantError(t, admin.do(http.MethodPost, "/api/groups", api.GroupInput{Name: "台新", Members: []api.GroupMemberInput{}}), http.StatusConflict, "name_taken")
	stranger := uuid.New()
	wantError(t, admin.do(http.MethodPost, "/api/groups", api.GroupInput{Name: "x", Members: []api.GroupMemberInput{{UserId: &stranger}}}), http.StatusBadRequest, "not_friend")

	// Dinner: I paid 3,000, split equally among the three.
	dinner := api.SharedExpenseInput{
		Id: uuid.New(), Kind: api.SharedKindExpense, Date: day(5), Description: "晚餐", Total: 3000,
		SplitMethod: api.Equal, Payers: []api.SharedPayer{{UserId: me.Id, Amount: 3000}},
		Shares:    []api.SharedShareInput{{UserId: me.Id}, {UserId: ming.Id}, {UserId: hua.UserId}},
		AccountId: &f.bank.Id, CategoryId: &f.food.Id,
	}
	// A taxi Hua paid, shared by Ming and me only.
	taxi := api.SharedExpenseInput{
		Id: uuid.New(), Kind: api.SharedKindExpense, Date: day(6), Description: "計程車", Total: 900,
		SplitMethod: api.Equal, Payers: []api.SharedPayer{{UserId: hua.UserId, Amount: 900}},
		Shares:     []api.SharedShareInput{{UserId: me.Id}, {UserId: ming.Id}},
		CategoryId: &f.food.Id,
	}
	// Snacks between the other two: nothing to me.
	snacks := api.SharedExpenseInput{
		Id: uuid.New(), Kind: api.SharedKindExpense, Date: day(7), Description: "零食", Total: 600,
		SplitMethod: api.Equal, Payers: []api.SharedPayer{{UserId: ming.Id, Amount: 600}},
		Shares: []api.SharedShareInput{{UserId: ming.Id}, {UserId: hua.UserId}},
	}
	if code, probs := saveGroup(admin, g, []api.SharedExpenseInput{dinner, taxi, snacks}); code != http.StatusOK {
		t.Fatalf("save = %d %+v", code, probs)
	}
	if got := balanceOf(t, admin, f.budget, *g.AccountId); got != 2000-450 {
		t.Fatalf("group account = %d", got)
	}
	_, envelopes := budgetMonth(t, admin, f.budget, "2026-11")
	if got := envelopes[f.food.Id].Activity; got != -1000-450 {
		t.Fatalf("food activity = %d", got)
	}
	list := groupExpenses(t, admin, g)
	if len(list.Expenses) != 3 || list.Group.ExpenseCount != 3 || list.Group.Balance != 1550 {
		t.Fatalf("expenses = %+v", list.Group)
	}
	if list.Expenses[2].Mine.TransactionId != nil {
		t.Fatalf("snacks wrote a transaction of mine: %+v", list.Expenses[2].Mine)
	}
	bal := memberBalances(list.Group)
	if bal[me.Id] != 1550 || bal[ming.Id] != -1150 || bal[hua.UserId] != -400 {
		t.Fatalf("member balances = %+v", bal)
	}

	// The group cannot be archived, nor Hua removed, while money is owed.
	keep := []api.GroupMemberInput{{UserId: &ming.Id}, {UserId: &hua.UserId}}
	wantError(t, admin.do(http.MethodPut, "/api/groups/"+g.Id.String(), api.GroupInput{Name: "花蓮", Members: keep, Archived: ptr(true)}),
		http.StatusConflict, "group_not_settled")
	wantError(t, admin.do(http.MethodPut, "/api/groups/"+g.Id.String(), api.GroupInput{Name: "花蓮", Members: keep[:1]}),
		http.StatusConflict, "member_in_use")
	wantError(t, admin.do(http.MethodDelete, "/api/groups/"+g.Id.String(), nil), http.StatusConflict, "group_in_use")
	wantError(t, admin.do(http.MethodDelete, "/api/friends/"+ming.Id.String(), nil), http.StatusConflict, "friend_in_group")

	// Problems are reported per expense and nothing is saved.
	direct := api.SharedExpenseInput{
		Id: uuid.New(), Kind: api.SharedKindExpense, Date: day(8), Description: "咖啡", Total: 200,
		SplitMethod: api.Equal, Payers: []api.SharedPayer{{UserId: me.Id, Amount: 200}},
		Shares:    []api.SharedShareInput{{UserId: me.Id}, {UserId: ming.Id}},
		AccountId: &f.bank.Id, CategoryId: &f.food.Id,
	}
	if code, probs := saveShared(admin, ming, []api.SharedExpenseInput{direct}); code != http.StatusOK {
		t.Fatalf("direct = %d %+v", code, probs)
	}
	bad := func(mod func(*api.SharedExpenseInput)) api.SharedExpenseInput {
		x := dinner
		x.Id = uuid.New()
		x.Payers = []api.SharedPayer{{UserId: me.Id, Amount: 3000}}
		x.Shares = []api.SharedShareInput{{UserId: me.Id}, {UserId: ming.Id}, {UserId: hua.UserId}}
		mod(&x)
		return x
	}
	moved := direct
	moved.Shares = []api.SharedShareInput{{UserId: me.Id}, {UserId: ming.Id}, {UserId: hua.UserId}}
	cases := map[string]api.SharedExpenseInput{
		"invalid_payers": bad(func(x *api.SharedExpenseInput) { x.Payers[0].UserId = stranger }),
		"invalid_shares": bad(func(x *api.SharedExpenseInput) { x.Shares[2].UserId = stranger }),
		"not_found":      moved,
	}
	settleToNobody := bad(func(x *api.SharedExpenseInput) {
		x.Kind = api.SharedKindSettlement
		x.Shares = []api.SharedShareInput{}
	})
	var batch []api.SharedExpenseInput
	want := map[uuid.UUID]string{settleToNobody.Id: "invalid_shares"}
	batch = append(batch, settleToNobody)
	for code, x := range cases {
		batch = append(batch, x)
		want[x.Id] = code
	}
	code, probs := saveGroup(admin, g, batch)
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("bad batch = %d", code)
	}
	for id, code := range want {
		if probs[id].Code != code {
			t.Errorf("want %s, got %+v", code, probs[id])
		}
	}

	// Settling up: Ming pays me 1,150, and Hua pays me 400, into the bank.
	settle := func(from uuid.UUID, amount int64) api.SharedExpenseInput {
		return api.SharedExpenseInput{
			Id: uuid.New(), Kind: api.SharedKindSettlement, Date: day(10), Description: "還款", Total: amount,
			SplitMethod: api.Exact, Payers: []api.SharedPayer{{UserId: from, Amount: amount}},
			Shares: []api.SharedShareInput{{UserId: me.Id}}, AccountId: &f.bank.Id,
		}
	}
	if code, probs := saveGroup(admin, g, []api.SharedExpenseInput{settle(ming.Id, 1150), settle(hua.UserId, 400)}); code != http.StatusOK {
		t.Fatalf("settle = %d %+v", code, probs)
	}
	if got := balanceOf(t, admin, f.budget, *g.AccountId); got != 0 {
		t.Fatalf("settled group account = %d", got)
	}
	if got := balanceOf(t, admin, f.budget, f.bank.Id); got != 50000-3000-200+1150+400 {
		t.Fatalf("bank = %d", got)
	}
	s := summary(t, admin, f.budget)
	if s.OnBudgetBalance != s.Pool+s.EnvelopeBalance {
		t.Fatalf("on budget %d != pool %d + envelopes %d", s.OnBudgetBalance, s.Pool, s.EnvelopeBalance)
	}

	// Archived: renamed with its account, closed, and read-only.
	rec = admin.do(http.MethodPut, "/api/groups/"+g.Id.String(), api.GroupInput{Name: "花蓮三日", Members: keep, Archived: ptr(true)})
	wantStatus(t, rec, http.StatusOK)
	decode(t, rec, &g)
	if !g.Archived || g.Name != "花蓮三日" {
		t.Fatalf("archived = %+v", g)
	}
	for _, a := range listAccounts(t, admin, f.budget) {
		if a.Id == *g.AccountId && (!a.Closed || a.Name != "花蓮三日") {
			t.Fatalf("archived group account = %+v", a)
		}
	}
	if code, _ := saveGroup(admin, g, nil); code != http.StatusConflict {
		t.Fatalf("archived save = %d", code)
	}
	wantStatus(t, admin.do(http.MethodPut, "/api/groups/"+g.Id.String(), api.GroupInput{Name: "花蓮三日", Members: keep, Archived: ptr(false)}), http.StatusOK)

	// Deleting every expense lets a member go and the group be deleted.
	ids := make([]uuid.UUID, 0)
	for _, x := range groupExpenses(t, admin, g).Expenses {
		ids = append(ids, x.Id)
	}
	if code, probs := saveGroup(admin, g, nil, ids...); code != http.StatusOK {
		t.Fatalf("delete all = %d %+v", code, probs)
	}
	wantStatus(t, admin.do(http.MethodPut, "/api/groups/"+g.Id.String(), api.GroupInput{Name: "花蓮三日", Members: keep[:1]}), http.StatusOK)
	wantStatus(t, admin.do(http.MethodDelete, "/api/groups/"+g.Id.String(), nil), http.StatusNoContent)
	var groups []api.Group
	decode(t, admin.do(http.MethodGet, "/api/groups", nil), &groups)
	if len(groups) != 0 {
		t.Fatalf("groups after delete = %+v", groups)
	}
	for _, a := range listAccounts(t, admin, f.budget) {
		if a.GroupId != nil {
			t.Fatalf("group account left = %+v", a)
		}
	}
}

func TestGroupsArePrivate(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	newLedgerFixture(t, admin)
	rec := admin.do(http.MethodPost, "/api/groups", api.GroupInput{Name: "家", Members: []api.GroupMemberInput{{DisplayName: ptr("媽")}}})
	wantStatus(t, rec, http.StatusCreated)
	var g api.Group
	decode(t, rec, &g)

	hs.addUser("hua", "hua-password-1")
	hua := hs.browser().mustLogin("hua", "hua-password-1")
	createBudget(t, hua, "華的帳本", false)
	wantError(t, hua.do(http.MethodGet, "/api/groups/"+g.Id.String()+"/expenses", nil), http.StatusNotFound, "not_found")
	wantError(t, hua.do(http.MethodDelete, "/api/groups/"+g.Id.String(), nil), http.StatusNotFound, "not_found")
	if code, _ := saveGroup(hua, g, nil); code != http.StatusNotFound {
		t.Fatalf("someone else's group = %d", code)
	}
}

func saveSplitting(b *browser, batch api.SplittingBatch) (int, map[uuid.UUID]api.BatchProblem) {
	for _, l := range []*[]uuid.UUID{&batch.DeleteFriends, &batch.DeleteGroups} {
		if *l == nil {
			*l = []uuid.UUID{}
		}
	}
	if batch.Friends == nil {
		batch.Friends = []api.FriendUpsert{}
	}
	if batch.Groups == nil {
		batch.Groups = []api.GroupUpsert{}
	}
	rec := b.do(http.MethodPost, "/api/splitting/batch", batch)
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

// The 分帳 page saves friends and groups in one batch (ADR-116).
func TestSplittingBatch(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	me, _ := admin.me()
	f := newLedgerFixture(t, admin)

	// A new friend and a new group with them, in one batch.
	ming, trip := uuid.New(), uuid.New()
	code, probs := saveSplitting(admin, api.SplittingBatch{
		Friends: []api.FriendUpsert{{Id: ming, DisplayName: " 小明 "}},
		Groups:  []api.GroupUpsert{{Id: trip, Name: "花蓮", Members: []uuid.UUID{ming}}},
	})
	if code != http.StatusOK {
		t.Fatalf("create = %d %+v", code, probs)
	}
	var groups []api.Group
	decode(t, admin.do(http.MethodGet, "/api/groups", nil), &groups)
	if len(groups) != 1 || groups[0].Id != trip || len(groups[0].Members) != 2 || groups[0].Members[1].UserId != ming ||
		groups[0].Members[1].DisplayName != "小明" || groups[0].AccountId == nil {
		t.Fatalf("groups = %+v", groups)
	}

	// A shared expense in the group keeps Ming in it and the group unarchived.
	lunch := api.SharedExpenseInput{
		Id: uuid.New(), Kind: api.SharedKindExpense, Date: day(5), Description: "午餐", Total: 1000,
		SplitMethod: api.Equal, Payers: []api.SharedPayer{{UserId: me.Id, Amount: 1000}},
		Shares:    []api.SharedShareInput{{UserId: me.Id}, {UserId: ming}},
		AccountId: &f.bank.Id, CategoryId: &f.food.Id,
	}
	if code, probs := saveGroup(admin, groups[0], []api.SharedExpenseInput{lunch}); code != http.StatusOK {
		t.Fatalf("lunch = %d %+v", code, probs)
	}
	stranger, hua := uuid.New(), uuid.New()
	code, probs = saveSplitting(admin, api.SplittingBatch{
		Friends:       []api.FriendUpsert{{Id: hua, DisplayName: ""}},
		Groups:        []api.GroupUpsert{{Id: trip, Name: "花蓮", Members: []uuid.UUID{}, Archived: true}},
		DeleteFriends: []uuid.UUID{ming},
	})
	if code != http.StatusUnprocessableEntity || probs[hua].Code != "invalid_name" || probs[trip].Code != "member_in_use" {
		t.Fatalf("bad batch = %d %+v", code, probs)
	}
	code, probs = saveSplitting(admin, api.SplittingBatch{
		Groups:        []api.GroupUpsert{{Id: trip, Name: "花蓮", Members: []uuid.UUID{ming, stranger}}},
		DeleteFriends: []uuid.UUID{ming},
		DeleteGroups:  []uuid.UUID{},
	})
	if code != http.StatusUnprocessableEntity || probs[trip].Code != "not_friend" {
		t.Fatalf("stranger = %d %+v", code, probs)
	}
	code, probs = saveSplitting(admin, api.SplittingBatch{
		Groups: []api.GroupUpsert{{Id: trip, Name: "花蓮", Members: []uuid.UUID{ming}, Archived: true}},
	})
	if code != http.StatusUnprocessableEntity || probs[trip].Code != "group_not_settled" {
		t.Fatalf("archive unsettled = %d %+v", code, probs)
	}
	code, probs = saveSplitting(admin, api.SplittingBatch{DeleteFriends: []uuid.UUID{ming}, DeleteGroups: []uuid.UUID{trip}})
	if code != http.StatusUnprocessableEntity || probs[trip].Code != "group_in_use" {
		t.Fatalf("delete in use = %d %+v", code, probs)
	}

	// Renames reach the accounts; once the expense is gone the group and
	// the friend can both be deleted in one batch.
	code, probs = saveSplitting(admin, api.SplittingBatch{
		Friends: []api.FriendUpsert{{Id: ming, DisplayName: "阿明"}},
		Groups:  []api.GroupUpsert{{Id: trip, Name: "花蓮三日", Members: []uuid.UUID{ming}}},
	})
	if code != http.StatusOK {
		t.Fatalf("rename = %d %+v", code, probs)
	}
	names := map[string]bool{}
	for _, a := range listAccounts(t, admin, f.budget) {
		names[a.Name] = true
	}
	if !names["阿明"] || !names["花蓮三日"] {
		t.Fatalf("accounts = %+v", names)
	}
	if code, probs := saveGroup(admin, groups[0], nil, lunch.Id); code != http.StatusOK {
		t.Fatalf("delete lunch = %d %+v", code, probs)
	}
	code, probs = saveSplitting(admin, api.SplittingBatch{DeleteFriends: []uuid.UUID{ming}, DeleteGroups: []uuid.UUID{trip}})
	if code != http.StatusOK {
		t.Fatalf("delete both = %d %+v", code, probs)
	}
	var friends []api.Friend
	decode(t, admin.do(http.MethodGet, "/api/friends", nil), &friends)
	decode(t, admin.do(http.MethodGet, "/api/groups", nil), &groups)
	if len(friends) != 0 || len(groups) != 0 {
		t.Fatalf("left = %+v %+v", friends, groups)
	}
}
