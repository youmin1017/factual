package identity

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/identity/internal/db"
	"factual/apps/api/internal/shared/apperr"
	"factual/apps/api/internal/shared/reqctx"
)

func (h *Handlers) Login(ctx context.Context, req api.LoginRequestObject) (api.LoginResponseObject, error) {
	if h.s == nil {
		return nil, errors.New("identity service not configured")
	}
	client := reqctx.ClientFrom(ctx)
	token, u, err := h.s.Login(ctx, req.Body.Username, req.Body.Password, client)
	if err != nil {
		slog.Info("login failed", "username", req.Body.Username, "ip", client.IP, "reason", err.Error())
		return nil, loginError(err)
	}
	slog.Info("login", "user", u.ID, "method", "password", "ip", client.IP)
	cookie := h.s.Cookie(token).String()
	return api.Login200JSONResponse{
		Body:    currentUser(u),
		Headers: api.Login200ResponseHeaders{SetCookie: &cookie},
	}, nil
}

// loginError maps login errors to API errors.
func loginError(err error) error {
	switch {
	case errors.Is(err, ErrInvalidCredentials):
		return apperr.New(http.StatusUnauthorized, "invalid_credentials", "invalid username or password")
	case errors.Is(err, ErrAccountDisabled):
		return apperr.New(http.StatusForbidden, "account_disabled", "account is disabled")
	case errors.Is(err, ErrPasswordLoginDisabled):
		return apperr.New(http.StatusForbidden, "password_login_disabled", "password login is disabled")
	}
	return err
}

func (h *Handlers) Logout(ctx context.Context, _ api.LogoutRequestObject) (api.LogoutResponseObject, error) {
	if h.s == nil {
		return api.Logout204Response{}, nil
	}
	if err := h.s.Logout(ctx, reqctx.TokenFrom(ctx)); err != nil {
		return nil, err
	}
	cookie := h.s.ClearCookie().String()
	return api.Logout204Response{Headers: api.Logout204ResponseHeaders{SetCookie: &cookie}}, nil
}

func (h *Handlers) GetCurrentUser(ctx context.Context, _ api.GetCurrentUserRequestObject) (api.GetCurrentUserResponseObject, error) {
	u, err := h.s.User(ctx, reqctx.Caller(ctx))
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	return api.GetCurrentUser200JSONResponse(currentUser(u)), nil
}

func (h *Handlers) ChangePassword(ctx context.Context, req api.ChangePasswordRequestObject) (api.ChangePasswordResponseObject, error) {
	err := h.s.ChangePassword(ctx, reqctx.Caller(ctx), reqctx.TokenFrom(ctx), req.Body.CurrentPassword, req.Body.NewPassword)
	if errors.Is(err, ErrWrongPassword) {
		// 400, not 401: the session is fine, only the input is wrong.
		return nil, apperr.BadRequest("wrong_password", "current password is wrong")
	}
	if err != nil {
		return nil, err
	}
	return api.ChangePassword204Response{}, nil
}

func currentUser(u User) api.CurrentUser {
	return api.CurrentUser{
		Id: u.ID, Username: u.Username, DisplayName: u.DisplayName, Email: u.Email,
		IsAdmin: u.IsAdmin, HasPassword: u.PasswordHash != "",
	}
}

// maxKeymapLen matches the column's check and the spec's maxLength.
const maxKeymapLen = 8000

func (h *Handlers) GetPreferences(ctx context.Context, _ api.GetPreferencesRequestObject) (api.GetPreferencesResponseObject, error) {
	keymap, err := h.s.q.GetPreferences(ctx, reqctx.Caller(ctx).UserID)
	if err != nil {
		return nil, apperr.FromDB(err)
	}
	return api.GetPreferences200JSONResponse{EditorKeymap: keymap}, nil
}

func (h *Handlers) UpdatePreferences(ctx context.Context, req api.UpdatePreferencesRequestObject) (api.UpdatePreferencesResponseObject, error) {
	keymap := strings.ReplaceAll(req.Body.EditorKeymap, "\r\n", "\n")
	if len(keymap) > maxKeymapLen {
		return nil, apperr.BadRequest("keymap_too_long", "the key mappings are at most 8000 bytes")
	}
	err := h.s.q.UpdatePreferences(ctx, db.UpdatePreferencesParams{ID: reqctx.Caller(ctx).UserID, EditorKeymap: keymap})
	if err != nil {
		return nil, err
	}
	return api.UpdatePreferences200JSONResponse{EditorKeymap: keymap}, nil
}
