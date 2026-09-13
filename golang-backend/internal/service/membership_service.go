package service

import (
	"context"
	"errors"
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

// CalculateDiscount returns custom discount factors matching special member categories
func (s *MembershipService) CalculateDiscount(ctx context.Context, mType model.MemberType) *MembershipDiscount {
	switch mType {
	case model.MemberStudent:
		return &MembershipDiscount{
			PercentageDiscount: 20.0,
			Description:        "Student ID discount: 20% off",
		}
	case model.MemberClub:
		return &MembershipDiscount{
			PercentageDiscount: 10.0,
			Description:        "Full Club Membership discount: 10% off",
		}
	case model.MemberCorporate:
		return &MembershipDiscount{
			PercentageDiscount: 15.0,
			Description:        "Corporate Account agreement discount: 15% off",
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
