package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

type AuthClaims struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
	jwt.RegisteredClaims
}

type AuthService struct {
	usrRepo   *repository.UserRepository
	auditRepo *repository.AuditRepository
	jwtSecret []byte
	throttle  *LoginThrottle
}

// NewAuthService takes the JWT signing secret explicitly (see
// resolveJWTSecret in main.go). It used to be read from JWT_SECRET in a
// package init(), which runs before main loads .env - so a secret set in
// .env was silently ignored in favour of a hard-coded, publicly committed
// default that anyone could use to sign an ADMIN token.
func NewAuthService(usrRepo *repository.UserRepository, auditRepo *repository.AuditRepository, jwtSecret []byte, throttle *LoginThrottle) *AuthService {
	if len(jwtSecret) == 0 {
		panic("auth: empty JWT secret")
	}
	s := &AuthService{
		usrRepo:   usrRepo,
		auditRepo: auditRepo,
		jwtSecret: jwtSecret,
		throttle:  throttle,
	}
	// Built now rather than on the first unknown-account login, which would
	// otherwise be measurably slower than the rest.
	compareDummy("")
	return s
}

// PruneLoginFailures forgets failed logins older than the throttle window.
func (s *AuthService) PruneLoginFailures(ctx context.Context) error {
	return s.throttle.Prune(ctx)
}

// TooManyAttemptsError is returned by Login while an account or client IP
// is locked out after repeated failed passwords.
type TooManyAttemptsError struct{ RetryAfter time.Duration }

func (e *TooManyAttemptsError) Error() string {
	return fmt.Sprintf("too many failed logins - try again in %d minutes", int(e.RetryAfter.Minutes())+1)
}

var (
	dummyHashOnce sync.Once
	dummyHash     []byte
)

// compareDummy spends the same bcrypt time as a real password check, so an
// unknown phone/email doesn't answer faster than a wrong password - which
// would reveal who is registered.
func compareDummy(password string) {
	dummyHashOnce.Do(func() {
		dummyHash, _ = bcrypt.GenerateFromPassword([]byte("not-a-real-password"), bcrypt.DefaultCost)
	})
	_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
}

var (
	ErrInvalidCredentials = errors.New("invalid login credentials")
	ErrDuplicateUser      = errors.New("this phone number or email is already registered")
	ErrInvalidPhone       = errors.New("phone number must have at least 9 digits")
	ErrAccountSuspended   = errors.New("account is suspended - please contact staff")
	// ErrInvalidRegistration: a field is malformed (bad email, too long...).
	ErrInvalidRegistration = errors.New("invalid registration details")
)

type AuthResult struct {
	Token string      `json:"token"`
	User  *model.User `json:"user"`
}

