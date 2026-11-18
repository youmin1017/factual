package server

import (
	"net/http"
	"testing"

	"github.com/google/uuid"

	"factual/apps/api/internal/api"
)

// Integration tests of payee renaming, merging and deleting (ADR-069) and of
// the user's preferences (ADR-070).

func payees(t *testing.T, b *browser, budget api.Budget) map[string]api.Payee {
	t.Helper()
	rec := b.do(http.MethodGet, budgetPath(budget, "/payees"), nil)
	wantStatus(t, rec, http.StatusOK)
	var list []api.Payee
	decode(t, rec, &list)
	out := map[string]api.Payee{}
	for _, p := range list {
		out[p.Name] = p
	}
	return out
}

func TestRenameMergeAndDeletePayees(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)
	f := newLedgerFixture(t, admin)

	spend := func(payee string, amount int64) api.TransactionInput {
		return api.TransactionInput{Id: uuid.New(), Date: day(2), Payee: payee, Entries: []api.EntryInput{entry(f.card.Id, &f.food.Id, -amount)}}
	}
	wantStatus(t, save(admin, f.budget, []api.TransactionInput{
		spend("全聯", 100), spend("全聯福利中心", 200), spend("PX Mart", 300), spend("7-11", 50),
	}), http.StatusOK)

	ps := payees(t, admin, f.budget)
	if ps["全聯"].TransactionCount != 1 || ps["全聯"].LastCategoryId == nil || *ps["全聯"].LastCategoryId != f.food.Id {
		t.Fatalf("payee = %+v", ps["全聯"])
	}

	// Renaming onto another payee's name is refused; merging is the way.
	path := func(p api.Payee, rest string) string { return budgetPath(f.budget, "/payees/"+p.Id.String()+rest) }
	wantError(t, admin.do(http.MethodPut, path(ps["全聯福利中心"], ""), api.PayeeUpdate{Name: "全聯"}), http.StatusConflict, "payee_exists")
	wantError(t, admin.do(http.MethodPut, path(ps["7-11"], ""), api.PayeeUpdate{Name: "  "}), http.StatusBadRequest, "invalid_payee_name")
	rec := admin.do(http.MethodPut, path(ps["7-11"], ""), api.PayeeUpdate{Name: " 7-ELEVEN "})
	wantStatus(t, rec, http.StatusOK)
	var renamed api.Payee
	decode(t, rec, &renamed)
	if renamed.Name != "7-ELEVEN" || renamed.TransactionCount != 1 {
		t.Fatalf("renamed = %+v", renamed)
	}

	wantError(t, admin.do(http.MethodPost, path(ps["全聯"], "/merge"), api.PayeeMerge{SourceIds: []uuid.UUID{ps["全聯"].Id}}),
		http.StatusBadRequest, "invalid_merge")
	wantError(t, admin.do(http.MethodPost, path(ps["全聯"], "/merge"), api.PayeeMerge{SourceIds: []uuid.UUID{uuid.New()}}),
		http.StatusNotFound, "not_found")
	rec = admin.do(http.MethodPost, path(ps["全聯"], "/merge"), api.PayeeMerge{
		SourceIds: []uuid.UUID{ps["全聯福利中心"].Id, ps["PX Mart"].Id, ps["PX Mart"].Id},
	})
	wantStatus(t, rec, http.StatusOK)
	var merged api.Payee
	decode(t, rec, &merged)
	if merged.TransactionCount != 3 {
		t.Fatalf("merged = %+v", merged)
	}
	after := payees(t, admin, f.budget)
	if len(after) != 2 {
		t.Fatalf("payees after merge = %+v", after)
	}
	for _, tx := range register(t, admin, f.budget, f.card) {
		if tx.PayeeName != nil && *tx.PayeeName != "全聯" && *tx.PayeeName != "7-ELEVEN" {
			t.Fatalf("transaction kept payee %q", *tx.PayeeName)
		}
	}

	// Only an unused payee can be deleted.
	wantError(t, admin.do(http.MethodDelete, path(after["全聯"], ""), nil), http.StatusConflict, "payee_in_use")
	var lone api.TransactionInput
	for _, tx := range register(t, admin, f.budget, f.card) {
		if tx.PayeeName != nil && *tx.PayeeName == "7-ELEVEN" {
			lone.Id = tx.Id
		}
	}
	wantStatus(t, save(admin, f.budget, nil, lone.Id), http.StatusOK)
	wantStatus(t, admin.do(http.MethodDelete, path(after["7-ELEVEN"], ""), nil), http.StatusNoContent)
	wantError(t, admin.do(http.MethodDelete, path(after["7-ELEVEN"], ""), nil), http.StatusNotFound, "not_found")

	// Viewers can read payees but not change them.
	hs.addUser("ming", "ming-password")
	ming := hs.browser().mustLogin("ming", "ming-password")
	if _, err := hs.pool.Exec(t.Context(), `
		insert into budget_members (budget_id, user_id, role)
		select $1, id, 'viewer' from users where username = 'ming'`, f.budget.Id); err != nil {
		t.Fatal(err)
	}
	payees(t, ming, f.budget)
	wantError(t, ming.do(http.MethodPut, path(after["全聯"], ""), api.PayeeUpdate{Name: "x"}), http.StatusForbidden, "forbidden")
}

func TestPreferences(t *testing.T) {
	hs := newHarness(t)
	admin := hs.browser().mustLogin(adminName, adminPassword)

	rec := admin.do(http.MethodGet, "/api/me/preferences", nil)
	wantStatus(t, rec, http.StatusOK)
	var p api.Preferences
	decode(t, rec, &p)
	if p.EditorKeymap != "" {
		t.Fatalf("default keymap = %q", p.EditorKeymap)
	}

	rec = admin.do(http.MethodPut, "/api/me/preferences", api.Preferences{EditorKeymap: "inoremap jk <Esc>\r\nnnoremap H 0\n"})
	wantStatus(t, rec, http.StatusOK)
	rec = admin.do(http.MethodGet, "/api/me/preferences", nil)
	decode(t, rec, &p)
	if p.EditorKeymap != "inoremap jk <Esc>\nnnoremap H 0\n" {
		t.Fatalf("keymap = %q", p.EditorKeymap)
	}

	// Each user has their own.
	hs.addUser("ming", "ming-password")
	ming := hs.browser().mustLogin("ming", "ming-password")
	decode(t, ming.do(http.MethodGet, "/api/me/preferences", nil), &p)
	if p.EditorKeymap != "" {
		t.Fatalf("other user's keymap = %q", p.EditorKeymap)
	}
	wantStatus(t, hs.browser().do(http.MethodGet, "/api/me/preferences", nil), http.StatusUnauthorized)
}
