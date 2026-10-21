package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// RoleService manages roles (named permission sets) and answers which
// permissions a role has - Authenticate asks on every request, so a role
// edit applies at once.
type RoleService struct {
	db  *gorm.DB
	now func() time.Time
}

func NewRoleService(db *gorm.DB) *RoleService {
	return &RoleService{db: db, now: time.Now}
}

// SeedBuiltins creates the built-in roles if missing. Existing rows are left
// alone (the admin may have edited them), except that ADMIN always keeps
// manage_roles.
func (s *RoleService) SeedBuiltins(ctx context.Context) error {
	for _, r := range model.BuiltinRoles {
		r.CreatedAt, r.UpdatedAt = s.now(), s.now()
		if err := s.db.WithContext(ctx).Where(model.Role{ID: r.ID}).FirstOrCreate(&r).Error; err != nil {
			return fmt.Errorf("seed role %s: %w", r.ID, err)
		}
		if r.ID == string(model.RoleAdmin) && !hasPerm(r.Permissions, model.PermManageRoles) {
			r.Permissions = append(r.Permissions, model.PermManageRoles)
			// Through the struct, not a column map: only then does GORM apply
			// the json serializer to the permissions column.
			if err := s.db.WithContext(ctx).Model(&r).Select("permissions").Updates(&r).Error; err != nil {
				return err
			}
		}
	}
	return nil
}

// Permissions returns the permissions of role id. A built-in role whose
// row is missing falls back to its default set; an unknown role has none.
func (s *RoleService) Permissions(ctx context.Context, roleID string) ([]model.Permission, error) {
	var r model.Role
	err := s.db.WithContext(ctx).First(&r, "id = ?", roleID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		for _, b := range model.BuiltinRoles {
			if b.ID == roleID {
				return b.Permissions, nil
			}
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return r.Permissions, nil
}

// RoleWithCount is a role plus how many accounts have it.
type RoleWithCount struct {
	model.Role
	UserCount int64 `json:"user_count"`
}

func (s *RoleService) List(ctx context.Context) ([]RoleWithCount, error) {
	var roles []model.Role
	if err := s.db.WithContext(ctx).Order("is_builtin DESC, created_at, id").Find(&roles).Error; err != nil {
		return nil, err
	}
	type count struct {
		Role string
		N    int64
	}
	var counts []count
	if err := s.db.WithContext(ctx).Model(&model.User{}).Select("role, count(*) AS n").Group("role").Scan(&counts).Error; err != nil {
		return nil, err
	}
	byRole := map[string]int64{}
	for _, c := range counts {
		byRole[c.Role] = c.N
	}
	out := make([]RoleWithCount, len(roles))
	for i, r := range roles {
		out[i] = RoleWithCount{Role: r, UserCount: byRole[r.ID]}
	}
	return out, nil
}

// Exists reports whether role id exists (users may only be given one that does).
func (s *RoleService) Exists(ctx context.Context, roleID string) (bool, error) {
	var n int64
	err := s.db.WithContext(ctx).Model(&model.Role{}).Where("id = ?", roleID).Count(&n).Error
	return n > 0, err
}

type RoleInput struct {
	Name        string             `json:"name"`
	Permissions []model.Permission `json:"permissions"`
}

func cleanRoleInput(in RoleInput) (RoleInput, error) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len([]rune(in.Name)) > 60 {
		return in, fmt.Errorf("%w: role name is required (max 60 characters)", ErrInvalidBooking)
	}
	seen := map[model.Permission]bool{}
	clean := []model.Permission{}
	for _, p := range in.Permissions {
		if !model.IsValidPermission(p) {
			return in, fmt.Errorf("%w: unknown permission %q", ErrInvalidBooking, p)
		}
		if !seen[p] {
			seen[p] = true
			clean = append(clean, p)
		}
	}
	in.Permissions = clean
	return in, nil
}

func (s *RoleService) Create(ctx context.Context, in RoleInput, actorID, actorName string) (*model.Role, error) {
	in, err := cleanRoleInput(in)
	if err != nil {
		return nil, err
	}
	r := model.Role{ID: ids.New("role"), Name: in.Name, Permissions: in.Permissions, CreatedAt: s.now(), UpdatedAt: s.now()}
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.checkNameFree(tx, "", in.Name); err != nil {
			return err
		}
		if err := tx.Create(&r).Error; err != nil {
			return err
		}
		return s.audit(tx, actorID, actorName, "ROLE_CREATED", r.ID, nil, r)
	})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *RoleService) Update(ctx context.Context, id string, in RoleInput, actorID, actorName string) (*model.Role, error) {
	in, err := cleanRoleInput(in)
	if err != nil {
		return nil, err
	}
	var r model.Role
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&r, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		// ADMIN keeps role management, or nobody could ever fix roles again.
		if r.ID == string(model.RoleAdmin) && !hasPerm(in.Permissions, model.PermManageRoles) {
			return fmt.Errorf("%w: the Admin role must keep \"manage roles\"", ErrInvalidState)
		}
		if err := s.checkNameFree(tx, r.ID, in.Name); err != nil {
			return err
		}
		before := r
		r.Name, r.Permissions, r.UpdatedAt = in.Name, in.Permissions, s.now()
		if err := tx.Model(&r).Select("name", "permissions", "updated_at").Updates(&r).Error; err != nil {
			return err
		}
		return s.audit(tx, actorID, actorName, "ROLE_UPDATED", r.ID, before, r)
	})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// Delete removes a custom role nobody has. Built-in roles can't be deleted.
func (s *RoleService) Delete(ctx context.Context, id, actorID, actorName string) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var r model.Role
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&r, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		if r.IsBuiltin {
			return fmt.Errorf("%w: built-in roles can't be deleted", ErrInvalidState)
		}
		var n int64
		if err := tx.Model(&model.User{}).Where("role = ?", r.ID).Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			return fmt.Errorf("%w: %d account(s) still have this role - give them another role first", ErrInvalidState, n)
		}
		if err := tx.Delete(&r).Error; err != nil {
			return err
		}
		return s.audit(tx, actorID, actorName, "ROLE_DELETED", r.ID, r, nil)
	})
}

func (s *RoleService) checkNameFree(tx *gorm.DB, exceptID, name string) error {
	var n int64
	if err := tx.Model(&model.Role{}).Where("id <> ? AND LOWER(name) = LOWER(?)", exceptID, name).Count(&n).Error; err != nil {
		return err
	}
	if n > 0 {
		return fmt.Errorf("%w: a role named %q already exists", ErrInvalidState, name)
	}
	return nil
}

func (s *RoleService) audit(tx *gorm.DB, actorID, actorName, action, targetID string, before, after any) error {
	b, a := "", ""
	if before != nil {
		b = model.AuditJSON(before)
	}
	if after != nil {
		a = model.AuditJSON(after)
	}
	return tx.Create(&model.AuditLog{
		ID: ids.New("log"), UserID: actorID, UserName: actorName, Action: action,
		TargetType: "Role", TargetID: targetID, BeforeState: b, AfterState: a, CreatedAt: s.now(),
	}).Error
}

func hasPerm(perms []model.Permission, p model.Permission) bool {
	for _, x := range perms {
		if x == p {
			return true
		}
	}
	return false
}
