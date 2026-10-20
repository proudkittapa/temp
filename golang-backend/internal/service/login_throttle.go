package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/repository"
	"gorm.io/gorm"
)

// LoginThrottle limits failed logins within a sliding 15-minute window,
// without which a 6-character password could be guessed by brute force:
//
//   - 5 failures for one account from one IP lock that account *from that
//     IP* - a guesser is stopped quickly, but a stranger on another network
//     can't lock the real owner out with five wrong guesses;
//   - 20 failures for one account from anywhere lock the account (a
//     distributed guess);
//   - 50 failures from one IP lock that IP (one source spraying accounts).
//
// Failures are stored in the database (login_failures), so the limits hold
// across restarts and across several backend instances. Keys are stored
// hashed, so the table holds no phone numbers, emails or IPs.
type LoginThrottle struct {
	store      attemptStore
	window     time.Duration
	maxPerPair int
	maxPerAcct int
	maxPerIP   int
	now        func() time.Time
}

// attemptStore keeps failure timestamps per key.
type attemptStore interface {
	record(ctx context.Context, keys []string, at time.Time) error
	since(ctx context.Context, key string, from time.Time) ([]time.Time, error) // oldest first
	clear(ctx context.Context, keys []string) error
	remove(ctx context.Context, keys []string, at time.Time) error // one attempt's rows
	prune(ctx context.Context, before time.Time) error
}

func newLoginThrottle(store attemptStore) *LoginThrottle {
	return &LoginThrottle{store: store, window: 15 * time.Minute, maxPerPair: 5, maxPerAcct: 20, maxPerIP: 50, now: time.Now}
}

// NewLoginThrottle stores failures in the database.
func NewLoginThrottle(db *gorm.DB) *LoginThrottle { return newLoginThrottle(&dbAttemptStore{db: db}) }

// identityKey makes "081-234-5678" and "+66812345678", or "A@x.com" and
// "a@x.com", count as the same account.
func identityKey(identity string) string {
	identity = strings.TrimSpace(identity)
	if strings.Contains(identity, "@") {
		return strings.ToLower(identity)
	}
	if p := repository.NormalizePhone(identity); p != "" {
		return p
	}
	return identity
}

func hashKey(kind, value string) string {
	h := sha256.Sum256([]byte(kind + ":" + value))
	return hex.EncodeToString(h[:])
}

func (t *LoginThrottle) keys(identity, ip string) (pair, acct, ipKey string) {
	return t.accountKeys(identityKey(identity), ip)
}

// accountKeys takes an account key already in canonical form (identityKey,
// or AccountKeyForUser once the identity is known to be an account).
func (t *LoginThrottle) accountKeys(account, ip string) (pair, acct, ipKey string) {
	return hashKey("pair", account+"|"+ip), hashKey("acct", account), hashKey("ip", ip)
}

// AccountKeyForUser keys the limits by the account itself, so its phone
// number and its email share one count - otherwise switching between them
// doubled the guesses allowed. ("user:" can't collide with an identityKey:
// phones are digits only and emails contain "@".)
func AccountKeyForUser(userID string) string { return "user:" + userID }

// RetryAfter reports how long until this identity/IP may try again; zero
// means now.
func (t *LoginThrottle) RetryAfter(ctx context.Context, identity, ip string) (time.Duration, error) {
	now := t.now()
	pair, acct, ipKey := t.keys(identity, ip)
	wait := time.Duration(0)
	for _, l := range []struct {
		key string
		max int
	}{{pair, t.maxPerPair}, {acct, t.maxPerAcct}, {ipKey, t.maxPerIP}} {
		times, err := t.store.since(ctx, l.key, now.Add(-t.window))
		if err != nil {
			return 0, err
		}
		if len(times) >= l.max {
			if w := times[len(times)-l.max].Add(t.window).Sub(now); w > wait {
				wait = w
			}
		}
	}
	return wait, nil
}

// Begin records this attempt as a failure *before* the password is checked,
// then counts. Checking first and recording after the slow password hash
// let a burst of simultaneous guesses all through; now each guess is
// counted before it is tried, so of a burst only the first few recorded can
// be under the limit. wait > 0: refused (and this attempt is not counted).
// Otherwise call done(true) after a correct password - it clears the
// account's failures - or done(false), which keeps the recorded failure.
func (t *LoginThrottle) Begin(ctx context.Context, identity, ip string) (time.Duration, func(ok bool) error, error) {
	return t.BeginAccount(ctx, identityKey(identity), ip)
}

