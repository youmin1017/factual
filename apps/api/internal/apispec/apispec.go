// Package apispec reads the API operations and their access rules from the
// OpenAPI spec. The server uses it for the per-operation access check.
package apispec

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

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
	// Budget is the permission the caller's role in the budget of the path
	// must grant, from `x-budget: read | write | manage`; "" for operations
	// outside a budget.
	Budget string
}

// BudgetParam is the path parameter that names the budget of an operation
// with `x-budget`.
const BudgetParam = "budgetId"

var budgetPermissions = map[string]bool{"read": true, "write": true, "manage": true}

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
			budget, err := operationBudget(op, path, access)
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
				Budget:      budget,
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

// operationBudget reads `x-budget`. Paths with a budget id must declare it,
// so that no operation inside a budget skips the membership check.
func operationBudget(op *openapi3.Operation, path string, access Access) (string, error) {
	inBudget := strings.Contains(path, "{"+BudgetParam+"}")
	v, ok := op.Extensions["x-budget"]
	if !ok {
		if inBudget {
			return "", errors.New("has {budgetId} in its path but declares no x-budget")
		}
		return "", nil
	}
	p, _ := v.(string)
	switch {
	case !budgetPermissions[p]:
		return "", fmt.Errorf("x-budget must be read, write or manage, got %v", v)
	case !inBudget:
		return "", errors.New("declares x-budget but has no {budgetId} in its path")
	case access != Authenticated:
		return "", errors.New("x-budget needs x-auth: authenticated")
	}
	return p, nil
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
