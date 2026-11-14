package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"arena-backend/internal/model"
	"arena-backend/internal/repository"
	"arena-backend/internal/service"
)

// fakeLine stands in for LINE's token and verify endpoints. A code is
// "code-<sub>"; the verify answer echoes the nonce sent, as LINE's does
// once it has checked it against the token.
type fakeLine struct {
	mu        sync.Mutex
	tokenReqs []url.Values
	failToken bool
}

func (f *fakeLine) handler(t *testing.T, channelID, secret, callback string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth2/v2.1/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		f.tokenReqs = append(f.tokenReqs, r.PostForm)
		fail := f.failToken
		f.mu.Unlock()
		if fail || r.PostForm.Get("client_secret") != secret || r.PostForm.Get("client_id") != channelID ||
			r.PostForm.Get("redirect_uri") != callback || r.PostForm.Get("grant_type") != "authorization_code" ||
			!strings.HasPrefix(r.PostForm.Get("code"), "code-") {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "at", "id_token": "idt-" + strings.TrimPrefix(r.PostForm.Get("code"), "code-")})
	})
	mux.HandleFunc("/oauth2/v2.1/verify", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		idt := r.PostForm.Get("id_token")
		if r.PostForm.Get("client_id") != channelID || !strings.HasPrefix(idt, "idt-") {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		sub := strings.TrimPrefix(idt, "idt-")
		_ = json.NewEncoder(w).Encode(map[string]string{"iss": "https://access.line.me", "sub": sub, "aud": channelID,
			"nonce": r.PostForm.Get("nonce"), "name": "LINE " + sub})
	})
	return mux
}

func lineSetup(t *testing.T) (*service.LineLogin, *service.AuthService, *fakeLine, *raceEnv) {
	e := raceSetup(t)
	auth := service.NewAuthService(repository.NewUserRepository(e.db), repository.NewAuditRepository(e.db),
		[]byte("test-secret-test-secret-test-secret"), service.NewLoginThrottle(e.db), e.db)
	f := &fakeLine{}
	cfg := &service.LineConfig{ChannelID: "1650000000", ChannelSecret: "chan-secret", CallbackURL: "https://book.example.com/line-callback",
		BotPrompt: "aggressive", AuthBase: "https://access.line.me", HTTP: http.DefaultClient}
	srv := httptest.NewServer(f.handler(t, cfg.ChannelID, cfg.ChannelSecret, cfg.CallbackURL))
	t.Cleanup(srv.Close)
	cfg.APIBase = srv.URL
	return service.NewLineLogin(cfg, auth, e.db), auth, f, e
}

// startState runs Start and returns the state LINE would send back.
func startState(t *testing.T, l *service.LineLogin, linkUser string) string {
	t.Helper()
	u, state, err := l.Start(context.Background(), linkUser)
	if err != nil {
		t.Fatal(err)
	}
	q, err := url.Parse(u)
	if err != nil {
		t.Fatal(err)
	}
	v := q.Query()
	if !strings.HasPrefix(u, "https://access.line.me/oauth2/v2.1/authorize?") || v.Get("client_id") != "1650000000" ||
		v.Get("redirect_uri") != "https://book.example.com/line-callback" || v.Get("scope") != "profile openid" ||
		v.Get("nonce") == "" || v.Get("bot_prompt") != "aggressive" || v.Get("state") != state || v.Get("response_type") != "code" {
		t.Fatalf("authorize URL: %s", u)
	}
	return state
}

func TestLineLoginNewCustomerThenReturning(t *testing.T) {
	l, auth, _, e := lineSetup(t)
	ctx := context.Background()
	n := nextSeq()
	sub := fmt.Sprintf("Unew%d", n)

	res, err := l.Callback(ctx, "code-"+sub, startState(t, l, ""), "")
	if err != nil || !res.NeedsPhone || res.SignupToken == "" || res.Name != "LINE "+sub {
		t.Fatalf("first LINE sign-in: %+v %v", res, err)
	}
	// The phone number is required.
	if _, err := l.CompleteSignup(ctx, res.SignupToken, "", "12", fmt.Sprintf("10.60.%d.1", n%250)); !errors.Is(err, service.ErrInvalidPhone) {
		t.Fatalf("no phone: %v", err)
	}
	phone := fmt.Sprintf("0881%06d", n)
	acc, err := l.CompleteSignup(ctx, res.SignupToken, "", phone, fmt.Sprintf("10.60.%d.2", n%250))
	if err != nil || acc.Token == "" || acc.User.Role != model.RoleCustomer || acc.User.Name != "LINE "+sub ||
		acc.User.LineUserID == nil || *acc.User.LineUserID != sub || acc.User.Phone != phone {
		t.Fatalf("complete sign-up: %+v %v", acc, err)
	}
	// No password was set: phone + any password must not sign in.
	if _, err := auth.Login(ctx, phone, "", fmt.Sprintf("10.61.%d.1", n%250), nil); err == nil {
		t.Fatal("a LINE-only account signed in with an empty password")
	}
	// The same LINE account again: signed straight in, same member.
	again, err := l.Callback(ctx, "code-"+sub, startState(t, l, ""), "")
	if err != nil || again.Auth == nil || again.Auth.User.ID != acc.User.ID {
		t.Fatalf("returning LINE sign-in: %+v %v", again, err)
	}
	// The sign-up token can't make a second account.
	if _, err := l.CompleteSignup(ctx, res.SignupToken, "", fmt.Sprintf("0882%06d", n), fmt.Sprintf("10.60.%d.3", n%250)); !errors.Is(err, service.ErrLineAlreadyLinked) {
		t.Fatalf("second account from one LINE sign-up: %v", err)
	}
	_ = e
}

