package repository

import (
	"context"
	"errors"
	"fmt"

	"arena-backend/internal/model"
	"gorm.io/gorm"
)

type BookingRepository struct {
	db *gorm.DB
}

func NewBookingRepository(db *gorm.DB) *BookingRepository {
	return &BookingRepository{db: db}
}

// CheckAndBlockOverlap evaluates if target timings collide with active
// reservations inside an ACID transaction block. Conflicts are resolved
// generically via Court.MutexGroupID (FR-1.2): courts sharing a group id are
// the same physical resource, so a booking on any of them blocks every other
// court in the group for the overlapping time range. This replaces the old
// isHalf/side ("A"/"B"/"FULL") conflict matrix, which only worked for
// basketball and had to be extended by hand for every new shared-resource
// sport - and had already drifted from the frontend's own half-court IDs.
func (r *BookingRepository) CheckAndBlockOverlap(
	ctx context.Context,
	courtID string,
	date string,
	startVal string, // "HH:MM"
	endVal string, // "HH:MM"
	actionFunc func(tx *gorm.DB) error,
) error {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1. Lock the master court record to serialize concurrent threads for this specific court
		var court model.Court
		err := tx.Set("gorm:query_option", "FOR UPDATE").First(&court, "id = ?", courtID).Error
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errors.New("boundary error: selected court does not exist")
			}
			return err
		}
		if !court.IsActive {
			return errors.New("boundary error: court is currently set to inactive")
		}

		// 2. Resolve every court that shares this court's mutex group (itself
		// included), then lock and query overlapping active reservations
		// across all of them.
		mutexCourtIDs := []string{courtID}
		if court.MutexGroupID != nil {
			var siblingIDs []string
			if err := tx.Model(&model.Court{}).
				Where("mutex_group_id = ?", *court.MutexGroupID).
				Pluck("id", &siblingIDs).Error; err != nil {
				return fmt.Errorf("failed to resolve mutex group: %w", err)
			}
			mutexCourtIDs = siblingIDs
		}

		var bookings []model.Booking
		overlapQuery := tx.Where("court_id IN ? AND date = ? AND status != 'CANCELLED' AND NOT (end_time <= ? OR start_time >= ?)",
			mutexCourtIDs, date, startVal, endVal)

		if err := overlapQuery.Find(&bookings).Error; err != nil {
			return fmt.Errorf("failed to scan schedule blocks: %w", err)
		}

		if len(bookings) > 0 {
			b := bookings[0]
			return fmt.Errorf("slot collision: court timing already reserved by active booking %s (%s-%s)", b.ID, b.StartTime, b.EndTime)
		}

		// 3. Perform actions (insert, updates, etc.) inside transactional boundary
		if err := actionFunc(tx); err != nil {
			return err
		}

		return nil
	})

	return err
}

// FetchSlotsForGantt queries timeline lists for specific days to populate interactive client views
func (r *BookingRepository) FetchSlotsForGantt(ctx context.Context, date string, courtType model.CourtType) ([]model.Booking, error) {
	var results []model.Booking
	query := r.db.WithContext(ctx).Table("bookings").Select("bookings.id, bookings.booking_code, bookings.court_id, bookings.user_id, bookings.date, to_char(bookings.start_time, 'HH24:MI') as start_time, to_char(bookings.end_time, 'HH24:MI') as end_time, bookings.is_half_court, bookings.price_type, bookings.total_amount, bookings.status").
		Joins("join courts on bookings.court_id = courts.id").
		Where("bookings.date = ? AND bookings.status != 'CANCELLED'", date)

	if courtType != "" {
		query = query.Where("courts.type = ?", courtType)
	}

	err := query.Find(&results).Error
	if err != nil {
		return nil, err
	}
	return results, nil
}
