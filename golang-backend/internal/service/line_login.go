package service

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
	"github.com/golang-jwt/jwt/v5"
	"gorm.io/gorm"
)

// LINE login (owner decisions 2026-11-14, TODO.md "LINE"): customers only -
// staff keep phone + password - and a new LINE user gives their phone
// number once, since LINE doesn't share it.
//
// The flow (LINE Login v2.1, web):
//  1. Start: the browser is sent to LINE's authorize page with a signed
//     `state` (it carries the nonce, and the account to link, if any).
//  2. LINE sends the browser back to LINE_LOGIN_CALLBACK_URL (the
//     frontend's /line-callback page) with ?code&state; the page posts
//     them to Callback.
//  3. Callback trades the code for an ID token and has LINE's verify
//     endpoint check it (signature, channel, expiry, nonce), then signs
//     the customer in - or, for a LINE account not yet known, returns a
//     short-lived signup token for CompleteSignup (phone number).

var (
	ErrLineNotConfigured = errors.New("LINE login is not set up")
	ErrLineLoginFailed   = errors.New("LINE sign-in failed - please try again")
	// ErrLineStaffAccount: LINE sign-in is for customers only.
	ErrLineStaffAccount = errors.New("staff accounts sign in with phone and password")
	// ErrLineAlreadyLinked: that LINE account belongs to another member.
	ErrLineAlreadyLinked = errors.New("this LINE account is already linked to another member")
	// ErrLinePhoneTaken: a new LINE user typed a number that already has an
	// account - they sign in with its password and link LINE from there
	// (attaching LINE by phone alone would let anyone take over an account).
	ErrLinePhoneTaken = errors.New("this phone number already has an account - sign in with your password, then link LINE from your account")
)

const (
	lineStateTTL  = 10 * time.Minute
	lineSignupTTL = 15 * time.Minute
)

type LineConfig struct {
	ChannelID     string
	ChannelSecret string
	CallbackURL   string
	// BotPrompt asks the customer to add the shop's LINE account as a
	// friend while signing in ("normal" or "aggressive"); LINE only
	// delivers the shop's messages to friends. Empty = not asked.
	BotPrompt string
	AuthBase  string // https://access.line.me (tests point these elsewhere)
	APIBase   string // https://api.line.me
	HTTP      *http.Client
}

// LineConfigFromEnv reads LINE_LOGIN_CHANNEL_ID / _SECRET / _CALLBACK_URL
// (and the optional LINE_LOGIN_BOT_PROMPT); nil when LINE login is not set
// up. Secrets live in golang-backend/.env only.
func LineConfigFromEnv() (*LineConfig, error) {
	id := strings.TrimSpace(os.Getenv("LINE_LOGIN_CHANNEL_ID"))
	secret := strings.TrimSpace(os.Getenv("LINE_LOGIN_CHANNEL_SECRET"))
	callback := strings.TrimSpace(os.Getenv("LINE_LOGIN_CALLBACK_URL"))
	if id == "" && secret == "" && callback == "" {
		return nil, nil
	}
	if id == "" || secret == "" || callback == "" {
		return nil, fmt.Errorf("LINE login needs LINE_LOGIN_CHANNEL_ID, LINE_LOGIN_CHANNEL_SECRET and LINE_LOGIN_CALLBACK_URL together: %w", ErrLineNotConfigured)
	}
	if u, err := url.Parse(callback); err != nil || (u.Scheme != "https" && u.Hostname() != "localhost") {
		return nil, fmt.Errorf("LINE_LOGIN_CALLBACK_URL must be an https address (or http://localhost for testing): %w", ErrLineNotConfigured)
	}
	prompt, set := os.LookupEnv("LINE_LOGIN_BOT_PROMPT")
	if !set {
		prompt = "aggressive"
	}
	if prompt != "" && prompt != "normal" && prompt != "aggressive" {
		return nil, fmt.Errorf("LINE_LOGIN_BOT_PROMPT must be normal, aggressive or empty: %w", ErrLineNotConfigured)
	}
	cfg := &LineConfig{ChannelID: id, ChannelSecret: secret, CallbackURL: callback, BotPrompt: prompt,
		AuthBase: "https://access.line.me", APIBase: "https://api.line.me", HTTP: &http.Client{Timeout: 15 * time.Second}}
	// Testing only: a stand-in for LINE (e.g. a local fake server).
	if v := strings.TrimSpace(os.Getenv("LINE_TEST_AUTH_BASE")); v != "" {
		cfg.AuthBase = strings.TrimRight(v, "/")
	}
	if v := strings.TrimSpace(os.Getenv("LINE_TEST_API_BASE")); v != "" {
		cfg.APIBase = strings.TrimRight(v, "/")
	}
	return cfg, nil
}