// Register verifies credentials duplicate and inserts a secured password payload
func (s *AuthService) Register(ctx context.Context, name, email, phone, password string) (*AuthResult, error) {
	// Stored digits-only, so the same number typed with or without dashes
	// or spaces is one account, and walk-in lookups by phone find it.
	phone = repository.NormalizePhone(phone)
	if len(phone) < 9 {
		return nil, ErrInvalidPhone
	}
	// Emails are stored lower-case and compared ignoring case, so
	// "John@Gmail.com" can't become a second account next to john@gmail.com.
	email = strings.ToLower(strings.TrimSpace(email))
	name = strings.TrimSpace(name)
	switch {
	case name == "" || len(name) > 100:
		return nil, fmt.Errorf("%w: name is required (max 100 characters)", ErrInvalidRegistration)
	case len(phone) > 15:
		return nil, fmt.Errorf("%w: phone number is too long", ErrInvalidRegistration)
	// Login matches email OR phone, so an "email" that is really someone
	// else's phone number would take over that number.
	case email != "" && (len(email) > 254 || !strings.Contains(email, "@") || strings.ContainsAny(email, " \t") ||
		strings.Index(email, "@") == 0 || !strings.Contains(email[strings.Index(email, "@"):], ".")):
		return nil, fmt.Errorf("%w: email address is not valid", ErrInvalidRegistration)
	// bcrypt only hashes 72 bytes and refuses longer passwords.
	case len(password) > 72:
		return nil, fmt.Errorf("%w: password must be at most 72 characters", ErrInvalidRegistration)
	}
	// The unique indexes on users.phone/email are the real guarantee; this
	// pre-check just gives a clear message in the common case.
	for _, identity := range []string{phone, email} {
		if identity == "" {
			continue
		}
		existing, err := s.usrRepo.FindByIdentity(ctx, identity)
		if err != nil {
			return nil, err
		}
		if len(existing) > 0 {
			return nil, ErrDuplicateUser
		}
	}

	hashedBytes, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	userID := ids.New("u")
	var emailVal *string
	if email != "" {
		emailVal = &email
	}

	newUser := model.User{
		ID:           userID,
		Name:         name,
		Email:        emailVal,
		Phone:        phone,
		Role:         model.RoleCustomer,
		MemberType:   model.MemberNormal,
		IsActive:     true,
		Points:       0,
		PasswordHash: string(hashedBytes),
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}

	err = s.usrRepo.Create(ctx, &newUser)
	if err != nil {
		// Only a unique-index violation means "already registered" - a lost
		// connection or another constraint must surface as a server error.
		if repository.IsUniqueViolation(err) {
			return nil, ErrDuplicateUser
		}
		return nil, err
	}

	// Dynamic admin trace logger creation for CRM tracking
	auditID := ids.New("log")
	_ = s.auditRepo.LogAction(ctx, &model.AuditLog{
		ID:         auditID,
		UserID:     "system",
		UserName:   "SYSTEM_AUTH",
		Action:     "USER_REGISTERED",
		TargetType: "User",
		TargetID:   userID,
		AfterState: model.AuditJSON(map[string]string{"id": userID, "phone": phone}),
		CreatedAt:  time.Now(),
	})

	tokenString, err := s.generateToken(userID, string(model.RoleCustomer), 24*time.Hour)
	if err != nil {
		return nil, err
	}

	return &AuthResult{
		Token: tokenString,
		User:  &newUser,
	}, nil
}

// Login checks a phone/email and password. clientIP feeds the brute-force
// throttle. Every account matching the identity is tried, because before
// phones were normalized one number could belong to two accounts (see
// UserRepository.FindByIdentity) - checking only the oldest locked the
// other account's owner out.
func (s *AuthService) Login(ctx context.Context, identity, password, clientIP string) (*AuthResult, error) {
	wait, done, err := s.throttle.Begin(ctx, identity, clientIP)
	if err != nil {
		return nil, err
	}
	if wait > 0 {
		return nil, &TooManyAttemptsError{RetryAfter: wait}
	}
	users, err := s.usrRepo.FindByIdentity(ctx, identity)
	if err != nil {
		return nil, err
	}

	var user *model.User
	for i := range users {
		if bcrypt.CompareHashAndPassword([]byte(users[i].PasswordHash), []byte(password)) == nil {
			user = &users[i]
			break
		}
	}
	if len(users) == 0 {
		compareDummy(password)
	}
	// Same error for unknown user and wrong password so the response
	// doesn't reveal which phone numbers/emails are registered.
	if user == nil {
		if err := done(false); err != nil {
			return nil, err
		}
		return nil, ErrInvalidCredentials
	}
	if err := done(true); err != nil {
		return nil, err
	}

	if !user.IsActive {
		return nil, ErrAccountSuspended
	}

	tokenString, err := s.generateToken(user.ID, string(user.Role), 48*time.Hour)
	if err != nil {
		return nil, err
	}

	return &AuthResult{
		Token: tokenString,
		User:  user,
	}, nil
}

// IssueTokenForTest signs a token like a login would; tests only.
func (s *AuthService) IssueTokenForTest(userID, role string) (string, error) {
	return s.generateToken(userID, role, time.Hour)
}

func (s *AuthService) generateToken(userID string, role string, d time.Duration) (string, error) {
	// Standard mapping wrapper
	expirationTime := time.Now().Add(d)
	claims := &AuthClaims{
		UserID: userID,
		Role:   role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expirationTime),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.jwtSecret)
}

// ParseToken validates a bearer token issued by generateToken and returns
// its claims. Only HS256 is accepted so a token can't downgrade to "none".
func (s *AuthService) ParseToken(tokenString string) (*AuthClaims, error) {
	claims := &AuthClaims{}
	token, err := jwt.ParseWithClaims(tokenString, claims, func(t *jwt.Token) (interface{}, error) {
		return s.jwtSecret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	if err != nil || !token.Valid {
		return nil, errors.New("invalid or expired token")
	}
	return claims, nil
}
