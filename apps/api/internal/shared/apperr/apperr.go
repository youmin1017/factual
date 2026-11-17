// Package apperr is the error every domain returns for an expected failure:
// a status, a machine-readable code and a message, rendered by the server as
// the Error envelope. Unexpected errors are returned as they are and become a
// 500 without details.
package apperr

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Error is an expected failure with its HTTP status and envelope code.
type Error struct {
	Status  int
	Code    string
	Message string
	// Details are machine-readable extras, e.g. the row a batch failed on.
	Details map[string]any
}

func (e *Error) Error() string { return e.Message }

// New returns an expected failure.
func New(status int, code, message string) error {
	return &Error{Status: status, Code: code, Message: message}
}

// WithDetails is New with machine-readable details.
func WithDetails(status int, code, message string, details map[string]any) error {
	return &Error{Status: status, Code: code, Message: message, Details: details}
}

// BadRequest is a 400 with a specific code.
func BadRequest(code, message string) error {
	return New(http.StatusBadRequest, code, message)
}

// As returns err's *Error, if it is one.
func As(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}

// PostgreSQL error codes mapped to client errors.
const (
	pgUniqueViolation     = "23505"
	pgForeignKeyViolation = "23503"
	pgCheckViolation      = "23514"
)

// FromDB turns expected database errors into client errors (no row: 404,
// duplicate key: 409, missing referenced row or a violated rule: 400); others
// pass through.
func FromDB(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return New(http.StatusNotFound, "not_found", "not found")
	}
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		switch pe.Code {
		case pgUniqueViolation:
			return New(http.StatusConflict, "duplicate", "already exists")
		case pgForeignKeyViolation:
			return BadRequest("invalid_reference", "a referenced record does not exist or is still in use")
		case pgCheckViolation:
			return BadRequest("rule_violated", pe.Message)
		}
	}
	return err
}
