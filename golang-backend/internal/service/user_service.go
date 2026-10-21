package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
	"gorm.io/gorm"
)

type UserService struct {
	db      *gorm.DB
	usrRepo *repository.UserRepository
}

func NewUserService(db *gorm.DB, usrRepo *repository.UserRepository) *UserService {
	return &UserService{db: db, usrRepo: usrRepo}
}

// GetUserProfile loads a user profile by system identifier
func (s *UserService) GetUserProfile(ctx context.Context, userID string) (*model.User, error) {
	return s.usrRepo.GetByID(ctx, userID)
}

// MaxManualPointsChange bounds one manual change, so a typo (or a misused
// account) can't hand out an unlimited balance.
const MaxManualPointsChange = 10000

// AdjustUserPoints is a manager/admin's manual points change. A reason is
// required, only customers hold points, and nobody may change their own
// balance.
func (s *UserService) AdjustUserPoints(ctx context.Context, userID string, delta int, actorID, actorName, reason string) (int, error) {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return 0, fmt.Errorf("%w: a reason is required for a manual points change", ErrInvalidBooking)
	}
	if delta == 0 || delta < -MaxManualPointsChange || delta > MaxManualPointsChange {
		return 0, fmt.Errorf("%w: points change must be between -%d and %d", ErrInvalidBooking, MaxManualPointsChange, MaxManualPointsChange)
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

// SetRole changes a user's role (admin only - the route enforces it), e.g.
// to make a registered customer counter staff. Role is re-read on every
// request, so it takes effect at once.
func (s *UserService) SetRole(ctx context.Context, userID string, role model.UserRole, actorID, actorName string) (*model.User, error) {
	// Any role in the roles table: the four built-ins or one the admin made.
	var n int64
	if err := s.db.WithContext(ctx).Model(&model.Role{}).Where("id = ?", string(role)).Count(&n).Error; err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, fmt.Errorf("%w: unknown role %q", ErrInvalidBooking, role)
	}
	return s.updateUser(ctx, userID, actorID, actorName, "USER_ROLE_CHANGED", func(u *model.User) (map[string]any, any, any) {
		return map[string]any{"role": role}, map[string]any{"role": u.Role}, map[string]any{"role": role}
	})
}

// SetActive suspends or reactivates an account (admin only). A suspended
// user's existing sessions stop working at once (Authenticate re-reads it).
func (s *UserService) SetActive(ctx context.Context, userID string, active bool, actorID, actorName string) (*model.User, error) {
	action := "USER_REACTIVATED"
	if !active {
		action = "USER_SUSPENDED"
	}
	return s.updateUser(ctx, userID, actorID, actorName, action, func(u *model.User) (map[string]any, any, any) {
		return map[string]any{"is_active": active}, map[string]any{"is_active": u.IsActive}, map[string]any{"is_active": active}
	})
}

// updateUser applies one admin change to a user with an audit log. Nobody
// may change their own role or status - that is how the last admin locks
// everyone out.
func (s *UserService) updateUser(ctx context.Context, userID, actorID, actorName, action string,
	change func(*model.User) (updates map[string]any, before, after any)) (*model.User, error) {
	if userID == actorID {
		return nil, fmt.Errorf("%w: you cannot change your own role or status", ErrForbidden)
	}
	var u model.User
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.First(&u, "id = ?", userID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		updates, before, after := change(&u)
		now := time.Now()
		updates["updated_at"] = now
		if err := tx.Model(&u).Updates(updates).Error; err != nil {
			return err
		}
		return tx.Create(&model.AuditLog{
			ID:          ids.New("log"),
			UserID:      actorID,
			UserName:    actorName,
			Action:      action,
			TargetType:  "User",
			TargetID:    userID,
			BeforeState: model.AuditJSON(before),
			AfterState:  model.AuditJSON(after),
			CreatedAt:   now,
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return &u, nil
}
