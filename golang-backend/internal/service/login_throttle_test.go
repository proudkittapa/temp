package service

import (
	"testing"
	"time"
)

func TestLoginThrottleLocksAnAccountAfterFiveFailures(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	th := NewLoginThrottle()
	th.now = func() time.Time { return now }

	for i := 0; i < 5; i++ {
		if w := th.RetryAfter("081-234-5678", "1.1.1.1"); w != 0 {
			t.Fatalf("attempt %d blocked early (%v)", i+1, w)
		}
		th.Failed("081-234-5678", "1.1.1.1")
	}
	// The same account in another format, from another IP, is still locked.
	if w := th.RetryAfter("+66812345678", "2.2.2.2"); w <= 0 {
		t.Fatal("6th attempt on the same account should be blocked")
	}
	// Other accounts from a different IP are unaffected.
	if w := th.RetryAfter("0899999999", "2.2.2.2"); w != 0 {
		t.Fatalf("an unrelated account was blocked (%v)", w)
	}
	// The lock lifts once the window has passed.
	now = now.Add(15 * time.Minute)
	if w := th.RetryAfter("0812345678", "1.1.1.1"); w != 0 {
		t.Fatalf("still blocked after the window (%v)", w)
	}
}

func TestLoginThrottleSuccessClearsTheAccount(t *testing.T) {
	th := NewLoginThrottle()
	for i := 0; i < 4; i++ {
		th.Failed("a@x.com", "1.1.1.1")
	}
	th.Succeeded("A@X.com")
	th.Failed("a@x.com", "1.1.1.1")
	if w := th.RetryAfter("a@x.com", "9.9.9.9"); w != 0 {
		t.Fatalf("a correct password should reset the account's failures (%v)", w)
	}
}

func TestLoginThrottlePerIPLimit(t *testing.T) {
	th := NewLoginThrottle()
	for i := 0; i < 50; i++ {
		th.Failed("08000000"+string(rune('0'+i%10))+string(rune('0'+i/10)), "6.6.6.6")
	}
	if w := th.RetryAfter("0811111111", "6.6.6.6"); w <= 0 {
		t.Fatal("an IP spraying many accounts should be blocked")
	}
}
