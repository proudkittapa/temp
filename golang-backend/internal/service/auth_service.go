package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

var jwtKeySecret = []byte("SUPER_SECRET_COMPLEX_KEY_93281")

func init() {
	if envSecret := os.Getenv("JWT_SECRET"); envSecret != "" {
		jwtKeySecret = []byte(envSecret)
	}
}

type AuthClaims struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
	jwt.RegisteredClaims
}

type AuthService struct {
	usrRepo   *repository.UserRepository
	auditRepo *repository.AuditRepository
}

func NewAuthService(usrRepo *repository.UserRepository, auditRepo *repository.AuditRepository) *AuthService {
	return &AuthService{
		usrRepo:   usrRepo,
		auditRepo: auditRepo,
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
		return nil, ErrDuplicateUser
	}

	// Dynamic admin trace logger creation for CRM tracking
	auditID := fmt.Sprintf("log-%d", time.Now().UnixNano())
	_ = s.auditRepo.LogAction(ctx, &model.AuditLog{
		ID:         auditID,
		UserID:     "system",
		UserName:   "SYSTEM_AUTH",
		Action:     "USER_REGISTERED",
		TargetType: "User",
		TargetID:   userID,
		AfterState: fmt.Sprintf(`{"id": %q, "phone": %q}`, userID, phone),
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
	return token.SignedString(jwtKeySecret)
}

// ParseToken validates a bearer token issued by generateToken and returns
// its claims. Only HS256 is accepted so a token can't downgrade to "none".
func (s *AuthService) ParseToken(tokenString string) (*AuthClaims, error) {
	claims := &AuthClaims{}
	token, err := jwt.ParseWithClaims(tokenString, claims, func(t *jwt.Token) (interface{}, error) {
		return jwtKeySecret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	if err != nil || !token.Valid {
		return nil, errors.New("invalid or expired token")
	}
	return claims, nil
}
