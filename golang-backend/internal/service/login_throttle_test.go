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
	now = now.Add(16 * time.Minute)
	_ = th.Prune(context.Background())
	if len(store.m) != 0 {
		t.Fatalf("old failures should be pruned, %d keys left", len(store.m))
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
