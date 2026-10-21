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

// CourtAdminService lets admins add courts and open/close them for
// booking. Courts are never deleted: bookings and reports point at them.
type CourtAdminService struct {
	db  *gorm.DB
	now func() time.Time
}

func NewCourtAdminService(db *gorm.DB) *CourtAdminService {
	return &CourtAdminService{db: db, now: time.Now}
}

// List returns every court, closed ones included, in display order.
func (s *CourtAdminService) List(ctx context.Context) ([]model.Court, error) {
	var courts []model.Court
	err := s.db.WithContext(ctx).Order("type, created_at, id").Find(&courts).Error
	return courts, err
}

type CourtInput struct {
	Name      string          `json:"name"`
	Type      model.CourtType `json:"type"`
	HalfCourt bool            `json:"half_court"` // priced at the half-court rate (create only)
	// HalfOf is the full court a new half court is part of (required with
	// half_court): the two then can't be booked at the same time, and
	// occupancy counts the half as half of that court.
	HalfOf      string `json:"half_of,omitempty"`
	OffPeakOnly *bool  `json:"off_peak_only"` // FR-1.2
	IsActive    *bool  `json:"is_active"`
}

func cleanCourtName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 100 {
		return "", fmt.Errorf("%w: court name is required (max 100 characters)", ErrInvalidBooking)
	}
	return name, nil
}

// Create adds a court: standalone, or a half of an existing full court
// (HalfOf). Its sport needs pricing rules, which already exist per sport.
func (s *CourtAdminService) Create(ctx context.Context, in CourtInput, actorID, actorName string) (*model.Court, error) {
	name, err := cleanCourtName(in.Name)
	if err != nil {
		return nil, err
	}
	if !validCourtTypes[in.Type] {
		return nil, fmt.Errorf("%w: unknown court type %q", ErrInvalidBooking, in.Type)
	}
	c := model.Court{
		ID: ids.New(strings.ToLower(string(in.Type))[:3]), Name: name, Type: in.Type,
		ShareOfGroup: 1, IsActive: true, CreatedAt: s.now(),
	}
	if in.HalfCourt {
		c.ShareOfGroup = 0.5
	}
	if in.OffPeakOnly != nil {
		c.OffPeakOnly = *in.OffPeakOnly
	}
	if in.HalfCourt && strings.TrimSpace(in.HalfOf) == "" {
		return nil, fmt.Errorf("%w: a half court must be part of a full court - choose which court it is half of", ErrInvalidBooking)
	}
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if in.HalfCourt {
			// Join the full court's group (giving it one if it has none), so
			// the half and the full court block each other.
			var full model.Court
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&full, "id = ?", strings.TrimSpace(in.HalfOf)).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return fmt.Errorf("%w: court %q does not exist", ErrInvalidBooking, in.HalfOf)
				}
				return err
			}
			if full.ShareOfGroup < 1 || full.Type != in.Type {
				return fmt.Errorf("%w: a half court must be part of a full %s court", ErrInvalidBooking, in.Type)
			}
			if full.MutexGroupID == nil || *full.MutexGroupID == "" {
				group := "grp-" + full.ID
				if err := tx.Model(&full).Update("mutex_group_id", group).Error; err != nil {
					return err
				}
				full.MutexGroupID = &group
			}
			c.MutexGroupID = full.MutexGroupID
		}
		var same int64
		if err := tx.Model(&model.Court{}).Where("LOWER(name) = LOWER(?)", name).Count(&same).Error; err != nil {
			return err
		}
		if same > 0 {
			return fmt.Errorf("%w: a court named %q already exists", ErrInvalidState, name)
		}
		if err := tx.Create(&c).Error; err != nil {
			return err
		}
		return tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: actorID, UserName: actorName, Action: "COURT_CREATED",
			TargetType: "Court", TargetID: c.ID, AfterState: model.AuditJSON(c), CreatedAt: s.now(),
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// CourtUpdateResult reports, when a court is closed, how many upcoming
// bookings still stand on it - they are not cancelled automatically.
type CourtUpdateResult struct {
	Court            model.Court     `json:"court"`
	UpcomingBookings int64           `json:"upcoming_bookings"`
	Upcoming         []model.Booking `json:"upcoming,omitempty"` // to move or cancel (with refund)
}

// Update renames a court, opens or closes it for new bookings, or sets
// off-peak-only. Its type and half-court share stay fixed (prices and old
// bookings depend on them).
func (s *CourtAdminService) Update(ctx context.Context, id string, in CourtInput, actorID, actorName string) (*CourtUpdateResult, error) {
	out := &CourtUpdateResult{}
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var c model.Court
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&c, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		before := c
		if strings.TrimSpace(in.Name) != "" {
			name, err := cleanCourtName(in.Name)
			if err != nil {
				return err
			}
			c.Name = name
		}
		if in.IsActive != nil {
			c.IsActive = *in.IsActive
		}
		if in.OffPeakOnly != nil {
			c.OffPeakOnly = *in.OffPeakOnly
		}
		if err := tx.Model(&c).Updates(map[string]interface{}{"name": c.Name, "is_active": c.IsActive, "off_peak_only": c.OffPeakOnly}).Error; err != nil {
			return err
		}
		if !c.IsActive {
			today := s.now().In(Bangkok).Format("2006-01-02")
			if err := tx.Where("court_id = ? AND date >= ? AND status IN ?", c.ID, today,
				[]model.BookingStatus{model.BookingPendingPayment, model.BookingConfirmed}).
				Order("date, start_time").Find(&out.Upcoming).Error; err != nil {
				return err
			}
			out.Upcoming = normalizeDates(out.Upcoming)
			out.UpcomingBookings = int64(len(out.Upcoming))
		}
		out.Court = c
		return tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: actorID, UserName: actorName, Action: "COURT_UPDATED",
			TargetType: "Court", TargetID: c.ID, BeforeState: model.AuditJSON(before), AfterState: model.AuditJSON(c), CreatedAt: s.now(),
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
