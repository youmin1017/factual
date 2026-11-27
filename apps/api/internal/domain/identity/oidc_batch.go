package identity

import (
	"context"
	"log/slog"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/identity/internal/db"
	"factual/apps/api/internal/shared/apperr"
)

// The identity providers page saves its buffer in one request (:w,
// ADR-126), as the accounts page does (ADR-108): new providers, changes,
// the order of the login buttons and deletions, all or nothing, with
// problems reported per provider (ADR-044).

var (
	providerCode = regexp.MustCompile(`^[a-z][a-z0-9_-]{1,31}$`)
	iconSlug     = regexp.MustCompile(`^[a-z0-9_]{0,64}$`)
)

type providerProblems []api.BatchProblem

func (p *providerProblems) add(id uuid.UUID, field, code, message string) {
	*p = append(*p, api.BatchProblem{Id: id, Field: field, Code: code, Message: message})
}

// providerPlan is an upsert checked and ready to write.
type providerPlan struct {
	in     api.OidcProviderUpsert
	cur    *db.OidcProvider
	name   string
	issuer string
	scopes []string
	secret string // sealed; "" keeps the stored one
}

func (h *Handlers) SaveOidcProviders(ctx context.Context, req api.SaveOidcProvidersRequestObject) (api.SaveOidcProvidersResponseObject, error) {
	if !h.s.oidcOn() {
		return nil, apperr.BadRequest("oidc_unavailable", "OIDC login is not available on this server")
	}
	b := req.Body
	rows, err := h.s.q.ListOIDCProviders(ctx)
	if err != nil {
		return nil, err
	}
	saved := make(map[uuid.UUID]db.OidcProvider, len(rows))
	for _, p := range rows {
		saved[p.ID] = p
	}

	var probs providerProblems
	seen := map[uuid.UUID]bool{}
	once := func(id uuid.UUID) bool {
		if seen[id] {
			probs.add(id, "", "duplicate_id", "it appears twice in the batch")
			return false
		}
		seen[id] = true
		return true
	}
	deleted := map[uuid.UUID]bool{}
	for _, id := range b.Deletes {
		if once(id) {
			deleted[id] = true
		}
	}

	var plans []providerPlan
	for _, u := range b.Upserts {
		if !once(u.Id) {
			continue
		}
		plan, field, code, message := checkProvider(u, saved)
		if code != "" {
			probs.add(u.Id, field, code, message)
			continue
		}
		plans = append(plans, plan)
	}

	// Codes are unique among the providers kept after the batch.
	owner := map[string]uuid.UUID{}
	planned := map[uuid.UUID]bool{}
	for _, p := range plans {
		planned[p.in.Id] = true
	}
	for _, p := range rows {
		if !deleted[p.ID] && !planned[p.ID] {
			owner[p.Code] = p.ID
		}
	}
	for _, p := range plans {
		if other, ok := owner[p.in.Code]; ok && other != p.in.Id {
			probs.add(p.in.Id, "code", "duplicate_code", "another provider has this code")
			continue
		}
		owner[p.in.Code] = p.in.Id
	}
	if len(probs) > 0 {
		return api.SaveOidcProviders422JSONResponse{Errors: probs}, nil
	}

	// Only now the network: a new or changed OIDC issuer must serve discovery.
	for i, p := range plans {
		if p.in.Kind == api.Oidc && (p.cur == nil || p.cur.Issuer != p.issuer) {
			dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := h.s.oidc.Discover(dctx, p.issuer)
			cancel()
			if err != nil {
				slog.Warn("oidc discovery", "issuer", p.issuer, "err", err)
				probs.add(p.in.Id, "issuer", "invalid_issuer", "the issuer does not serve a valid OpenID Connect discovery document")
				continue
			}
		}
		if p.in.ClientSecret != "" {
			sealed, err := h.sealClientSecret(p.in.ClientSecret)
			if err != nil {
				return nil, err
			}
			plans[i].secret = sealed
		}
	}
	if len(probs) > 0 {
		return api.SaveOidcProviders422JSONResponse{Errors: probs}, nil
	}

	var out api.OidcProviderBatchSaved
	by := callerID(ctx)
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		for _, id := range b.Deletes {
			if _, ok := saved[id]; !ok {
				continue // already gone
			}
			if err := q.DeleteOIDCProvider(ctx, id); err != nil {
				return err
			}
			out.Deleted++
		}
		for _, p := range plans {
			if p.cur == nil {
				continue
			}
			secret := p.cur.ClientSecret
			if p.secret != "" {
				secret = p.secret
			}
			if err := q.UpdateOIDCProvider(ctx, db.UpdateOIDCProviderParams{
				ID: p.in.Id, Code: p.in.Code, Name: p.name, Issuer: p.issuer, ClientID: strings.TrimSpace(p.in.ClientId),
				ClientSecret: secret, Scopes: p.scopes, Icon: p.in.Icon, Sort: p.in.Sort, Enabled: p.in.Enabled,
				Remark: strings.TrimSpace(p.in.Remark), UpdatedBy: by,
			}); err != nil {
				return err
			}
			out.Upserted++
		}
		for _, p := range plans {
			if p.cur != nil {
				continue
			}
			if err := q.CreateOIDCProvider(ctx, db.CreateOIDCProviderParams{
				ID: p.in.Id, Code: p.in.Code, Name: p.name, Kind: string(p.in.Kind), Issuer: p.issuer,
				ClientID: strings.TrimSpace(p.in.ClientId), ClientSecret: p.secret, Scopes: p.scopes, Icon: p.in.Icon,
				Sort: p.in.Sort, Enabled: p.in.Enabled, Remark: strings.TrimSpace(p.in.Remark), CreatedBy: by,
			}); err != nil {
				return err
			}
			out.Upserted++
		}
		return nil
	})
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	return api.SaveOidcProviders200JSONResponse(out), nil
}

