package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"arena-backend/internal/model"
	"gorm.io/gorm"
)

type UserRepository struct {
	db *gorm.DB
}

func NewUserRepository(db *gorm.DB) *UserRepository {
	return &UserRepository{db: db}
}

// Create inserts a brand new customer or staff member user profile row.
func (r *UserRepository) Create(ctx context.Context, u *model.User) error {
	if err := r.db.WithContext(ctx).Create(u).Error; err != nil {
		return fmt.Errorf("failed to register user to database: %w", err)
	}
	return nil
}

// GetByID queries user profiles safely from DB by unique ID.
func (r *UserRepository) GetByID(ctx context.Context, id string) (*model.User, error) {
	var u model.User
	err := r.db.WithContext(ctx).First(&u, "id = ?", id).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to query user by ID: %w", err)
	}
	return &u, nil
}

// GetByIdentity finds user profile using either Phone or Email. Used heavily in Login controllers.
func (r *UserRepository) GetByIdentity(ctx context.Context, identity string) (*model.User, string, error) {
	var u model.User
	err := r.db.WithContext(ctx).Where("email = ? OR phone = ?", identity, identity).First(&u).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, "", nil
		}
		return nil, "", fmt.Errorf("failed to retrieve user by email/phone check: %w", err)
	}
	return &u, u.PasswordHash, nil
}

// UpdatePoints handles atomic points adjustment. Safely locks rows inside database session blocks of ACID.
func (r *UserRepository) UpdatePoints(ctx context.Context, userID string, delta int, actionStaff string) (int, error) {
	var newBalance int
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var u model.User
		// SELECT FOR UPDATE inside the txn block
		if err := tx.Set("gorm:query_option", "FOR UPDATE").First(&u, "id = ?", userID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errors.New("user not found")
			}
			return err
		}

		calculated := u.Points + delta
		if calculated < 0 {
			return errors.New("insufficient points: balance cannot drop below zero")
		}

		u.Points = calculated
		u.UpdatedAt = time.Now()
		if err := tx.Save(&u).Error; err != nil {
			return err
		}
		newBalance = calculated

		// Dynamic admin trace logger creation inside same Postgres atomic transaction
		logID := fmt.Sprintf("log-%d", time.Now().UnixNano())
		auditLog := model.AuditLog{
			ID:          logID,
			UserID:      actionStaff,
			UserName:    actionStaff,
			Action:      "POINTS_OVERRIDE",
			TargetType:  "User",
			TargetID:    userID,
			BeforeState: fmt.Sprintf(`{"points": %d}`, u.Points-delta),
			AfterState:  fmt.Sprintf(`{"points": %d, "delta": %d}`, calculated, delta),
			CreatedAt:   time.Now(),
		}
		if err := tx.Create(&auditLog).Error; err != nil {
			return fmt.Errorf("failed to record points adjustment to audit logs: %w", err)
		}

		return nil
	})

	if err != nil {
		return 0, err
	}
	return newBalance, nil
}

// FetchAll retrieves lists database rows representing users. Helpful for Admin panel customer dashboards.
func (r *UserRepository) FetchAll(ctx context.Context, roleFilter string) ([]model.User, error) {
	var users []model.User
	query := r.db.WithContext(ctx)
	if roleFilter != "" {
		query = query.Where("role = ?", roleFilter)
	}
	err := query.Order("created_at DESC").Find(&users).Error
	if err != nil {
		return nil, fmt.Errorf("failed to query users ledger: %w", err)
	}
	return users, nil
}
