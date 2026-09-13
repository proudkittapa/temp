package repository

import (
	"context"
	"errors"
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

// IsDayOffActive checks whether a date is blocked for this court
func (r *CourtRepository) IsDayOffActive(ctx context.Context, date string, courtID string) (bool, string, error) {
	var do model.DayOff
	err := r.db.WithContext(ctx).Where("date = ? AND (court_id = 'all' OR court_id = ?)", date, courtID).First(&do).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, "", nil
		}
		return false, "", err
	}
	return true, do.Reason, nil
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
