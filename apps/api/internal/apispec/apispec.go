// Package apispec reads the API operations and their access rules from the
// OpenAPI spec. The server uses it for the per-operation access check.
package apispec

import (
	"errors"
	"fmt"
	"regexp"
	"sort"

	"github.com/getkin/kin-openapi/openapi3"
)

// BaseURL prefixes every API route; it matches `servers` in openapi.yaml.
const BaseURL = "/api"

// Access says who may call an operation, from its `x-auth` extension.
type Access string

const (
	// Public operations need no session.
	Public Access = "public"
	// Authenticated operations need any logged-in user.
	Authenticated Access = "authenticated"
	// Admin operations need the instance admin.
	Admin Access = "admin"
)

// Operation is one API operation.
type Operation struct {
	Method string
	// Route is the echo path, e.g. /api/oidc-providers/:id.
	Route       string
	OperationID string
	Summary     string
	Access      Access
}

var pathParam = regexp.MustCompile(`\{([^}]+)\}`)

// Operations lists every operation in spec, sorted by route and method.
// Every operation must declare `x-auth`, so a forgotten declaration fails at
// startup instead of silently exposing or blocking an endpoint.
func Operations(spec *openapi3.T) ([]Operation, error) {
	var ops []Operation
	var errs []error
	for path, item := range spec.Paths.Map() {
		for method, op := range item.Operations() {
			access, err := operationAccess(op)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s %s: %w", method, path, err))
				continue
			}
			ops = append(ops, Operation{
				Method:      method,
				Route:       BaseURL + pathParam.ReplaceAllString(path, ":$1"),
				OperationID: op.OperationID,
				Summary:     op.Summary,
				Access:      access,
			})
		}
	}
	sort.Slice(ops, func(i, j int) bool {
		if ops[i].Route != ops[j].Route {
			return ops[i].Route < ops[j].Route
		}
		return ops[i].Method < ops[j].Method
	})
	return ops, errors.Join(errs...)
}

func operationAccess(op *openapi3.Operation) (Access, error) {
	v, ok := op.Extensions["x-auth"]
	if !ok {
		return "", errors.New("declares no x-auth")
	}
	switch v {
	case string(Public):
		return Public, nil
	case string(Authenticated):
		return Authenticated, nil
	case string(Admin):
		return Admin, nil
	}
	return "", fmt.Errorf("x-auth must be public, authenticated or admin, got %v", v)
}
