package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"factual/apps/api/internal/api"
)

// The users page and one-time links (ADR-131, ADR-132).

func saveUsers(b *browser, batch api.UsersBatch) *httptest.ResponseRecorder {
	b.hs.t.Helper()
	if batch.Users == nil {
		batch.Users = []api.UserChange{}
	}
	if batch.Links == nil {
		batch.Links = []api.NewLink{}
	}
	if batch.Revoke == nil {
		batch.Revoke = []uuid.UUID{}
	}
	return b.do(http.MethodPost, "/api/users/batch", batch)
}

func listUsers(t *testing.T, b *browser) api.UsersPage {
	t.Helper()
	rec := b.do(http.MethodGet, "/api/users", nil)
	wantStatus(t, rec, http.StatusOK)
	var page api.UsersPage
	decode(t, rec, &page)
	return page
}

func userNamed(t *testing.T, page api.UsersPage, username string) api.UserSummary {
	t.Helper()
	for _, u := range page.Users {
		if u.Username == username {
			return u
		}
	}
	t.Fatalf("no user %q in %+v", username, page.Users)
	return api.UserSummary{}
}

func TestUsersPageIsForManagers(t *testing.T) {
	hs := newHarness(t)
	hs.addUser("ming", "ming-password")
	ming := hs.browser().mustLogin("ming", "ming-password")
	wantError(t, ming.do(http.MethodGet, "/api/users", nil), http.StatusForbidden, "forbidden")
	wantError(t, saveUsers(ming, api.UsersBatch{}), http.StatusForbidden, "forbidden")
}

func TestJoinAndResetLinks(t *testing.T) {
	hs := newHarness(t)
	hs.addUser("ming", "ming-password")
	admin := hs.browser().mustLogin(adminName, adminPassword)
	ming := hs.browser().mustLogin("ming", "ming-password")
	page := listUsers(t, admin)
	mingID := userNamed(t, page, "ming").Id
	if len(page.Users) != 2 || len(page.Links) != 0 {
		t.Fatalf("page = %+v", page)
	}

	// The admin makes a join link and a reset link for ming; tokens come back once.
	joinID, resetID := uuid.New(), uuid.New()
	rec := saveUsers(admin, api.UsersBatch{Links: []api.NewLink{
		{Id: joinID, Purpose: api.Join, Note: "阿華"},
		{Id: resetID, Purpose: api.Reset, UserId: &mingID},
	}})
	wantStatus(t, rec, http.StatusOK)
	var saved api.UsersBatchSaved
	decode(t, rec, &saved)
	tokens := map[uuid.UUID]string{}
	for _, c := range saved.Created {
		tokens[c.Id] = c.Token
	}
	if len(tokens) != 2 || tokens[joinID] == "" || tokens[resetID] == "" {
		t.Fatalf("saved = %+v", saved)
	}
	// The page can copy an open link again (ADR-135): its token is kept sealed.
	page = listUsers(t, admin)
	if len(page.Links) != 2 {
		t.Fatalf("open links = %+v", page.Links)
	}
	for _, l := range page.Links {
		if l.Token == nil || *l.Token != tokens[l.Id] {
			t.Fatalf("link %s lists token %v, want the one made", l.Id, l.Token)
		}
	}
	var sealed string
	if err := hs.pool.QueryRow(context.Background(), `select token_sealed from links where id = $1`, joinID).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	if sealed == "" || strings.Contains(sealed, tokens[joinID]) {
		t.Fatalf("the token is not sealed at rest: %q", sealed)
	}

	// Anyone with the token sees what it is for; others see nothing.
	visitor := hs.browser()
	var info api.LinkInfo
	rec = visitor.do(http.MethodGet, "/api/auth/links/"+tokens[resetID], nil)
	wantStatus(t, rec, http.StatusOK)
	decode(t, rec, &info)
	if info.Purpose != api.Reset || info.Username != "ming" {
		t.Fatalf("reset link = %+v", info)
	}
	wantError(t, visitor.do(http.MethodGet, "/api/auth/links/nope", nil), http.StatusNotFound, "link_invalid")

	// Joining registers a member and logs in; the link is then used up.
	wantError(t, visitor.do(http.MethodPost, "/api/auth/join", api.JoinRequest{
		Token: tokens[joinID], Username: "ming", DisplayName: "Ming", Password: "a-new-password",
	}), http.StatusConflict, "username_taken")
	rec = visitor.do(http.MethodPost, "/api/auth/join", api.JoinRequest{
		Token: tokens[joinID], Username: "hua", DisplayName: "阿華", Password: "hua-password",
	})
	wantStatus(t, rec, http.StatusOK)
	if u, status := visitor.me(); status != http.StatusOK || u.Username != "hua" || u.Role != api.InstanceRoleMember {
		t.Fatalf("/me after joining = %d %+v", status, u)
	}
	wantError(t, hs.browser().do(http.MethodPost, "/api/auth/join", api.JoinRequest{
		Token: tokens[joinID], Username: "other", DisplayName: "Other", Password: "other-password",
	}), http.StatusNotFound, "link_invalid")
	// A join link does not reset, nor a reset link join.
	wantError(t, hs.browser().do(http.MethodPost, "/api/auth/join", api.JoinRequest{
		Token: tokens[resetID], Username: "other", DisplayName: "Other", Password: "other-password",
	}), http.StatusNotFound, "link_invalid")

	// Resetting sets the password, ends ming's sessions and logs in.
	rec = hs.browser().do(http.MethodPost, "/api/auth/reset", api.ResetRequest{Token: tokens[resetID], Password: "ming-new-password"})
	wantStatus(t, rec, http.StatusOK)
	if _, status := ming.me(); status != http.StatusUnauthorized {
		t.Fatalf("ming's old session survived the reset (%d)", status)
	}
	wantError(t, hs.browser().login("ming", "ming-password"), http.StatusUnauthorized, "invalid_credentials")
	hs.browser().mustLogin("ming", "ming-new-password")
	wantError(t, hs.browser().do(http.MethodPost, "/api/auth/reset", api.ResetRequest{Token: tokens[resetID], Password: "again-password"}),
		http.StatusNotFound, "link_invalid")

	// Revoked and expired links are invalid.
	revoked, expired := uuid.New(), uuid.New()
	rec = saveUsers(admin, api.UsersBatch{Links: []api.NewLink{{Id: revoked, Purpose: api.Join}, {Id: expired, Purpose: api.Join}}})
	wantStatus(t, rec, http.StatusOK)
	decode(t, rec, &saved)
	for _, c := range saved.Created {
		tokens[c.Id] = c.Token
	}
	wantStatus(t, saveUsers(admin, api.UsersBatch{Revoke: []uuid.UUID{revoked}}), http.StatusOK)
	wantError(t, hs.browser().do(http.MethodGet, "/api/auth/links/"+tokens[revoked], nil), http.StatusNotFound, "link_invalid")
	if _, err := hs.pool.Exec(context.Background(), `update links set expires_at = now() - interval '1 minute' where id = $1`, expired); err != nil {
		t.Fatal(err)
	}
	wantError(t, hs.browser().do(http.MethodGet, "/api/auth/links/"+tokens[expired], nil), http.StatusNotFound, "link_invalid")
	if page := listUsers(t, admin); len(page.Links) != 0 {
		t.Fatalf("used, revoked and expired links are listed: %+v", page.Links)
	}

	// A reset link is only for a user who can log in.
	nobody := uuid.New()
	bad := uuid.New()
	wantProblem(t, saveUsers(admin, api.UsersBatch{Links: []api.NewLink{{Id: bad, Purpose: api.Reset, UserId: &nobody}}}),
		bad, "", "not_found")
}

