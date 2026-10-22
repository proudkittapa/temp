package service

import (
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
