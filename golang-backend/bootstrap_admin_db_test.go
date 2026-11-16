package main

import (
	"context"
	"testing"

	"arena-backend/internal/model"
)

// BOOTSTRAP_ADMIN_PHONE promotes only while there is no admin at all.
func TestBootstrapAdminOnlyWithoutAnAdmin(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	// Start from "no admin" (other tests' admins are put back afterwards).
	var admins []string
	e.db.Model(&model.User{}).Where("role = ?", model.RoleAdmin).Pluck("id", &admins)
	if len(admins) > 0 {
		e.db.Model(&model.User{}).Where("id IN ?", admins).Update("role", model.RoleManager)
		t.Cleanup(func() { e.db.Model(&model.User{}).Where("id IN ?", admins).Update("role", model.RoleAdmin) })
	}
	owner := e.newCustomer(t, 0)
	other := e.newCustomer(t, 0)
	t.Cleanup(func() { e.db.Model(&model.User{}).Where("id = ?", owner.ID).Update("role", model.RoleCustomer) })

	t.Setenv("BOOTSTRAP_ADMIN_PHONE", owner.Phone)
	if err := bootstrapAdmin(ctx, e.db); err != nil {
		t.Fatal(err)
	}
	var got model.User
	e.db.First(&got, "id = ?", owner.ID)
	if got.Role != model.RoleAdmin {
		t.Fatalf("owner's role %s, want ADMIN", got.Role)
	}
	// Now there is an admin: pointing the setting at someone else does nothing.
	t.Setenv("BOOTSTRAP_ADMIN_PHONE", other.Phone)
	if err := bootstrapAdmin(ctx, e.db); err != nil {
		t.Fatal(err)
	}
	var second model.User
	e.db.First(&second, "id = ?", other.ID)
	if second.Role != model.RoleCustomer {
		t.Fatalf("second account became %s with an admin already there", second.Role)
	}
}
