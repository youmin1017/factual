package server

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"golang.org/x/time/rate"

	"factual/apps/api/internal/apispec"
	"factual/apps/api/internal/domain/identity"
	"factual/apps/api/internal/domain/ledger"
	"factual/apps/api/internal/shared/apperr"
	"factual/apps/api/internal/shared/reqctx"
)

// session puts the client info and, for a valid session cookie, the
// principal into the request context. It never rejects a request; the
// per-operation access check does that.
func (s *server) session(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		req := c.Request()
		ctx := reqctx.WithClient(req.Context(), reqctx.Client{IP: c.RealIP(), UserAgent: req.UserAgent()})
		if id := s.deps.Identity; id != nil {
			if flow, err := c.Cookie(id.FlowCookieName()); err == nil && flow.Value != "" {
				ctx = reqctx.WithFlow(ctx, flow.Value)
			}
			if cookie, err := c.Cookie(id.CookieName()); err == nil && cookie.Value != "" {
				ctx = reqctx.WithToken(ctx, cookie.Value)
				p, err := id.Authenticate(ctx, cookie.Value)
				switch {
				case err == nil:
					ctx = reqctx.WithPrincipal(ctx, p)
				case !errors.Is(err, identity.ErrNoSession):
					return err
				}
			}
		}
		c.SetRequest(req.WithContext(ctx))
		return next(c)
	}
}

// crossSiteGuard rejects state-changing requests that the browser marks as
// coming from another origin (Fetch Metadata). With the SameSite=Lax session
// cookie this is the CSRF protection. Non-browser clients send no
// Sec-Fetch-Site header and are let through.
func crossSiteGuard(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		switch c.Request().Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			return next(c)
		}
		switch c.Request().Header.Get("Sec-Fetch-Site") {
		case "", "same-origin", "none":
			return next(c)
		}
		return apperr.New(http.StatusForbidden, "cross_site_request", "cross-site request rejected")
	}
}

// routeKey identifies an echo route: method plus registered path, e.g.
// "GET /api/oidc-providers/:id" (c.Path() form).
func routeKey(method, path string) string { return method + " " + path }

// accessRules maps every operation's route to the operation.
func accessRules(ops []apispec.Operation) map[string]apispec.Operation {
	rules := make(map[string]apispec.Operation, len(ops))
	for _, op := range ops {
		rules[routeKey(op.Method, op.Route)] = op
	}
	return rules
}

// checkAccess enforces the matched route's `x-auth`. Routes without a rule
// are not API operations (e.g. echo's not-found route) and pass through.
func checkAccess(rules map[string]apispec.Operation) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			op, ok := rules[routeKey(c.Request().Method, c.Path())]
			if !ok || op.Access == apispec.Public {
				return next(c)
			}
			p, ok := reqctx.PrincipalFrom(c.Request().Context())
			if !ok {
				return apperr.New(http.StatusUnauthorized, "unauthorized", "login required")
			}
			if op.Access == apispec.Permitted && !p.Can(op.Permission) {
				return apperr.New(http.StatusForbidden, "forbidden", "forbidden")
			}
			return next(c)
		}
	}
}

// checkBudget enforces `x-budget`: the caller must be a member of the
// budget in the path, with a role that grants the declared permission. A
// budget the caller is not a member of answers 404, like one that does not
// exist, so ids cannot be probed. Runs after checkAccess, which guarantees a
// caller for these operations.
func (s *server) checkBudget(rules map[string]apispec.Operation) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			op, ok := rules[routeKey(c.Request().Method, c.Path())]
			if !ok || op.Budget == "" {
				return next(c)
			}
			notFound := apperr.New(http.StatusNotFound, "not_found", "budget not found")
			budgetID, err := uuid.Parse(c.Param(apispec.BudgetParam))
			if err != nil {
				return notFound
			}
			ctx := c.Request().Context()
			role, err := s.deps.Ledger.MemberRole(ctx, budgetID, reqctx.Caller(ctx).UserID)
			if errors.Is(err, ledger.ErrNotMember) {
				return notFound
			}
			if err != nil {
				return err
			}
			if !role.Can(ledger.Permission(op.Budget)) {
				return apperr.New(http.StatusForbidden, "forbidden", "your role in this budget does not allow this")
			}
			return next(c)
		}
	}
}

// loginRateLimit slows password guessing: per client IP, a burst of 10
// attempts, then one every 6 seconds.
func loginRateLimit() echo.MiddlewareFunc {
	return middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Skipper: func(c echo.Context) bool {
			return c.Request().Method != http.MethodPost || c.Request().URL.Path != apispec.BaseURL+"/auth/login"
		},
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate: rate.Every(6 * time.Second), Burst: 10, ExpiresIn: 10 * time.Minute,
		}),
	})
}
