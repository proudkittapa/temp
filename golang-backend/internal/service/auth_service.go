package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/repository"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/crypto/bcrypt"
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

type AuthResult struct {
	Token string      `json:"token"`
	User  *model.User `json:"user"`
}

// Register verifies credentials duplicate and inserts a secured password payload
func (s *AuthService) Register(ctx context.Context, name, email, phone, password string) (*AuthResult, error) {
	hashedBytes, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	userID := "u-" + time.Now().Format("02150405")
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
		return nil, errors.New("user configuration collision (phone/email duplicate)")
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
		AfterState: fmt.Sprintf("Registered new customer user: ID %s, Phone %s", userID, phone),
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
		return nil, errors.New("invalid login credentials")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(pHash), []byte(password)); err != nil {
		return nil, errors.New("invalid password verification match")
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
