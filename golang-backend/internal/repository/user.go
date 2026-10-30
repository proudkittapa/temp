package repository

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"sort"
	"strings"
	"sync/atomic"
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

// Deadlocks counts the transactions Postgres aborted as deadlocks in this
// process (each is retried below). The race tests check it doesn't move: a
// deadlock means two code paths take the same locks in a different order.
// (Postgres's own pg_stat_database.deadlocks can report one up to ~10 s
// late, so it can't tell which test caused it.)
var Deadlocks atomic.Int64

// RetryTx runs fn in a transaction and, when Postgres aborts it as a
// deadlock or serialization failure (IsRetryableConflict), runs it again -
// up to 3 attempts, after a short pause - instead of sending the client
// "busy, try again". The aborted attempt was rolled back, so fn must only
// change the database, or reset anything it fills outside itself.
func RetryTx(db *gorm.DB, fn func(tx *gorm.DB) error) error {
	var err error
	for attempt := 1; ; attempt++ {
		err = db.Transaction(fn)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "40P01" {
			Deadlocks.Add(1)
		}
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

// IsCheckViolation reports a write a CHECK constraint refused (23514) -
// e.g. stock or points would go below zero (see ensureConstraints).
func IsCheckViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23514"
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
// all "0812345678" - and so is "812345678": a 9-digit number starting
// with 6, 8 or 9 is a mobile (06/08/09 + 8 digits) typed without its 0.
// Phones are stored this way (see AuthService.Register) and compared this
// way.
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
	case len(d) == 9 && (d[0] == '6' || d[0] == '8' || d[0] == '9'):
		return "0" + d
	}
	return d
}

// canonicalPhoneSQL is NormalizePhone in SQL, applied to users.phone. Only
// NormalizeStoredPhones and the fallback for old-format phones use it: it
// can't use an index, so it reads every user row.
const canonicalPhoneSQL = `(CASE
	WHEN regexp_replace(phone, '[^0-9]', '', 'g') ~ '^66[0-9]{8,9}$' THEN '0' || substr(regexp_replace(phone, '[^0-9]', '', 'g'), 3)
	WHEN regexp_replace(phone, '[^0-9]', '', 'g') ~ '^0066[0-9]{8,9}$' THEN '0' || substr(regexp_replace(phone, '[^0-9]', '', 'g'), 5)
	WHEN regexp_replace(phone, '[^0-9]', '', 'g') ~ '^[689][0-9]{8}$' THEN '0' || regexp_replace(phone, '[^0-9]', '', 'g')
	ELSE regexp_replace(phone, '[^0-9]', '', 'g') END)`

// phonesNormalized is true once startup found every stored phone in
// canonical form (see NormalizeStoredPhones): lookups are then a plain
// indexed "phone = ?". Until then - or while some account keeps an
// old-format number because another account already has it - they also
// compare canonicalPhoneSQL, so those accounts are still found.
var phonesNormalized atomic.Bool

// phoneMatch is the WHERE condition for "users.phone is this canonical
// number".
func phoneMatch(db *gorm.DB, phone string) *gorm.DB {
	if phonesNormalized.Load() {
		return db.Where("phone = ?", phone)
	}
	return db.Where("(phone = ? OR "+canonicalPhoneSQL+" = ?)", phone, phone)
}