func TestLineSignupCannotTakeAnExistingPhone(t *testing.T) {
	l, auth, _, _ := lineSetup(t)
	ctx := context.Background()
	n := nextSeq()
	phone := fmt.Sprintf("0883%06d", n)
	if _, err := auth.Register(ctx, "Has Password", "", phone, "secret1", fmt.Sprintf("10.62.%d.1", n%250)); err != nil {
		t.Fatal(err)
	}
	res, err := l.Callback(ctx, fmt.Sprintf("code-Utake%d", n), startState(t, l, ""), "")
	if err != nil || !res.NeedsPhone {
		t.Fatal(res, err)
	}
	if _, err := l.CompleteSignup(ctx, res.SignupToken, "Attacker", phone, fmt.Sprintf("10.62.%d.2", n%250)); !errors.Is(err, service.ErrLinePhoneTaken) {
		t.Fatalf("LINE sign-up with someone's phone: %v, want ErrLinePhoneTaken", err)
	}
}

func TestLineLinkExistingCustomer(t *testing.T) {
	l, auth, _, e := lineSetup(t)
	ctx := context.Background()
	n := nextSeq()
	me, err := auth.Register(ctx, "Member", "", fmt.Sprintf("0884%06d", n), "secret1", fmt.Sprintf("10.63.%d.1", n%250))
	if err != nil {
		t.Fatal(err)
	}
	other, err := auth.Register(ctx, "Other", "", fmt.Sprintf("0885%06d", n), "secret1", fmt.Sprintf("10.63.%d.2", n%250))
	if err != nil {
		t.Fatal(err)
	}
	sub := fmt.Sprintf("Ulink%d", n)

	// A link started by one account can't be finished by another.
	if _, err := l.Callback(ctx, "code-"+sub, startState(t, l, me.User.ID), other.User.ID); !errors.Is(err, service.ErrLineLoginFailed) {
		t.Fatalf("link finished by another account: %v", err)
	}
	res, err := l.Callback(ctx, "code-"+sub, startState(t, l, me.User.ID), me.User.ID)
	if err != nil || res.Linked == nil || res.Linked.ID != me.User.ID {
		t.Fatalf("link: %+v %v", res, err)
	}
	// Now LINE signs this member in.
	in, err := l.Callback(ctx, "code-"+sub, startState(t, l, ""), "")
	if err != nil || in.Auth == nil || in.Auth.User.ID != me.User.ID {
		t.Fatalf("LINE sign-in after linking: %+v %v", in, err)
	}
	// The same LINE account can't be linked to a second member.
	if _, err := l.Callback(ctx, "code-"+sub, startState(t, l, other.User.ID), other.User.ID); !errors.Is(err, service.ErrLineAlreadyLinked) {
		t.Fatalf("LINE account linked twice: %v", err)
	}
	// A suspended member can't sign in with LINE either.
	if err := e.db.Exec("UPDATE users SET is_active = false WHERE id = ?", me.User.ID).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := l.Callback(ctx, "code-"+sub, startState(t, l, ""), ""); !errors.Is(err, service.ErrAccountSuspended) {
		t.Fatalf("suspended LINE sign-in: %v", err)
	}
}

func TestLineLoginIsCustomersOnly(t *testing.T) {
	l, auth, _, e := lineSetup(t)
	ctx := context.Background()
	n := nextSeq()
	staff, err := auth.Register(ctx, "Staff", "", fmt.Sprintf("0886%06d", n), "secret1", fmt.Sprintf("10.64.%d.1", n%250))
	if err != nil {
		t.Fatal(err)
	}
	sub := fmt.Sprintf("Ustaff%d", n)
	if err := e.db.Exec("UPDATE users SET role = ?, line_user_id = ? WHERE id = ?", model.RoleStaff, sub, staff.User.ID).Error; err != nil {
		t.Fatal(err)
	}
	if _, _, err := l.Start(ctx, staff.User.ID); !errors.Is(err, service.ErrLineStaffAccount) {
		t.Fatalf("staff starting a LINE link: %v", err)
	}
	if _, err := l.Callback(ctx, "code-"+sub, startState(t, l, ""), ""); !errors.Is(err, service.ErrLineStaffAccount) {
		t.Fatalf("staff signing in with LINE: %v", err)
	}
}

func TestLineLoginRefusesBadStateAndLineErrors(t *testing.T) {
	l, _, f, _ := lineSetup(t)
	ctx := context.Background()
	state := startState(t, l, "")
	for name, s := range map[string]string{"tampered": state[:len(state)-2] + "xx", "empty": "", "not a token": "abc"} {
		if _, err := l.Callback(ctx, "code-Ux", s, ""); !errors.Is(err, service.ErrLineLoginFailed) {
			t.Fatalf("%s state: %v", name, err)
		}
	}
	f.mu.Lock()
	f.failToken = true
	f.mu.Unlock()
	if _, err := l.Callback(ctx, "code-Ux", state, ""); !errors.Is(err, service.ErrLineLoginFailed) {
		t.Fatalf("LINE refused the code: %v", err)
	}
	if _, err := l.CompleteSignup(ctx, "forged", "x", "0899999999", "10.65.0.1"); !errors.Is(err, service.ErrLineLoginFailed) {
		t.Fatalf("forged sign-up token: %v", err)
	}
	off := service.NewLineLogin(nil, nil, nil)
	if _, _, err := off.Start(ctx, ""); !errors.Is(err, service.ErrLineNotConfigured) {
		t.Fatalf("not configured: %v", err)
	}
}
