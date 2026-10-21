package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
	"gorm.io/gorm"
)

type MembershipService struct {
	db      *gorm.DB
	usrRepo *repository.UserRepository
}

func NewMembershipService(db *gorm.DB, usrRepo *repository.UserRepository) *MembershipService {
	return &MembershipService{
		db:      db,
		usrRepo: usrRepo,
	}
}

type MembershipDiscount struct {
	PercentageDiscount float64 `json:"percentage_discount"`
	Description        string  `json:"description"`
}

// CalculateDiscount returns the discount configured for a member category
// (FR-2.3), read from the member_discounts table via UserRepository.GetMemberDiscount
// instead of a hardcoded switch - previously this switch, mockData.ts, and
// BACKEND_PLAN.md's pricing engine sample each hardcoded a different set of
// numbers (20/10/15 here vs 15/10/20 in REQUIREMENTS.md), which is exactly
// the drift a single config table prevents. Called from
// PriceEngineService.NewSlotQuoter, which applies it to booking prices.
func (s *MembershipService) CalculateDiscount(ctx context.Context, mType model.MemberType) (*MembershipDiscount, error) {
	d, err := s.usrRepo.GetMemberDiscount(ctx, mType)
	if err != nil {
		return nil, err
	}
	if d == nil || !d.IsActive {
		return &MembershipDiscount{PercentageDiscount: 0.0, Description: "Standard member rate"}, nil
	}
	return &MembershipDiscount{
		PercentageDiscount: d.DiscountPercent,
		Description:        fmt.Sprintf("%s discount: %.0f%% off", d.Name, d.DiscountPercent),
	}, nil
}

// SetMemberType sets a customer's membership tier (FR-2.3) - what the
// server prices their bookings with - and audit-logs the change. Only
// managers/admins reach this (PUT /admin/users/:id/member-type).
func (s *MembershipService) SetMemberType(ctx context.Context, userID string, newTier model.MemberType, actorID, actorName string) (*model.User, error) {
	switch newTier {
	case model.MemberNormal, model.MemberStudent, model.MemberClub, model.MemberCorporate:
	default:
		return nil, fmt.Errorf("%w: unknown member_type %q", ErrInvalidBooking, newTier)
	}
	var u model.User
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		if err := tx.First(&u, "id = ?", userID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		if u.Role != model.RoleCustomer {
			return fmt.Errorf("%w: membership tiers only apply to customers", ErrInvalidBooking)
		}
		oldTier := u.MemberType
		if oldTier == newTier {
			return nil
		}
		now := time.Now()
		if err := tx.Model(&u).Updates(map[string]interface{}{"member_type": newTier, "updated_at": now}).Error; err != nil {
			return err
		}
		return tx.Create(&model.AuditLog{
			ID:          ids.New("log"),
			UserID:      actorID,
			UserName:    actorName,
			Action:      "MEMBERSHIP_CHANGED",
			TargetType:  "User",
			TargetID:    userID,
			BeforeState: model.AuditJSON(map[string]model.MemberType{"member_type": oldTier}),
			AfterState:  model.AuditJSON(map[string]model.MemberType{"member_type": newTier}),
			CreatedAt:   now,
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return &u, nil
}
