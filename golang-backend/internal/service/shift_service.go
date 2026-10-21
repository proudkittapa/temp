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

// ShiftService is the counter's cash drawer (FR-6.1/6.2): a shift opens
// with the cash float in the drawer and closes with the cash counted; the
// expected cash is the float plus every cash payment taken while it was
// open (court bookings and counter sales), so over/short shows at once.
// There is one drawer, so one shift is open at a time. Refunds are paid back
// by transfer, not from the drawer, so they don't lower the expected cash.
type ShiftService struct {
	db  *gorm.DB
	now func() time.Time
}

func NewShiftService(db *gorm.DB) *ShiftService {
	return &ShiftService{db: db, now: time.Now}
}

// ShiftView is a shift with its cash taken so far (open) or at close.
type ShiftView struct {
	model.Shift
	CashBookings float64 `json:"cash_bookings"`
	CashOrders   float64 `json:"cash_orders"`
	Expected     float64 `json:"expected"` // opening float + cash bookings + cash orders
}

// cashBetween sums cash taken in [from, to): approved cash payments for
// bookings and non-voided cash counter orders.
func cashBetween(db *gorm.DB, from, to time.Time) (float64, float64, error) {
	var bookings, orders float64
	if err := db.Model(&model.Payment{}).Select("COALESCE(SUM(amount), 0)").
		Where("method = ? AND verified_at >= ? AND verified_at < ? AND status IN ?", model.PaymentCash, from, to,
			[]model.PaymentStatus{model.PaymentVerified, model.PaymentRefunded}).Scan(&bookings).Error; err != nil {
		return 0, 0, err
	}
	if err := db.Model(&model.Order{}).Select("COALESCE(SUM(total_amount), 0)").
		Where("payment_method = ? AND created_at >= ? AND created_at < ? AND status <> ?", model.PaymentCash, from, to, model.OrderCancelled).
		Scan(&orders).Error; err != nil {
		return 0, 0, err
	}
	return RoundBaht(bookings), RoundBaht(orders), nil
}

func (s *ShiftService) view(db *gorm.DB, sh model.Shift) (*ShiftView, error) {
	to := s.now()
	if sh.ClosedAt != nil {
		to = *sh.ClosedAt
	}
	b, o, err := cashBetween(db, sh.OpenedAt, to)
	if err != nil {
		return nil, err
	}
	v := &ShiftView{Shift: sh, CashBookings: b, CashOrders: o, Expected: RoundBaht(sh.OpeningFloat + b + o)}
	// A closed shift keeps what it was counted against.
	if sh.ExpectedCash != nil {
		v.Expected = *sh.ExpectedCash
	}
	if sh.CashBookingsAtClose != nil && sh.CashOrdersAtClose != nil {
		v.CashBookings, v.CashOrders = *sh.CashBookingsAtClose, *sh.CashOrdersAtClose
	}
	return v, nil
}

// Current returns the open shift with its running totals, or nil.
func (s *ShiftService) Current(ctx context.Context) (*ShiftView, error) {
	db := s.db.WithContext(ctx)
	var sh model.Shift
	if err := db.Where("closed_at IS NULL").Order("opened_at DESC").First(&sh).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return s.view(db, sh)
}

// shiftLockKey serializes opening/closing so two counters can't both open.
const shiftLockKey = 4202

// lockDrawerShared is taken (shared) by every cash payment before it stamps
// its time; Open/Close take the same key exclusively. A cash sale that
// commits while a shift is being closed therefore either finishes first
// (and is counted) or waits and lands in the next shift - never in neither.
func lockDrawerShared(tx *gorm.DB) error {
	return tx.Exec("SELECT pg_advisory_xact_lock_shared(?)", shiftLockKey).Error
}

// ErrNoOpenShift: cash may only be taken while a drawer shift is open -
// cash taken outside one is in no shift's count, so the drawer never adds
// up (owner decision 2026-10-21).
var ErrNoOpenShift = errors.New("open the cash drawer shift before taking cash")

// lockDrawerForCash is lockDrawerShared for money coming into the drawer:
// after the lock (so a shift being closed has finished), it refuses when no
// shift is open.
func lockDrawerForCash(tx *gorm.DB) error {
	if err := lockDrawerShared(tx); err != nil {
		return err
	}
	var open int64
	if err := tx.Model(&model.Shift{}).Where("closed_at IS NULL").Count(&open).Error; err != nil {
		return err
	}
	if open == 0 {
		return ErrNoOpenShift
	}
	return nil
}

