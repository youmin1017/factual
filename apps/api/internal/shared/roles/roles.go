// Package roles is the instance's roles and what each may do (ADR-131): a
// fixed map in Go, as budgets' and groups' roles are (ADR-017). Operations
// name the permission they need (`x-auth: permission:<name>`); the session
// middleware puts the caller's role in the context and the access check
// asks it.
package roles

import "slices"

// Role is a user's role on the instance.
type Role string

const (
	// Admin runs the instance: users, sign-in providers, the calendar.
	Admin Role = "admin"
	// Member uses the app.
	Member Role = "member"
)

// Permission is something an instance role may do.
type Permission string

const (
	// ManageUsers: list, disable and enable users, make reset links, approve emails.
	ManageUsers Permission = "manage_users"
	// ManageProviders: the sign-in providers (OIDC, GitHub, Discord).
	ManageProviders Permission = "manage_providers"
	// ManageHolidays: import and delete the government calendar.
	ManageHolidays Permission = "manage_holidays"
	// Invite: make links for new users to join.
	Invite Permission = "invite"
)

// All is every permission, in the order they are listed to clients.
var All = []Permission{ManageUsers, ManageProviders, ManageHolidays, Invite}

var grants = map[Role][]Permission{
	Admin:  All,
	Member: {},
}

// Valid reports whether r is a role.
func Valid(r Role) bool {
	_, ok := grants[r]
	return ok
}

// Known reports whether p is a permission.
func Known(p Permission) bool { return slices.Contains(All, p) }

// Can reports whether the role grants p.
func (r Role) Can(p Permission) bool { return slices.Contains(grants[r], p) }

// Permissions is what the role grants, in the order of All.
func (r Role) Permissions() []Permission {
	out := []Permission{}
	for _, p := range All {
		if r.Can(p) {
			out = append(out, p)
		}
	}
	return out
}
