package service

import (
	"context"
	"fmt"
	"time"

	"arena-backend/internal/model"
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

// CalculateDiscount returns discount factors matching special member
// categories. Percentages match REQUIREMENTS.md FR-2.3 and mockData.ts's
// DEFAULT_MEMBER_DISCOUNTS - previously this switch, mockData.ts, and
// BACKEND_PLAN.md's pricing engine sample each hardcoded a different set of
// numbers (20/10/15 here vs 15/10/20 in the spec).
//
// TODO: this is currently NOT called from PriceEngineService.CalculatePrice -
// the booking price path applies peak/off-peak and half-court rate but never
// this membership discount. Wiring it in is a business-logic change beyond
// this pass's data-structure fixes; flagging it so it isn't mistaken for
// already-applied.
func (s *MembershipService) CalculateDiscount(ctx context.Context, mType model.MemberType) *MembershipDiscount {
	switch mType {
	case model.MemberStudent:
		return &MembershipDiscount{
			PercentageDiscount: 15.0,
			Description:        "Student ID discount: 15% off",
		}
	case model.MemberClub:
		return &MembershipDiscount{
			PercentageDiscount: 10.0,
			Description:        "Full Club Membership discount: 10% off",
		}
	case model.MemberCorporate:
		return &MembershipDiscount{
			PercentageDiscount: 20.0,
			Description:        "Corporate Account agreement discount: 20% off",
		}
	default:
		return &MembershipDiscount{
			PercentageDiscount: 0.0,
			Description:        "Standard member rate",
		}
	}
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
		auditID := fmt.Sprintf("log-%d", time.Now().UnixNano())
		audit := model.AuditLog{
			ID:          auditID,
			UserID:      adminStaff,
			UserName:    adminStaff,
			Action:      "MEMBERSHIP_UPGRADE",
			TargetType:  "User",
			TargetID:    userID,
			BeforeState: fmt.Sprintf(`{"member_type": "%s"}`, oldTier),
			AfterState:  fmt.Sprintf(`{"member_type": "%s"}`, newTier),
			CreatedAt:   time.Now(),
		}

		return tx.Create(&audit).Error
	})
}
