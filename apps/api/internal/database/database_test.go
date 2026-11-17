package database_test

import (
	"context"
	"testing"

	"factual/apps/api/internal/database"
	"factual/apps/api/internal/database/dbtest"
)

func TestMigrate(t *testing.T) {
	pool := dbtest.Empty(t)
	ctx := context.Background()

	applied, err := database.Migrate(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if applied == 0 {
		t.Fatal("expected at least one migration to be applied to an empty database")
	}

	var tables int
	err = pool.QueryRow(ctx,
		`select count(*) from information_schema.tables
		  where table_schema = 'public' and table_name in ('users', 'budgets', 'transactions', 'entries')`,
	).Scan(&tables)
	if err != nil {
		t.Fatal(err)
	}
	if tables != 4 {
		t.Fatalf("expected the core tables to exist, found %d of 4", tables)
	}

	again, err := database.Migrate(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if again != 0 {
		t.Fatalf("second run applied %d migrations, expected 0", again)
	}
}

// The ledger invariant lives in the database: a transfer whose two sides do
// not balance must be rejected at commit.
func TestEntriesMustBalance(t *testing.T) {
	pool := dbtest.New(t)
	ctx := context.Background()

	var budget, bank, card string
	if err := pool.QueryRow(ctx, `insert into budgets (name, currency) values ('t', 'TWD') returning id`).Scan(&budget); err != nil {
		t.Fatal(err)
	}
	const newAccount = `insert into accounts (budget_id, name, kind, on_budget) values ($1, $2, $3, true) returning id`
	if err := pool.QueryRow(ctx, newAccount, budget, "bank", "bank").Scan(&bank); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, newAccount, budget, "card", "credit_card").Scan(&card); err != nil {
		t.Fatal(err)
	}

	transfer := func(out, in int64) error {
		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback(ctx) }()

		var id string
		if err := tx.QueryRow(ctx, `insert into transactions (budget_id, date) values ($1, '2026-11-20') returning id`, budget).Scan(&id); err != nil {
			return err
		}
		const newEntry = `insert into entries (budget_id, transaction_id, account_id, amount) values ($1, $2, $3, $4)`
		if _, err := tx.Exec(ctx, newEntry, budget, id, bank, out); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, newEntry, budget, id, card, in); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}

	if err := transfer(-2000, 2000); err != nil {
		t.Fatalf("balanced transfer rejected: %v", err)
	}
	if err := transfer(-2000, 1500); err == nil {
		t.Fatal("unbalanced transfer was accepted")
	}
}
