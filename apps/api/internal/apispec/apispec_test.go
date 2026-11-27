package apispec

import (
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"

	"factual/apps/api/internal/shared/roles"
)

func specWith(auth any) *openapi3.T {
	op := &openapi3.Operation{OperationID: "op", Extensions: map[string]any{}}
	if auth != nil {
		op.Extensions["x-auth"] = auth
	}
	paths := openapi3.NewPaths()
	paths.Set("/things", &openapi3.PathItem{Get: op})
	return &openapi3.T{Paths: paths}
}

func TestOperationAccess(t *testing.T) {
	ops, err := Operations(specWith("permission:manage_users"))
	if err != nil {
		t.Fatal(err)
	}
	if ops[0].Access != Permitted || ops[0].Permission != roles.ManageUsers {
		t.Fatalf("operation = %+v", ops[0])
	}
	ops, err = Operations(specWith("authenticated"))
	if err != nil || ops[0].Access != Authenticated || ops[0].Permission != "" {
		t.Fatalf("authenticated = %+v, %v", ops, err)
	}
	for _, bad := range []any{nil, "admin", "permission:everything", "permission:", 3} {
		if _, err := Operations(specWith(bad)); err == nil {
			t.Errorf("x-auth %v was accepted", bad)
		} else if bad == "permission:everything" && !strings.Contains(err.Error(), "unknown permission") {
			t.Errorf("x-auth %v: %v", bad, err)
		}
	}
}
