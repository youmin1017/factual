package identity

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/identity/internal/db"
	"factual/apps/api/internal/shared/apperr"
	"factual/apps/api/internal/shared/reqctx"
	"factual/apps/api/internal/shared/roles"
)

// The users page and one-time links (ADR-131, ADR-132). The admin changes
// users' roles and whether they may log in, and makes links to join or to
// reset a password, all in one batch (:w, ADR-116). A link is a random token
// looked up by its SHA-256, as sessions are; it is used once, for LinkTTL.
// The token is also kept sealed with the encryption key, so the page can copy
// the link again while it can be used (ADR-135). Following one needs no session: /join/<token> registers and
// /reset/<token> sets a password, both logging in.

// LinkTTL is how long a one-time link can be used.
const LinkTTL = 7 * 24 * time.Hour

const (
	purposeJoin  = "join"
	purposeReset = "reset"
	linkAAD      = "link-token"
)

// sealLinkToken keeps a token for copying again; "" without an encryption key.
func (s *Service) sealLinkToken(token string) string {
	if s.oidc == nil || !s.oidc.box.HasKey() {
		return ""
	}
	sealed, err := s.oidc.box.Seal([]byte(token), linkAAD)
	if err != nil {
		slog.Warn("seal link token", "err", err)
		return ""
	}
	return sealed
}

// linkToken opens a kept token; nil when there is none or it cannot be opened.
func (s *Service) linkToken(sealed string) *string {
	if sealed == "" || s.oidc == nil {
		return nil
	}
	raw, err := s.oidc.box.Open(sealed, linkAAD)
	if err != nil {
		return nil
	}
	token := string(raw)
	return &token
}

// linkInvalid is the one answer for a link that does not exist, was used or
// revoked, or expired, so tokens cannot be told apart.
func linkInvalid() error {
	return apperr.New(http.StatusNotFound, "link_invalid", "the link is invalid, used or expired")
}

func (h *Handlers) ListUsers(ctx context.Context, _ api.ListUsersRequestObject) (api.ListUsersResponseObject, error) {
	users, err := h.s.q.ListRegisteredUsers(ctx)
	if err != nil {
		return nil, err
	}
	links, err := h.s.q.ListOpenLinks(ctx, db.ListOpenLinksParams{
		Now: h.s.now().UTC(), Purposes: []string{purposeJoin, purposeReset},
	})
	if err != nil {
		return nil, err
	}
	out := api.ListUsers200JSONResponse{Users: make([]api.UserSummary, 0, len(users)), Links: make([]api.OpenLink, 0, len(links))}
	for _, u := range users {
		item := api.UserSummary{
			Id: u.ID, Username: u.Username, DisplayName: u.DisplayName, Role: api.InstanceRole(u.Role),
			Active: u.Active, HasPassword: u.HasPassword, Identities: u.Identities, CreatedAt: u.CreatedAt,
		}
		if u.LastLoginAt.Valid {
			item.LastLoginAt = &u.LastLoginAt.Time
		}
		out.Users = append(out.Users, item)
	}
	for _, l := range links {
		item := api.OpenLink{
			Id: l.ID, Purpose: api.LinkPurpose(l.Purpose), Note: l.Note, CreatedBy: l.CreatedBy,
			CreatedAt: l.CreatedAt, ExpiresAt: l.ExpiresAt, Token: h.s.linkToken(l.TokenSealed),
		}
		if l.UserID.Valid {
			id := uuid.UUID(l.UserID.Bytes)
			item.UserId = &id
		}
		out.Links = append(out.Links, item)
	}
	return out, nil
}

