package server

import (
	"net/http"

	"github.com/labstack/echo/v4"
)

// docsPage is the API reference at /api/docs (ADR-114): Scalar reading the
// served spec, /api/openapi.json, so it always describes the running server,
// and its test requests go to the same origin with the caller's session.
// Scalar comes from jsDelivr at a pinned version checked by its hash; its
// telemetry, fonts, request proxy, AI agent and MCP generator are off, so the
// page calls nothing but the CDN and this server.
const docsPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Factual API</title>
</head>
<body>
<div id="app"></div>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.77.0/dist/browser/standalone.js"
  integrity="sha384-+7ESN8b9Ljg46TCYKedZUlhF/wfZbOt78aV/DtoU3anEElh8Q2eXsyhQ9W5lAZD4"
  crossorigin="anonymous"></script>
<script>
Scalar.createApiReference('#app', {
  url: './openapi.json',
  telemetry: false,
  withDefaultFonts: false,
  proxyUrl: '',
  agent: { disabled: true },
  mcp: { disabled: true },
  showDeveloperTools: 'never',
})
</script>
</body>
</html>
`

func serveDocs(c echo.Context) error {
	return c.HTML(http.StatusOK, docsPage)
}