func TestUserRolesAndAccess(t *testing.T) {
	hs := newHarness(t)
	hs.addUser("ming", "ming-password")
	admin := hs.browser().mustLogin(adminName, adminPassword)
	ming := hs.browser().mustLogin("ming", "ming-password")
	page := listUsers(t, admin)
	adminID, mingID := userNamed(t, page, adminName).Id, userNamed(t, page, "ming").Id

	// The admin cannot demote or disable themselves.
	wantProblem(t, saveUsers(admin, api.UsersBatch{Users: []api.UserChange{{Id: adminID, Role: api.InstanceRoleMember, Active: true}}}),
		adminID, "role", "own_role")
	wantProblem(t, saveUsers(admin, api.UsersBatch{Users: []api.UserChange{{Id: adminID, Role: api.InstanceRoleAdmin, Active: false}}}),
		adminID, "active", "own_access")

	// Disabling ends ming's sessions and refuses logging in; enabling lets them back.
	wantStatus(t, saveUsers(admin, api.UsersBatch{Users: []api.UserChange{{Id: mingID, Role: api.InstanceRoleMember, Active: false}}}), http.StatusOK)
	if _, status := ming.me(); status != http.StatusUnauthorized {
		t.Fatalf("a disabled user's session survived (%d)", status)
	}
	wantError(t, hs.browser().login("ming", "ming-password"), http.StatusForbidden, "account_disabled")
	if u := userNamed(t, listUsers(t, admin), "ming"); u.Active {
		t.Fatalf("ming = %+v", u)
	}

	// Made an admin, ming may manage users too.
	wantStatus(t, saveUsers(admin, api.UsersBatch{Users: []api.UserChange{{Id: mingID, Role: api.InstanceRoleAdmin, Active: true}}}), http.StatusOK)
	ming = hs.browser().mustLogin("ming", "ming-password")
	if u, _ := ming.me(); u.Role != api.InstanceRoleAdmin || len(u.Permissions) != 4 {
		t.Fatalf("ming = %+v", u)
	}
	wantStatus(t, ming.do(http.MethodGet, "/api/users", nil), http.StatusOK)
}
