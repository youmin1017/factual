// Package config reads the API's settings from FACTUAL_* environment
// variables. Local development gets them from apps/api/mise.toml.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is everything the API needs to start.
type Config struct {
	// HTTPAddr is the listen address (FACTUAL_HTTP_ADDR, default ":8080").
	HTTPAddr string
	// PublicURL is the origin browsers use to reach the app
	// (FACTUAL_PUBLIC_URL, default "http://localhost:3000"). Identity providers
	// redirect back to <PublicURL>/api/auth/oidc/callback.
	PublicURL string
	// DatabaseURL is the PostgreSQL connection string (FACTUAL_DATABASE_URL, required).
	DatabaseURL string
	// AutoMigrate applies pending migrations on startup (FACTUAL_DB_AUTO_MIGRATE, default true).
	AutoMigrate bool
	Auth        Auth
}

// Auth configures sessions and logins.
type Auth struct {
	// PasswordLogin allows logging in with a password (FACTUAL_PASSWORD_LOGIN,
	// default true). Turn it off only when every user can log in through an
	// identity provider.
	PasswordLogin bool
	// CookieName is the session cookie; the OIDC flow cookie is derived from it.
	CookieName string
	// SecureCookie marks cookies Secure (FACTUAL_COOKIE_SECURE; default: whether
	// PublicURL is https).
	SecureCookie bool
	// IdleTimeout ends a session not used for this long
	// (FACTUAL_SESSION_IDLE_TIMEOUT, default 720h).
	IdleTimeout time.Duration
	// MaxAge ends a session this long after login whatever its use
	// (FACTUAL_SESSION_MAX_AGE, default 2160h).
	MaxAge time.Duration
	// EncryptionKey is a base64-encoded 32-byte key (FACTUAL_ENCRYPTION_KEY)
	// for OIDC client secrets and the OIDC flow cookie. Without it OIDC login
	// is unavailable.
	EncryptionKey string
	// BootstrapAdmin is created on startup when nobody can log in yet
	// (FACTUAL_BOOTSTRAP_ADMIN_USERNAME, FACTUAL_BOOTSTRAP_ADMIN_PASSWORD).
	BootstrapAdmin BootstrapAdmin
}

// BootstrapAdmin is the first instance admin.
type BootstrapAdmin struct {
	Username string
	Password string
}

// Load reads the configuration from the environment.
func Load() (Config, error) {
	cfg := Config{
		HTTPAddr:    getenv("FACTUAL_HTTP_ADDR", ":8080"),
		PublicURL:   strings.TrimRight(getenv("FACTUAL_PUBLIC_URL", "http://localhost:3000"), "/"),
		DatabaseURL: os.Getenv("FACTUAL_DATABASE_URL"),
		Auth: Auth{
			CookieName:    "factual_session",
			EncryptionKey: os.Getenv("FACTUAL_ENCRYPTION_KEY"),
			BootstrapAdmin: BootstrapAdmin{
				Username: os.Getenv("FACTUAL_BOOTSTRAP_ADMIN_USERNAME"),
				Password: os.Getenv("FACTUAL_BOOTSTRAP_ADMIN_PASSWORD"),
			},
		},
	}
	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("FACTUAL_DATABASE_URL is not set")
	}
	if !strings.HasPrefix(cfg.PublicURL, "http://") && !strings.HasPrefix(cfg.PublicURL, "https://") {
		return Config{}, errors.New("FACTUAL_PUBLIC_URL must start with http:// or https://")
	}

	var err error
	if cfg.AutoMigrate, err = getbool("FACTUAL_DB_AUTO_MIGRATE", true); err != nil {
		return Config{}, err
	}
	if cfg.Auth.PasswordLogin, err = getbool("FACTUAL_PASSWORD_LOGIN", true); err != nil {
		return Config{}, err
	}
	if cfg.Auth.SecureCookie, err = getbool("FACTUAL_COOKIE_SECURE", strings.HasPrefix(cfg.PublicURL, "https://")); err != nil {
		return Config{}, err
	}
	if cfg.Auth.IdleTimeout, err = getduration("FACTUAL_SESSION_IDLE_TIMEOUT", 720*time.Hour); err != nil {
		return Config{}, err
	}
	if cfg.Auth.MaxAge, err = getduration("FACTUAL_SESSION_MAX_AGE", 2160*time.Hour); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getbool(key string, fallback bool) (bool, error) {
	v := os.Getenv(key)
	if v == "" {
		return fallback, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("%s: %w", key, err)
	}
	return b, nil
}

func getduration(key string, fallback time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return fallback, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("%s must be positive", key)
	}
	return d, nil
}
