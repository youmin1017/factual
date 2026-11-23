// Package webui holds the built web app (apps/web/dist/client). The
// container build (and `mise run build`) copies it into static/ before
// compiling, so one binary serves both the app and the API. A plain
// `go build` embeds only the placeholder: then FS is nil and the Vite dev
// server serves the app.
package webui

import (
	"embed"
	"io/fs"
)

// Shell is the app's entry page; the client router handles every path the
// server does not know (TanStack Start SPA mode).
const Shell = "_shell.html"

//go:embed all:static
var files embed.FS

// FS returns the embedded web app, or nil when the binary was built
// without it.
func FS() fs.FS {
	sub, err := fs.Sub(files, "static")
	if err != nil {
		return nil
	}
	if _, err := fs.Stat(sub, Shell); err != nil {
		return nil
	}
	return sub
}
