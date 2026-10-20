package service

import (
	"context"
	"fmt"
	"strings"

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

// AdjustUserPoints is a manager/admin's manual points change. A reason is
// required, only customers hold points, and nobody may change their own
// balance.
func (s *UserService) AdjustUserPoints(ctx context.Context, userID string, delta int, actorID, actorName, reason string) (int, error) {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return 0, fmt.Errorf("%w: a reason is required for a manual points change", ErrInvalidBooking)
	}
	if userID == actorID {
		return 0, fmt.Errorf("%w: you cannot change your own points", ErrForbidden)
	}
	u, err := s.usrRepo.GetByID(ctx, userID)
	if err != nil {
		return 0, err
	}
	if u == nil {
		return 0, ErrNotFound
	}
	if u.Role != model.RoleCustomer {
		return 0, fmt.Errorf("%w: only customers have loyalty points", ErrInvalidBooking)
	}
	return s.usrRepo.UpdatePoints(ctx, userID, delta, actorID, actorName, reason)
}

// FetchAllUsers returns a list of registered users filtered optionally by role
func (s *UserService) FetchAllUsers(ctx context.Context, roleFilter string) ([]model.User, error) {
	return s.usrRepo.FetchAll(ctx, roleFilter)
}