type LineLogin struct {
	cfg  *LineConfig
	auth *AuthService
	db   *gorm.DB
}

// NewLineLogin: cfg nil = LINE login is off (every call answers
// ErrLineNotConfigured).
func NewLineLogin(cfg *LineConfig, auth *AuthService, db *gorm.DB) *LineLogin {
	return &LineLogin{cfg: cfg, auth: auth, db: db}
}

func (l *LineLogin) Enabled() bool { return l != nil && l.cfg != nil }

type lineStateClaims struct {
	Purpose  string `json:"purpose"`
	Nonce    string `json:"nonce"`
	LinkUser string `json:"link_user,omitempty"`
	jwt.RegisteredClaims
}

type lineSignupClaims struct {
	Purpose    string `json:"purpose"`
	LineUserID string `json:"line_user_id"`
	Name       string `json:"name"`
	jwt.RegisteredClaims
}

func randomToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func (l *LineLogin) sign(claims jwt.Claims) (string, error) {
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(l.auth.jwtSecret)
}

func (l *LineLogin) parse(token string, claims jwt.Claims) error {
	_, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %w", ErrLineLoginFailed)
		}
		return l.auth.jwtSecret, nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	return err
}

// Start returns LINE's authorize URL and the state the browser keeps to
// check the callback is its own. linkUserID: the signed-in customer who is
// linking LINE to their account ("" = sign in).
func (l *LineLogin) Start(ctx context.Context, linkUserID string) (authURL, state string, err error) {
	if !l.Enabled() {
		return "", "", ErrLineNotConfigured
	}
	if linkUserID != "" {
		u, err := l.auth.usrRepo.GetByID(ctx, linkUserID)
		if err != nil {
			return "", "", err
		}
		if u.Role != model.RoleCustomer {
			return "", "", ErrLineStaffAccount
		}
	}
	nonce, err := randomToken()
	if err != nil {
		return "", "", err
	}
	now := time.Now()
	state, err = l.sign(lineStateClaims{Purpose: "line-state", Nonce: nonce, LinkUser: linkUserID,
		RegisteredClaims: jwt.RegisteredClaims{ID: ids.New("ls"), IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(lineStateTTL))}})
	if err != nil {
		return "", "", err
	}
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", l.cfg.ChannelID)
	q.Set("redirect_uri", l.cfg.CallbackURL)
	q.Set("state", state)
	q.Set("scope", "profile openid")
	q.Set("nonce", nonce)
	if l.cfg.BotPrompt != "" {
		q.Set("bot_prompt", l.cfg.BotPrompt)
	}
	return l.cfg.AuthBase + "/oauth2/v2.1/authorize?" + q.Encode(), state, nil
}

// LineResult: exactly one of Auth (signed in), Linked (LINE added to the
// signed-in account) or NeedsPhone (new LINE user - CompleteSignup).
type LineResult struct {
	Auth        *AuthResult
	Linked      *model.User
	NeedsPhone  bool
	SignupToken string
	Name        string // the LINE display name, to prefill the sign-up
}

