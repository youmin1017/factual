package server

import (
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"

	"factual/apps/api/internal/apispec"
	"factual/apps/api/internal/webui"
)

// serveWeb serves the built web app on every path outside the API: files
// under assets/ (named by content hash) are cached for a year, other files
// are revalidated, and any other path gets the app shell, so the client
// router handles it. A missing file (a path with an extension) is a 404
// rather than the shell, so a stale asset after an upgrade never arrives as
// HTML.
func serveWeb(e *echo.Echo, files fs.FS) error {
	shell, err := fs.ReadFile(files, webui.Shell)
	if err != nil {
		return fmt.Errorf("web app: %w", err)
	}
	handler := func(c echo.Context) error {
		p := c.Request().URL.Path
		if p == apispec.BaseURL || strings.HasPrefix(p, apispec.BaseURL+"/") {
			return echo.ErrNotFound
		}
		name := strings.TrimPrefix(path.Clean("/"+p), "/")
		header := c.Response().Header()
		if name != "" && name != webui.Shell {
			if info, err := fs.Stat(files, name); err == nil && !info.IsDir() {
				if strings.HasPrefix(name, "assets/") {
					header.Set(echo.HeaderCacheControl, "public, max-age=31536000, immutable")
				} else {
					header.Set(echo.HeaderCacheControl, "no-cache")
				}
				http.ServeFileFS(c.Response(), c.Request(), files, name)
				return nil
			}
			if path.Ext(name) != "" {
				return echo.ErrNotFound
			}
		}
		header.Set(echo.HeaderCacheControl, "no-cache")
		return c.HTMLBlob(http.StatusOK, shell)
	}
	// Gzip wraps the handler rather than a group: group middleware would
	// register its own catch-all not-found routes over the API group's.
	// "/" is registered on its own because the API group's catch-all for ""
	// would otherwise take it.
	h := middleware.Gzip()(handler)
	for _, route := range []string{"/", "/*"} {
		e.GET(route, h)
		e.HEAD(route, h)
	}
	return nil
}
