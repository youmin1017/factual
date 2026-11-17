// Package dbtest gives integration tests an empty, migrated database.
package dbtest

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"factual/apps/api/internal/database"
)

// EnvURL names the test database. It is wiped by every test that uses it, so
// it must never point at a database with data worth keeping.
const EnvURL = "FACTUAL_TEST_DATABASE_URL"

// New returns a pool on the test database after dropping everything in it
// and applying all migrations. The test is skipped when EnvURL is not set.
func New(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := Empty(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := database.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate test database: %v", err)
	}
	return pool
}

// Empty is New without the migrations.
func Empty(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv(EnvURL)
	if url == "" {
		t.Skipf("%s is not set; skipping database integration test", EnvURL)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := database.Open(ctx, url)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(pool.Close)

	if _, err := pool.Exec(ctx, "drop schema public cascade; create schema public"); err != nil {
		t.Fatalf("reset test database: %v", err)
	}
	return pool
}
