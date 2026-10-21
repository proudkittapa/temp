package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
	"gorm.io/gorm"
)

// DayOffService manages court closures (FR-1.3: holidays, tournaments,
// maintenance). They live in the database because CreateBookings enforces
// them - a closure kept only in one browser's localStorage never reached
// the booking checks, so customers could still book a closed court.
type DayOffService struct {
	db  *gorm.DB
	now func() time.Time
}

func NewDayOffService(db *gorm.DB) *DayOffService {
	return &DayOffService{db: db, now: time.Now}
}

type CreateDayOffInput struct {
	Date      string  `json:"date"`
	CourtID   *string `json:"court_id"` // nil (or "all") = every court
	Reason    string  `json:"reason"`
	IsFullDay bool    `json:"is_full_day"`
	StartHour *int    `json:"start_hour"` // required when !IsFullDay
	EndHour   *int    `json:"end_hour"`
}

type CreateDayOffResult struct {
	DayOff model.DayOff `json:"day_off"`
	// Active bookings the new closure overlaps. A closure only blocks new
	// bookings; these still stand, so staff need to contact the customers.
	AffectedBookings []model.Booking `json:"affected_bookings"`
}

// List returns closures with from <= date <= to (to may be empty for "no
// upper bound"), oldest first.
func (s *DayOffService) List(ctx context.Context, from, to string) ([]model.DayOff, error) {
	q := s.db.WithContext(ctx).Where("date >= ?", from)
	if to != "" {
		q = q.Where("date <= ?", to)
	}
	var list []model.DayOff
	if err := q.Order("date, start_hour NULLS FIRST, created_at").Limit(1000).Find(&list).Error; err != nil {
		return nil, err
	}
	for i := range list {
		normalizeDayOff(&list[i])
	}
	return list, nil
}

// Create validates and stores a closure, audit-logged as the acting
// manager/admin.
func (s *DayOffService) Create(ctx context.Context, in CreateDayOffInput, actorID, actorName string) (*CreateDayOffResult, error) {
	day, err := time.ParseInLocation("2006-01-02", in.Date, Bangkok)
	if err != nil {
		return nil, fmt.Errorf("%w: date must be YYYY-MM-DD", ErrInvalidBooking)
	}
	y, m, d := s.now().In(Bangkok).Date()
	today := time.Date(y, m, d, 0, 0, 0, 0, Bangkok)
	if day.Before(today) {
		return nil, fmt.Errorf("%w: cannot close a date in the past", ErrInvalidBooking)
	}
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Reason == "" {
		return nil, fmt.Errorf("%w: a reason is required", ErrInvalidBooking)
	}
	if in.CourtID != nil && (*in.CourtID == "" || *in.CourtID == "all") {
		in.CourtID = nil
	}
	if in.IsFullDay {
		in.StartHour, in.EndHour = nil, nil
	} else if in.StartHour == nil || in.EndHour == nil || !validHourRange(*in.StartHour, *in.EndHour) {
		return nil, fmt.Errorf("%w: a partial closure needs start_hour < end_hour within 0-24", ErrInvalidBooking)
	}

	res := &CreateDayOffResult{AffectedBookings: []model.Booking{}}
	err = repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		// Wait for bookings on this date that are mid-transaction (they
		// hold the lock shared) and keep new ones out until this closure
		// is committed - otherwise a booking that checked closures a moment
		// before could still be written into the closed window. A booking
		// that got in first is then listed below as affected.
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?, hashtext(?))", closureLockClass, in.Date).Error; err != nil {
			return err
		}
		// The courts this closure covers: the named court plus the ones that
		// conflict with it (model.CourtsConflict), for "affected bookings".
		var coveredCourtIDs []string
		if in.CourtID != nil {
			var closed model.Court
			if err := tx.First(&closed, "id = ?", *in.CourtID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return fmt.Errorf("%w: court %q does not exist", ErrInvalidBooking, *in.CourtID)
				}
				return err
			}
			group := []model.Court{closed}
			if closed.MutexGroupID != nil {
				if err := tx.Where("mutex_group_id = ?", *closed.MutexGroupID).Find(&group).Error; err != nil {
					return err
				}
			}
			coveredCourtIDs = model.ConflictingCourtIDs(closed, group)
		}
		now := s.now()
		d := model.DayOff{
			ID:        ids.New("do"),
			Date:      in.Date,
			CourtID:   in.CourtID,
			Reason:    in.Reason,
			IsFullDay: in.IsFullDay,
			StartHour: in.StartHour,
			EndHour:   in.EndHour,
			CreatedAt: now,
		}
		if err := tx.Create(&d).Error; err != nil {
			return err
		}
		res.DayOff = d

		// A no-show no longer holds its court: nobody to contact.
		q := tx.Where("date = ? AND status NOT IN ?", in.Date, []model.BookingStatus{model.BookingCancelled, model.BookingNoShow})
		if in.CourtID != nil {
			q = q.Where("court_id IN ?", coveredCourtIDs)
		}
		if !in.IsFullDay {
			q = q.Where("start_time < ? AND end_time > ?", fmt.Sprintf("%02d:00", *in.EndHour), fmt.Sprintf("%02d:00", *in.StartHour))
		}
		if err := q.Order("start_time, court_id").Find(&res.AffectedBookings).Error; err != nil {
			return err
		}
		normalizeDates(res.AffectedBookings)

		return tx.Create(&model.AuditLog{
			ID:         ids.New("log"),
			UserID:     actorID,
			UserName:   actorName,
			Action:     "DAY_OFF_CREATED",
			TargetType: "DayOff",
			TargetID:   d.ID,
			AfterState: model.AuditJSON(map[string]any{
				"date": d.Date, "court_id": d.CourtID, "reason": d.Reason, "is_full_day": d.IsFullDay,
				"start_hour": d.StartHour, "end_hour": d.EndHour, "affected_bookings": len(res.AffectedBookings),
			}),
			Reason:    &in.Reason,
			CreatedAt: now,
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// Delete removes a closure (reopening the court), audit-logged.
func (s *DayOffService) Delete(ctx context.Context, id, actorID, actorName string) error {
	return repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		var d model.DayOff
		if err := tx.First(&d, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		normalizeDayOff(&d)
		if err := tx.Delete(&d).Error; err != nil {
			return err
		}
		return tx.Create(&model.AuditLog{
			ID:          ids.New("log"),
			UserID:      actorID,
			UserName:    actorName,
			Action:      "DAY_OFF_DELETED",
			TargetType:  "DayOff",
			TargetID:    d.ID,
			BeforeState: model.AuditJSON(d),
			CreatedAt:   s.now(),
		}).Error
	})
}

func normalizeDayOff(d *model.DayOff) {
	if len(d.Date) > 10 {
		d.Date = d.Date[:10]
	}
}