func (h *Handlers) SaveUsers(ctx context.Context, req api.SaveUsersRequestObject) (api.SaveUsersResponseObject, error) {
	caller := reqctx.Caller(ctx).UserID
	b := req.Body
	rows, err := h.s.q.ListRegisteredUsers(ctx)
	if err != nil {
		return nil, err
	}
	users := make(map[uuid.UUID]db.ListRegisteredUsersRow, len(rows))
	for _, u := range rows {
		users[u.ID] = u
	}

	var probs []api.BatchProblem
	add := func(id uuid.UUID, field, code, message string) {
		probs = append(probs, api.BatchProblem{Id: id, Field: field, Code: code, Message: message})
	}
	seen := map[uuid.UUID]bool{}
	once := func(id uuid.UUID) bool {
		if seen[id] {
			add(id, "", "duplicate_id", "it appears twice in the batch")
			return false
		}
		seen[id] = true
		return true
	}

	// Users: the roles and access they will have after the batch.
	after := make(map[uuid.UUID]db.ListRegisteredUsersRow, len(rows))
	for id, u := range users {
		after[id] = u
	}
	var changes []api.UserChange
	for _, c := range b.Users {
		if !once(c.Id) {
			continue
		}
		cur, ok := users[c.Id]
		switch {
		case !ok:
			add(c.Id, "", "not_found", "user not found")
			continue
		case !roles.Valid(roles.Role(c.Role)):
			add(c.Id, "role", "invalid_role", "the role is admin or member")
			continue
		case c.Id == caller && string(c.Role) != cur.Role:
			add(c.Id, "role", "own_role", "you cannot change your own role")
			continue
		case c.Id == caller && !c.Active:
			add(c.Id, "active", "own_access", "you cannot disable yourself")
			continue
		}
		cur.Role, cur.Active = string(c.Role), c.Active
		after[c.Id] = cur
		changes = append(changes, c)
	}
	admins := 0
	for _, u := range after {
		if u.Active && u.Role == string(roles.Admin) {
			admins++
		}
	}
	if admins == 0 {
		for _, c := range changes {
			if users[c.Id].Role == string(roles.Admin) && users[c.Id].Active {
				add(c.Id, "role", "last_admin", "an enabled admin must remain")
			}
		}
	}

	// New links: a join link for anyone, a reset link for a user with a login.
	for _, l := range b.Links {
		if !once(l.Id) {
			continue
		}
		switch {
		case l.Purpose != api.Join && l.Purpose != api.Reset:
			add(l.Id, "", "invalid_purpose", "a link is to join or to reset a password")
		case l.Purpose == api.Join && l.UserId != nil:
			add(l.Id, "", "invalid_purpose", "a join link names no user")
		case l.Purpose == api.Reset && (l.UserId == nil || !known(users, *l.UserId)):
			add(l.Id, "", "not_found", "user not found")
		case len([]rune(strings.TrimSpace(l.Note))) > 255:
			add(l.Id, "note", "invalid_note", "a note is at most 255 characters")
		}
	}
	for _, id := range b.Revoke {
		once(id)
	}
	if len(probs) > 0 {
		return api.SaveUsers422JSONResponse{Errors: probs}, nil
	}

	now := h.s.now().UTC()
	out := api.SaveUsers200JSONResponse{Created: []api.CreatedLink{}}
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		for _, c := range changes {
			cur := users[c.Id]
			if cur.Role == string(c.Role) && cur.Active == c.Active {
				continue
			}
			if err := q.SetUserAccess(ctx, db.SetUserAccessParams{ID: c.Id, Role: string(c.Role), Active: c.Active}); err != nil {
				return err
			}
			if !c.Active {
				if err := q.DeleteUserSessions(ctx, c.Id); err != nil {
					return err
				}
			}
			out.Updated++
		}
		for _, l := range b.Links {
			token := randomToken()
			var user pgtype.UUID
			if l.UserId != nil {
				user = pgtype.UUID{Bytes: *l.UserId, Valid: true}
			}
			if err := q.CreateLink(ctx, db.CreateLinkParams{
				ID: l.Id, TokenHash: hashToken(token), TokenSealed: h.s.sealLinkToken(token), Purpose: string(l.Purpose), UserID: user,
				Note: strings.TrimSpace(l.Note), CreatedBy: caller, ExpiresAt: now.Add(LinkTTL), CreatedAt: now,
			}); err != nil {
				return err
			}
			out.Created = append(out.Created, api.CreatedLink{Id: l.Id, Token: token})
		}
		for _, id := range b.Revoke {
			n, err := q.RevokeLink(ctx, db.RevokeLinkParams{ID: id, Now: now})
			if err != nil {
				return err
			}
			out.Revoked += int(n)
		}
		return nil
	})
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == pgUniqueViolation {
		return nil, apperr.New(http.StatusConflict, "duplicate", "a link with this id exists")
	}
	if err != nil {
		return nil, err
	}
	return out, nil
}

func known(users map[uuid.UUID]db.ListRegisteredUsersRow, id uuid.UUID) bool {
	_, ok := users[id]
	return ok
}

// openLink finds a link that can still be used.
func (s *Service) openLink(ctx context.Context, token string) (db.GetOpenLinkRow, error) {
	if token == "" || len(token) > 128 {
		return db.GetOpenLinkRow{}, linkInvalid()
	}
	l, err := s.q.GetOpenLink(ctx, db.GetOpenLinkParams{TokenHash: hashToken(token), Now: s.now().UTC()})
	if isNoRows(err) {
		return l, linkInvalid()
	}
	return l, err
}

func (h *Handlers) GetLink(ctx context.Context, req api.GetLinkRequestObject) (api.GetLinkResponseObject, error) {
	l, err := h.s.openLink(ctx, req.Token)
	if err != nil {
		return nil, err
	}
	if l.Purpose != purposeJoin && l.Purpose != purposeReset {
		// Claim links arrive with claiming placeholders.
		return nil, linkInvalid()
	}
	return api.GetLink200JSONResponse{Purpose: api.LinkPurpose(l.Purpose), ExpiresAt: l.ExpiresAt, Username: l.Username}, nil
}

