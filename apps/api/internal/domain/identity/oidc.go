package identity

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"

	"factual/apps/api/internal/domain/identity/internal/db"
	"factual/apps/api/internal/secretbox"
)

// OpenID Connect login and account linking.
//
// Providers are configured in the web app by issuer URL (discovery), so any
// standards-compliant IdP works; GitHub and Discord, which only speak OAuth2,
// are kinds of their own (oauth_sites.go, ADR-125). The flow is the
// authorization code flow with PKCE, state and nonce. Its state lives in a short-lived, encrypted cookie,
// not in the database. An identity only logs in after its owner linked it
// from their profile; unknown identities are rejected (no auto-provisioning).
// Identities are matched by (provider, subject), never by email.

// Flow modes.
const (
	FlowLogin = "login"
	FlowLink  = "link"
)

const (
	// FlowTTL bounds the time between leaving for the IdP and returning.
	FlowTTL   = 10 * time.Minute
	flowAAD   = "oidc-flow"
	secretAAD = "oidc-client-secret"

	pgUniqueViolation = "23505"
	// identityUserKey is the unique constraint "one identity per provider per user".
	identityUserKey = "user_identities_user_key"
)

var (
	ErrProviderUnavailable = errors.New("unknown or disabled identity provider")
	ErrFlowInvalid         = errors.New("login flow expired or invalid")
	ErrNotLinked           = errors.New("identity is not linked to any user")
	ErrIdentityTaken       = errors.New("identity is linked to another user")
	ErrProviderLinked      = errors.New("user already linked an identity of this provider")
)

// OIDC runs the OIDC flows on the app database.
type OIDC struct {
	q        *db.Queries
	box      *secretbox.Box
	callback string
	client   *http.Client
	now      func() time.Time

	mu    sync.Mutex
	cache map[uuid.UUID]cachedProvider
}

type cachedProvider struct {
	updatedAt time.Time
	provider  *oidc.Provider
}

// NewOIDC builds the OIDC flows; publicURL is the origin browsers use, the
// IdP redirects back to <publicURL>/api/auth/oidc/callback.
func NewOIDC(pool *pgxpool.Pool, box *secretbox.Box, publicURL string) *OIDC {
	return &OIDC{
		q:        db.New(pool),
		box:      box,
		callback: strings.TrimRight(publicURL, "/") + "/api/auth/oidc/callback",
		client:   &http.Client{Timeout: 10 * time.Second},
		now:      time.Now,
		cache:    map[uuid.UUID]cachedProvider{},
	}
}

// CallbackURL is the redirect URI to register at every IdP.
func (o *OIDC) CallbackURL() string { return o.callback }

// Ready reports whether an encryption key is configured; without one no
// flow can start and no client secret can be stored.
func (o *OIDC) Ready() bool { return o.box.HasKey() }

// SealSecret encrypts a client secret for storage.
func (o *OIDC) SealSecret(secret string) (string, error) {
	if secret == "" {
		return "", nil
	}
	return o.box.Seal([]byte(secret), secretAAD)
}

// Discover checks that issuer serves a valid discovery document.
func (o *OIDC) Discover(ctx context.Context, issuer string) error {
	_, err := oidc.NewProvider(oidc.ClientContext(ctx, o.client), issuer)
	return err
}

// flow is the state carried through the IdP round trip in the flow cookie.
type flow struct {
	ProviderID uuid.UUID `json:"p"`
	State      string    `json:"s"`
	Nonce      string    `json:"n"`
	Verifier   string    `json:"v"`
	Mode       string    `json:"m"`
	UserID     uuid.UUID `json:"u"`
	Redirect   string    `json:"r"`
	Expires    int64     `json:"e"`
}