// checkProvider checks one upsert on its own; it returns the plan, or the
// field, code and message of its first problem.
func checkProvider(u api.OidcProviderUpsert, saved map[uuid.UUID]db.OidcProvider) (providerPlan, string, string, string) {
	plan := providerPlan{in: u}
	if cur, ok := saved[u.Id]; ok {
		plan.cur = &cur
	}
	kind := string(u.Kind)
	switch {
	case !ValidKind(kind):
		return plan, "kind", "invalid_provider_kind", "the kind is oidc, github or discord"
	case plan.cur != nil && plan.cur.Kind != kind:
		return plan, "kind", "kind_fixed", "a provider's kind cannot change once created"
	}
	plan.name = strings.TrimSpace(u.Name)
	if n := utf8.RuneCountInString(plan.name); n < 1 || n > 64 {
		return plan, "name", "invalid_name", "a name is 1 to 64 characters"
	}
	if !providerCode.MatchString(u.Code) {
		return plan, "code", "invalid_code", "a code is 2 to 32 of a-z, 0-9, _ and -, starting with a letter"
	}
	if !iconSlug.MatchString(u.Icon) {
		return plan, "icon", "invalid_icon", "an icon is a Simple Icons slug"
	}
	plan.issuer = strings.TrimSpace(u.Issuer)
	if plan.issuer == "" && kind != KindOIDC {
		plan.issuer = DefaultSiteURL(kind)
	}
	if !webAddress(plan.issuer) {
		if kind == KindOIDC {
			return plan, "issuer", "invalid_issuer", "the issuer is an http or https address"
		}
		return plan, "issuer", "invalid_site_url", "the address is an http or https address"
	}
	if kind != KindOIDC {
		plan.issuer = strings.TrimRight(plan.issuer, "/")
	}
	if strings.TrimSpace(u.ClientId) == "" {
		return plan, "clientId", "client_id_required", "the client id is required"
	}
	hasSecret := plan.cur != nil && plan.cur.ClientSecret != ""
	if kind == KindGitHub && u.ClientSecret == "" && !hasSecret {
		return plan, "clientSecret", "secret_required", "GitHub needs the client secret"
	}
	for _, s := range u.Scopes {
		s = strings.TrimSpace(s)
		if s == "" || strings.ContainsFunc(s, unicode.IsSpace) {
			return plan, "scopes", "invalid_scope", "a scope is one word"
		}
		if !slices.Contains(plan.scopes, s) {
			plan.scopes = append(plan.scopes, s)
		}
	}
	if len(plan.scopes) == 0 {
		plan.scopes = DefaultScopes(kind)
	}
	return plan, "", "", ""
}

func webAddress(s string) bool {
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}
