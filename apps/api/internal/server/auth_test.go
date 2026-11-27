package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/config"
	"factual/apps/api/internal/database/dbtest"
	"factual/apps/api/internal/domain/calendar"
	"factual/apps/api/internal/domain/identity"
	"factual/apps/api/internal/domain/ledger"
	"factual/apps/api/internal/secretbox"
)

// Integration tests of sessions and OpenID Connect against the test database
// (skipped without FACTUAL_TEST_DATABASE_URL) and a fake identity provider.

const (
	testPublicURL = "http://app.test"
	adminName     = "admin"
	adminPassword = "admin-password"
)

// testToday is what day it is for the ledger in these tests.
var testToday = time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)

type harness struct {
	t      *testing.T
	h      http.Handler
	pool   *pgxpool.Pool
	ledger *ledger.Service
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	pool := dbtest.New(t)

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	box, err := secretbox.New(base64.StdEncoding.EncodeToString(key))
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Auth{
		PasswordLogin: true, CookieName: "factual_session", IdleTimeout: time.Hour, MaxAge: 24 * time.Hour,
		BootstrapAdmin: config.BootstrapAdmin{Username: adminName, Password: adminPassword},
	}
	svc := identity.New(pool, cfg, identity.NewOIDC(pool, box, testPublicURL))
	created, err := svc.EnsureBootstrapAdmin(context.Background())
	if err != nil || !created {
		t.Fatalf("bootstrap admin: created=%v err=%v", created, err)
	}
	cal := calendar.New(pool)
	led := ledger.New(pool, cal)
	led.SetClock(func() time.Time { return testToday })
	e, err := New(Deps{DB: pool, Identity: svc, Ledger: led, Calendar: cal})
	if err != nil {
		t.Fatal(err)
	}
	return &harness{t: t, h: e, pool: pool, ledger: led}
}

// addUser inserts a user who can log in with password.
func (hs *harness) addUser(username, password string) {
	hs.t.Helper()
	hash, err := identity.HashPassword(password)
	if err != nil {
		hs.t.Fatal(err)
	}
	_, err = hs.pool.Exec(context.Background(),
		`insert into users (username, display_name, password_hash) values ($1, $1, $2)`, username, hash)
	if err != nil {
		hs.t.Fatal(err)
	}
}

// browser is an HTTP client with a cookie jar; redirects are not followed.
type browser struct {
	hs      *harness
	cookies map[string]string
}

func (hs *harness) browser() *browser { return &browser{hs: hs, cookies: map[string]string{}} }

func (b *browser) do(method, path string, body any) *httptest.ResponseRecorder {
	b.hs.t.Helper()
	var payload bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&payload).Encode(body); err != nil {
			b.hs.t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, &payload)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for name, value := range b.cookies {
		req.AddCookie(&http.Cookie{Name: name, Value: value})
	}
	rec := httptest.NewRecorder()
	b.hs.h.ServeHTTP(rec, req)
	for _, c := range rec.Result().Cookies() {
		if c.MaxAge < 0 || c.Value == "" {
			delete(b.cookies, c.Name)
		} else {
			b.cookies[c.Name] = c.Value
		}
	}
	return rec
}

func (b *browser) login(username, password string) *httptest.ResponseRecorder {
	return b.do(http.MethodPost, "/api/auth/login", api.LoginRequest{Username: username, Password: password})
}

// mustLogin logs in and fails the test otherwise.
func (b *browser) mustLogin(username, password string) *browser {
	b.hs.t.Helper()
	if rec := b.login(username, password); rec.Code != http.StatusOK {
		b.hs.t.Fatalf("login %s = %d (%s)", username, rec.Code, rec.Body)
	}
	return b
}

func (b *browser) me() (api.CurrentUser, int) {
	b.hs.t.Helper()
	rec := b.do(http.MethodGet, "/api/me", nil)
	var u api.CurrentUser
	if rec.Code == http.StatusOK {
		decode(b.hs.t, rec, &u)
	}
	return u, rec.Code
}

func decode(t *testing.T, rec *httptest.ResponseRecorder, into any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), into); err != nil {
		t.Fatalf("decode %s: %v", rec.Body, err)
	}
}

func wantStatus(t *testing.T, rec *httptest.ResponseRecorder, status int) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, status, rec.Body)
	}
}

func wantError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	wantStatus(t, rec, status)
	if got := decodeError(t, rec); got.Code != code {
		t.Fatalf("error code = %q, want %q", got.Code, code)
	}
}

