// Package ledger owns budgets and what is inside them: members, accounts,
// categories, payees, transactions and entries, allocations and goals.
//
// Access (ADR-017): every operation inside a budget declares `x-budget` in
// the spec; the server checks the caller's role against it before the
// handler runs, so handlers trust the budget id in the path and scope every
// query by it.
package ledger

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"factual/apps/api/internal/domain/ledger/internal/db"
	"factual/apps/api/internal/shared/apperr"
)

// Role is a member's role in a budget.
type Role string

const (
	Owner  Role = "owner"
	Editor Role = "editor"
	Viewer Role = "viewer"
)

// Permission is what an operation inside a budget needs (`x-budget`).
type Permission string

const (
	// Read sees the budget's data.
	Read Permission = "read"
	// Write records and changes transactions and allocations.
	Write Permission = "write"
	// Manage changes the budget's structure: accounts, categories, members.
	Manage Permission = "manage"
)

var permissions = map[Role]map[Permission]bool{
	Viewer: {Read: true},
	Editor: {Read: true, Write: true},
	Owner:  {Read: true, Write: true, Manage: true},
}

// Can reports whether the role grants the permission.
func (r Role) Can(p Permission) bool { return permissions[r][p] }

// ErrNotMember is returned for budgets the user is not a member of; callers
// answer 404 so that budget ids cannot be probed.
var ErrNotMember = errors.New("not a member of this budget")

// Service is the ledger domain's API for the server and other domains.
type Service struct {
	pool *pgxpool.Pool
	q    *db.Queries
}

// New builds the service on the app database.
func New(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, q: db.New(pool)}
}

// Handlers are the domain's API operations.
type Handlers struct{ s *Service }

// Handlers returns the domain's API operations.
func (s *Service) Handlers() *Handlers { return &Handlers{s: s} }

// MemberRole is the user's role in the budget, or ErrNotMember.
func (s *Service) MemberRole(ctx context.Context, budgetID, userID uuid.UUID) (Role, error) {
	if s == nil {
		return "", ErrNotMember
	}
	r, err := s.q.GetMemberRole(ctx, db.GetMemberRoleParams{BudgetID: budgetID, UserID: userID})
	if isNoRows(err) {
		return "", ErrNotMember
	}
	return Role(r), err
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

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

// isForeignKeyViolation reports whether err is "still referenced".
func isForeignKeyViolation(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23503"
}

func notFound(what string) error {
	return apperr.New(http.StatusNotFound, "not_found", what+" not found")
}

// minorUnits are the digits after the decimal point that amounts are kept
// in. Currencies whose smaller units are not used in practice keep whole
// units: TWD is recorded in 元 (ADR-056).
var minorUnits = map[string]int32{
	"TWD": 0, "JPY": 0, "KRW": 0, "VND": 0, "CLP": 0, "ISK": 0, "HUF": 0,
}

// MinorUnits is the number of decimal digits amounts in currency are kept in.
func MinorUnits(currency string) int32 {
	if n, ok := minorUnits[currency]; ok {
		return n
	}
	return 2
}

func nullID(id *uuid.UUID) uuid.NullUUID {
	if id == nil {
		return uuid.NullUUID{}
	}
	return uuid.NullUUID{UUID: *id, Valid: true}
}

func idPtr(id uuid.NullUUID) *uuid.UUID {
	if !id.Valid {
		return nil
	}
	return &id.UUID
}
