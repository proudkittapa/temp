package main

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"arena-backend/internal/repository"
	"arena-backend/internal/service"
	"golang.org/x/crypto/bcrypt"
)

// Login lockout with trusted devices (owner decision 2026-11-05). Needs
// TEST_DATABASE_URL (see concurrency_test.go).
func TestTrustedDeviceGetsPastAccountLock(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	auth := service.NewAuthService(repository.NewUserRepository(e.db), repository.NewAuditRepository(e.db),
		[]byte("test-secret"), service.NewLoginThrottle(e.db), e.db)
	n := nextSeq()
	phone := fmt.Sprintf("0897%06d", n)
	other := fmt.Sprintf("0896%06d", n)
	reg, err := auth.Register(ctx, "Staff Device", "", phone, "right-pass", fmt.Sprintf("10.50.%d.1", n%250))
	if err != nil {
		t.Fatal(err)
	}
	if reg.DeviceToken == "" {
		t.Fatal("sign-up gave no device key")
	}
	otherReg, err := auth.Register(ctx, "Other", "", other, "other-pass", fmt.Sprintf("10.51.%d.1", n%250))
	if err != nil {
		t.Fatal(err)
	}
	// The ~45 sign-ins below each check a bcrypt hash; at the real cost that
	// is ~30 s under -race. Same passwords, cheapest cost (test data only).
	for id, pw := range map[string]string{reg.User.ID: "right-pass", otherReg.User.ID: "other-pass"} {
		h, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.MinCost)
		if err != nil {
			t.Fatal(err)
		}
		if err := e.db.Exec("UPDATE users SET password_hash = ? WHERE id = ?", string(h), id).Error; err != nil {
			t.Fatal(err)
		}
	}
	// A second browser signs in normally: it gets its own key.
	pc, err := auth.Login(ctx, phone, "right-pass", "192.168.7.7", nil)
	if err != nil || pc.DeviceToken == "" || pc.DeviceToken == reg.DeviceToken {
		t.Fatalf("login on the counter PC: %v, key %q", err, pc.DeviceToken)
	}
	// Someone who knows the number: 20 wrong passwords from 20 networks.
	for i := 0; i < 20; i++ {
		if _, err := auth.Login(ctx, phone, "guess", fmt.Sprintf("203.0.%d.%d", n%250, i+1), nil); !errors.Is(err, service.ErrInvalidCredentials) {
			t.Fatalf("guess %d: %v", i+1, err)
		}
	}
	var tooMany *service.TooManyAttemptsError
	// An unknown browser - even with the right password - waits.
	if _, err := auth.Login(ctx, phone, "right-pass", "192.168.7.8", nil); !errors.As(err, &tooMany) {
		t.Fatalf("unknown device during the lock: %v, want TooManyAttempts", err)
	}
	// Another account's key doesn't help.
	if _, err := auth.Login(ctx, phone, "right-pass", "192.168.7.8", []string{otherReg.DeviceToken}); !errors.As(err, &tooMany) {
		t.Fatalf("another account's key: %v, want TooManyAttempts", err)
	}
	// The counter PC (holding several staff keys) signs in.
	res, err := auth.Login(ctx, phone, "right-pass", "192.168.7.7", []string{otherReg.DeviceToken, pc.DeviceToken})
	if err != nil {
		t.Fatalf("trusted device during the lock: %v", err)
	}
	if res.DeviceToken != pc.DeviceToken {
		t.Errorf("trusted sign-in changed the key (%q, want the same)", res.DeviceToken)
	}
	// A wrong password from it is still just wrong.
	if _, err := auth.Login(ctx, phone, "nope", "192.168.7.7", []string{pc.DeviceToken}); !errors.Is(err, service.ErrInvalidCredentials) {
		t.Fatalf("wrong password on the trusted device: %v", err)
	}
	// A key past its expiry no longer counts. (The trusted sign-in above,
	// a right password, cleared the account's failures - as any correct
	// sign-in does - so lock it again first.)
	for i := 0; i < 20; i++ {
		_, _ = auth.Login(ctx, phone, "guess", fmt.Sprintf("198.51.%d.%d", n%250, i+1), nil)
	}
	if _, err := auth.Login(ctx, phone, "right-pass", "192.168.7.8", nil); !errors.As(err, &tooMany) {
		t.Fatalf("not locked again: %v", err)
	}
	if err := e.db.Exec("UPDATE trusted_devices SET expires_at = now() - interval '1 second' WHERE user_id = ?", reg.User.ID).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := auth.Login(ctx, phone, "right-pass", "192.168.7.7", []string{pc.DeviceToken}); !errors.As(err, &tooMany) {
		t.Fatalf("expired key during the lock: %v, want TooManyAttempts", err)
	}
	if err := auth.PruneLoginFailures(ctx); err != nil {
		t.Fatal(err)
	}
	var left int64
	e.db.Table("trusted_devices").Where("user_id = ?", reg.User.ID).Count(&left)
	if left != 0 {
		t.Errorf("%d expired devices left after pruning", left)
	}
	// Only a hash is stored.
	var stored int64
	e.db.Table("trusted_devices").Where("token_hash = ?", pc.DeviceToken).Count(&stored)
	if stored != 0 {
		t.Error("a device key is stored as it is")
	}
}
