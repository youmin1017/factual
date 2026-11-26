// Package server wires echo, middleware and the generated OpenAPI handlers.
package server

import (
	"compress/gzip"
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	echomw "github.com/oapi-codegen/echo-middleware"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/apispec"
	"factual/apps/api/internal/domain/calendar"
	"factual/apps/api/internal/domain/identity"
	"factual/apps/api/internal/domain/ledger"
)

// Pinger reports whether the database answers (*pgxpool.Pool).
type Pinger interface {
	Ping(ctx context.Context) error
}

// Deps are the collaborators of the server: the database for the health
// check, the domains whose operations it serves and the built web app.
// Identity may be nil in tests without a database: then nobody is
// authenticated. Web is nil when the binary was built without the app
// (development: Vite serves it).
type Deps struct {
	DB       Pinger
	Identity *identity.Service
	Ledger   *ledger.Service
	Calendar *calendar.Service
	Web      fs.FS
	// APIDocs serves the API reference at /api/docs (FACTUAL_API_DOCS, ADR-114).
	APIDocs bool
}

// The domains' operations are promoted into server by embedding their
// Handlers; the aliases give the embedded fields distinct names. Two domains
// implementing the same operation do not compile (ambiguous selector).
type (
	identityHandlers = identity.Handlers
	ledgerHandlers   = ledger.Handlers
	calendarHandlers = calendar.Handlers
)

// server implements api.StrictServerInterface: the domains' operations and
// the health check.
type server struct {
	*identityHandlers
	*ledgerHandlers
	*calendarHandlers
	deps Deps
}

var _ api.StrictServerInterface = (*server)(nil)

func (s *server) GetHealth(ctx context.Context, _ api.GetHealthRequestObject) (api.GetHealthResponseObject, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	if err := s.deps.DB.Ping(ctx); err != nil {
		slog.Warn("health check: database unreachable", "err", err)
		return api.GetHealth503JSONResponse{Status: api.Degraded}, nil
	}
	return api.GetHealth200JSONResponse{Status: api.Ok}, nil
}

// New builds the echo instance.
//
// Request flow: recover/log -> cross-site guard -> session -> access check
// (x-auth) -> budget membership (x-budget) -> login rate limit -> OpenAPI
// validation -> handler. Every other path is the web app (serveWeb).
func New(d Deps) (*echo.Echo, error) {
	swagger, err := api.GetSwagger()
	if err != nil {
		return nil, err
	}
	ops, err := apispec.Operations(swagger)
	if err != nil {
		return nil, fmt.Errorf("openapi access rules: %w", err)
	}
	s := &server{
		identityHandlers: d.Identity.Handlers(), ledgerHandlers: d.Ledger.Handlers(),
		calendarHandlers: d.Calendar.Handlers(), deps: d,
	}

	e := echo.New()
	e.HideBanner = true
	e.HidePort = true
	e.HTTPErrorHandler = errorHandler
	// The client address is the last X-Forwarded-For entry not added by a
	// loopback or private-network proxy; used for the login rate limit and
	// recorded with sessions.
	e.IPExtractor = echo.ExtractIPFromXFFHeader()
	e.Use(middleware.Recover(), middleware.RequestLogger(), middleware.SecureWithConfig(middleware.SecureConfig{
		ContentTypeNosniff: "nosniff",
		XFrameOptions:      "DENY",
		ReferrerPolicy:     "same-origin",
	}))

	e.GET(apispec.BaseURL+"/openapi.json", func(c echo.Context) error {
		return c.JSON(http.StatusOK, swagger)
	})
	if d.APIDocs {
		e.GET(apispec.BaseURL+"/docs", serveDocs)
	}

	g := e.Group("")
	rules := accessRules(ops)
	g.Use(crossSiteGuard, s.session, checkAccess(rules), s.checkBudget(rules), loginRateLimit())
	// Registers and month responses are JSON that compresses about fivefold;
	// the fastest level keeps nearly all of that (20 MB in ~90 ms) while the
	// default level takes twice as long for 10% less.
	g.Use(middleware.GzipWithConfig(middleware.GzipConfig{Level: gzip.BestSpeed, MinLength: 1024}))
	g.Use(echomw.OapiRequestValidatorWithOptions(swagger, &echomw.Options{
		SilenceServersWarning: true,
		Skipper: func(c echo.Context) bool {
			return strings.HasPrefix(c.Request().URL.Path, apispec.BaseURL+"/openapi")
		},
	}))

	api.RegisterHandlersWithBaseURL(g, api.NewStrictHandler(s, nil), apispec.BaseURL)
	if d.Web != nil {
		if err := serveWeb(e, d.Web); err != nil {
			return nil, err
		}
	}
	return e, nil
}
