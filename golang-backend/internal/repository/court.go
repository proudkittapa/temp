package repository

import (
	"context"
	"fmt"
	"time"

	"arena-backend/internal/model"
	"gorm.io/gorm"
)

type CourtRepository struct {
	db *gorm.DB
}

func NewCourtRepository(db *gorm.DB) *CourtRepository {
	return &CourtRepository{db: db}
}

// FetchAll retrieves all active play lanes, whether basketball, badminton, or meeting options.
func (r *CourtRepository) FetchAll(ctx context.Context, onlyActive bool) ([]model.Court, error) {
	var list []model.Court
	query := r.db.WithContext(ctx)
	if onlyActive {
		query = query.Where("is_active = ?", true)
	}
	err := query.Order("type ASC, name ASC").Find(&list).Error
	if err != nil {
		return nil, fmt.Errorf("failed to fetch courts lists: %w", err)
	}
	return list, nil
}

// ToggleCourtState activates or suspends specific court booking allocations
func (r *CourtRepository) ToggleCourtState(ctx context.Context, courtID string, isActive bool) error {
	err := r.db.WithContext(ctx).Model(&model.Court{}).Where("id = ?", courtID).Update("is_active", isActive).Error
	if err != nil {
		return fmt.Errorf("failed to toggle court availability index: %w", err)
	}
	return nil
}

// CreateDayOff inserts court closures due to tournaments, holidays, or deep cleaning maintenance cycles.
func (r *CourtRepository) CreateDayOff(ctx context.Context, d *model.DayOff) error {
	d.CreatedAt = time.Now()
	err := r.db.WithContext(ctx).Create(d).Error
	if err != nil {
		return fmt.Errorf("failed to record court maintenance day-off blocks: %w", err)
	}
	return nil
}

// IsDayOffActive checks whether a specific hour is blocked for this court
// (FR-1.3): a closure with CourtID = NULL applies to every court, and a
// non-full-day closure only blocks the [StartHour, EndHour) window.
// ListDayOffs returns every closure on a date (all-court and per-court),
// so a multi-slot booking can check them in memory instead of one query
// per slot.
func (r *CourtRepository) ListDayOffs(ctx context.Context, date string) ([]model.DayOff, error) {
	var closures []model.DayOff
	if err := r.db.WithContext(ctx).Where("date = ?", date).Find(&closures).Error; err != nil {
		return nil, fmt.Errorf("failed to load closures: %w", err)
	}
	return closures, nil
}

// ClosureFor returns the closure (if any) that blocks courtID at hour.
func ClosureFor(closures []model.DayOff, courtID string, hour int) *model.DayOff {
	for i, do := range closures {
		if do.CourtID != nil && *do.CourtID != courtID {
			continue
		}
		if do.IsFullDay || do.StartHour == nil || do.EndHour == nil {
			return &closures[i]
		}
		if hour >= *do.StartHour && hour < *do.EndHour {
			return &closures[i]
		}
	}
	return nil
}

// FetchByIDs loads the given courts (any state), keyed by id.
func (r *CourtRepository) FetchByIDs(ctx context.Context, courtIDs []string) (map[string]model.Court, error) {
	var list []model.Court
	if err := r.db.WithContext(ctx).Where("id IN ?", courtIDs).Find(&list).Error; err != nil {
		return nil, fmt.Errorf("failed to load courts: %w", err)
	}
	out := make(map[string]model.Court, len(list))
	for _, c := range list {
		out[c.ID] = c
	}
	return out, nil
}

func (r *CourtRepository) GetPricingConfig(ctx context.Context) (*model.PricingConfig, error) {
	var cfg model.PricingConfig
	if err := r.db.WithContext(ctx).First(&cfg, "id = ?", "global").Error; err != nil {
		return nil, fmt.Errorf("failed to load pricing config: %w", err)
	}
	return &cfg, nil
}

// GetActivePricingRules retrieves custom billing structures matching target court types and dates.
func (r *CourtRepository) GetActivePricingRules(ctx context.Context, cType model.CourtType, isWeekend bool) ([]model.PricingRule, error) {
	dayType := "WEEKDAY"
	if isWeekend {
		dayType = "WEEKEND"
	}

	var rules []model.PricingRule
	err := r.db.WithContext(ctx).
		Where("court_type = ? AND day_type = ? AND is_active = ?", cType, dayType, true).
		Order("start_hour ASC").
		Find(&rules).Error
	if err != nil {
		return nil, fmt.Errorf("failed to pull dynamic pricing profiles: %w", err)
	}
	return rules, nil
}