// Callback finishes a LINE sign-in. callerUserID is the signed-in user
// sending it ("" if none); linking needs the same user that started it.
func (l *LineLogin) Callback(ctx context.Context, code, state, callerUserID string) (*LineResult, error) {
	if !l.Enabled() {
		return nil, ErrLineNotConfigured
	}
	var st lineStateClaims
	if err := l.parse(state, &st); err != nil || st.Purpose != "line-state" || st.Nonce == "" {
		return nil, fmt.Errorf("bad state: %v: %w", err, ErrLineLoginFailed)
	}
	if st.LinkUser != "" && st.LinkUser != callerUserID {
		return nil, fmt.Errorf("link started by another account: %w", ErrLineLoginFailed)
	}
	idToken, err := l.exchangeCode(ctx, code)
	if err != nil {
		return nil, err
	}
	sub, name, err := l.verifyIDToken(ctx, idToken, st.Nonce)
	if err != nil {
		return nil, err
	}

	if st.LinkUser != "" {
		u, err := l.link(ctx, st.LinkUser, sub)
		if err != nil {
			return nil, err
		}
		return &LineResult{Linked: u}, nil
	}

	var found []model.User
	if err := l.db.WithContext(ctx).Where("line_user_id = ?", sub).Limit(1).Find(&found).Error; err != nil {
		return nil, err
	}
	if len(found) == 0 {
		now := time.Now()
		token, err := l.sign(lineSignupClaims{Purpose: "line-signup", LineUserID: sub, Name: name,
			RegisteredClaims: jwt.RegisteredClaims{IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(lineSignupTTL))}})
		if err != nil {
			return nil, err
		}
		return &LineResult{NeedsPhone: true, SignupToken: token, Name: name}, nil
	}
	user := &found[0]
	if user.Role != model.RoleCustomer {
		return nil, ErrLineStaffAccount
	}
	if !user.IsActive {
		return nil, ErrAccountSuspended
	}
	tok, err := l.auth.generateToken(user.ID, string(user.Role), 48*time.Hour)
	if err != nil {
		return nil, err
	}
	l.audit(ctx, user, "LINE_LOGIN")
	return &LineResult{Auth: &AuthResult{Token: tok, User: user}}, nil
}

// CompleteSignup creates the customer account for a new LINE user, with
// the phone number they typed (required, owner decision).
func (l *LineLogin) CompleteSignup(ctx context.Context, signupToken, name, phone, clientIP string) (*AuthResult, error) {
	if !l.Enabled() {
		return nil, ErrLineNotConfigured
	}
	var sc lineSignupClaims
	if err := l.parse(signupToken, &sc); err != nil || sc.Purpose != "line-signup" || sc.LineUserID == "" {
		return nil, fmt.Errorf("bad signup token: %v: %w", err, ErrLineLoginFailed)
	}
	wait, err := l.auth.throttle.BeginSignup(ctx, clientIP)
	if err != nil {
		return nil, err
	}
	if wait > 0 {
		return nil, &TooManySignupsError{RetryAfter: wait}
	}
	phone = repository.NormalizePhone(phone)
	name = strings.TrimSpace(name)
	if name == "" {
		name = strings.TrimSpace(sc.Name)
	}
	switch {
	case len(phone) < 9:
		return nil, ErrInvalidPhone
	case len(phone) > 15:
		return nil, fmt.Errorf("%w: phone number is too long", ErrInvalidRegistration)
	case name == "" || utf8.RuneCountInString(name) > 100:
		return nil, fmt.Errorf("%w: name is required (max 100 characters)", ErrInvalidRegistration)
	}
	existing, err := l.auth.usrRepo.FindByIdentity(ctx, phone)
	if err != nil {
		return nil, err
	}
	if len(existing) > 0 {
		return nil, ErrLinePhoneTaken
	}
	lineID := sc.LineUserID
	now := time.Now()
	user := model.User{
		ID: ids.New("u"), Name: name, Phone: phone, LineUserID: &lineID,
		Role: model.RoleCustomer, MemberType: model.MemberNormal, IsActive: true,
		// No password: this account signs in with LINE (the counter can
		// set one later). An empty hash never matches a password.
		PasswordHash: "", CreatedAt: now, UpdatedAt: now,
	}
	if err := l.auth.usrRepo.Create(ctx, &user); err != nil {
		if repository.IsUniqueViolation(err) {
			// The phone was taken meanwhile, or this LINE account was
			// just registered (a second tap).
			var other []model.User
			if e := l.db.WithContext(ctx).Where("line_user_id = ?", lineID).Limit(1).Find(&other).Error; e == nil && len(other) > 0 {
				return nil, ErrLineAlreadyLinked
			}
			return nil, ErrLinePhoneTaken
		}
		return nil, err
	}
	l.audit(ctx, &user, "USER_REGISTERED_LINE")
	tok, err := l.auth.generateToken(user.ID, string(user.Role), 48*time.Hour)
	if err != nil {
		return nil, err
	}
	return &AuthResult{Token: tok, User: &user}, nil
}

