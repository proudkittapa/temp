package service

import (
	"errors"
	"strings"
	"testing"

	"arena-backend/internal/model"
)

func TestMissingPermissions(t *testing.T) {
	hr := []model.Permission{model.PermManageStaff}
	admin := model.AllPermissions
	if got := missingPermissions(admin, hr); len(got) == 0 {
		t.Fatal("a manage_staff-only role must not be able to grant ADMIN")
	}
	if got := missingPermissions([]model.Permission{model.PermBookOnline}, hr); len(got) != 0 {
		t.Fatalf("book_online (any customer has it) must not count as outranking: %v", got)
	}
	if got := missingPermissions(hr, admin); len(got) != 0 {
		t.Fatalf("admin holds everything: %v", got)
	}
	staff := []model.Permission{model.PermBookOnline, model.PermSellRent}
	if got := missingPermissions(staff, hr); len(got) != 1 || got[0] != model.PermSellRent {
		t.Fatalf("want [sell_rent], got %v", got)
	}
}

// A role editor can't put rights into a role they don't hold themselves
// (or "manage roles" alone could grant itself everything).
func TestCheckRoleEditable(t *testing.T) {
	editor := []model.Permission{model.PermManageRoles, model.PermSellRent}
	if err := checkRoleEditable([]model.Permission{model.PermSellRent, model.PermBookOnline}, editor); err != nil {
		t.Errorf("rights the editor has: %v", err)
	}
	err := checkRoleEditable([]model.Permission{model.PermSellRent, model.PermManageStaff, model.PermViewReports}, editor)
	if !errors.Is(err, ErrForbidden) || !strings.Contains(err.Error(), "manage_staff") || !strings.Contains(err.Error(), "view_reports") {
		t.Errorf("rights the editor lacks: %v", err)
	}
	if err := checkRoleEditable(model.AllPermissions, model.AllPermissions); err != nil {
		t.Errorf("an admin edits any role: %v", err)
	}
}
