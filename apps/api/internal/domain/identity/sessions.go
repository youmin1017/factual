package identity

// Sessions and password login. A session is a row in sessions. The browser
// holds a random token in an httpOnly cookie; only the token's SHA-256 is
// stored, so a database leak does not leak usable sessions.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"factual/apps/api/internal/domain/identity/internal/db"
	"factual/apps/api/internal/shared/reqctx"
	"factual/apps/api/internal/shared/roles"
)

var (
	ErrInvalidCredentials    = errors.New("invalid username or password")
	ErrWrongPassword         = errors.New("current password is wrong")
	ErrAccountDisabled       = errors.New("account is disabled")
	ErrPasswordLoginDisabled = errors.New("password login is disabled")
	ErrNoSession             = errors.New("no valid session")
)

const (
	tokenBytes = 32
	// touchInterval limits last_seen_at writes to one per session per interval.
	touchInterval = time.Minute
	maxUserAgent  = 255
)

// User is a user as the identity domain reads it.
type User struct {
	ID           uuid.UUID
	Username     string
	DisplayName  string
	Email        string
	PasswordHash string
	// Role is the instance role (roles.Role, ADR-131).
	Role     string
	Disabled bool
}

// Login checks a username and password and starts a session.
func (s *Service) Login(ctx context.Context, username, password string, client reqctx.Client) (string, User, error) {
	if !s.cfg.PasswordLogin {
		return "", User{}, ErrPasswordLoginDisabled
	}
	row, err := s.q.GetUserByUsername(ctx, username)
	if isNoRows(err) || (err == nil && row.PasswordHash == "") {
		_, _ = VerifyPassword(password, dummyHash())
		return "", User{}, ErrInvalidCredentials
	}
	if err != nil {
		return "", User{}, err
	}
	u := User(row)
	ok, err := VerifyPassword(password, u.PasswordHash)
	if err != nil {
		return "", User{}, fmt.Errorf("user %s: %w", u.ID, err)
	}
	if !ok {
		return "", User{}, ErrInvalidCredentials
	}
	if u.Disabled {
		return "", User{}, ErrAccountDisabled
	}

	token, err := s.StartSession(ctx, u.ID, client)
	return token, u, err
}

// StartSession creates a session for an authenticated user and records the
// login time; used by password and OIDC logins.
func (s *Service) StartSession(ctx context.Context, userID uuid.UUID, client reqctx.Client) (string, error) {
	token, err := s.CreateSession(ctx, userID, client)
	if err != nil {
		return "", err
	}
	err = s.q.SetUserLastLogin(ctx, db.SetUserLastLoginParams{LastLoginAt: s.now().UTC(), ID: userID})
	return token, err
}

// CreateSession starts a session for an already authenticated user and
// returns the token for the cookie.
func (s *Service) CreateSession(ctx context.Context, userID uuid.UUID, client reqctx.Client) (string, error) {
	token := randomToken()
	now := s.now().UTC()
	err := s.q.CreateSession(ctx, db.CreateSessionParams{
		TokenHash:  hashToken(token),
		UserID:     userID,
		Ip:         client.IP,
		UserAgent:  truncate(client.UserAgent, maxUserAgent),
		CreatedAt:  now,
		LastSeenAt: now,
		ExpiresAt:  now.Add(s.cfg.MaxAge),
	})
	if err != nil {
		return "", fmt.Errorf("create session: %w", err)
	}
	return token, nil
}

// Authenticate resolves a session token. Expired or idle sessions, and those
// of disabled users, are deleted and yield ErrNoSession.
func (s *Service) Authenticate(ctx context.Context, token string) (reqctx.Principal, error) {
	if token == "" {
		return reqctx.Principal{}, ErrNoSession
	}
	hash := hashToken(token)
	row, err := s.q.GetSessionByTokenHash(ctx, hash)
	if isNoRows(err) {
		return reqctx.Principal{}, ErrNoSession
	}
	if err != nil {
		return reqctx.Principal{}, err
	}
	now := s.now().UTC()
	if now.After(row.ExpiresAt) || now.Sub(row.LastSeenAt) > s.cfg.IdleTimeout || row.Disabled {
		if err := s.q.DeleteSessionByTokenHash(ctx, hash); err != nil {
			return reqctx.Principal{}, err
		}
		return reqctx.Principal{}, ErrNoSession
	}
	if now.Sub(row.LastSeenAt) > touchInterval {
		if err := s.q.TouchSession(ctx, db.TouchSessionParams{TokenHash: hash, LastSeenAt: now}); err != nil {
			return reqctx.Principal{}, err
		}
	}
	return reqctx.Principal{
		UserID: row.UserID, Username: row.Username, DisplayName: row.DisplayName, Role: roles.Role(row.Role),
	}, nil
}

