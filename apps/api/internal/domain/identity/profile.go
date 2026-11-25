package identity

// Renaming: a user changes the username they log in with and the name shown
// to others (ADR-102). Sessions and linked identities refer to the user's id,
// so they are unaffected.

import (
	"context"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"factual/apps/api/internal/domain/identity/internal/db"
)

var (
	ErrInvalidUsername    = errors.New("invalid username")
	ErrInvalidDisplayName = errors.New("invalid display name")
	ErrUsernameTaken      = errors.New("username taken")
)

const (
	maxNameLen = 64
	// usernameKey is the unique index on lower(username).
	usernameKey = "users_username_key"
)

// UpdateProfile sets the user's username and display name, trimmed. The
// username has no spaces or control characters and is unique regardless of
// case; the display name may have spaces but no control characters.
func (s *Service) UpdateProfile(ctx context.Context, userID uuid.UUID, username, displayName string) (User, error) {
	username = strings.TrimSpace(username)
	displayName = strings.TrimSpace(displayName)
	if !validName(username, unicode.IsSpace) {
		return User{}, ErrInvalidUsername
	}
	if !validName(displayName, nil) {
		return User{}, ErrInvalidDisplayName
	}
	err := s.q.UpdateUserProfile(ctx, db.UpdateUserProfileParams{
		Username: username, DisplayName: displayName, ID: userID,
	})
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == pgUniqueViolation && pe.ConstraintName == usernameKey {
		return User{}, ErrUsernameTaken
	}
	if err != nil {
		return User{}, err
	}
	row, err := s.q.GetUserByID(ctx, userID)
	return User(row), err
}

// validName reports whether name is 1 to maxNameLen characters with no
// control characters, nor any for which also returns true.
func validName(name string, also func(rune) bool) bool {
	if name == "" || utf8.RuneCountInString(name) > maxNameLen {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) || (also != nil && also(r)) {
			return false
		}
	}
	return true
}
