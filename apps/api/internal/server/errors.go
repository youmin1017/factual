package server

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/labstack/echo/v4"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/shared/apperr"
)

// errorHandler renders every error as the Error envelope. Details of 5xx
// errors are logged, never sent to the client.
func errorHandler(err error, c echo.Context) {
	if c.Response().Committed {
		return
	}
	status := http.StatusInternalServerError
	body := api.Error{Code: "internal", Message: "internal server error"}

	var he *echo.HTTPError
	ae, isApp := apperr.As(err)
	switch {
	case isApp:
		status, body = ae.Status, api.Error{Code: ae.Code, Message: ae.Message}
		if ae.Details != nil {
			body.Details = &ae.Details
		}
	case errors.As(err, &he):
		status = he.Code
		body = api.Error{Code: codeForStatus(he.Code), Message: http.StatusText(he.Code)}
		if m, ok := he.Message.(string); ok && m != "" && status < 500 {
			body.Message = m
		}
	}
	if status >= 500 {
		slog.Error("request failed", "method", c.Request().Method, "path", c.Request().URL.Path, "err", err)
	}

	if c.Request().Method == http.MethodHead {
		err = c.NoContent(status)
	} else {
		err = c.JSON(status, body)
	}
	if err != nil {
		slog.Error("write error response", "err", err)
	}
}

func codeForStatus(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "bad_request"
	case http.StatusUnauthorized:
		return "unauthorized"
	case http.StatusForbidden:
		return "forbidden"
	case http.StatusNotFound:
		return "not_found"
	case http.StatusMethodNotAllowed:
		return "method_not_allowed"
	case http.StatusConflict:
		return "conflict"
	case http.StatusRequestEntityTooLarge:
		return "too_large"
	case http.StatusTooManyRequests:
		return "too_many_requests"
	}
	if status >= 500 {
		return "internal"
	}
	return "error"
}
