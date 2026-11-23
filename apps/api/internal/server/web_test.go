package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func webRequest(t *testing.T, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	files := fstest.MapFS{
		"_shell.html":      {Data: []byte("<!DOCTYPE html><title>shell</title>")},
		"assets/app-1a.js": {Data: []byte("console.log(1)")},
		"robots.txt":       {Data: []byte("User-agent: *")},
	}
	e, err := New(Deps{DB: fakeDB{}, Web: files})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	return rec
}

func TestWebAppShellForClientRoutes(t *testing.T) {
	for _, path := range []string{"/", "/b/0e5f/accounts", "/settings/editor?x=1", "/_shell.html"} {
		rec := webRequest(t, http.MethodGet, path)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<title>shell</title>") {
			t.Fatalf("GET %s = %d %q, want the shell", path, rec.Code, rec.Body)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("GET %s Cache-Control = %q, want no-cache", path, got)
		}
	}
}

func TestWebAppFiles(t *testing.T) {
	rec := webRequest(t, http.MethodGet, "/assets/app-1a.js")
	if rec.Code != http.StatusOK || rec.Body.String() != "console.log(1)" {
		t.Fatalf("asset = %d %q", rec.Code, rec.Body)
	}
	if got := rec.Header().Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Fatalf("asset Cache-Control = %q, want immutable", got)
	}
	if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "javascript") {
		t.Fatalf("asset Content-Type = %q", got)
	}
	if rec := webRequest(t, http.MethodGet, "/robots.txt"); rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("robots.txt = %d, Cache-Control %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
	for _, path := range []string{"/assets/gone-2b.js", "/favicon.ico"} {
		if rec := webRequest(t, http.MethodGet, path); rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s = %d, want 404", path, rec.Code)
		}
	}
}

// The web app never answers for the API: unknown API paths keep the JSON
// error envelope and API operations still work.
func TestWebAppLeavesAPIAlone(t *testing.T) {
	for _, path := range []string{"/api", "/api/nope", "/api/budgets/x/nope"} {
		rec := webRequest(t, http.MethodGet, path)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s = %d, want 404 (body %s)", path, rec.Code, rec.Body)
		}
		if got := decodeError(t, rec); got.Code != "not_found" {
			t.Fatalf("GET %s code = %q, want not_found", path, got.Code)
		}
	}
	if rec := webRequest(t, http.MethodGet, "/api/healthz"); rec.Code != http.StatusOK {
		t.Fatalf("health = %d (body %s)", rec.Code, rec.Body)
	}
	if rec := webRequest(t, http.MethodGet, "/api/me"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("/api/me = %d, want 401", rec.Code)
	}
}

func TestSecurityHeaders(t *testing.T) {
	rec := webRequest(t, http.MethodGet, "/")
	for k, want := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "same-origin",
	} {
		if got := rec.Header().Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
}
