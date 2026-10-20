package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type UserRepository struct {
	db *gorm.DB
}

func NewUserRepository(db *gorm.DB) *UserRepository {
	return &UserRepository{db: db}
}

// IsUniqueViolation reports whether err is a Postgres unique-constraint
// violation (SQLSTATE 23505), e.g. a duplicate users.phone/email.
func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
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

// NormalizePhone keeps only the digits of a phone number, so "081-234-5678",
// "081 234 5678" and "0812345678" are the same number. Phones are stored
// this way (see AuthService.Register) and compared this way.
func NormalizePhone(p string) string {
	var b strings.Builder
	for _, r := range p {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// phoneDigitsMatch compares users.phone by digits only, so accounts
// registered before phones were normalized (stored as typed, e.g. with
// dashes) are still found.
const phoneDigitsMatch = "regexp_replace(phone, '[^0-9]', '', 'g') = ?"

// GetByIdentity finds a user by email, or - when identity has no "@" - by
// phone number compared digits-only. Used by login and the register
// duplicate check.
func (r *UserRepository) GetByIdentity(ctx context.Context, identity string) (*model.User, string, error) {
	q := r.db.WithContext(ctx).Where("email = ?", identity)
	if !strings.Contains(identity, "@") {
		if digits := NormalizePhone(identity); digits != "" {
			q = q.Or(phoneDigitsMatch, digits)
		}
	}
	var u model.User
	if err := q.Order("created_at").First(&u).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, "", nil
		}
		return nil, "", fmt.Errorf("failed to retrieve user by email/phone check: %w", err)
	}
	return &u, u.PasswordHash, nil
}

// GetByPhone finds a user by phone number, compared digits-only.
func (r *UserRepository) GetByPhone(ctx context.Context, phone string) (*model.User, error) {
	digits := NormalizePhone(phone)
	if digits == "" {
		return nil, nil
	}
	var u model.User
	if err := r.db.WithContext(ctx).Where(phoneDigitsMatch, digits).Order("created_at").First(&u).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to retrieve user by phone: %w", err)
	}
	return &u, nil
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
	if err := tx.WithContext(ctx).Clauses(clause.Locking{Strength: "UPDATE"}).First(&u, "id = ?", userID).Error; err != nil {
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
		ID:        ids.New("ledger"),
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
		logID := ids.New("log")
		auditLog := model.AuditLog{
			ID:          logID,
			UserID:      actionStaff,
			UserName:    actionStaff,
			Action:      "POINTS_OVERRIDE",
			TargetType:  "User",
			TargetID:    userID,
			BeforeState: model.AuditJSON(map[string]int{"points": beforePoints}),
			AfterState:  model.AuditJSON(map[string]int{"points": newBalance, "delta": delta}),
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
