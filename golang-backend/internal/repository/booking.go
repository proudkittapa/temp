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

// CheckAndBlockOverlap evaluates if target timings collide with active reservations inside an ACID transaction block.
func (r *BookingRepository) CheckAndBlockOverlap(
	ctx context.Context,
	courtID string,
	date string,
	startVal string, // "HH:MM"
	endVal string,   // "HH:MM"
	isHalf bool,
	side string, // "A", "B", "FULL"
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

		// 2. Query other overlapping active reservations matching courtID, date, and status parameters
		var bookings []model.Booking
		overlapQuery := tx.Where("court_id = ? AND date = ? AND status != 'CANCELLED' AND NOT (end_time <= ? OR start_time >= ?)",
			courtID, date, startVal, endVal)
		
		if err := overlapQuery.Find(&bookings).Error; err != nil {
			return fmt.Errorf("failed to scan schedule blocks: %w", err)
		}

		for _, b := range bookings {
			existingSideVal := "FULL"
			if b.HalfCourtSide != nil {
				existingSideVal = *b.HalfCourtSide
			}

			// Conflict Matrix rules:
			if !isHalf {
				return fmt.Errorf("slot collision: court timing already reserved by active booking %s (%s-%s)", b.ID, b.StartTime, b.EndTime)
			} else {
				if !b.IsHalfCourt || existingSideVal == "FULL" {
					return fmt.Errorf("slot collision: entire court has been reserved by full booking %s during %s-%s", b.ID, b.StartTime, b.EndTime)
				}
				if existingSideVal == side {
					return fmt.Errorf("slot collision: Half-court Side %s is already reserved by active booking %s", side, b.ID)
				}
			}
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
	query := r.db.WithContext(ctx).Table("bookings").Select("bookings.id, bookings.booking_code, bookings.court_id, bookings.user_id, bookings.date, to_char(bookings.start_time, 'HH24:MI') as start_time, to_char(bookings.end_time, 'HH24:MI') as end_time, bookings.is_half_court, bookings.half_court_side, bookings.price_type, bookings.total_amount, bookings.status").
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
