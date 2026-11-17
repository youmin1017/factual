// Package reqctx carries what the server learns about a request (the caller,
// the client, the session token and the OIDC flow cookie) to the domains
// through the context. The server's session middleware sets them; domains
// only read them.
package reqctx

import (
	"context"

	"github.com/google/uuid"
)

// Principal is the authenticated caller.
type Principal struct {
	UserID      uuid.UUID
	Username    string
	DisplayName string
	// IsAdmin is the instance admin flag (`x-auth: admin` operations).
	IsAdmin bool
}

// Client describes where a request comes from; stored with sessions.
type Client struct {
	IP        string
	UserAgent string
}

type key int

const (
	principalKey key = iota
	clientKey
	tokenKey
	flowKey
)

// WithPrincipal records the authenticated caller.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey, p)
}

// PrincipalFrom returns the authenticated caller, if any.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey).(Principal)
	return p, ok
}

// Caller is the authenticated caller of an operation that needs a session;
// the access check guarantees one (the zero Principal otherwise).
func Caller(ctx context.Context) Principal {
	p, _ := PrincipalFrom(ctx)
	return p
}

// WithClient records the client's address and user agent.
func WithClient(ctx context.Context, c Client) context.Context {
	return context.WithValue(ctx, clientKey, c)
}

// ClientFrom returns the client's address and user agent.
func ClientFrom(ctx context.Context) Client {
	c, _ := ctx.Value(clientKey).(Client)
	return c
}

// WithToken records the session cookie's token.
func WithToken(ctx context.Context, token string) context.Context {
	return context.WithValue(ctx, tokenKey, token)
}

// TokenFrom returns the session cookie's token ("" without one).
func TokenFrom(ctx context.Context) string {
	t, _ := ctx.Value(tokenKey).(string)
	return t
}

// WithFlow records the OIDC flow cookie's value.
func WithFlow(ctx context.Context, flow string) context.Context {
	return context.WithValue(ctx, flowKey, flow)
}

// FlowFrom returns the OIDC flow cookie's value ("" without one).
func FlowFrom(ctx context.Context) string {
	f, _ := ctx.Value(flowKey).(string)
	return f
}
