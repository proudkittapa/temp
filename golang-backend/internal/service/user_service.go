package service

import (
	"context"

	"arena-backend/internal/model"
	"arena-backend/internal/repository"
)

type UserService struct {
	usrRepo *repository.UserRepository
}

func NewUserService(usrRepo *repository.UserRepository) *UserService {
	return &UserService{usrRepo: usrRepo}
}

// GetUserProfile loads a user profile by system identifier
func (s *UserService) GetUserProfile(ctx context.Context, userID string) (*model.User, error) {
	return s.usrRepo.GetByID(ctx, userID)
}

// AdjustUserPoints modifies member points balances and registers audit entries via user repository
func (s *UserService) AdjustUserPoints(ctx context.Context, userID string, delta int, staffSession string) (int, error) {
	return s.usrRepo.UpdatePoints(ctx, userID, delta, staffSession)
}

// FetchAllUsers returns a list of registered users filtered optionally by role
func (s *UserService) FetchAllUsers(ctx context.Context, roleFilter string) ([]model.User, error) {
	return s.usrRepo.FetchAll(ctx, roleFilter)
}