// Start begins a flow with the provider code. It returns the IdP URL to send
// the browser to and the sealed flow for the flow cookie. userID is the
// caller for FlowLink; redirect is where to land afterwards (an app path).
func (o *OIDC) Start(ctx context.Context, code, mode string, userID uuid.UUID, redirect string) (string, string, error) {
	p, err := o.q.GetEnabledOIDCProviderByCode(ctx, code)
	if isNoRows(err) {
		return "", "", ErrProviderUnavailable
	}
	if err != nil {
		return "", "", err
	}
	cfg, _, err := o.config(ctx, p)
	if err != nil {
		return "", "", err
	}
	f := flow{
		ProviderID: p.ID, State: randomToken(), Nonce: randomToken(), Verifier: oauth2.GenerateVerifier(),
		Mode: mode, UserID: userID, Redirect: redirect, Expires: o.now().Add(FlowTTL).Unix(),
	}
	raw, err := json.Marshal(f)
	if err != nil {
		return "", "", err
	}
	sealed, err := o.box.Seal(raw, flowAAD)
	if err != nil {
		return "", "", err
	}
	opts := []oauth2.AuthCodeOption{oauth2.S256ChallengeOption(f.Verifier)}
	if p.Kind == KindOIDC {
		opts = append(opts, oidc.Nonce(f.Nonce))
	}
	return cfg.AuthCodeURL(f.State, opts...), sealed, nil
}

// Identity is a verified external identity at the end of a flow.
type Identity struct {
	ProviderID   uuid.UUID
	ProviderCode string
	Subject      string
	Email        string
	// From the flow:
	Mode     string
	UserID   uuid.UUID
	Redirect string
}

// FlowInfo opens the flow cookie without completing the flow, to know where
// to send the browser when the IdP reports an error.
func (o *OIDC) FlowInfo(sealed string) (mode, redirect string, ok bool) {
	f, err := o.openFlow(sealed)
	if err != nil {
		return "", "", false
	}
	return f.Mode, f.Redirect, true
}

// Finish completes a flow: it checks state against the flow cookie, redeems
// the code (with the PKCE verifier) and verifies the ID token and nonce, or
// for GitHub and Discord reads the user with the access token.
func (o *OIDC) Finish(ctx context.Context, sealed, state, code string) (Identity, error) {
	f, err := o.openFlow(sealed)
	if err != nil {
		return Identity{}, err
	}
	if subtle.ConstantTimeCompare([]byte(f.State), []byte(state)) != 1 {
		return Identity{}, ErrFlowInvalid
	}
	p, err := o.q.GetOIDCProvider(ctx, f.ProviderID)
	if isNoRows(err) || (err == nil && !p.Enabled) {
		return Identity{}, ErrProviderUnavailable
	}
	if err != nil {
		return Identity{}, err
	}
	cfg, provider, err := o.config(ctx, p)
	if err != nil {
		return Identity{}, err
	}

	ctx = oidc.ClientContext(ctx, o.client)
	tok, err := cfg.Exchange(ctx, code, oauth2.VerifierOption(f.Verifier))
	if err != nil {
		return Identity{}, fmt.Errorf("redeem code: %w", err)
	}
	id := Identity{ProviderID: p.ID, ProviderCode: p.Code, Mode: f.Mode, UserID: f.UserID, Redirect: f.Redirect}
	if s, ok := sites[p.Kind]; ok {
		id.Subject, id.Email, err = s.user(ctx, cfg.Client(ctx, tok), siteBase(p))
		if err != nil {
			return Identity{}, fmt.Errorf("read %s user: %w", p.Kind, err)
		}
		return id, nil
	}
	rawID, ok := tok.Extra("id_token").(string)
	if !ok {
		return Identity{}, errors.New("token response has no id_token")
	}
	idTok, err := provider.Verifier(&oidc.Config{ClientID: p.ClientID, Now: o.now}).Verify(ctx, rawID)
	if err != nil {
		return Identity{}, fmt.Errorf("verify id token: %w", err)
	}
	if subtle.ConstantTimeCompare([]byte(idTok.Nonce), []byte(f.Nonce)) != 1 {
		return Identity{}, errors.New("id token nonce mismatch")
	}
	var claims struct {
		Email string `json:"email"`
	}
	if err := idTok.Claims(&claims); err != nil {
		return Identity{}, err
	}
	id.Subject, id.Email = idTok.Subject, claims.Email
	return id, nil
}

