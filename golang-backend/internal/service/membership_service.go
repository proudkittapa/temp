package service

import (
	"context"
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

// UpgradeMembership converts the member tier of a user and records an audit trail
func (s *MembershipService) UpgradeMembership(ctx context.Context, userID string, newTier model.MemberType, adminStaff string) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var u model.User
		if err := tx.First(&u, "id = ?", userID).Error; err != nil {
			return err
		}

		oldTier := u.MemberType
		u.MemberType = newTier
		u.UpdatedAt = time.Now()

		if err := tx.Save(&u).Error; err != nil {
			return err
		}

		// Create dynamic administrative audit trail
		auditID := ids.New("log")
		audit := model.AuditLog{
			ID:          auditID,
			UserID:      adminStaff,
			UserName:    adminStaff,
			Action:      "MEMBERSHIP_UPGRADE",
			TargetType:  "User",
			TargetID:    userID,
			BeforeState: model.AuditJSON(map[string]model.MemberType{"member_type": oldTier}),
			AfterState:  model.AuditJSON(map[string]model.MemberType{"member_type": newTier}),
			CreatedAt:   time.Now(),
		}

		return tx.Create(&audit).Error
	})
}
