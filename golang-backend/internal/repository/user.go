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

// AddPointsEntry applies a signed point delta to a user atomically within an
// existing transaction and appends a PointsLedgerEntry, so User.Points stays
// a cached sum of the ledger instead of an independently-mutable integer -
// every earn/redeem/adjustment path (booking accrual, POS purchases, admin
// overrides) must go through here rather than writing u.Points directly.
// Returns the resulting balance; errors rather than clamping if the delta
// would take the balance below zero.
func (r *UserRepository) AddPointsEntry(
	ctx context.Context,
	tx *gorm.DB,
	userID string,
	entryType model.LedgerEntryType,
	points int,
	createdBy string,
	refType *string,
	refID *string,
	note *string,
) (int, error) {
	var u model.User
	if err := tx.WithContext(ctx).Set("gorm:query_option", "FOR UPDATE").First(&u, "id = ?", userID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, errors.New("user not found")
		}
		return 0, err
	}

	newBalance := u.Points + points
	if newBalance < 0 {
		return 0, errors.New("insufficient points: balance cannot drop below zero")
	}

	u.Points = newBalance
	u.UpdatedAt = time.Now()
	if err := tx.Save(&u).Error; err != nil {
		return 0, err
	}

	entry := model.PointsLedgerEntry{
		ID:        fmt.Sprintf("ledger-%d", time.Now().UnixNano()),
		UserID:    userID,
		Type:      entryType,
		Points:    points,
		RefType:   refType,
		RefID:     refID,
		Note:      note,
		CreatedAt: time.Now(),
		CreatedBy: createdBy,
	}
	if err := tx.Create(&entry).Error; err != nil {
		return 0, fmt.Errorf("failed to record points ledger entry: %w", err)
	}

	return newBalance, nil
}

// UpdatePoints handles a manual admin points adjustment. Safely locks rows
// inside a database session block of ACID via AddPointsEntry, which also
// records the change to points_ledger (LedgerAdjustManual) in addition to the
// before/after audit log kept here for parity with other admin actions.
func (r *UserRepository) UpdatePoints(ctx context.Context, userID string, delta int, actionStaff string) (int, error) {
	var newBalance int
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var err error
		newBalance, err = r.AddPointsEntry(ctx, tx, userID, model.LedgerAdjustManual, delta, actionStaff, nil, nil, nil)
		if err != nil {
			return err
		}
		beforePoints := newBalance - delta // AddPointsEntry always applies the full delta or errors, never clamps

		// Dynamic admin trace logger creation inside same Postgres atomic transaction
		logID := fmt.Sprintf("log-%d", time.Now().UnixNano())
		auditLog := model.AuditLog{
			ID:          logID,
			UserID:      actionStaff,
			UserName:    actionStaff,
			Action:      "POINTS_OVERRIDE",
			TargetType:  "User",
			TargetID:    userID,
			BeforeState: fmt.Sprintf(`{"points": %d}`, beforePoints),
			AfterState:  fmt.Sprintf(`{"points": %d, "delta": %d}`, newBalance, delta),
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

// GetMemberDiscount loads the discount configured for a membership tier
// (FR-2.3) from the member_discounts table - the single source of truth
// consulted by the pricing engine, instead of a percentage hardcoded per
// service/language.
func (r *UserRepository) GetMemberDiscount(ctx context.Context, mType model.MemberType) (*model.MemberDiscount, error) {
	var d model.MemberDiscount
	err := r.db.WithContext(ctx).First(&d, "member_type = ? AND is_active = ?", mType, true).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to load member discount: %w", err)
	}
	return &d, nil
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
