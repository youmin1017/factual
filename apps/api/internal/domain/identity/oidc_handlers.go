package identity

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/identity/internal/db"
	"factual/apps/api/internal/secretbox"
	"factual/apps/api/internal/shared/apperr"
	"factual/apps/api/internal/shared/reqctx"
)

// OpenID Connect login, account linking and provider management. The browser
// navigates to the flow endpoints, so they answer with redirects to web pages
// carrying ?error=<code> instead of JSON errors.

const (
	loginPage   = "/login"
	profilePage = "/profile"
)

// redirectResponse is a 302 that can also set cookies; it serves every
// redirecting OIDC operation.
type redirectResponse struct {
	location string
	cookies  []*http.Cookie
}

func (r redirectResponse) visit(w http.ResponseWriter) error {
	for _, c := range r.cookies {
		http.SetCookie(w, c)
	}
	w.Header().Set("Location", r.location)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusFound)
	return nil
}

func (r redirectResponse) VisitStartOidcLoginResponse(w http.ResponseWriter) error { return r.visit(w) }
func (r redirectResponse) VisitStartOidcLinkResponse(w http.ResponseWriter) error  { return r.visit(w) }
func (r redirectResponse) VisitOidcCallbackResponse(w http.ResponseWriter) error   { return r.visit(w) }

func withError(page, code string, cookies ...*http.Cookie) redirectResponse {
	return redirectResponse{location: page + "?error=" + url.QueryEscape(code), cookies: cookies}
}

// safePath keeps redirects inside the app (no open redirects).
func safePath(p string) string {
	if strings.HasPrefix(p, "/") && !strings.HasPrefix(p, "//") && !strings.HasPrefix(p, "/\\") {
		return p
	}
	return "/"
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (h *Handlers) StartOidcLogin(ctx context.Context, req api.StartOidcLoginRequestObject) (api.StartOidcLoginResponseObject, error) {
	if !h.s.oidcOn() {
		return withError(loginPage, "oidc_unavailable"), nil
	}
	authURL, sealed, err := h.s.oidc.Start(ctx, req.Code, FlowLogin, uuid.Nil, safePath(deref(req.Params.Redirect)))
	if err != nil {
		slog.Warn("start oidc login", "provider", req.Code, "err", err)
		return withError(loginPage, "oidc_unavailable"), nil
	}
	return redirectResponse{location: authURL, cookies: []*http.Cookie{h.s.FlowCookie(sealed)}}, nil
}

func (h *Handlers) StartOidcLink(ctx context.Context, req api.StartOidcLinkRequestObject) (api.StartOidcLinkResponseObject, error) {
	if !h.s.oidcOn() {
		return withError(profilePage, "oidc_unavailable"), nil
	}
	authURL, sealed, err := h.s.oidc.Start(ctx, req.Code, FlowLink, reqctx.Caller(ctx).UserID, profilePage)
	if err != nil {
		slog.Warn("start oidc link", "provider", req.Code, "err", err)
		return withError(profilePage, "oidc_unavailable"), nil
	}
	return redirectResponse{location: authURL, cookies: []*http.Cookie{h.s.FlowCookie(sealed)}}, nil
}

func (h *Handlers) OidcCallback(ctx context.Context, req api.OidcCallbackRequestObject) (api.OidcCallbackResponseObject, error) {
	if !h.s.oidcOn() {
		return withError(loginPage, "oidc_unavailable"), nil
	}
	clearFlow := h.s.FlowCookie("")
	sealed := reqctx.FlowFrom(ctx)
	mode, _, ok := h.s.oidc.FlowInfo(sealed)
	if !ok {
		return withError(loginPage, "oidc_flow_invalid", clearFlow), nil
	}
	page := loginPage
	if mode == FlowLink {
		page = profilePage
	}
	if req.Params.Error != nil {
		return withError(page, "oidc_cancelled", clearFlow), nil
	}

	client := reqctx.ClientFrom(ctx)
	id, err := h.s.oidc.Finish(ctx, sealed, deref(req.Params.State), deref(req.Params.Code))
	if err != nil {
		code := "oidc_failed"
		switch {
		case errors.Is(err, ErrFlowInvalid):
			code = "oidc_flow_invalid"
		case errors.Is(err, ErrProviderUnavailable):
			code = "oidc_unavailable"
		default:
			slog.Warn("finish oidc flow", "err", err)
		}
		return withError(page, code, clearFlow), nil
	}

	if mode == FlowLink {
		return h.finishLink(ctx, id, clearFlow), nil
	}

	u, err := h.s.oidc.LinkedUser(ctx, id)
	if err != nil {
		code := "oidc_failed"
		switch {
		case errors.Is(err, ErrNotLinked):
			code = "oidc_not_linked"
		case errors.Is(err, ErrAccountDisabled):
			code = "account_disabled"
		default:
			slog.Error("oidc login", "err", err)
		}
		slog.Info("login failed", "method", "oidc:"+id.ProviderCode, "ip", client.IP, "reason", code)
		return withError(page, code, clearFlow), nil
	}
	token, err := h.s.StartSession(ctx, u.UserID, client)
	if err != nil {
		return nil, err
	}
	slog.Info("login", "user", u.UserID, "method", "oidc:"+id.ProviderCode, "ip", client.IP)
	return redirectResponse{location: safePath(id.Redirect), cookies: []*http.Cookie{h.s.Cookie(token), clearFlow}}, nil
}

// finishLink links the identity to the user who started the flow, if that
// user is still the one logged in.
func (h *Handlers) finishLink(ctx context.Context, id Identity, clearFlow *http.Cookie) redirectResponse {
	p, ok := reqctx.PrincipalFrom(ctx)
	if !ok || p.UserID != id.UserID {
		return withError(profilePage, "oidc_link_session", clearFlow)
	}
	err := h.s.oidc.Link(ctx, p.UserID, id)
	switch {
	case errors.Is(err, ErrIdentityTaken):
		return withError(profilePage, "oidc_identity_taken", clearFlow)
	case errors.Is(err, ErrProviderLinked):
		return withError(profilePage, "oidc_already_linked", clearFlow)
	case err != nil:
		slog.Error("link oidc identity", "err", err)
		return withError(profilePage, "oidc_failed", clearFlow)
	}
	slog.Info("identity linked", "user", p.UserID, "provider", id.ProviderCode)
	return redirectResponse{
		location: profilePage + "?linked=" + url.QueryEscape(id.ProviderCode),
		cookies:  []*http.Cookie{clearFlow},
	}
}

func (h *Handlers) ListLoginProviders(ctx context.Context, _ api.ListLoginProvidersRequestObject) (api.ListLoginProvidersResponseObject, error) {
	out := api.ListLoginProviders200JSONResponse{}
	if !h.s.oidcOn() || !h.s.oidc.Ready() {
		return out, nil
	}
	rows, err := h.s.q.ListEnabledOIDCProviders(ctx)
	if err != nil {
		return nil, err
	}
	for _, p := range rows {
		out = append(out, api.LoginProvider{Code: p.Code, Name: p.Name, Icon: p.Icon})
	}
	return out, nil
}

// --- provider management ---

func (h *Handlers) ListOidcProviders(ctx context.Context, _ api.ListOidcProvidersRequestObject) (api.ListOidcProvidersResponseObject, error) {
	rows, err := h.s.q.ListOIDCProviders(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]api.OidcProvider, 0, len(rows))
	for _, p := range rows {
		items = append(items, oidcProviderResponse(p))
	}
	out := api.ListOidcProviders200JSONResponse{Items: items}
	if h.s.oidcOn() {
		out.CallbackUrl = h.s.oidc.CallbackURL()
		out.EncryptionConfigured = h.s.oidc.Ready()
	}
	return out, nil
}

