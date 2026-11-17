package config

import (
	"testing"
	"time"
)

// clear unsets every setting so a test starts from the defaults.
func clear(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"FACTUAL_HTTP_ADDR", "FACTUAL_PUBLIC_URL", "FACTUAL_DATABASE_URL", "FACTUAL_DB_AUTO_MIGRATE",
		"FACTUAL_PASSWORD_LOGIN", "FACTUAL_COOKIE_SECURE", "FACTUAL_SESSION_IDLE_TIMEOUT", "FACTUAL_SESSION_MAX_AGE",
		"FACTUAL_ENCRYPTION_KEY", "FACTUAL_BOOTSTRAP_ADMIN_USERNAME", "FACTUAL_BOOTSTRAP_ADMIN_PASSWORD",
	} {
		t.Setenv(k, "")
	}
}

func TestLoad(t *testing.T) {
	t.Run("database url is required", func(t *testing.T) {
		clear(t)
		if _, err := Load(); err == nil {
			t.Fatal("expected an error without FACTUAL_DATABASE_URL")
		}
	})

	t.Run("defaults", func(t *testing.T) {
		clear(t)
		t.Setenv("FACTUAL_DATABASE_URL", "postgres://x")
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.HTTPAddr != ":8080" || !cfg.AutoMigrate || cfg.PublicURL != "http://localhost:3000" {
			t.Fatalf("unexpected defaults: %+v", cfg)
		}
		a := cfg.Auth
		if !a.PasswordLogin || a.SecureCookie || a.IdleTimeout != 720*time.Hour || a.MaxAge != 2160*time.Hour {
			t.Fatalf("unexpected auth defaults: %+v", a)
		}
	})

	t.Run("overrides", func(t *testing.T) {
		clear(t)
		t.Setenv("FACTUAL_DATABASE_URL", "postgres://x")
		t.Setenv("FACTUAL_HTTP_ADDR", ":9000")
		t.Setenv("FACTUAL_DB_AUTO_MIGRATE", "false")
		t.Setenv("FACTUAL_PUBLIC_URL", "https://money.example.com/")
		t.Setenv("FACTUAL_SESSION_IDLE_TIMEOUT", "2h")
		t.Setenv("FACTUAL_PASSWORD_LOGIN", "false")
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.HTTPAddr != ":9000" || cfg.AutoMigrate || cfg.PublicURL != "https://money.example.com" {
			t.Fatalf("overrides not applied: %+v", cfg)
		}
		if cfg.Auth.IdleTimeout != 2*time.Hour || cfg.Auth.PasswordLogin {
			t.Fatalf("auth overrides not applied: %+v", cfg.Auth)
		}
	})

	t.Run("cookies are secure when the public url is https", func(t *testing.T) {
		clear(t)
		t.Setenv("FACTUAL_DATABASE_URL", "postgres://x")
		t.Setenv("FACTUAL_PUBLIC_URL", "https://money.example.com")
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if !cfg.Auth.SecureCookie {
			t.Fatal("expected secure cookies for an https public url")
		}
		t.Setenv("FACTUAL_COOKIE_SECURE", "false")
		if cfg, err = Load(); err != nil || cfg.Auth.SecureCookie {
			t.Fatalf("FACTUAL_COOKIE_SECURE=false not honoured: %+v, %v", cfg.Auth, err)
		}
	})

	t.Run("invalid values", func(t *testing.T) {
		for key, value := range map[string]string{
			"FACTUAL_DB_AUTO_MIGRATE":      "maybe",
			"FACTUAL_SESSION_MAX_AGE":      "forever",
			"FACTUAL_SESSION_IDLE_TIMEOUT": "-1h",
			"FACTUAL_PUBLIC_URL":           "money.example.com",
		} {
			clear(t)
			t.Setenv("FACTUAL_DATABASE_URL", "postgres://x")
			t.Setenv(key, value)
			if _, err := Load(); err == nil {
				t.Fatalf("expected an error for %s=%s", key, value)
			}
		}
	})
}
