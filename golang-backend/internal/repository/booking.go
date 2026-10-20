package repository

import (
	"context"
	"errors"
	"fmt"

	"arena-backend/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrSlotTaken is returned (wrapped) when a requested slot overlaps an
// active booking on the same court or a conflicting mutex-group sibling.
var ErrSlotTaken = errors.New("slot already booked")

type BookingRepository struct {
	db *gorm.DB
}

func NewBookingRepository(db *gorm.DB) *BookingRepository {
	return &BookingRepository{db: db}
}

// LockKey identifies the row set LockCourtGroupTx locks for a court: its
// mutex group, or the court itself when it has none. Callers booking several
// courts in one transaction must lock in LockKey order - sorting by court id
// alone isn't enough, because locking one member locks the whole group, so
// two requests could otherwise take the same locks in opposite orders.
func LockKey(c model.Court) string {
	if c.MutexGroupID != nil {
		return "group:" + *c.MutexGroupID
	}
	return "court:" + c.ID
}

// LockCourtGroupTx locks (SELECT ... FOR UPDATE, ordered by id) every court
// in `court`'s mutex group - or just the court, if it has no group - and
// returns them. Locking the whole group serializes bookings across a shared
// physical resource: locking only the target row would let a full-court and
// a half-court booking for the same hour both pass CheckOverlapTx before
// either commits. Fails if the target court is inactive.
func (r *BookingRepository) LockCourtGroupTx(tx *gorm.DB, court model.Court) ([]model.Court, error) {
	q := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Order("id")
	if court.MutexGroupID != nil {
		q = q.Where("mutex_group_id = ?", *court.MutexGroupID)
	} else {
		q = q.Where("id = ?", court.ID)
	}
	var group []model.Court
	if err := q.Find(&group).Error; err != nil {
		return nil, fmt.Errorf("failed to lock court group: %w", err)
	}
	for _, c := range group {
		if c.ID == court.ID {
			if !c.IsActive {
				return nil, fmt.Errorf("%w: %s is currently closed for booking", ErrSlotTaken, c.Name)
			}
			return group, nil
		}
	}
	return nil, errors.New("boundary error: selected court does not exist")
}

// CheckOverlapTx fails with ErrSlotTaken if [startVal, endVal) on date
// overlaps an active booking on `court` or a conflicting sibling in its
// (already locked) mutex group. Conflicts are resolved via
// Court.MutexGroupID/IsHub (FR-1.2): the group's hub (full court) is
// exclusive with every sibling, but two non-hub sub-allocations (e.g.
// half-court sides B and C) do NOT block each other. Rows inserted earlier
// in the same transaction are visible, so slots within one multi-slot
// request can't double-book each other either.
func (r *BookingRepository) CheckOverlapTx(
	tx *gorm.DB,
	court model.Court,
	groupCourts []model.Court,
	date string,
	startVal string, // "HH:MM"
	endVal string, // "HH:MM"
) error {
	mutexCourtIDs := model.ConflictingCourtIDs(court, groupCourts)

	var bookings []model.Booking
	if err := tx.Where("court_id IN ? AND date = ? AND status != ? AND NOT (end_time <= ? OR start_time >= ?)",
		mutexCourtIDs, date, model.BookingCancelled, startVal, endVal).
		Find(&bookings).Error; err != nil {
		return fmt.Errorf("failed to scan schedule blocks: %w", err)
	}
	if len(bookings) > 0 {
		b := bookings[0]
		return fmt.Errorf("%w: %s %s-%s is already reserved", ErrSlotTaken, court.Name, b.StartTime, b.EndTime)
	}
	return nil
}

// FetchSlotsForGantt queries timeline lists for specific days to populate
// interactive client views. Callers must strip personal fields before
// returning rows to anyone but staff (see handler.sanitizeBookings).
func (r *BookingRepository) FetchSlotsForGantt(ctx context.Context, date string, courtType model.CourtType) ([]model.Booking, error) {
	var results []model.Booking
	query := r.db.WithContext(ctx).Table("bookings").Select("bookings.id, bookings.booking_code, bookings.court_id, bookings.user_id, to_char(bookings.date, 'YYYY-MM-DD') as date, bookings.start_time, bookings.end_time, bookings.is_half_court, bookings.price_type, bookings.total_amount, bookings.status").
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