func (h *Handlers) sealClientSecret(secret string) (string, error) {
	sealed, err := h.s.oidc.SealSecret(secret)
	if errors.Is(err, secretbox.ErrNoKey) {
		return "", apperr.BadRequest("encryption_key_missing", "FACTUAL_ENCRYPTION_KEY is not configured on the server")
	}
	return sealed, err
}

func callerID(ctx context.Context) pgtype.UUID {
	return pgtype.UUID{Bytes: reqctx.Caller(ctx).UserID, Valid: true}
}

func oidcProviderResponse(p db.OidcProvider) api.OidcProvider {
	scopes := p.Scopes
	if scopes == nil {
		scopes = []string{}
	}
	return api.OidcProvider{
		Id: p.ID, Code: p.Code, Name: p.Name, Kind: api.OidcProviderKind(p.Kind), Issuer: p.Issuer,
		ClientId: p.ClientID, HasSecret: p.ClientSecret != "", Scopes: scopes, Icon: p.Icon,
		Sort: p.Sort, Enabled: p.Enabled, Remark: p.Remark, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
	}
}

// --- the caller's own identities ---

func (h *Handlers) ListMyIdentities(ctx context.Context, _ api.ListMyIdentitiesRequestObject) (api.ListMyIdentitiesResponseObject, error) {
	rows, err := h.s.q.ListUserIdentities(ctx, reqctx.Caller(ctx).UserID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListMyIdentities200JSONResponse, 0, len(rows))
	for _, r := range rows {
		item := api.LinkedIdentity{
			Id: r.ID, ProviderCode: r.ProviderCode, ProviderName: r.ProviderName, ProviderIcon: r.ProviderIcon,
			Email: r.Email, CreatedAt: r.CreatedAt,
		}
		if r.LastLoginAt.Valid {
			item.LastLoginAt = &r.LastLoginAt.Time
		}
		out = append(out, item)
	}
	return out, nil
}

func (h *Handlers) UnlinkMyIdentity(ctx context.Context, req api.UnlinkMyIdentityRequestObject) (api.UnlinkMyIdentityResponseObject, error) {
	p := reqctx.Caller(ctx)
	u, err := h.s.User(ctx, p)
	if err != nil {
		return nil, err
	}
	if u.PasswordHash == "" {
		n, err := h.s.q.CountUserIdentities(ctx, p.UserID)
		if err != nil {
			return nil, err
		}
		if n <= 1 {
			return nil, apperr.BadRequest("last_login_method", "this is your only way to log in")
		}
	}
	n, err := h.s.q.DeleteUserIdentity(ctx, db.DeleteUserIdentityParams{ID: req.Id, UserID: p.UserID})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, apperr.New(http.StatusNotFound, "not_found", "not found")
	}
	return api.UnlinkMyIdentity204Response{}, nil
}
