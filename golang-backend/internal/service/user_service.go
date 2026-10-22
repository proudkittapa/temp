package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

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
	if err := checkText("reason", reason); err != nil {
		return 0, err
	}
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
// ListUsers is one page of the admin user list (newest first, up to 1000;
// default 200) and whether more match.
func (s *UserService) ListUsers(ctx context.Context, role, search string, limit, offset int) ([]model.User, bool, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	if offset < 0 {
		offset = 0
	}
	if len([]rune(search)) > 100 {
		return []model.User{}, false, nil
	}
	return s.usrRepo.FetchPage(ctx, repository.UserFilter{Role: role, Search: search, PhoneDigits: partialPhone(search), Limit: limit, Offset: offset})
}

// MemberMatch is what the counter sees when it looks up a customer to give
// points to: enough to pick the right person, nothing more.
type MemberMatch struct {
	ID         string           `json:"id"`
	Name       string           `json:"name"`
	Phone      string           `json:"phone"`
	MemberType model.MemberType `json:"member_type"`
	Points     int              `json:"points"`
}

// SearchMembers lists active customers A-Z for the counter's member-phone
// dropdown, up to 20: all of them when q is empty, otherwise those whose
// phone starts with q's digits or whose name contains q.
func (s *UserService) SearchMembers(ctx context.Context, q string) ([]MemberMatch, error) {
	q = strings.TrimSpace(q)
	out := []MemberMatch{}
	if len([]rune(q)) > 50 {
		return out, nil
	}
	esc := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	tx := s.db.WithContext(ctx).Model(&model.User{}).
		Where("role = ? AND is_active", model.RoleCustomer)
	if q == "" {
		// no filter - the first page of the list
	} else if digits := partialPhone(q); digits != "" {
		tx = tx.Where("(phone LIKE ? OR name ILIKE ?)", esc.Replace(digits)+"%", "%"+esc.Replace(q)+"%")
	} else {
		tx = tx.Where("name ILIKE ?", "%"+esc.Replace(q)+"%")
	}
	err := tx.Order("name").Limit(20).Select("id, name, phone, member_type, points").Scan(&out).Error
	return out, err
}

// partialPhone is NormalizePhone for a number still being typed: a leading
// +66 / 0066 becomes 0 even before the number is complete ("+66 845" ->
// "0845").
func partialPhone(q string) string {
	d := repository.NormalizePhone(q)
	t := strings.TrimSpace(q)
	switch {
	case strings.HasPrefix(t, "+66") && strings.HasPrefix(d, "66"):
		return "0" + d[2:]
	case strings.HasPrefix(d, "0066"):
		return "0" + d[4:]
	}
	return d
}

// SetRole changes a user's role (admin only - the route enforces it), e.g.
// to make a registered customer counter staff. Role is re-read on every
// request, so it takes effect at once.
//
// actorPerms are the caller's own permissions: nobody hands out a role with
// rights they don't have themselves (a "manage staff" role must not be able
// to make an account ADMIN), see updateUser for the target-side check.
func (s *UserService) SetRole(ctx context.Context, userID string, role model.UserRole, actorID, actorName string, actorPerms []model.Permission) (*model.User, error) {
	// Any role in the roles table: the four built-ins or one the admin made.
	var r model.Role
	if err := s.db.WithContext(ctx).First(&r, "id = ?", string(role)).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, fmt.Errorf("%w: unknown role %q", ErrInvalidBooking, role)
		}
		return nil, err
	}
	if missing := missingPermissions(r.Permissions, actorPerms); len(missing) > 0 {
		return nil, fmt.Errorf("%w: role %q has permissions you don't have (%s)", ErrForbidden, r.Name, joinPermissions(missing))
	}
	return s.updateUser(ctx, userID, actorID, actorName, actorPerms, "USER_ROLE_CHANGED", func(u *model.User) (map[string]any, any, any) {
		return map[string]any{"role": role}, map[string]any{"role": u.Role}, map[string]any{"role": role}
	})
}

// SetActive suspends or reactivates an account (admin only). A suspended
// user's existing sessions stop working at once (Authenticate re-reads it).
func (s *UserService) SetActive(ctx context.Context, userID string, active bool, actorID, actorName string, actorPerms []model.Permission) (*model.User, error) {
	action := "USER_REACTIVATED"
	if !active {
		action = "USER_SUSPENDED"
	}
	return s.updateUser(ctx, userID, actorID, actorName, actorPerms, action, func(u *model.User) (map[string]any, any, any) {
		return map[string]any{"is_active": active}, map[string]any{"is_active": u.IsActive}, map[string]any{"is_active": active}
	})
}

// updateUser applies one admin change to a user with an audit log. Nobody
// may change their own role or status - that is how the last admin locks
// everyone out - nor that of an account whose role has rights the caller
// lacks (a staff manager can't suspend or demote the admin).
func (s *UserService) updateUser(ctx context.Context, userID, actorID, actorName string, actorPerms []model.Permission, action string,
	change func(*model.User) (updates map[string]any, before, after any)) (*model.User, error) {
	if userID == actorID {
		return nil, fmt.Errorf("%w: you cannot change your own role or status", ErrForbidden)
	}
	var u model.User
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		if err := tx.First(&u, "id = ?", userID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		targetPerms, err := rolePermissionsTx(tx, string(u.Role))
		if err != nil {
			return err
		}
		if missing := missingPermissions(targetPerms, actorPerms); len(missing) > 0 {
			return fmt.Errorf("%w: this account has permissions you don't have (%s)", ErrForbidden, joinPermissions(missing))
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

// rolePermissionsTx is RoleService.Permissions inside a transaction.
func rolePermissionsTx(tx *gorm.DB, roleID string) ([]model.Permission, error) {
	var r model.Role
	err := tx.First(&r, "id = ?", roleID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return builtinPermissions(roleID), nil
	}
	if err != nil {
		return nil, err
	}
	return r.Permissions, nil
}

// missingPermissions returns the entries of want that have lacks.
// book_online doesn't count: anyone gets it by signing up, so it doesn't
// make an account outrank a staff manager (who must be able to promote a
// customer without booking rights of their own).
func missingPermissions(want, have []model.Permission) []model.Permission {
	held := map[model.Permission]bool{model.PermBookOnline: true}
	for _, p := range have {
		held[p] = true
	}
	var out []model.Permission
	for _, p := range want {
		if !held[p] {
			out = append(out, p)
		}
	}
	return out
}

func joinPermissions(perms []model.Permission) string {
	parts := make([]string, len(perms))
	for i, p := range perms {
		parts[i] = string(p)
	}
	return strings.Join(parts, ", ")
}

// MaxTextLen bounds free text people type (notes, reasons): plenty for any
// real explanation, but one request can't load megabytes into every list
// and audit row.
const MaxTextLen = 500

func checkText(field, s string) error {
	if utf8.RuneCountInString(s) > MaxTextLen {
		return fmt.Errorf("%w: %s is too long (at most %d characters)", ErrInvalidBooking, field, MaxTextLen)
	}
	return nil
}
