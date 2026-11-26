package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/apispec"
)

// These tests need no database: the server runs without the identity
// domain, so nobody is authenticated.

type fakeDB struct{ err error }

func (f fakeDB) Ping(context.Context) error { return f.err }

func request(t *testing.T, db Pinger, method, path string, headers ...string) *httptest.ResponseRecorder {
	t.Helper()
	e, err := New(Deps{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, nil)
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) api.Error {
	t.Helper()
	var got api.Error
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("body is not an Error envelope: %v (%s)", err, rec.Body)
	}
	return got
}

func TestHealth(t *testing.T) {
	tests := []struct {
		name       string
		db         fakeDB
		wantStatus int
		wantBody   api.HealthStatus
	}{
		{"database up", fakeDB{}, http.StatusOK, api.Ok},
		{"database down", fakeDB{err: errors.New("connection refused")}, http.StatusServiceUnavailable, api.Degraded},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := request(t, tt.db, http.MethodGet, "/api/healthz")
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tt.wantStatus, rec.Body)
			}
			var got api.Health
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if got.Status != tt.wantBody {
				t.Fatalf("status field = %q, want %q", got.Status, tt.wantBody)
			}
		})
	}
}

func TestUnknownRouteUsesErrorEnvelope(t *testing.T) {
	rec := request(t, fakeDB{}, http.MethodGet, "/api/nope")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", rec.Code, rec.Body)
	}
	if got := decodeError(t, rec); got.Code != "not_found" {
		t.Fatalf("code = %q, want not_found", got.Code)
	}
}

func TestOpenAPISpecIsServed(t *testing.T) {
	rec := request(t, fakeDB{}, http.MethodGet, "/api/openapi.json")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var spec struct {
		Paths map[string]any `json:"paths"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &spec); err != nil {
		t.Fatal(err)
	}
	if _, ok := spec.Paths["/healthz"]; !ok {
		t.Fatalf("spec has no /healthz path: %v", spec.Paths)
	}
}

func TestAPIDocsOnlyWhenEnabled(t *testing.T) {
	if rec := request(t, fakeDB{}, http.MethodGet, "/api/docs"); rec.Code != http.StatusNotFound {
		t.Fatalf("docs off: status = %d, want 404", rec.Code)
	}
	e, err := New(Deps{DB: fakeDB{}, APIDocs: true})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/docs", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "./openapi.json") {
		t.Fatalf("docs on: status = %d, body %.200s", rec.Code, rec.Body)
	}
}

func TestAuthenticatedOperationNeedsSession(t *testing.T) {
	for _, path := range []string{"/api/me", "/api/me/identities", "/api/oidc-providers"} {
		rec := request(t, fakeDB{}, http.MethodGet, path)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("GET %s without a session = %d, want 401 (body %s)", path, rec.Code, rec.Body)
		}
		if got := decodeError(t, rec); got.Code != "unauthorized" {
			t.Fatalf("GET %s code = %q, want unauthorized", path, got.Code)
		}
	}
}

func TestLogoutWithoutSession(t *testing.T) {
	rec := request(t, fakeDB{}, http.MethodPost, "/api/auth/logout")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body %s)", rec.Code, rec.Body)
	}
}

func TestCrossSiteWriteRejected(t *testing.T) {
	rec := request(t, fakeDB{}, http.MethodPost, "/api/auth/logout", "Sec-Fetch-Site", "cross-site")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", rec.Code, rec.Body)
	}
	if got := decodeError(t, rec); got.Code != "cross_site_request" {
		t.Fatalf("code = %q, want cross_site_request", got.Code)
	}
	// Reads are not state-changing and stay allowed.
	if rec := request(t, fakeDB{}, http.MethodGet, "/api/healthz", "Sec-Fetch-Site", "cross-site"); rec.Code != http.StatusOK {
		t.Fatalf("cross-site GET = %d, want 200", rec.Code)
	}
}

// Every operation in the spec declares who may call it, and nothing but the
// login flow, logout and the health check is public.
func TestEveryOperationDeclaresAccess(t *testing.T) {
	spec, err := api.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	ops, err := apispec.Operations(spec)
	if err != nil {
		t.Fatal(err)
	}
	if len(ops) == 0 {
		t.Fatal("no operations found")
	}
	for _, op := range ops {
		if op.Access != apispec.Public {
			continue
		}
		if op.Route != "/api/healthz" && !strings.HasPrefix(op.Route, "/api/auth/") {
			t.Errorf("%s %s is public; only /api/healthz and /api/auth/* may be", op.Method, op.Route)
		}
	}
}

// API responses are gzipped when the client accepts it; small ones, like the
// health check, are sent as they are.
func TestAPICompression(t *testing.T) {
	rec := request(t, fakeDB{}, http.MethodGet, "/api/healthz", "Accept-Encoding", "gzip")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
		t.Fatalf("Vary = %q, want Accept-Encoding (gzip middleware on the API)", got)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q for a small response, want none", got)
	}
	var got api.Health
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("body: %v (%q)", err, rec.Body)
	}
}
