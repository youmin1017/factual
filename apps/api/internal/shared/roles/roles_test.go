package roles

import (
	"slices"
	"testing"
)

func TestRolesGrantTheirPermissions(t *testing.T) {
	for _, p := range All {
		if !Admin.Can(p) {
			t.Errorf("admin cannot %s", p)
		}
		if Member.Can(p) {
			t.Errorf("member can %s", p)
		}
	}
	if !slices.Equal(Admin.Permissions(), All) || len(Member.Permissions()) != 0 {
		t.Fatalf("admin %v, member %v", Admin.Permissions(), Member.Permissions())
	}
	if Role("owner").Can(ManageUsers) || Valid("owner") || !Valid(Member) {
		t.Fatal("an unknown role grants something or is valid")
	}
	if !Known(Invite) || Known("everything") {
		t.Fatal("Known")
	}
}
