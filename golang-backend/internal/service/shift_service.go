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
	// Rental deposits taken minus deposits given back while open.
	CashDeposits float64 `json:"cash_deposits"`
	Expected     float64 `json:"expected"` // opening float + cash bookings + cash orders + deposits
	// Blind: the cash figures above are withheld (counter staff, see
	// handler.blindCount).
	Blind bool `json:"blind,omitempty"`
}

// cashBetween sums cash taken in [from, to): approved cash payments for
// bookings, non-voided cash counter orders, and rental deposits (taken,
// voided rentals too, minus those given back).
func cashBetween(db *gorm.DB, from, to time.Time) (float64, float64, float64, error) {
	var bookings, orders, depIn, depOut float64
	if err := db.Model(&model.Payment{}).Select("COALESCE(SUM(amount), 0)").
		Where("method = ? AND verified_at >= ? AND verified_at < ? AND status IN ?", model.PaymentCash, from, to,
			[]model.PaymentStatus{model.PaymentVerified, model.PaymentRefunded}).Scan(&bookings).Error; err != nil {
		return 0, 0, 0, err
	}
	if err := db.Model(&model.Order{}).Select("COALESCE(SUM(total_amount), 0)").
		Where("payment_method = ? AND created_at >= ? AND created_at < ? AND status <> ?", model.PaymentCash, from, to, model.OrderCancelled).
		Scan(&orders).Error; err != nil {
		return 0, 0, 0, err
	}
	if err := db.Model(&model.Order{}).Select("COALESCE(SUM(deposit_amount), 0)").
		Where("created_at >= ? AND created_at < ?", from, to).Scan(&depIn).Error; err != nil {
		return 0, 0, 0, err
	}
	if err := db.Model(&model.Order{}).Select("COALESCE(SUM(deposit_returned), 0)").
		Where("deposit_settled_at >= ? AND deposit_settled_at < ?", from, to).Scan(&depOut).Error; err != nil {
		return 0, 0, 0, err
	}
	return RoundBaht(bookings), RoundBaht(orders), RoundBaht(depIn - depOut), nil
}

func (s *ShiftService) view(db *gorm.DB, sh model.Shift) (*ShiftView, error) {
	// A closed shift with its figures frozen at close needs no queries (the
	// shift history used to recount every shift: 3 queries each).
	if sh.ClosedAt != nil && sh.ExpectedCash != nil && sh.CashBookingsAtClose != nil && sh.CashOrdersAtClose != nil && sh.CashDepositsAtClose != nil {
		return &ShiftView{Shift: sh, CashBookings: *sh.CashBookingsAtClose, CashOrders: *sh.CashOrdersAtClose,
			CashDeposits: *sh.CashDepositsAtClose, Expected: *sh.ExpectedCash}, nil
	}
	to := s.now()
	if sh.ClosedAt != nil {
		to = *sh.ClosedAt
	}
	b, o, d, err := cashBetween(db, sh.OpenedAt, to)
	if err != nil {
		return nil, err
	}
	v := &ShiftView{Shift: sh, CashBookings: b, CashOrders: o, CashDeposits: d, Expected: RoundBaht(sh.OpeningFloat + b + o + d)}
	// A closed shift keeps what it was counted against.
	if sh.ExpectedCash != nil {
		v.Expected = *sh.ExpectedCash
	}
	if sh.CashBookingsAtClose != nil && sh.CashOrdersAtClose != nil {
		v.CashBookings, v.CashOrders = *sh.CashBookingsAtClose, *sh.CashOrdersAtClose
	}
	if sh.CashDepositsAtClose != nil {
		v.CashDeposits = *sh.CashDepositsAtClose
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

// LastCount is the cash counted when the last shift was closed - what the
// drawer should hold when the next one opens - or nil before the first.
func (s *ShiftService) LastCount(ctx context.Context) (*float64, error) {
	return lastCount(s.db.WithContext(ctx))
}

func lastCount(db *gorm.DB) (*float64, error) {
	var last []model.Shift
	if err := db.Select("counted_cash").Where("closed_at IS NOT NULL AND counted_cash IS NOT NULL").
		Order("closed_at DESC").Limit(1).Find(&last).Error; err != nil {
		return nil, err
	}
	if len(last) == 0 {
		return nil, nil
	}
	return last[0].CountedCash, nil
}

// Open starts a shift with the float counted into the drawer. A float other
// than the cash counted at the last close (money taken to the bank, a
// different drawer) needs a note, so a gap between two shifts is explained
// rather than unnoticed.
func (s *ShiftService) Open(ctx context.Context, openingFloat float64, note, staffID, staffName string) (*ShiftView, error) {
	if openingFloat < 0 || openingFloat > 10000000 {
		return nil, fmt.Errorf("%w: opening float must be between 0 and 10,000,000 THB", ErrInvalidBooking)
	}
	note = strings.TrimSpace(note)
	if err := checkText("note", note); err != nil {
		return nil, err
	}
	var out *ShiftView
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
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
		float := RoundBaht(openingFloat)
		last, err := lastCount(tx)
		if err != nil {
			return err
		}
		if last != nil && float != *last && note == "" {
			return fmt.Errorf("%w: the opening float differs from the last count (%.2f THB) - add a note explaining it", ErrInvalidBooking, *last)
		}
		sh := model.Shift{ID: ids.New("shf"), StaffID: staffID, StaffName: staffName, OpenedAt: s.now(), OpeningFloat: float}
		if note != "" {
			sh.OpeningNote = &note
		}
		if err := tx.Create(&sh).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: staffID, UserName: staffName, Action: "SHIFT_OPENED", TargetType: "Shift", TargetID: sh.ID,
			AfterState: model.AuditJSON(map[string]any{"opening_float": sh.OpeningFloat, "last_count": last}),
			Reason:     sh.OpeningNote, CreatedAt: sh.OpenedAt,
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
// (counted - expected: positive = over, negative = short). blind: the
// closer may not see the expected cash (no view_reports), so an off count
// is refused without saying by how much - the figure would give the
// expected cash away to a probe with counted_cash 0.
func (s *ShiftService) Close(ctx context.Context, counted float64, notes, staffID, staffName string, blind bool) (*ShiftView, error) {
	if counted < 0 || counted > 10000000 {
		return nil, fmt.Errorf("%w: counted cash must be 0 or more", ErrInvalidBooking)
	}
	notes = strings.TrimSpace(notes)
	if err := checkText("notes", notes); err != nil {
		return nil, err
	}
	var out *ShiftView
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
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
			if blind {
				return fmt.Errorf("%w: the count doesn't match - count again, or add a note explaining the difference", ErrInvalidBooking)
			}
			return fmt.Errorf("%w: the count is %.2f THB off - add a note explaining it", ErrInvalidBooking, variance)
		}
		sh.CountedCash, sh.ExpectedCash, sh.VarianceCash = &counted, &v.Expected, &variance
		sh.CashBookingsAtClose, sh.CashOrdersAtClose, sh.CashDepositsAtClose = &v.CashBookings, &v.CashOrders, &v.CashDeposits
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