// link attaches a LINE account to a signed-in customer.
func (l *LineLogin) link(ctx context.Context, userID, sub string) (*model.User, error) {
	var other []model.User
	if err := l.db.WithContext(ctx).Where("line_user_id = ? AND id <> ?", sub, userID).Limit(1).Find(&other).Error; err != nil {
		return nil, err
	}
	if len(other) > 0 {
		return nil, ErrLineAlreadyLinked
	}
	u, err := l.auth.usrRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if u.Role != model.RoleCustomer {
		return nil, ErrLineStaffAccount
	}
	res := l.db.WithContext(ctx).Model(&model.User{}).Where("id = ?", userID).
		Updates(map[string]any{"line_user_id": sub, "updated_at": time.Now()})
	if res.Error != nil {
		if repository.IsUniqueViolation(res.Error) {
			return nil, ErrLineAlreadyLinked
		}
		return nil, res.Error
	}
	u.LineUserID = &sub
	l.audit(ctx, u, "LINE_LINKED")
	return u, nil
}

func (l *LineLogin) audit(ctx context.Context, u *model.User, action string) {
	_ = l.auth.auditRepo.LogAction(ctx, &model.AuditLog{
		ID: ids.New("log"), UserID: u.ID, UserName: u.Name, Action: action,
		TargetType: "User", TargetID: u.ID, CreatedAt: time.Now(),
	})
}

// lineError reads LINE's error body for the log (never shown to a user).
func lineError(resp *http.Response) string {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return fmt.Sprintf("HTTP %d %s", resp.StatusCode, strings.TrimSpace(string(b)))
}

func (l *LineLogin) postForm(ctx context.Context, path string, form url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, l.cfg.APIBase+path, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := l.cfg.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("LINE %s unreachable: %v: %w", path, err, ErrLineLoginFailed)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("LINE %s: %s: %w", path, lineError(resp), ErrLineLoginFailed)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out); err != nil {
		return fmt.Errorf("LINE %s: bad response: %v: %w", path, err, ErrLineLoginFailed)
	}
	return nil
}

func (l *LineLogin) exchangeCode(ctx context.Context, code string) (string, error) {
	if code == "" || len(code) > 512 {
		return "", fmt.Errorf("missing code: %w", ErrLineLoginFailed)
	}
	var tok struct {
		IDToken string `json:"id_token"`
	}
	err := l.postForm(ctx, "/oauth2/v2.1/token", url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {l.cfg.CallbackURL},
		"client_id": {l.cfg.ChannelID}, "client_secret": {l.cfg.ChannelSecret},
	}, &tok)
	if err != nil {
		return "", err
	}
	if tok.IDToken == "" {
		return "", fmt.Errorf("no id_token (is the openid scope enabled?): %w", ErrLineLoginFailed)
	}
	return tok.IDToken, nil
}

// verifyIDToken has LINE check the ID token (signature, channel, expiry,
// nonce) and returns the LINE user ID and display name.
func (l *LineLogin) verifyIDToken(ctx context.Context, idToken, nonce string) (sub, name string, err error) {
	var claims struct {
		Sub   string `json:"sub"`
		Aud   string `json:"aud"`
		Name  string `json:"name"`
		Nonce string `json:"nonce"`
	}
	if err := l.postForm(ctx, "/oauth2/v2.1/verify", url.Values{
		"id_token": {idToken}, "client_id": {l.cfg.ChannelID}, "nonce": {nonce},
	}, &claims); err != nil {
		return "", "", err
	}
	// The endpoint has checked the channel and nonce we sent; a different
	// value in its answer is refused too.
	if claims.Sub == "" || (claims.Aud != "" && claims.Aud != l.cfg.ChannelID) || (claims.Nonce != "" && claims.Nonce != nonce) {
		return "", "", fmt.Errorf("ID token claims don't match: %w", ErrLineLoginFailed)
	}
	return claims.Sub, claims.Name, nil
}