// wantRedirect checks a 302 and returns its location.
func wantRedirect(t *testing.T, rec *httptest.ResponseRecorder, location string) {
	t.Helper()
	wantStatus(t, rec, http.StatusFound)
	if got := rec.Header().Get("Location"); got != location {
		t.Fatalf("redirected to %q, want %q", got, location)
	}
}

func TestBootstrapAdminIsCreatedOnce(t *testing.T) {
	hs := newHarness(t)
	var n int
	if err := hs.pool.QueryRow(context.Background(), `select count(*) from users where role = 'admin'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("admins = %d, want 1", n)
	}
	// A second start must not create another one, even without credentials.
	svc := identity.New(hs.pool, config.Auth{}, nil)
	created, err := svc.EnsureBootstrapAdmin(context.Background())
	if err != nil || created {
		t.Fatalf("second bootstrap: created=%v err=%v", created, err)
	}
}

func TestBootstrapNeedsCredentialsOnAnEmptyDatabase(t *testing.T) {
	pool := dbtest.New(t)
	svc := identity.New(pool, config.Auth{BootstrapAdmin: config.BootstrapAdmin{Username: "admin", Password: "short"}}, nil)
	if _, err := svc.EnsureBootstrapAdmin(context.Background()); err == nil {
		t.Fatal("expected an error for a too short bootstrap password")
	}
}

func TestLoginSessionAndLogout(t *testing.T) {
	hs := newHarness(t)
	b := hs.browser()

	wantError(t, b.login(adminName, "wrong-password"), http.StatusUnauthorized, "invalid_credentials")
	wantError(t, b.login("nobody", adminPassword), http.StatusUnauthorized, "invalid_credentials")
	if _, status := b.me(); status != http.StatusUnauthorized {
		t.Fatalf("/me before login = %d, want 401", status)
	}

	rec := b.login("ADMIN", adminPassword) // usernames are case-insensitive
	wantStatus(t, rec, http.StatusOK)
	cookie := rec.Result().Cookies()[0]
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" {
		t.Fatalf("session cookie is not httpOnly/Lax/root: %+v", cookie)
	}

	u, status := b.me()
	if status != http.StatusOK || u.Username != adminName || u.Role != api.InstanceRoleAdmin || !u.HasPassword ||
		len(u.Permissions) != 4 {
		t.Fatalf("/me = %d %+v", status, u)
	}

	// Only the token's hash is stored.
	var stored int
	err := hs.pool.QueryRow(context.Background(),
		`select count(*) from sessions where token_hash = $1`, []byte(cookie.Value)).Scan(&stored)
	if err != nil || stored != 0 {
		t.Fatalf("session token is stored in the clear (rows=%d err=%v)", stored, err)
	}

	wantStatus(t, b.do(http.MethodPost, "/api/auth/logout", nil), http.StatusNoContent)
	if _, status := b.me(); status != http.StatusUnauthorized {
		t.Fatalf("/me after logout = %d, want 401", status)
	}
	// The old token no longer works even if replayed.
	b.cookies[cookie.Name] = cookie.Value
	if _, status := b.me(); status != http.StatusUnauthorized {
		t.Fatalf("/me with a logged-out token = %d, want 401", status)
	}
}

func TestDisabledUserCannotLoginAndLosesSession(t *testing.T) {
	hs := newHarness(t)
	hs.addUser("ming", "ming-password")
	b := hs.browser().mustLogin("ming", "ming-password")

	if _, err := hs.pool.Exec(context.Background(), `update users set disabled_at = now() where username = 'ming'`); err != nil {
		t.Fatal(err)
	}
	if _, status := b.me(); status != http.StatusUnauthorized {
		t.Fatalf("/me of a disabled user = %d, want 401", status)
	}
	wantError(t, hs.browser().login("ming", "ming-password"), http.StatusForbidden, "account_disabled")
}

func TestExpiredSessionIsRejected(t *testing.T) {
	hs := newHarness(t)
	b := hs.browser().mustLogin(adminName, adminPassword)
	if _, err := hs.pool.Exec(context.Background(), `update sessions set last_seen_at = now() - interval '2 hours'`); err != nil {
		t.Fatal(err)
	}
	if _, status := b.me(); status != http.StatusUnauthorized {
		t.Fatalf("/me with an idle session = %d, want 401", status)
	}
}

func TestChangePassword(t *testing.T) {
	hs := newHarness(t)
	here := hs.browser().mustLogin(adminName, adminPassword)
	elsewhere := hs.browser().mustLogin(adminName, adminPassword)

	change := func(current, next string) *httptest.ResponseRecorder {
		return here.do(http.MethodPut, "/api/me/password", api.ChangePasswordRequest{CurrentPassword: current, NewPassword: next})
	}
	wantError(t, change("wrong", "new-password-1"), http.StatusBadRequest, "wrong_password")
	wantStatus(t, change(adminPassword, "short"), http.StatusBadRequest) // spec: at least 8 characters
	wantStatus(t, change(adminPassword, "new-password-1"), http.StatusNoContent)

	if _, status := here.me(); status != http.StatusOK {
		t.Fatalf("the session that changed the password ended (%d)", status)
	}
	if _, status := elsewhere.me(); status != http.StatusUnauthorized {
		t.Fatalf("other sessions survived a password change (%d)", status)
	}
	wantError(t, hs.browser().login(adminName, adminPassword), http.StatusUnauthorized, "invalid_credentials")
	hs.browser().mustLogin(adminName, "new-password-1")
}

func TestUpdateProfile(t *testing.T) {
	hs := newHarness(t)
	hs.addUser("ming", "ming-password")
	here := hs.browser().mustLogin(adminName, adminPassword)
	elsewhere := hs.browser().mustLogin(adminName, adminPassword)

	rename := func(username, displayName string) *httptest.ResponseRecorder {
		return here.do(http.MethodPatch, "/api/me", api.ProfileUpdate{Username: username, DisplayName: displayName})
	}
	wantError(t, rename("has space", "管理員"), http.StatusBadRequest, "invalid_username")
	wantError(t, rename("  ", "管理員"), http.StatusBadRequest, "invalid_username")
	wantError(t, rename("boss", "   "), http.StatusBadRequest, "invalid_display_name")
	wantError(t, rename("MING", "管理員"), http.StatusConflict, "username_taken") // case-insensitive

	rec := rename(" boss ", " 大 老 闆 ")
	wantStatus(t, rec, http.StatusOK)
	var u api.CurrentUser
	decode(t, rec, &u)
	if u.Username != "boss" || u.DisplayName != "大 老 闆" || u.Role != api.InstanceRoleAdmin {
		t.Fatalf("renamed user = %+v", u)
	}
	// Sessions carry on, under the new names.
	for _, b := range []*browser{here, elsewhere} {
		if me, status := b.me(); status != http.StatusOK || me.Username != "boss" || me.DisplayName != "大 老 闆" {
			t.Fatalf("/me after renaming = %d %+v", status, me)
		}
	}
	// The new username logs in; the old one no longer does.
	wantError(t, hs.browser().login(adminName, adminPassword), http.StatusUnauthorized, "invalid_credentials")
	hs.browser().mustLogin("BOSS", adminPassword)

	// Keeping the username and changing only its case is allowed.
	wantStatus(t, rename("Boss", "大老闆"), http.StatusOK)
}

func TestProviderSettingsAreAdminOnly(t *testing.T) {
	hs := newHarness(t)
	hs.addUser("ming", "ming-password")
	ming := hs.browser().mustLogin("ming", "ming-password")
	if u, _ := ming.me(); u.Role != api.InstanceRoleMember || len(u.Permissions) != 0 {
		t.Fatalf("a member's /me = %+v", u)
	}

	wantError(t, ming.do(http.MethodGet, "/api/oidc-providers", nil), http.StatusForbidden, "forbidden")
	wantError(t, saveProviders(ming, []api.OidcProviderUpsert{providerUpsert("corp", "https://idp.invalid", "s")}),
		http.StatusForbidden, "forbidden")
	wantError(t, hs.browser().do(http.MethodGet, "/api/oidc-providers", nil), http.StatusUnauthorized, "unauthorized")
}

func providerUpsert(code, issuer, secret string) api.OidcProviderUpsert {
	return api.OidcProviderUpsert{
		Id: uuid.New(), Code: code, Name: "Company " + code, Kind: api.Oidc, Issuer: issuer, ClientId: "factual",
		ClientSecret: secret, Scopes: []string{}, Enabled: true,
	}
}

// saveProviders posts the identity providers page's batch.
func saveProviders(b *browser, upserts []api.OidcProviderUpsert, deletes ...uuid.UUID) *httptest.ResponseRecorder {
	b.hs.t.Helper()
	return b.do(http.MethodPost, "/api/oidc-providers/batch", api.OidcProviderBatch{
		Upserts: append([]api.OidcProviderUpsert{}, upserts...), Deletes: append([]uuid.UUID{}, deletes...),
	})
}

// listProviders returns the providers as the settings page reads them.
func listProviders(t *testing.T, b *browser) api.OidcProviderList {
	t.Helper()
	rec := b.do(http.MethodGet, "/api/oidc-providers", nil)
	wantStatus(t, rec, http.StatusOK)
	var list api.OidcProviderList
	decode(t, rec, &list)
	return list
}

// wantProblem checks a 422 naming the line, field and code.
func wantProblem(t *testing.T, rec *httptest.ResponseRecorder, id uuid.UUID, field, code string) {
	t.Helper()
	p, ok := wantProblems(t, rec)[id]
	if !ok || p.Field != field || p.Code != code {
		t.Fatalf("problem of %s = %+v, want %s %s (body %s)", id, p, field, code, rec.Body)
	}
}

func TestOIDCProviderManagement(t *testing.T) {
	hs := newHarness(t)
	idp := newFakeIdP(t, "factual")
	admin := hs.browser().mustLogin(adminName, adminPassword)

	// The issuer must serve discovery; the code is used in URLs.
	bad := providerUpsert("corp", "http://127.0.0.1:1", "s")
	wantProblem(t, saveProviders(admin, []api.OidcProviderUpsert{bad}), bad.Id, "issuer", "invalid_issuer")
	bad = providerUpsert("Bad Code", idp.srv.URL, "s")
	wantProblem(t, saveProviders(admin, []api.OidcProviderUpsert{bad}), bad.Id, "code", "invalid_code")
	bad = providerUpsert("corp", idp.srv.URL, "s")
	bad.Icon = "Not An Icon"
	wantProblem(t, saveProviders(admin, []api.OidcProviderUpsert{bad}), bad.Id, "icon", "invalid_icon")
	// A batch with a problem saves nothing.
	if list := listProviders(t, admin); len(list.Items) != 0 {
		t.Fatalf("a refused batch saved %+v", list.Items)
	}

	corp := providerUpsert("corp", idp.srv.URL, "top-secret")
	corp.Icon = "authentik"
	wantStatus(t, saveProviders(admin, []api.OidcProviderUpsert{corp}), http.StatusOK)
	list := listProviders(t, admin)
	if len(list.Items) != 1 || list.CallbackUrl != testPublicURL+"/api/auth/oidc/callback" || !list.EncryptionConfigured {
		t.Fatalf("list = %+v", list)
	}
	created := list.Items[0]
	if created.Id != corp.Id || !created.HasSecret || created.Kind != api.Oidc || created.Icon != "authentik" ||
		strings.Join(created.Scopes, " ") != "openid email profile" || !created.Enabled {
		t.Fatalf("created provider = %+v", created)
	}
	rec := admin.do(http.MethodGet, "/api/oidc-providers", nil)
	if strings.Contains(rec.Body.String(), "top-secret") {
		t.Fatal("the client secret is returned by the API")
	}
	var stored string
	if err := hs.pool.QueryRow(context.Background(), `select client_secret from oidc_providers where code = 'corp'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == "" || strings.Contains(stored, "top-secret") {
		t.Fatalf("the client secret is not encrypted at rest: %q", stored)
	}

	// Codes are unique among the providers kept.
	dup := providerUpsert("corp", idp.srv.URL, "s")
	wantProblem(t, saveProviders(admin, []api.OidcProviderUpsert{dup}), dup.Id, "code", "duplicate_code")

	// An empty secret on update keeps the stored one; disabling hides it
	// from the login page; scopes are kept as a list, without repeats.
	update := corp
	update.ClientSecret, update.Name, update.Enabled = "", "Renamed", false
	update.Scopes = []string{"openid", "groups", "groups"}
	wantStatus(t, saveProviders(admin, []api.OidcProviderUpsert{update}), http.StatusOK)
	updated := listProviders(t, admin).Items[0]
	if updated.Name != "Renamed" || updated.Enabled || !updated.HasSecret || strings.Join(updated.Scopes, " ") != "openid groups" {
		t.Fatalf("updated provider = %+v", updated)
	}
	var after string
	if err := hs.pool.QueryRow(context.Background(), `select client_secret from oidc_providers where code = 'corp'`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != stored {
		t.Fatal("an empty client secret on update replaced the stored one")
	}
	bad = update
	bad.Scopes = []string{"two words"}
	wantProblem(t, saveProviders(admin, []api.OidcProviderUpsert{bad}), bad.Id, "scopes", "invalid_scope")

	var public []api.LoginProvider
	rec = hs.browser().do(http.MethodGet, "/api/auth/oidc/providers", nil)
	wantStatus(t, rec, http.StatusOK)
	decode(t, rec, &public)
	if len(public) != 0 {
		t.Fatalf("a disabled provider is offered on the login page: %+v", public)
	}

	// The kind is fixed once created.
	bad = update
	bad.Kind, bad.Issuer = api.Github, "https://github.com"
	wantProblem(t, saveProviders(admin, []api.OidcProviderUpsert{bad}), bad.Id, "kind", "kind_fixed")

	// Deleting frees the code in the same batch; deleting again is nothing.
	again := providerUpsert("corp", idp.srv.URL, "s")
	rec = saveProviders(admin, []api.OidcProviderUpsert{again}, corp.Id)
	wantStatus(t, rec, http.StatusOK)
	var saved api.OidcProviderBatchSaved
	decode(t, rec, &saved)
	if saved.Upserted != 1 || saved.Deleted != 1 {
		t.Fatalf("saved = %+v", saved)
	}
	rec = saveProviders(admin, nil, corp.Id)
	wantStatus(t, rec, http.StatusOK)
	decode(t, rec, &saved)
	if saved.Deleted != 0 {
		t.Fatalf("deleting a deleted provider = %+v", saved)
	}
	if list := listProviders(t, admin); len(list.Items) != 1 || list.Items[0].Id != again.Id {
		t.Fatalf("after delete = %+v", list.Items)
	}
}

// TestOAuthSiteLogin links and logs in through GitHub and Discord, which
// only speak OAuth2: the user is read from their user API (ADR-125).
func TestOAuthSiteLogin(t *testing.T) {
	for _, kind := range []api.OidcProviderKind{api.Github, api.Discord} {
		t.Run(string(kind), func(t *testing.T) {
			hs := newHarness(t)
			site := newFakeSite(t, kind)
			admin := hs.browser().mustLogin(adminName, adminPassword)

			p := providerUpsert(string(kind), site.srv.URL+"/", "")
			p.Kind = kind
			if kind == api.Github {
				// GitHub always needs the secret.
				wantProblem(t, saveProviders(admin, []api.OidcProviderUpsert{p}), p.Id, "clientSecret", "secret_required")
			}
			p.ClientSecret = "site-secret"
			wantStatus(t, saveProviders(admin, []api.OidcProviderUpsert{p}), http.StatusOK)
			saved := listProviders(t, admin).Items[0]
			want := map[api.OidcProviderKind]string{api.Github: "read:user user:email", api.Discord: "identify email"}[kind]
			if saved.Issuer != site.srv.URL || strings.Join(saved.Scopes, " ") != want {
				t.Fatalf("saved provider = %+v", saved)
			}

			signIn := func(b *browser, start string, user int) *httptest.ResponseRecorder {
				t.Helper()
				rec := b.do(http.MethodGet, start, nil)
				wantStatus(t, rec, http.StatusFound)
				code, state := site.authorize(rec.Header().Get("Location"), user, want)
				return b.do(http.MethodGet, "/api/auth/oidc/callback?code="+url.QueryEscape(code)+"&state="+url.QueryEscape(state), nil)
			}
			code := string(kind)
			wantRedirect(t, signIn(hs.browser(), "/api/auth/oidc/"+code+"/login", 4242), "/login?error=oidc_not_linked")
			wantRedirect(t, signIn(admin, "/api/auth/oidc/"+code+"/link", 4242), "/settings/users?linked="+code)
			var mine []api.LinkedIdentity
			rec := admin.do(http.MethodGet, "/api/me/identities", nil)
			decode(t, rec, &mine)
			if len(mine) != 1 || mine[0].Email != "user4242@site.test" {
				t.Fatalf("identities = %+v", mine)
			}
			var subject string
			if err := hs.pool.QueryRow(context.Background(), `select subject from user_identities`).Scan(&subject); err != nil {
				t.Fatal(err)
			}
			if subject != "4242" {
				t.Fatalf("subject = %q, want the site's user id", subject)
			}

			fresh := hs.browser()
			wantRedirect(t, signIn(fresh, "/api/auth/oidc/"+code+"/login", 4242), "/")
			if u, status := fresh.me(); status != http.StatusOK || u.Username != adminName {
				t.Fatalf("/me after %s login = %d %+v", kind, status, u)
			}
			// Another user of the site is someone else.
			wantRedirect(t, signIn(hs.browser(), "/api/auth/oidc/"+code+"/login", 7), "/login?error=oidc_not_linked")
		})
	}
}

func TestOIDCLoginAndLinking(t *testing.T) {
	hs := newHarness(t)
	idp := newFakeIdP(t, "factual")
	hs.addUser("ming", "ming-password")
	admin := hs.browser().mustLogin(adminName, adminPassword)
	corp := providerUpsert("corp", idp.srv.URL, "top-secret")
	corp.Icon = "authentik"
	wantStatus(t, saveProviders(admin, []api.OidcProviderUpsert{corp}), http.StatusOK)

	var public []api.LoginProvider
	rec := hs.browser().do(http.MethodGet, "/api/auth/oidc/providers", nil)
	decode(t, rec, &public)
	if len(public) != 1 || public[0].Code != "corp" || public[0].Icon != "authentik" {
		t.Fatalf("login providers = %+v", public)
	}

	// signIn drives a flow: our API redirects to the IdP, the user signs in
	// there as (sub, email), and the IdP redirects back to the callback.
	signIn := func(b *browser, start, sub, email string) *httptest.ResponseRecorder {
		t.Helper()
		rec := b.do(http.MethodGet, start, nil)
		wantStatus(t, rec, http.StatusFound)
		code, state := idp.authorize(rec.Header().Get("Location"), sub, email)
		return b.do(http.MethodGet, "/api/auth/oidc/callback?code="+url.QueryEscape(code)+"&state="+url.QueryEscape(state), nil)
	}

	// 1. An identity nobody linked cannot log in (no auto-provisioning), even
	// when its email matches an existing user.
	stranger := hs.browser()
	wantRedirect(t, signIn(stranger, "/api/auth/oidc/corp/login", "sub-admin", adminName), "/login?error=oidc_not_linked")
	if _, status := stranger.me(); status != http.StatusUnauthorized {
		t.Fatalf("an unlinked identity got a session (%d)", status)
	}

	// 2. Linking needs a session.
	wantError(t, hs.browser().do(http.MethodGet, "/api/auth/oidc/corp/link", nil), http.StatusUnauthorized, "unauthorized")

	// 3. The admin links their identity from the profile.
	wantRedirect(t, signIn(admin, "/api/auth/oidc/corp/link", "sub-admin", "admin@corp.test"), "/settings/users?linked=corp")
	var mine []api.LinkedIdentity
	rec = admin.do(http.MethodGet, "/api/me/identities", nil)
	wantStatus(t, rec, http.StatusOK)
	decode(t, rec, &mine)
	if len(mine) != 1 || mine[0].ProviderCode != "corp" || mine[0].ProviderIcon != "authentik" ||
		mine[0].Email != "admin@corp.test" || mine[0].LastLoginAt != nil {
		t.Fatalf("identities = %+v", mine)
	}

	// 4. Now the identity logs in, landing on the requested page.
	fresh := hs.browser()
	wantRedirect(t, signIn(fresh, "/api/auth/oidc/corp/login?redirect=%2Fbudget", "sub-admin", "admin@corp.test"), "/budget")
	if u, status := fresh.me(); status != http.StatusOK || u.Username != adminName {
		t.Fatalf("/me after OIDC login = %d %+v", status, u)
	}
	if _, ok := fresh.cookies["factual_session_oidc"]; ok {
		t.Fatal("the flow cookie was not cleared after the callback")
	}

	// 5. Redirects stay inside the app.
	evil := hs.browser()
	wantRedirect(t, signIn(evil, "/api/auth/oidc/corp/login?redirect=%2F%2Fevil.example", "sub-admin", ""), "/")

	// 6. The same identity cannot be linked to a second user, and a user links
	// one identity per provider.
	ming := hs.browser().mustLogin("ming", "ming-password")
	wantRedirect(t, signIn(ming, "/api/auth/oidc/corp/link", "sub-admin", ""), "/settings/users?error=oidc_identity_taken")
	wantRedirect(t, signIn(admin, "/api/auth/oidc/corp/link", "sub-other", ""), "/settings/users?error=oidc_already_linked")

	// 7. A tampered state, a missing flow cookie and an IdP error are refused.
	b := hs.browser()
	rec = b.do(http.MethodGet, "/api/auth/oidc/corp/login", nil)
	code, _ := idp.authorize(rec.Header().Get("Location"), "sub-admin", "")
	wantRedirect(t, b.do(http.MethodGet, "/api/auth/oidc/callback?code="+code+"&state=forged", nil), "/login?error=oidc_flow_invalid")

	b = hs.browser()
	rec = b.do(http.MethodGet, "/api/auth/oidc/corp/login", nil)
	code, state := idp.authorize(rec.Header().Get("Location"), "sub-admin", "")
	wantRedirect(t, hs.browser().do(http.MethodGet, "/api/auth/oidc/callback?code="+code+"&state="+state, nil), "/login?error=oidc_flow_invalid")

	b = hs.browser()
	b.do(http.MethodGet, "/api/auth/oidc/corp/login", nil)
	wantRedirect(t, b.do(http.MethodGet, "/api/auth/oidc/callback?error=access_denied", nil), "/login?error=oidc_cancelled")

	// 8. An unknown provider.
	wantRedirect(t, hs.browser().do(http.MethodGet, "/api/auth/oidc/nope/login", nil), "/login?error=oidc_unavailable")

	// 9. Unlinking: allowed with a password, refused when it is the only way in.
	ctx := context.Background()
	if _, err := hs.pool.Exec(ctx, `update users set password_hash = null where username = $1`, adminName); err != nil {
		t.Fatal(err)
	}
	wantError(t, admin.do(http.MethodDelete, "/api/me/identities/"+mine[0].Id.String(), nil), http.StatusBadRequest, "last_login_method")
	if u, _ := admin.me(); u.HasPassword {
		t.Fatal("hasPassword is true for a user without a password")
	}
	// Setting a first password needs no current one.
	wantStatus(t, admin.do(http.MethodPut, "/api/me/password", api.ChangePasswordRequest{NewPassword: "first-password"}), http.StatusNoContent)
	wantStatus(t, admin.do(http.MethodDelete, "/api/me/identities/"+mine[0].Id.String(), nil), http.StatusNoContent)
	wantError(t, admin.do(http.MethodDelete, "/api/me/identities/"+mine[0].Id.String(), nil), http.StatusNotFound, "not_found")
	wantRedirect(t, signIn(hs.browser(), "/api/auth/oidc/corp/login", "sub-admin", ""), "/login?error=oidc_not_linked")
}

// fakeIdP is a minimal OpenID Connect provider: discovery, JWKS, and a token
// endpoint that checks PKCE and signs RS256 ID tokens.
type fakeIdP struct {
	t        *testing.T
	srv      *httptest.Server
	key      *rsa.PrivateKey
	clientID string

	mu     sync.Mutex
	grants map[string]fakeGrant
}

type fakeGrant struct {
	sub, email, nonce, challenge string
}

func newFakeIdP(t *testing.T, clientID string) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeIdP{t: t, key: key, clientID: clientID, grants: map[string]fakeGrant{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{
			"issuer": f.srv.URL, "authorization_endpoint": f.srv.URL + "/authorize",
			"token_endpoint": f.srv.URL + "/token", "jwks_uri": f.srv.URL + "/keys",
			"response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"},
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/keys", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	})
	mux.HandleFunc("/token", f.token)
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// authorize plays the user signing in at the IdP: it accepts our API's
// authorization URL and returns the code and state the IdP sends back.
func (f *fakeIdP) authorize(authURL, sub, email string) (code, state string) {
	f.t.Helper()
	u, err := url.Parse(authURL)
	if err != nil || !strings.HasPrefix(authURL, f.srv.URL+"/authorize") {
		f.t.Fatalf("unexpected authorization URL %q", authURL)
	}
	q := u.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("client_id") != f.clientID ||
		q.Get("redirect_uri") != testPublicURL+"/api/auth/oidc/callback" || q.Get("nonce") == "" ||
		!strings.Contains(q.Get("scope"), "openid") {
		f.t.Fatalf("authorization request missing PKCE, client, redirect, nonce or scope: %v", q)
	}
	var seq [8]byte
	_, _ = rand.Read(seq[:])
	code = fmt.Sprintf("code-%x", seq)
	f.mu.Lock()
	f.grants[code] = fakeGrant{sub: sub, email: email, nonce: q.Get("nonce"), challenge: q.Get("code_challenge")}
	f.mu.Unlock()
	return code, q.Get("state")
}

func (f *fakeIdP) token(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	f.mu.Lock()
	g, ok := f.grants[r.Form.Get("code")]
	delete(f.grants, r.Form.Get("code")) // codes are single use
	f.mu.Unlock()
	sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
	if !ok || base64.RawURLEncoding.EncodeToString(sum[:]) != g.challenge {
		w.WriteHeader(http.StatusBadRequest)
		writeJSON(w, map[string]string{"error": "invalid_grant"})
		return
	}
	now := time.Now()
	claims, _ := json.Marshal(map[string]any{
		"iss": f.srv.URL, "sub": g.sub, "aud": f.clientID, "email": g.email, "nonce": g.nonce,
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
	})
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: f.key, KeyID: "k1"}},
		(&jose.SignerOptions{}).WithType("JWT"))
	if err != nil {
		f.t.Error(err)
		return
	}
	jws, err := signer.Sign(claims)
	if err != nil {
		f.t.Error(err)
		return
	}
	idToken, _ := jws.CompactSerialize()
	writeJSON(w, map[string]any{"access_token": "at", "token_type": "Bearer", "expires_in": 3600, "id_token": idToken})
}

// fakeSite plays GitHub (an Enterprise Server: the API under /api/v3) or
// Discord: a token endpoint that checks PKCE and the client secret, and the
// user API that answers for the access token it gave.
type fakeSite struct {
	t    *testing.T
	kind api.OidcProviderKind
	srv  *httptest.Server

	mu     sync.Mutex
	grants map[string]fakeSiteGrant
	tokens map[string]int
}

type fakeSiteGrant struct {
	user      int
	challenge string
}

func newFakeSite(t *testing.T, kind api.OidcProviderKind) *fakeSite {
	t.Helper()
	f := &fakeSite{t: t, kind: kind, grants: map[string]fakeSiteGrant{}, tokens: map[string]int{}}
	mux := http.NewServeMux()
	if kind == api.Github {
		mux.HandleFunc("POST /login/oauth/access_token", f.token)
		mux.HandleFunc("GET /api/v3/user", func(w http.ResponseWriter, r *http.Request) {
			if user, ok := f.caller(w, r); ok {
				// A private address: only /user/emails has it.
				writeJSON(w, map[string]any{"id": user, "login": fmt.Sprintf("user%d", user), "email": nil})
			}
		})
		mux.HandleFunc("GET /api/v3/user/emails", func(w http.ResponseWriter, r *http.Request) {
			if user, ok := f.caller(w, r); ok {
				writeJSON(w, []map[string]any{
					{"email": "old@site.test", "primary": false, "verified": true},
					{"email": fmt.Sprintf("user%d@site.test", user), "primary": true, "verified": true},
				})
			}
		})
	} else {
		mux.HandleFunc("POST /api/oauth2/token", f.token)
		mux.HandleFunc("GET /api/users/@me", func(w http.ResponseWriter, r *http.Request) {
			if user, ok := f.caller(w, r); ok {
				writeJSON(w, map[string]any{
					"id": fmt.Sprint(user), "username": "someone", "email": fmt.Sprintf("user%d@site.test", user), "verified": true,
				})
			}
		})
	}
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

// authorize plays the user approving our app at the site.
func (f *fakeSite) authorize(authURL string, user int, scope string) (code, state string) {
	f.t.Helper()
	path := map[api.OidcProviderKind]string{api.Github: "/login/oauth/authorize", api.Discord: "/oauth2/authorize"}[f.kind]
	u, err := url.Parse(authURL)
	if err != nil || !strings.HasPrefix(authURL, f.srv.URL+path+"?") {
		f.t.Fatalf("unexpected authorization URL %q", authURL)
	}
	q := u.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("client_id") != "factual" || q.Get("state") == "" ||
		q.Get("redirect_uri") != testPublicURL+"/api/auth/oidc/callback" || q.Get("scope") != scope || q.Has("nonce") {
		f.t.Fatalf("authorization request: %v", q)
	}
	var seq [8]byte
	_, _ = rand.Read(seq[:])
	code = fmt.Sprintf("code-%x", seq)
	f.mu.Lock()
	f.grants[code] = fakeSiteGrant{user: user, challenge: q.Get("code_challenge")}
	f.mu.Unlock()
	return code, q.Get("state")
}

func (f *fakeSite) token(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	id, secret, basic := r.BasicAuth()
	if !basic {
		id, secret = r.Form.Get("client_id"), r.Form.Get("client_secret")
	}
	f.mu.Lock()
	g, ok := f.grants[r.Form.Get("code")]
	delete(f.grants, r.Form.Get("code"))
	f.mu.Unlock()
	sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
	if !ok || id != "factual" || secret != "site-secret" || base64.RawURLEncoding.EncodeToString(sum[:]) != g.challenge {
		w.WriteHeader(http.StatusBadRequest)
		writeJSON(w, map[string]string{"error": "invalid_grant"})
		return
	}
	token := fmt.Sprintf("at-%d-%s", g.user, r.Form.Get("code"))
	f.mu.Lock()
	f.tokens[token] = g.user
	f.mu.Unlock()
	if f.kind == api.Github {
		// GitHub answers in form encoding unless asked for JSON.
		w.Header().Set("Content-Type", "application/x-www-form-urlencoded")
		_, _ = w.Write([]byte(url.Values{"access_token": {token}, "token_type": {"bearer"}, "scope": {"read:user,user:email"}}.Encode()))
		return
	}
	writeJSON(w, map[string]any{"access_token": token, "token_type": "Bearer", "expires_in": 604800, "scope": "identify email"})
}

// caller is the user whose access token the request carries.
func (f *fakeSite) caller(w http.ResponseWriter, r *http.Request) (int, bool) {
	f.mu.Lock()
	user, ok := f.tokens[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
	f.mu.Unlock()
	if !ok {
		w.WriteHeader(http.StatusUnauthorized)
	}
	return user, ok
}