// Logout ends the session for token; unknown tokens are ignored.
func (s *Service) Logout(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	return s.q.DeleteSessionByTokenHash(ctx, hashToken(token))
}

// User returns the caller's user row.
func (s *Service) User(ctx context.Context, p reqctx.Principal) (User, error) {
	row, err := s.q.GetUserByID(ctx, p.UserID)
	return User(row), err
}

// ChangePassword sets a new password and ends the user's other sessions;
// token is the session to keep. A user without a password (OIDC only) sets
// one without giving a current password.
func (s *Service) ChangePassword(ctx context.Context, p reqctx.Principal, token, current, next string) error {
	u, err := s.q.GetUserByID(ctx, p.UserID)
	if err != nil {
		return err
	}
	if u.PasswordHash != "" {
		ok, err := VerifyPassword(current, u.PasswordHash)
		if err != nil {
			return fmt.Errorf("user %s: %w", u.ID, err)
		}
		if !ok {
			return ErrWrongPassword
		}
	}
	hash, err := HashPassword(next)
	if err != nil {
		return err
	}
	return s.inTx(ctx, func(q *db.Queries) error {
		if err := q.UpdateUserPassword(ctx, db.UpdateUserPasswordParams{PasswordHash: hash, ID: p.UserID}); err != nil {
			return err
		}
		return q.DeleteOtherUserSessions(ctx, db.DeleteOtherUserSessionsParams{UserID: p.UserID, TokenHash: hashToken(token)})
	})
}

// Cookie returns the session cookie for token.
func (s *Service) Cookie(token string) *http.Cookie {
	return &http.Cookie{
		Name:     s.cfg.CookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(s.cfg.MaxAge.Seconds()),
		HttpOnly: true,
		Secure:   s.cfg.SecureCookie,
		SameSite: http.SameSiteLaxMode,
	}
}

// ClearCookie returns a cookie that deletes the session cookie.
func (s *Service) ClearCookie() *http.Cookie {
	c := s.Cookie("")
	c.MaxAge = -1
	return c
}

// CookieName is the session cookie's name.
func (s *Service) CookieName() string { return s.cfg.CookieName }

// FlowCookieName is the OIDC flow cookie's name.
func (s *Service) FlowCookieName() string { return s.cfg.CookieName + "_oidc" }

// FlowCookie carries a sealed OIDC flow to the callback; an empty value
// deletes it. SameSite=Lax lets it ride along the IdP's top-level redirect.
func (s *Service) FlowCookie(sealed string) *http.Cookie {
	c := &http.Cookie{
		Name:     s.FlowCookieName(),
		Value:    sealed,
		Path:     "/api/auth/oidc",
		MaxAge:   int(FlowTTL.Seconds()),
		HttpOnly: true,
		Secure:   s.cfg.SecureCookie,
		SameSite: http.SameSiteLaxMode,
	}
	if sealed == "" {
		c.MaxAge = -1
	}
	return c
}

// DeleteExpired removes sessions past their absolute or idle expiry.
func (s *Service) DeleteExpired(ctx context.Context) (int64, error) {
	now := s.now().UTC()
	return s.q.DeleteExpiredSessions(ctx, db.DeleteExpiredSessionsParams{
		ExpiresAt: now, LastSeenAt: now.Add(-s.cfg.IdleTimeout),
	})
}

// RunCleanup calls DeleteExpired every interval until ctx is done.
func (s *Service) RunCleanup(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := s.DeleteExpired(ctx); err != nil {
				slog.Error("delete expired sessions", "err", err)
			} else if n > 0 {
				slog.Info("deleted expired sessions", "count", n)
			}
		}
	}
}

// randomToken returns 32 random bytes, base64url-encoded.
func randomToken() string {
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func hashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// truncate cuts s to at most n runes.
func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
