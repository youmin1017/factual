// Package identity owns users, sessions, invites, identity providers and
// linked identities: password login with server-side sessions, and OpenID
// Connect login for identities a user linked.
package identity

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"factual/apps/api/internal/config"
	"factual/apps/api/internal/domain/identity/internal/db"
)

// Service is the identity domain's API for the server and other domains.
type Service struct {
	pool *pgxpool.Pool
	q    *db.Queries
	cfg  config.Auth
	now  func() time.Time
	oidc *OIDC
}

// New builds the service on the app database. oidc may be nil: OIDC login is
// then unavailable.
func New(pool *pgxpool.Pool, cfg config.Auth, oidc *OIDC) *Service {
	return &Service{pool: pool, q: db.New(pool), cfg: cfg, now: time.Now, oidc: oidc}
}

// Handlers are the domain's API operations.
type Handlers struct{ s *Service }

// Handlers returns the domain's API operations; with a nil Service (tests
// without a database) logout succeeds and no login providers are listed.
func (s *Service) Handlers() *Handlers { return &Handlers{s: s} }

// UserCount is the number of users who can log in. While it is zero the
// bootstrap admin is created on startup.
func (s *Service) UserCount(ctx context.Context) (int64, error) {
	return s.q.CountLoginUsers(ctx)
}

func (s *Service) inTx(ctx context.Context, fn func(q *db.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(s.q.WithTx(tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// oidcOn reports whether OIDC login is configured.
func (s *Service) oidcOn() bool { return s != nil && s.oidc != nil }

// isNoRows reports whether err is "no such row".
func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
