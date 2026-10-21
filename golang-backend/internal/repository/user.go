package repository

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"strings"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrInsufficientPoints: a points change would take the balance below zero.
var ErrInsufficientPoints = errors.New("insufficient points: balance cannot drop below zero")

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

// IsRetryableConflict reports a deadlock (40P01) or serialization failure
// (40001): two requests collided; repeating the request will work.
func IsRetryableConflict(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "40P01" || pgErr.Code == "40001")
}

// RetryTx runs fn in a transaction and, when Postgres aborts it as a
// deadlock or serialization failure (IsRetryableConflict), runs it again -
// up to 3 attempts, after a short pause - instead of sending the client
// "busy, try again". The aborted attempt was rolled back, so fn must only
// change the database, or reset anything it fills outside itself.
func RetryTx(db *gorm.DB, fn func(tx *gorm.DB) error) error {
	var err error
	for attempt := 1; ; attempt++ {
		err = db.Transaction(fn)
		if err == nil || attempt == 3 || !IsRetryableConflict(err) {
			return err
		}
		select {
		case <-db.Statement.Context.Done():
			return err
		case <-time.After(time.Duration(attempt*attempt*25+rand.IntN(25)) * time.Millisecond):
		}
	}
}

// IsLockTimeout reports a row/advisory lock wait cut off by lock_timeout
// (55P03): another request held the lock too long.
func IsLockTimeout(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "55P03"
}

// IsQueryTimeout reports a statement cancelled by statement_timeout or by
// the request's deadline (57014), or a deadline hit while waiting.
func IsQueryTimeout(err error) bool {
	var pgErr *pgconn.PgError
	return (errors.As(err, &pgErr) && pgErr.Code == "57014") || errors.Is(err, context.DeadlineExceeded)
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

// NormalizePhone reduces a phone number to one canonical form: digits only,
// with the Thai country code rewritten as the domestic leading 0. So
// "081-234-5678", "081 234 5678", "+66 81 234 5678" and "0066812345678" are
// all "0812345678". Phones are stored this way (see AuthService.Register)
// and compared this way.
func NormalizePhone(p string) string {
	var b strings.Builder
	for _, r := range p {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	d := b.String()
	// Domestic numbers always start with 0, so a leading 66 (or 0066) is
	// the country code: 66 + 9 digits for a mobile, 66 + 8 for a landline.
	switch {
	case (len(d) == 10 || len(d) == 11) && strings.HasPrefix(d, "66"):
		return "0" + d[2:]
	case (len(d) == 12 || len(d) == 13) && strings.HasPrefix(d, "0066"):
		return "0" + d[4:]
	}
	return d
}

// canonicalPhoneSQL is NormalizePhone in SQL, applied to users.phone, so
// accounts stored before phones were normalized (with dashes, or as
// +66...) still match.
const canonicalPhoneSQL = `(CASE
	WHEN regexp_replace(phone, '[^0-9]', '', 'g') ~ '^66[0-9]{8,9}$' THEN '0' || substr(regexp_replace(phone, '[^0-9]', '', 'g'), 3)
	WHEN regexp_replace(phone, '[^0-9]', '', 'g') ~ '^0066[0-9]{8,9}$' THEN '0' || substr(regexp_replace(phone, '[^0-9]', '', 'g'), 5)
	ELSE regexp_replace(phone, '[^0-9]', '', 'g') END)`

// FindByIdentity returns every user whose email is identity (ignoring
// case: "John@Gmail.com" is john@gmail.com) or - when identity has no "@" -
// whose phone is the same number, oldest first.
// Usually that is zero or one user, but before phones were normalized the
// same number could be registered twice (e.g. "081-555-0000" and
// "0815550000"), so callers must not assume a single match.
func (r *UserRepository) FindByIdentity(ctx context.Context, identity string) ([]model.User, error) {
	identity = strings.TrimSpace(identity)
	q := r.db.WithContext(ctx).Where("lower(email) = lower(?)", identity)
	if !strings.Contains(identity, "@") {
		if phone := NormalizePhone(identity); phone != "" {
			q = q.Or(canonicalPhoneSQL+" = ?", phone)
		}
	}
	var users []model.User
	if err := q.Order("created_at, id").Find(&users).Error; err != nil {
		return nil, fmt.Errorf("failed to retrieve user by email/phone check: %w", err)
	}
	return users, nil
}

// GetByPhone finds the oldest user with this phone number (compared in
// canonical form), or nil.
func (r *UserRepository) GetByPhone(ctx context.Context, phone string) (*model.User, error) {
	phone = NormalizePhone(phone)
	if phone == "" {
		return nil, nil
	}
	var u model.User
	if err := r.db.WithContext(ctx).Where(canonicalPhoneSQL+" = ?", phone).Order("created_at, id").First(&u).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to retrieve user by phone: %w", err)
	}
	return &u, nil
}

// DuplicatePhones returns canonical phone numbers that more than one
// account uses - left over from before phones were normalized. Such
// accounts should be merged by hand; until then login tries each one.
func (r *UserRepository) DuplicatePhones(ctx context.Context) ([]string, error) {
	var phones []string
	err := r.db.WithContext(ctx).Model(&model.User{}).
		Select(canonicalPhoneSQL+" AS p").
		Where("phone <> ''").
		Group("p").Having("count(*) > 1").
		Pluck("p", &phones).Error
	return phones, err
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
		return 0, ErrInsufficientPoints
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

// UpdatePoints handles a manual points adjustment by a manager/admin.
// AddPointsEntry records it in points_ledger (LedgerAdjustManual, with the
// reason as the note) and the audit log keeps before/after, the actor's
// name and the reason, as FR-7.3 requires for manual point changes.
func (r *UserRepository) UpdatePoints(ctx context.Context, userID string, delta int, actorID, actorName, reason string) (int, error) {
	var newBalance int
	err := RetryTx(r.db.WithContext(ctx), func(tx *gorm.DB) error {
		var err error
		newBalance, err = r.AddPointsEntry(ctx, tx, userID, model.LedgerAdjustManual, delta, actorID, nil, nil, &reason)
		if err != nil {
			return err
		}
		beforePoints := newBalance - delta // AddPointsEntry always applies the full delta or errors, never clamps

		auditLog := model.AuditLog{
			ID:          ids.New("log"),
			UserID:      actorID,
			UserName:    actorName,
			Action:      "POINTS_OVERRIDE",
			TargetType:  "User",
			TargetID:    userID,
			BeforeState: model.AuditJSON(map[string]int{"points": beforePoints}),
			AfterState:  model.AuditJSON(map[string]int{"points": newBalance, "delta": delta}),
			Reason:      &reason,
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