// LinkedUser returns the active user an identity is linked to.
func (o *OIDC) LinkedUser(ctx context.Context, id Identity) (db.GetIdentityUserRow, error) {
	u, err := o.q.GetIdentityUser(ctx, db.GetIdentityUserParams{ProviderID: id.ProviderID, Subject: id.Subject})
	if isNoRows(err) {
		return u, ErrNotLinked
	}
	if err != nil {
		return u, err
	}
	if u.Disabled {
		return u, ErrAccountDisabled
	}
	err = o.q.TouchIdentityLogin(ctx, db.TouchIdentityLoginParams{LastLoginAt: o.now().UTC(), ID: u.IdentityID})
	return u, err
}

// Link links an identity to a user.
func (o *OIDC) Link(ctx context.Context, userID uuid.UUID, id Identity) error {
	err := o.q.CreateIdentity(ctx, db.CreateIdentityParams{
		UserID: userID, ProviderID: id.ProviderID, Subject: id.Subject, Email: truncate(id.Email, 255),
	})
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == pgUniqueViolation {
		if pe.ConstraintName == identityUserKey {
			return ErrProviderLinked
		}
		return ErrIdentityTaken
	}
	return err
}

func (o *OIDC) openFlow(sealed string) (flow, error) {
	var f flow
	raw, err := o.box.Open(sealed, flowAAD)
	if err != nil {
		return f, ErrFlowInvalid
	}
	if err := json.Unmarshal(raw, &f); err != nil || o.now().Unix() > f.Expires {
		return f, ErrFlowInvalid
	}
	return f, nil
}

// siteBase is a GitHub or Discord provider's address, without a final slash.
func siteBase(p db.OidcProvider) string {
	if p.Issuer == "" {
		return DefaultSiteURL(p.Kind)
	}
	return strings.TrimRight(p.Issuer, "/")
}

// config returns the provider's OAuth2 settings and, for OIDC, its
// discovered endpoints. Discovery is cached until the provider row changes.
func (o *OIDC) config(ctx context.Context, p db.OidcProvider) (*oauth2.Config, *oidc.Provider, error) {
	var secret string
	if p.ClientSecret != "" {
		raw, err := o.box.Open(p.ClientSecret, secretAAD)
		if err != nil {
			return nil, nil, fmt.Errorf("client secret of %s: %w", p.Code, err)
		}
		secret = string(raw)
	}
	cfg := &oauth2.Config{
		ClientID: p.ClientID, ClientSecret: secret, RedirectURL: o.callback,
		Scopes: scopesFor(p.Kind, p.Scopes),
	}
	if s, ok := sites[p.Kind]; ok {
		base := siteBase(p)
		cfg.Endpoint = oauth2.Endpoint{AuthURL: base + s.authPath, TokenURL: base + s.tokenPath}
		return cfg, nil, nil
	}
	if p.Kind != KindOIDC {
		return nil, nil, fmt.Errorf("provider %s has unknown kind %q", p.Code, p.Kind)
	}

	o.mu.Lock()
	cached, ok := o.cache[p.ID]
	o.mu.Unlock()
	provider := cached.provider
	if !ok || !cached.updatedAt.Equal(p.UpdatedAt) {
		var err error
		provider, err = oidc.NewProvider(oidc.ClientContext(ctx, o.client), p.Issuer)
		if err != nil {
			return nil, nil, fmt.Errorf("discover %s: %w", p.Issuer, err)
		}
		o.mu.Lock()
		o.cache[p.ID] = cachedProvider{updatedAt: p.UpdatedAt, provider: provider}
		o.mu.Unlock()
	}
	cfg.Endpoint = provider.Endpoint()
	return cfg, provider, nil
}
