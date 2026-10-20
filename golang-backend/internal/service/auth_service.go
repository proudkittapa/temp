package service

import (
	"context"
	"errors"
	"fmt"
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
}

// NewAuthService takes the JWT signing secret explicitly (see
// resolveJWTSecret in main.go). It used to be read from JWT_SECRET in a
// package init(), which runs before main loads .env - so a secret set in
// .env was silently ignored in favour of a hard-coded, publicly committed
// default that anyone could use to sign an ADMIN token.
func NewAuthService(usrRepo *repository.UserRepository, auditRepo *repository.AuditRepository, jwtSecret []byte) *AuthService {
	if len(jwtSecret) == 0 {
		panic("auth: empty JWT secret")
	}
	return &AuthService{
		usrRepo:   usrRepo,
		auditRepo: auditRepo,
		jwtSecret: jwtSecret,
	}
}

var (
	ErrInvalidCredentials = errors.New("invalid login credentials")
	ErrDuplicateUser      = errors.New("this phone number or email is already registered")
)

type AuthResult struct {
	Token string      `json:"token"`
	User  *model.User `json:"user"`
}

// Register verifies credentials duplicate and inserts a secured password payload
func (s *AuthService) Register(ctx context.Context, name, email, phone, password string) (*AuthResult, error) {
	// The unique indexes on users.phone/email are the real guarantee; this
	// pre-check just gives a clear message in the common case.
	for _, identity := range []string{phone, email} {
		if identity == "" {
			continue
		}
		if existing, _, err := s.usrRepo.GetByIdentity(ctx, identity); err == nil && existing != nil {
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

// Login validates existence and compares hashed credentials
func (s *AuthService) Login(ctx context.Context, identity, password string) (*AuthResult, error) {
	user, pHash, err := s.usrRepo.GetByIdentity(ctx, identity)
	if err != nil || user == nil {
		return nil, ErrInvalidCredentials
	}

	// Same error for unknown user and wrong password so the response
	// doesn't reveal which phone numbers/emails are registered.
	if err := bcrypt.CompareHashAndPassword([]byte(pHash), []byte(password)); err != nil {
		return nil, ErrInvalidCredentials
	}

	if !user.IsActive {
		return nil, errors.New("account is suspended - please contact staff")
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