// NormalizeStoredPhones rewrites phones stored before sign-up normalized
// them ("081-555-0000", "+66815550000") to canonical form, so lookups can
// use the index. When several accounts have the same number, the one
// already in canonical form - otherwise the oldest - gets it; the others
// keep theirs and are returned (canonical number -> account ids) to be
// merged by hand. Runs at every start: it is cheap, and an account left
// over is normalized as soon as the conflict is gone.
func NormalizeStoredPhones(ctx context.Context, db *gorm.DB) (fixed int64, leftover map[string][]string, err error) {
	res := db.WithContext(ctx).Exec(`UPDATE users u SET phone = c.p
		FROM (SELECT id, p, row_number() OVER (PARTITION BY p ORDER BY (phone = p) DESC, created_at, id) AS rn
		      FROM (SELECT id, phone, created_at, ` + canonicalPhoneSQL + ` AS p FROM users WHERE phone <> '') x) c
		WHERE u.id = c.id AND c.rn = 1 AND u.phone <> c.p
		  AND NOT EXISTS (SELECT 1 FROM users o WHERE o.phone = c.p AND o.id <> u.id)`)
	if res.Error != nil {
		return 0, nil, res.Error
	}
	var rows []struct{ P, ID string }
	if err := db.WithContext(ctx).Model(&model.User{}).Select("id, " + canonicalPhoneSQL + " AS p").
		Where("phone <> '' AND phone <> " + canonicalPhoneSQL).Order("p, created_at, id").Scan(&rows).Error; err != nil {
		return res.RowsAffected, nil, err
	}
	leftover = map[string][]string{}
	for _, r := range rows {
		leftover[r.P] = append(leftover[r.P], r.ID)
	}
	phonesNormalized.Store(len(rows) == 0)
	return res.RowsAffected, leftover, nil
}

// FindByIdentity returns every user whose email is identity (ignoring
// case: "John@Gmail.com" is john@gmail.com) or - when identity has no "@" -
// whose phone is the same number, oldest first.
// Usually that is zero or one user, but an account left with an old-format
// copy of another's number (see NormalizeStoredPhones) matches too, so
// callers must not assume a single match.
func (r *UserRepository) FindByIdentity(ctx context.Context, identity string) ([]model.User, error) {
	identity = strings.TrimSpace(identity)
	db := r.db.WithContext(ctx)
	// Two queries, each on its own index (an OR of the two can't use them
	// together once the phone side needs the old-format fallback).
	var users []model.User
	if err := db.Where("lower(email) = lower(?)", identity).Find(&users).Error; err != nil {
		return nil, fmt.Errorf("failed to retrieve user by email/phone check: %w", err)
	}
	if !strings.Contains(identity, "@") {
		if phone := NormalizePhone(identity); phone != "" {
			var byPhone []model.User
			if err := phoneMatch(db, phone).Find(&byPhone).Error; err != nil {
				return nil, fmt.Errorf("failed to retrieve user by email/phone check: %w", err)
			}
			seen := map[string]bool{}
			for _, u := range users {
				seen[u.ID] = true
			}
			for _, u := range byPhone {
				if !seen[u.ID] {
					users = append(users, u)
				}
			}
		}
	}
	sort.Slice(users, func(i, j int) bool {
		if !users[i].CreatedAt.Equal(users[j].CreatedAt) {
			return users[i].CreatedAt.Before(users[j].CreatedAt)
		}
		return users[i].ID < users[j].ID
	})
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
	if err := phoneMatch(r.db.WithContext(ctx), phone).Order("created_at, id").First(&u).Error; err != nil {
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
// UserFilter narrows the admin user list. Search matches part of the name
// or email, or digits anywhere in the phone; PhoneDigits is Search reduced to
// a phone number (empty if it has no digits).
type UserFilter struct {
	Role        string
	Search      string
	PhoneDigits string
	Limit       int
	Offset      int
}

// FetchPage returns users newest first, at most f.Limit of them, and
// whether more match - the list is never sent whole.
func (r *UserRepository) FetchPage(ctx context.Context, f UserFilter) ([]model.User, bool, error) {
	query := r.db.WithContext(ctx)
	if f.Role != "" {
		query = query.Where("role = ?", f.Role)
	}
	if term := strings.TrimSpace(f.Search); term != "" {
		esc := strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`)
		like := "%" + esc.Replace(term) + "%"
		if f.PhoneDigits != "" {
			query = query.Where("(name ILIKE ? OR email ILIKE ? OR phone LIKE ?)", like, like, "%"+esc.Replace(f.PhoneDigits)+"%")
		} else {
			query = query.Where("(name ILIKE ? OR email ILIKE ?)", like, like)
		}
	}
	var users []model.User
	if err := query.Order("created_at DESC, id").Limit(f.Limit + 1).Offset(f.Offset).Find(&users).Error; err != nil {
		return nil, false, fmt.Errorf("failed to query users ledger: %w", err)
	}
	if len(users) > f.Limit {
		return users[:f.Limit], true, nil
	}
	return users, false, nil
}
