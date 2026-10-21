package service

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testThrottle(now *time.Time) *LoginThrottle {
	th := newLoginThrottle(newMemAttemptStore())
	th.now = func() time.Time { return *now }
	return th
}

func wait(t *testing.T, th *LoginThrottle, identity, ip string) time.Duration {
	t.Helper()
	w, err := th.RetryAfter(context.Background(), identity, ip)
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func fail(th *LoginThrottle, identity, ip string, n int) {
	for i := 0; i < n; i++ {
		_ = th.Failed(context.Background(), identity, ip)
	}
}

func TestLoginThrottleLocksAnAccountFromTheGuessingIP(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	th := testThrottle(&now)

	fail(th, "081-234-5678", "1.1.1.1", 4)
	if w := wait(t, th, "0812345678", "1.1.1.1"); w != 0 {
		t.Fatalf("blocked after 4 failures (%v)", w)
	}
	fail(th, "081-234-5678", "1.1.1.1", 1)
	// The same account in another format, from the guessing IP: locked.
	if w := wait(t, th, "+66812345678", "1.1.1.1"); w <= 0 {
		t.Fatal("6th attempt from the guessing IP should be blocked")
	}
	// The owner on another network can still log in.
	if w := wait(t, th, "0812345678", "9.9.9.9"); w != 0 {
		t.Fatalf("the account was locked for everyone after only 5 failures (%v)", w)
	}
	// The lock lifts once the window has passed.
	now = now.Add(15 * time.Minute)
	if w := wait(t, th, "0812345678", "1.1.1.1"); w != 0 {
		t.Fatalf("still blocked after the window (%v)", w)
	}
}

func TestLoginThrottleLocksAnAccountUnderDistributedGuessing(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	th := testThrottle(&now)
	for i := 0; i < 20; i++ {
		fail(th, "a@x.com", "10.0.0."+string(rune('a'+i)), 1)
	}
	if w := wait(t, th, "A@X.com", "8.8.8.8"); w <= 0 {
		t.Fatal("20 failures from many IPs should lock the account everywhere")
	}
}

func TestLoginThrottlePerIPLimit(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	th := testThrottle(&now)
	for i := 0; i < 50; i++ {
		fail(th, "08000000"+string(rune('0'+i%10))+string(rune('0'+i/10)), "6.6.6.6", 1)
	}
	if w := wait(t, th, "0811111111", "6.6.6.6"); w <= 0 {
		t.Fatal("an IP spraying many accounts should be blocked")
	}
}

func TestLoginThrottleSuccessClearsTheAccount(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	th := testThrottle(&now)
	fail(th, "a@x.com", "1.1.1.1", 4)
	_ = th.Succeeded(context.Background(), "A@X.com", "1.1.1.1")
	fail(th, "a@x.com", "1.1.1.1", 1)
	if w := wait(t, th, "a@x.com", "1.1.1.1"); w != 0 {
		t.Fatalf("a correct password should reset the account's failures (%v)", w)
	}
}

func TestLoginThrottlePrune(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	store := newMemAttemptStore()
	th := newLoginThrottle(store)
	th.now = func() time.Time { return now }
	fail(th, "a@x.com", "1.1.1.1", 3)
	// Kept for the longest window (the sign-up hour); logins only look
	// back 15 minutes, so the rows no longer count against the account.
	now = now.Add(16 * time.Minute)
	if w := wait(t, th, "a@x.com", "1.1.1.1"); w != 0 {
		t.Fatalf("failures older than the login window still count (%v)", w)
	}
	now = now.Add(45 * time.Minute)
	_ = th.Prune(context.Background())
	if len(store.m) != 0 {
		t.Fatalf("old failures should be pruned, %d keys left", len(store.m))
	}
}

func TestSignupLimitPerIP(t *testing.T) {
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	th := testThrottle(&now)
	ctx := context.Background()
	for i := 1; i <= maxSignupsPerIP; i++ {
		now = now.Add(time.Minute)
		if w, err := th.BeginSignup(ctx, "2.2.2.2"); err != nil || w != 0 {
			t.Fatalf("sign-up %d refused (%v, %v)", i, w, err)
		}
	}
	now = now.Add(time.Minute)
	w, _ := th.BeginSignup(ctx, "2.2.2.2")
	if w <= 0 || w > signupWindow {
		t.Fatalf("sign-up %d allowed or wrong wait (%v)", maxSignupsPerIP+1, w)
	}
	// Another network is unaffected, and the refused attempt isn't stored.
	if w, _ := th.BeginSignup(ctx, "3.3.3.3"); w != 0 {
		t.Fatalf("other IP limited (%v)", w)
	}
	if n, _ := th.store.since(ctx, hashKey("signup", "2.2.2.2"), now.Add(-2*signupWindow)); len(n) != maxSignupsPerIP {
		t.Fatalf("%d sign-ups stored, want %d", len(n), maxSignupsPerIP)
	}
	// An hour after the first ones, room again.
	now = now.Add(signupWindow)
	if w, _ := th.BeginSignup(ctx, "2.2.2.2"); w != 0 {
		t.Fatalf("still limited after the window (%v)", w)
	}
}

// A burst of simultaneous wrong guesses: each attempt is recorded before
// its password is checked, so only the first five get a try.
func TestLoginThrottleBurstOnlyLetsFiveThrough(t *testing.T) {
	th := newLoginThrottle(newMemAttemptStore())
	base := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	n := 0
	th.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		n++
		return base.Add(time.Duration(n) * time.Millisecond)
	}
	var wg sync.WaitGroup
	var allowed int32
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w, done, err := th.Begin(context.Background(), "0845678901", "1.2.3.4")
			if err != nil {
				t.Error(err)
				return
			}
			if w == 0 {
				atomic.AddInt32(&allowed, 1)
				_ = done(false)
			}
		}()
	}
	wg.Wait()
	if allowed > 5 {
		t.Fatalf("%d guesses got through, want at most 5", allowed)
	}
	// A correct password after the lock is still refused until the window passes.
	if w, _, _ := th.Begin(context.Background(), "0845678901", "1.2.3.4"); w == 0 {
		t.Fatal("locked account accepted another attempt")
	}
}