func (h *Handlers) JoinWithLink(ctx context.Context, req api.JoinWithLinkRequestObject) (api.JoinWithLinkResponseObject, error) {
	b := req.Body
	l, err := h.s.openLink(ctx, b.Token)
	if err != nil {
		return nil, err
	}
	if l.Purpose != purposeJoin {
		return nil, linkInvalid()
	}
	username, displayName := strings.TrimSpace(b.Username), strings.TrimSpace(b.DisplayName)
	if !validName(username, unicode.IsSpace) {
		return nil, apperr.BadRequest("invalid_username", "the username is 1 to 64 characters without spaces")
	}
	if !validName(displayName, nil) {
		return nil, apperr.BadRequest("invalid_display_name", "the display name is 1 to 64 characters")
	}
	hash, err := HashPassword(b.Password)
	if err != nil {
		return nil, err
	}
	var userID uuid.UUID
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		id, err := q.CreateUser(ctx, db.CreateUserParams{
			Username: username, DisplayName: displayName, PasswordHash: hash, Role: string(roles.Member),
		})
		if err != nil {
			return err
		}
		n, err := q.UseLink(ctx, db.UseLinkParams{ID: l.ID, Now: h.s.now().UTC(), UsedBy: pgtype.UUID{Bytes: id, Valid: true}})
		if err != nil {
			return err
		}
		if n == 0 {
			return errLinkTaken
		}
		userID = id
		return nil
	})
	var pe *pgconn.PgError
	switch {
	case errors.Is(err, errLinkTaken):
		return nil, linkInvalid()
	case errors.As(err, &pe) && pe.Code == pgUniqueViolation && pe.ConstraintName == usernameKey:
		return nil, apperr.New(http.StatusConflict, "username_taken", "another user has this username")
	case err != nil:
		return nil, err
	}
	client := reqctx.ClientFrom(ctx)
	slog.Info("joined", "user", userID, "link", l.ID, "ip", client.IP)
	return loginAfterLink(h, ctx, userID, client, func(u api.CurrentUser, cookie string) api.JoinWithLinkResponseObject {
		return api.JoinWithLink200JSONResponse{Body: u, Headers: api.JoinWithLink200ResponseHeaders{SetCookie: &cookie}}
	})
}

func (h *Handlers) ResetPasswordWithLink(ctx context.Context, req api.ResetPasswordWithLinkRequestObject) (api.ResetPasswordWithLinkResponseObject, error) {
	b := req.Body
	l, err := h.s.openLink(ctx, b.Token)
	if err != nil {
		return nil, err
	}
	if l.Purpose != purposeReset || !l.UserID.Valid {
		return nil, linkInvalid()
	}
	userID := uuid.UUID(l.UserID.Bytes)
	u, err := h.s.q.GetUserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if u.Disabled {
		return nil, apperr.New(http.StatusForbidden, "account_disabled", "account is disabled")
	}
	hash, err := HashPassword(b.Password)
	if err != nil {
		return nil, err
	}
	err = h.s.inTx(ctx, func(q *db.Queries) error {
		n, err := q.UseLink(ctx, db.UseLinkParams{ID: l.ID, Now: h.s.now().UTC(), UsedBy: pgtype.UUID{Bytes: userID, Valid: true}})
		if err != nil {
			return err
		}
		if n == 0 {
			return errLinkTaken
		}
		if err := q.UpdateUserPassword(ctx, db.UpdateUserPasswordParams{PasswordHash: hash, ID: userID}); err != nil {
			return err
		}
		// Whoever knew the old password is logged out everywhere.
		return q.DeleteUserSessions(ctx, userID)
	})
	if errors.Is(err, errLinkTaken) {
		return nil, linkInvalid()
	}
	if err != nil {
		return nil, err
	}
	client := reqctx.ClientFrom(ctx)
	slog.Info("password reset", "user", userID, "link", l.ID, "ip", client.IP)
	return loginAfterLink(h, ctx, userID, client, func(u api.CurrentUser, cookie string) api.ResetPasswordWithLinkResponseObject {
		return api.ResetPasswordWithLink200JSONResponse{Body: u, Headers: api.ResetPasswordWithLink200ResponseHeaders{SetCookie: &cookie}}
	})
}

var errLinkTaken = errors.New("link used or revoked meanwhile")

// loginAfterLink starts a session for the user a link just served and
// answers with them and the session cookie.
func loginAfterLink[R any](h *Handlers, ctx context.Context, userID uuid.UUID, client reqctx.Client, answer func(api.CurrentUser, string) R) (R, error) {
	var zero R
	token, err := h.s.StartSession(ctx, userID, client)
	if err != nil {
		return zero, err
	}
	row, err := h.s.q.GetUserByID(ctx, userID)
	if err != nil {
		return zero, err
	}
	return answer(currentUser(User(row)), h.s.Cookie(token).String()), nil
}