// Open starts a shift with the float counted into the drawer.
func (s *ShiftService) Open(ctx context.Context, openingFloat float64, staffID, staffName string) (*ShiftView, error) {
	if openingFloat < 0 || openingFloat > 1000000 {
		return nil, fmt.Errorf("%w: opening float must be between 0 and 1,000,000 THB", ErrInvalidBooking)
	}
	var out *ShiftView
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", shiftLockKey).Error; err != nil {
			return err
		}
		var open int64
		if err := tx.Model(&model.Shift{}).Where("closed_at IS NULL").Count(&open).Error; err != nil {
			return err
		}
		if open > 0 {
			return fmt.Errorf("%w: a shift is already open - close it first", ErrInvalidState)
		}
		sh := model.Shift{ID: ids.New("shf"), StaffID: staffID, StaffName: staffName, OpenedAt: s.now(), OpeningFloat: RoundBaht(openingFloat)}
		if err := tx.Create(&sh).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: staffID, UserName: staffName, Action: "SHIFT_OPENED", TargetType: "Shift", TargetID: sh.ID,
			AfterState: model.AuditJSON(map[string]any{"opening_float": sh.OpeningFloat}), CreatedAt: sh.OpenedAt,
		}).Error; err != nil {
			return err
		}
		v, err := s.view(tx, sh)
		out = v
		return err
	})
	return out, err
}

// Close records the counted cash and stores expected and variance
// (counted - expected: positive = over, negative = short).
func (s *ShiftService) Close(ctx context.Context, counted float64, notes, staffID, staffName string) (*ShiftView, error) {
	if counted < 0 || counted > 10000000 {
		return nil, fmt.Errorf("%w: counted cash must be 0 or more", ErrInvalidBooking)
	}
	notes = strings.TrimSpace(notes)
	var out *ShiftView
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", shiftLockKey).Error; err != nil {
			return err
		}
		var sh model.Shift
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("closed_at IS NULL").Order("opened_at DESC").First(&sh).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return fmt.Errorf("%w: no shift is open", ErrInvalidState)
			}
			return err
		}
		now := s.now()
		sh.ClosedAt = &now
		v, err := s.view(tx, sh)
		if err != nil {
			return err
		}
		counted = RoundBaht(counted)
		variance := RoundBaht(counted - v.Expected)
		if variance != 0 && notes == "" {
			return fmt.Errorf("%w: the count is %.2f THB off - add a note explaining it", ErrInvalidBooking, variance)
		}
		sh.CountedCash, sh.ExpectedCash, sh.VarianceCash = &counted, &v.Expected, &variance
		sh.CashBookingsAtClose, sh.CashOrdersAtClose = &v.CashBookings, &v.CashOrders
		sh.ClosedByID, sh.ClosedByName = &staffID, &staffName
		if notes != "" {
			sh.Notes = &notes
		}
		if err := tx.Save(&sh).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: staffID, UserName: staffName, Action: "SHIFT_CLOSED", TargetType: "Shift", TargetID: sh.ID,
			AfterState: model.AuditJSON(map[string]any{"opening_float": sh.OpeningFloat, "expected": v.Expected, "counted": counted, "variance": variance}),
			Reason:     sh.Notes, CreatedAt: now,
		}).Error; err != nil {
			return err
		}
		v.Shift = sh
		out = v
		return nil
	})
	return out, err
}

// List returns shifts opened in [from, to), newest first (managers).
func (s *ShiftService) List(ctx context.Context, from, to time.Time) ([]ShiftView, error) {
	db := s.db.WithContext(ctx)
	var shifts []model.Shift
	if err := db.Where("opened_at >= ? AND opened_at < ?", from, to).Order("opened_at DESC").Limit(500).Find(&shifts).Error; err != nil {
		return nil, err
	}
	out := make([]ShiftView, 0, len(shifts))
	for _, sh := range shifts {
		v, err := s.view(db, sh)
		if err != nil {
			return nil, err
		}
		out = append(out, *v)
	}
	return out, nil
}
