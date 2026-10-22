package main

import (
	"context"
	"reflect"
	"testing"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/repository"
)

// Phones stored before sign-up normalized them are rewritten at startup;
// an account whose number another account already has keeps its old
// format, is reported, and is still found until the conflict is resolved.
// Needs TEST_DATABASE_URL (see concurrency_test.go).
func TestNormalizeStoredPhones(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	repo := repository.NewUserRepository(e.db)
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	t1 := t0.Add(time.Hour)
	add := func(id, phone string, at time.Time) {
		u := model.User{ID: id, Name: id, Phone: phone, Role: model.RoleCustomer, MemberType: model.MemberNormal,
			IsActive: true, PasswordHash: "-", CreatedAt: at, UpdatedAt: at}
		if err := e.db.Create(&u).Error; err != nil {
			t.Fatal(err)
		}
	}
	ids := []string{"ph-a", "ph-b", "ph-c", "ph-d", "ph-e", "ph-f"}
	t.Cleanup(func() {
		e.db.Where("id IN ?", ids).Delete(&model.User{})
		repository.NormalizeStoredPhones(ctx, e.db) // back to the fast path for the other tests
	})
	add("ph-a", "081-555-0101", t0)
	add("ph-b", "+66 81 555 0102", t0)
	add("ph-c", "0815550103", t0)       // already canonical: keeps it
	add("ph-d", "081-555-0103", t1)     // same number as ph-c
	add("ph-e", "66815550104", t1)      // same number as ph-f, newer
	add("ph-f", "0066 81 555 0104", t0) // oldest of the two: gets it

	fixed, leftover, err := repository.NormalizeStoredPhones(ctx, e.db)
	if err != nil {
		t.Fatal(err)
	}
	if fixed != 3 {
		t.Errorf("fixed %d phones, want 3 (a, b, f)", fixed)
	}
	if want := map[string][]string{"0815550103": {"ph-d"}, "0815550104": {"ph-e"}}; !reflect.DeepEqual(leftover, want) {
		t.Errorf("leftover %v, want %v", leftover, want)
	}
	stored := map[string]string{}
	var rows []model.User
	e.db.Where("id IN ?", ids).Find(&rows)
	for _, u := range rows {
		stored[u.ID] = u.Phone
	}
	want := map[string]string{"ph-a": "0815550101", "ph-b": "0815550102", "ph-c": "0815550103",
		"ph-d": "081-555-0103", "ph-e": "66815550104", "ph-f": "0815550104"}
	if !reflect.DeepEqual(stored, want) {
		t.Errorf("stored %v, want %v", stored, want)
	}

	// The accounts left over are still found, oldest first.
	matchIDs := func(identity string) []string {
		users, err := repo.FindByIdentity(ctx, identity)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, u := range users {
			out = append(out, u.ID)
		}
		return out
	}
	if got := matchIDs("081 555 0103"); !reflect.DeepEqual(got, []string{"ph-c", "ph-d"}) {
		t.Errorf("login by 081 555 0103 finds %v", got)
	}
	if got := matchIDs("+66815550104"); !reflect.DeepEqual(got, []string{"ph-f", "ph-e"}) {
		t.Errorf("login by +66815550104 finds %v", got)
	}
	if u, _ := repo.GetByPhone(ctx, "0815550104"); u == nil || u.ID != "ph-f" {
		t.Errorf("GetByPhone 0815550104 = %v, want ph-f", u)
	}

	// Merged by hand (the older accounts removed): the next start
	// normalizes the rest, and lookups need no fallback.
	e.db.Where("id IN ?", []string{"ph-c", "ph-f"}).Delete(&model.User{})
	fixed, leftover, err = repository.NormalizeStoredPhones(ctx, e.db)
	if err != nil || fixed != 2 || len(leftover) != 0 {
		t.Fatalf("second run: fixed %d, leftover %v, err %v - want 2, none", fixed, leftover, err)
	}
	if got := matchIDs("0815550103"); !reflect.DeepEqual(got, []string{"ph-d"}) {
		t.Errorf("after the merge 0815550103 finds %v, want ph-d", got)
	}
	if u, _ := repo.GetByPhone(ctx, "+66 81 555 0104"); u == nil || u.ID != "ph-e" {
		t.Errorf("after the merge GetByPhone = %v, want ph-e", u)
	}
	if u, _ := repo.GetByPhone(ctx, "0815559999"); u != nil {
		t.Errorf("unknown number found %s", u.ID)
	}
}
