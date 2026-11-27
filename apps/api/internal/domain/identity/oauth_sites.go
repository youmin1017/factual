package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
)

// Provider kinds (ADR-125). An OIDC provider is found by discovery and says
// who signed in through a signed ID token. GitHub and Discord only speak
// OAuth2 for logins: after the code is redeemed (with PKCE and state, as
// for OIDC) the user is read from their user API with the access token,
// and its numeric id is the subject. Their issuer is the site's address,
// so a GitHub Enterprise Server works too.
const (
	KindOIDC    = "oidc"
	KindGitHub  = "github"
	KindDiscord = "discord"
)

// site is how an OAuth2-only provider is reached from its address.
type site struct {
	authPath, tokenPath string
	defaultURL          string
	defaultScopes       []string
	// user reads who signed in; c carries the access token.
	user func(ctx context.Context, c *http.Client, base string) (subject, email string, err error)
}

var sites = map[string]site{
	KindGitHub: {
		authPath: "/login/oauth/authorize", tokenPath: "/login/oauth/access_token",
		defaultURL: "https://github.com", defaultScopes: []string{"read:user", "user:email"},
		user: githubUser,
	},
	KindDiscord: {
		authPath: "/oauth2/authorize", tokenPath: "/api/oauth2/token",
		defaultURL: "https://discord.com", defaultScopes: []string{"identify", "email"},
		user: discordUser,
	},
}

// ValidKind reports whether kind is a provider kind.
func ValidKind(kind string) bool {
	_, ok := sites[kind]
	return ok || kind == KindOIDC
}

// DefaultSiteURL is the address a GitHub or Discord provider has unless
// another is given; "" for OIDC, whose issuer is always given.
func DefaultSiteURL(kind string) string { return sites[kind].defaultURL }

// DefaultScopes are the scopes a provider of the kind asks for when none are set.
func DefaultScopes(kind string) []string {
	if s, ok := sites[kind]; ok {
		return slices.Clone(s.defaultScopes)
	}
	return []string{oidc.ScopeOpenID, "email", "profile"}
}

// scopesFor is what a provider asks for: its scopes or the kind's
// defaults, with openid always first for OIDC.
func scopesFor(kind string, scopes []string) []string {
	if len(scopes) == 0 {
		scopes = DefaultScopes(kind)
	}
	if kind == KindOIDC && !slices.Contains(scopes, oidc.ScopeOpenID) {
		scopes = append([]string{oidc.ScopeOpenID}, scopes...)
	}
	return scopes
}

// githubAPI is the REST API of a GitHub site: api.github.com for
// github.com, <address>/api/v3 for an Enterprise Server.
func githubAPI(base string) string {
	if u, err := url.Parse(base); err == nil && strings.EqualFold(u.Host, "github.com") {
		return "https://api.github.com"
	}
	return base + "/api/v3"
}

func githubUser(ctx context.Context, c *http.Client, base string) (string, string, error) {
	api := githubAPI(base)
	var u struct {
		ID    int64  `json:"id"`
		Email string `json:"email"`
	}
	if err := getJSON(ctx, c, api+"/user", &u); err != nil {
		return "", "", err
	}
	if u.ID == 0 {
		return "", "", errors.New("github user has no id")
	}
	email := u.Email
	if email == "" {
		// A private address needs the user:email scope; without it the
		// identity just has no address (it is never matched on anyway).
		var emails []struct {
			Email    string `json:"email"`
			Primary  bool   `json:"primary"`
			Verified bool   `json:"verified"`
		}
		if getJSON(ctx, c, api+"/user/emails", &emails) == nil {
			for _, e := range emails {
				if e.Primary && e.Verified {
					email = e.Email
				}
			}
		}
	}
	return strconv.FormatInt(u.ID, 10), email, nil
}

func discordUser(ctx context.Context, c *http.Client, base string) (string, string, error) {
	var u struct {
		ID       string `json:"id"`
		Email    string `json:"email"`
		Verified bool   `json:"verified"`
	}
	if err := getJSON(ctx, c, base+"/api/users/@me", &u); err != nil {
		return "", "", err
	}
	if u.ID == "" {
		return "", "", errors.New("discord user has no id")
	}
	email := ""
	if u.Verified {
		email = u.Email
	}
	return u.ID, email, nil
}

func getJSON(ctx context.Context, c *http.Client, endpoint string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", endpoint, res.Status)
	}
	return json.Unmarshal(body, into)
}
