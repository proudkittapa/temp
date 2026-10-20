package service

import (
	"strings"
	"sync"
	"time"

	"arena-backend/internal/repository"
)

// LoginThrottle limits failed logins, per account and per client IP, within
// a sliding window - without it a 6-character password could be guessed by
// brute force. State is in memory, so it is per server process and resets
// on restart; that is enough for one backend instance.
//
// A locked identity cannot log in until the window passes even with the
// right password; that is the usual trade-off (someone can lock a known
// phone number for 15 minutes) in exchange for stopping password guessing.
type LoginThrottle struct {
	mu             sync.Mutex
	failures       map[string][]time.Time
	window         time.Duration
	maxPerIdentity int
	maxPerIP       int
	now            func() time.Time
}

func NewLoginThrottle() *LoginThrottle {
	return &LoginThrottle{
		failures:       map[string][]time.Time{},
		window:         15 * time.Minute,
		maxPerIdentity: 5,
		// Generous, because many customers can share one IP (mobile
		// carrier NAT, the venue's Wi-Fi).
		maxPerIP: 50,
		now:      time.Now,
	}
}

// identityKey makes "081-234-5678" and "0812345678", or "A@x.com" and
// "a@x.com", count as the same account.
func identityKey(identity string) string {
	identity = strings.TrimSpace(identity)
	if strings.Contains(identity, "@") {
		return "id:" + strings.ToLower(identity)
	}
	if p := repository.NormalizePhone(identity); p != "" {
		return "id:" + p
	}
	return "id:" + identity
}

// recent returns key's failures still inside the window (and forgets older ones).
func (t *LoginThrottle) recent(key string, now time.Time) []time.Time {
	list := t.failures[key]
	cut := 0
	for cut < len(list) && now.Sub(list[cut]) >= t.window {
		cut++
	}
	list = list[cut:]
	if len(list) == 0 {
		delete(t.failures, key)
	} else {
		t.failures[key] = list
	}
	return list
}

// RetryAfter reports how long until another attempt is allowed for this
// identity/IP pair; zero means it may proceed now.
func (t *LoginThrottle) RetryAfter(identity, ip string) time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	wait := time.Duration(0)
	for key, max := range map[string]int{identityKey(identity): t.maxPerIdentity, "ip:" + ip: t.maxPerIP} {
		if list := t.recent(key, now); len(list) >= max {
			if w := list[len(list)-max].Add(t.window).Sub(now); w > wait {
				wait = w
			}
		}
	}
	return wait
}

// Failed records a failed attempt.
func (t *LoginThrottle) Failed(identity, ip string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	for _, key := range []string{identityKey(identity), "ip:" + ip} {
		t.failures[key] = append(t.recent(key, now), now)
	}
	// Bound memory under a spray of random identities.
	if len(t.failures) > 10000 {
		for key := range t.failures {
			t.recent(key, now)
		}
	}
}

// Succeeded clears the identity's failures after a correct password.
func (t *LoginThrottle) Succeeded(identity string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.failures, identityKey(identity))
}
