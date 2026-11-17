// Package db holds the database migrations, embedded so that the binary can
// migrate its own database on startup.
package db

import "embed"

// Migrations are the goose SQL migrations in db/migrations.
//
//go:embed migrations/*.sql
var Migrations embed.FS
