package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"factual/apps/api/internal/config"
	"factual/apps/api/internal/database"
	"factual/apps/api/internal/domain/identity"
	"factual/apps/api/internal/secretbox"
	"factual/apps/api/internal/server"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	pool, err := database.Open(startCtx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	if cfg.AutoMigrate {
		applied, err := database.Migrate(startCtx, pool)
		if err != nil {
			return err
		}
		if applied > 0 {
			slog.Info("applied migrations", "count", applied)
		}
	}

	box, err := secretbox.New(cfg.Auth.EncryptionKey)
	if err != nil {
		return err
	}
	if !box.HasKey() {
		slog.Warn("FACTUAL_ENCRYPTION_KEY is not set: OIDC login is unavailable")
	}
	identitySvc := identity.New(pool, cfg.Auth, identity.NewOIDC(pool, box, cfg.PublicURL))

	created, err := identitySvc.EnsureBootstrapAdmin(startCtx)
	if err != nil {
		return err
	}
	if created {
		slog.Info("created bootstrap admin; change its password after the first login", "username", cfg.Auth.BootstrapAdmin.Username)
	}
	go identitySvc.RunCleanup(ctx, time.Hour)

	e, err := server.New(server.Deps{DB: pool, Identity: identitySvc})
	if err != nil {
		return err
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = e.Shutdown(shutdownCtx)
	}()

	slog.Info("listening", "addr", cfg.HTTPAddr, "public_url", cfg.PublicURL)
	if err := e.Start(cfg.HTTPAddr); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