// BeginAccount is Begin for a canonical account key (see accountKeys).
func (t *LoginThrottle) BeginAccount(ctx context.Context, account, ip string) (time.Duration, func(ok bool) error, error) {
	// Postgres keeps microseconds: without truncating, the stored row no
	// longer equals `now`, so this attempt was counted as a prior one (4
	// tries instead of 5) and remove() never matched refused attempts.
	now := t.now().Truncate(time.Microsecond)
	pair, acct, ipKey := t.accountKeys(account, ip)
	keys := []string{pair, acct, ipKey}
	if err := t.store.record(ctx, keys, now); err != nil {
		return 0, nil, err
	}
	wait := time.Duration(0)
	for _, l := range []struct {
		key string
		max int
	}{{pair, t.maxPerPair}, {acct, t.maxPerAcct}, {ipKey, t.maxPerIP}} {
		times, err := t.store.since(ctx, l.key, now.Add(-t.window))
		if err != nil {
			return 0, nil, err
		}
		// Other attempts than this one (which is in the list).
		prior := make([]time.Time, 0, len(times))
		skipped := false
		for _, at := range times {
			if !skipped && at.Equal(now) {
				skipped = true
				continue
			}
			prior = append(prior, at)
		}
		if len(prior) >= l.max {
			if w := prior[len(prior)-l.max].Add(t.window).Sub(now); w > wait {
				wait = w
			}
		}
	}
	if wait > 0 {
		return wait, nil, t.store.remove(ctx, keys, now)
	}
	done := func(ok bool) error {
		if !ok {
			return nil
		}
		if err := t.store.clear(ctx, []string{pair, acct}); err != nil {
			return err
		}
		return t.store.remove(ctx, []string{ipKey}, now)
	}
	return 0, done, nil
}

// Failed records a failed attempt.
func (t *LoginThrottle) Failed(ctx context.Context, identity, ip string) error {
	pair, acct, ipKey := t.keys(identity, ip)
	return t.store.record(ctx, []string{pair, acct, ipKey}, t.now())
}

// Succeeded clears the account's failures after a correct password (the
// IP's count stays, so a sprayer can't reset it with one valid account).
func (t *LoginThrottle) Succeeded(ctx context.Context, identity, ip string) error {
	pair, acct, _ := t.keys(identity, ip)
	return t.store.clear(ctx, []string{pair, acct})
}

// Prune forgets failures older than the window; main calls it every minute.
func (t *LoginThrottle) Prune(ctx context.Context) error {
	return t.store.prune(ctx, t.now().Add(-t.window))
}

// ---- database store ----

type dbAttemptStore struct{ db *gorm.DB }

func (s *dbAttemptStore) record(ctx context.Context, keys []string, at time.Time) error {
	rows := make([]model.LoginFailure, len(keys))
	for i, k := range keys {
		rows[i] = model.LoginFailure{Key: k, At: at}
	}
	return s.db.WithContext(ctx).Create(&rows).Error
}

func (s *dbAttemptStore) since(ctx context.Context, key string, from time.Time) ([]time.Time, error) {
	var times []time.Time
	err := s.db.WithContext(ctx).Model(&model.LoginFailure{}).
		Where("key = ? AND at > ?", key, from).Order("at").Pluck("at", &times).Error
	return times, err
}

func (s *dbAttemptStore) clear(ctx context.Context, keys []string) error {
	return s.db.WithContext(ctx).Where("key IN ?", keys).Delete(&model.LoginFailure{}).Error
}

func (s *dbAttemptStore) remove(ctx context.Context, keys []string, at time.Time) error {
	return s.db.WithContext(ctx).Where("key IN ? AND at = ?", keys, at).Delete(&model.LoginFailure{}).Error
}

func (s *dbAttemptStore) prune(ctx context.Context, before time.Time) error {
	return s.db.WithContext(ctx).Where("at <= ?", before).Delete(&model.LoginFailure{}).Error
}

// ---- in-memory store (tests) ----

type memAttemptStore struct {
	mu sync.Mutex
	m  map[string][]time.Time
}

func newMemAttemptStore() *memAttemptStore { return &memAttemptStore{m: map[string][]time.Time{}} }

func (s *memAttemptStore) record(_ context.Context, keys []string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, k := range keys {
		s.m[k] = append(s.m[k], at)
	}
	return nil
}

func (s *memAttemptStore) since(_ context.Context, key string, from time.Time) ([]time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []time.Time
	for _, t := range s.m[key] {
		if t.After(from) {
			out = append(out, t)
		}
	}
	return out, nil
}

func (s *memAttemptStore) clear(_ context.Context, keys []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, k := range keys {
		delete(s.m, k)
	}
	return nil
}

func (s *memAttemptStore) remove(_ context.Context, keys []string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, k := range keys {
		list := s.m[k]
		for i, t := range list {
			if t.Equal(at) {
				s.m[k] = append(list[:i:i], list[i+1:]...)
				break
			}
		}
	}
	return nil
}

func (s *memAttemptStore) prune(_ context.Context, before time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, list := range s.m {
		var keep []time.Time
		for _, t := range list {
			if t.After(before) {
				keep = append(keep, t)
			}
		}
		if len(keep) == 0 {
			delete(s.m, k)
		} else {
			s.m[k] = keep
		}
	}
	return nil
}
