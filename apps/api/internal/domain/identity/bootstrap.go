package identity

import (
	"context"
	"errors"
	"fmt"

	"factual/apps/api/internal/domain/identity/internal/db"
)

const minPasswordLen = 8

// EnsureBootstrapAdmin creates the configured instance admin when nobody can
// log in yet, i.e. on first start. It reports whether a user was created.
func (s *Service) EnsureBootstrapAdmin(ctx context.Context) (bool, error) {
	n, err := s.q.CountLoginUsers(ctx)
	if err != nil {
		return false, err
	}
	if n > 0 {
		return false, nil
	}
	admin := s.cfg.BootstrapAdmin
	if admin.Username == "" || len(admin.Password) < minPasswordLen {
		return false, errors.New("nobody can log in yet: set FACTUAL_BOOTSTRAP_ADMIN_USERNAME and FACTUAL_BOOTSTRAP_ADMIN_PASSWORD (at least 8 characters) to create the first admin")
	}
	hash, err := HashPassword(admin.Password)
	if err != nil {
		return false, err
	}
	_, err = s.q.CreateUser(ctx, db.CreateUserParams{
		Username: admin.Username, DisplayName: admin.Username, PasswordHash: hash, IsAdmin: true,
	})
	if err != nil {
		return false, fmt.Errorf("create bootstrap admin: %w", err)
	}
	return true, nil
}