func TestLoginThrottleAccountKeySharedByPhoneAndEmail(t *testing.T) {
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	th := testThrottle(&now)
	ctx := context.Background()
	acct := AccountKeyForUser("u-1")
	// Login keys every failure on one account - typed as its phone or its
	// email, from any IP - with this key, so they add up to the 20 allowed.
	for i := 0; i < 20; i++ {
		ip := "10.0.0." + string(rune('a'+i))
		w, done, err := th.BeginAccount(ctx, acct, ip)
		if err != nil || w != 0 {
			t.Fatalf("attempt %d refused early (%v, %v)", i+1, w, err)
		}
		_ = done(false)
	}
	if w, _, _ := th.BeginAccount(ctx, acct, "10.9.9.9"); w == 0 {
		t.Fatal("21st attempt on the account was allowed")
	}
	// Another account is unaffected.
	if w, _, _ := th.BeginAccount(ctx, AccountKeyForUser("u-2"), "10.9.9.9"); w != 0 {
		t.Fatalf("other account blocked (%v)", w)
	}
}

// A store that, like Postgres, keeps only microseconds.
type microStore struct{ *memAttemptStore }

func (m microStore) record(ctx context.Context, keys []string, at time.Time) error {
	return m.memAttemptStore.record(ctx, keys, at.Truncate(time.Microsecond))
}

func TestLoginThrottleWithMicrosecondStore(t *testing.T) {
	now := time.Date(2026, 10, 21, 12, 0, 0, 123456789, time.UTC) // has nanoseconds
	th := newLoginThrottle(microStore{newMemAttemptStore()})
	th.now = func() time.Time { return now }
	ctx := context.Background()
	for i := 1; i <= 5; i++ {
		now = now.Add(time.Second + 7) // keep the nanoseconds
		w, done, err := th.BeginAccount(ctx, "0812345678", "1.1.1.1")
		if err != nil || w != 0 {
			t.Fatalf("attempt %d refused (%v, %v) - the limit is 5", i, w, err)
		}
		_ = done(false)
	}
	now = now.Add(time.Second + 7)
	if w, _, _ := th.BeginAccount(ctx, "0812345678", "1.1.1.1"); w == 0 {
		t.Fatal("6th attempt allowed")
	}
	// The refused attempt left no rows behind.
	times, _ := th.store.since(ctx, hashKey("acct", "0812345678"), now.Add(-time.Hour))
	if len(times) != 5 {
		t.Fatalf("%d failures stored, want 5", len(times))
	}
}
