package service

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Sentinel errors the handler maps to HTTP status codes.
var (
	ErrNotFound       = errors.New("not found")
	ErrForbidden      = errors.New("not allowed")
	ErrInvalidState   = errors.New("invalid state for this action")
	ErrInvalidBooking = errors.New("invalid booking request")
	// ErrSlotUnavailable: the slot is free but can't be booked (court
	// closed that day, or an off-peak-only court at a peak hour).
	ErrSlotUnavailable = errors.New("slot not bookable")
)

type BookingService struct {
	db             *gorm.DB
	bkRepo         *repository.BookingRepository
	usrRepo        *repository.UserRepository
	courtRepo      *repository.CourtRepository
	priceEngine    *PriceEngineService
	paymentService *PaymentService
}

func NewBookingService(
	db *gorm.DB,
	bkRepo *repository.BookingRepository,
	usrRepo *repository.UserRepository,
	courtRepo *repository.CourtRepository,
	priceEngine *PriceEngineService,
	paymentService *PaymentService,
) *BookingService {
	return &BookingService{
		db:             db,
		bkRepo:         bkRepo,
		usrRepo:        usrRepo,
		courtRepo:      courtRepo,
		priceEngine:    priceEngine,
		paymentService: paymentService,
	}
}

// SlotRequest is one bookable hour on one court.
type SlotRequest struct {
	CourtID   string `json:"court_id"`
	StartTime string `json:"start_time"` // "HH:00"
}

type CreateBookingInput struct {
	Date   string        `json:"date"`
	Slots  []SlotRequest `json:"slots"`
	Notes  string        `json:"notes"`
	UserID string        `json:"user_id"`
}

type CreateBookingResult struct {
	BookingCode      string          `json:"booking_code"`
	TotalAmount      float64         `json:"total_amount"`
	PromptPayPayload string          `json:"promptpay_payload"`
	Bookings         []model.Booking `json:"bookings"`
	Payment          model.Payment   `json:"payment"`
}

// FetchSlotsForGantt delegates timeline searches directly to BookingRepository
func (s *BookingService) FetchSlotsForGantt(ctx context.Context, date string, cType model.CourtType) ([]model.Booking, error) {
	return s.bkRepo.FetchSlotsForGantt(ctx, date, cType)
}

// CreateBookings books every requested slot under one booking code with a
// single PromptPay payment for the combined total, all in one transaction:
// if any slot is taken, closed, or not allowed, nothing is written. This is
// the server-side version of the frontend's multi-slot checkout - one
// booking row per hour, the payment attached to the first row.
func (s *BookingService) CreateBookings(ctx context.Context, input CreateBookingInput) (*CreateBookingResult, error) {
	if _, err := time.Parse("2006-01-02", input.Date); err != nil {
		return nil, fmt.Errorf("%w: date must be YYYY-MM-DD", ErrInvalidBooking)
	}
	if len(input.Slots) == 0 {
		return nil, fmt.Errorf("%w: select at least one slot", ErrInvalidBooking)
	}
	if len(input.Slots) > 24 {
		return nil, fmt.Errorf("%w: too many slots in one booking", ErrInvalidBooking)
	}

	// Member type comes from the resolved user record, never from client input.
	bookingUser, err := s.usrRepo.GetByID(ctx, input.UserID)
	if err != nil {
		return nil, err
	}
	if bookingUser == nil {
		return nil, fmt.Errorf("%w: unknown user", ErrInvalidBooking)
	}
	memberType := bookingUser.MemberType

	// Stable order so concurrent multi-slot requests lock mutex groups in
	// the same sequence (avoids deadlocks) and rows read naturally.
	slots := append([]SlotRequest(nil), input.Slots...)
	sort.Slice(slots, func(i, j int) bool {
		if slots[i].CourtID != slots[j].CourtID {
			return slots[i].CourtID < slots[j].CourtID
		}
		return slots[i].StartTime < slots[j].StartTime
	})

	bookingCode := ids.Code("BK", input.Date)
	var notesVal *string
	if input.Notes != "" {
		notesVal = &input.Notes
	}

	result := &CreateBookingResult{BookingCode: bookingCode}
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		total := 0.0
		for _, slot := range slots {
			endTime, hour, err := hourSlotEnd(slot.StartTime)
			if err != nil {
				return err
			}

			court, err := s.bkRepo.LockAndCheckOverlapTx(tx, slot.CourtID, input.Date, slot.StartTime, endTime)
			if err != nil {
				return err
			}

			closed, reason, err := s.courtRepo.IsDayOffActive(ctx, input.Date, court.ID, hour)
			if err != nil {
				return err
			}
			if closed {
				return fmt.Errorf("%w: %s is closed at %s (%s)", ErrSlotUnavailable, court.Name, slot.StartTime, reason)
			}

			// isHalfCourt is derived from the court's configuration, never
			// from client input, so a caller can't pick the cheaper rate.
			isHalfCourt := court.ShareOfGroup < 1
			amount, priceType, err := s.priceEngine.CalculatePrice(ctx, court.Type, input.Date, slot.StartTime, endTime, isHalfCourt, memberType)
			if err != nil {
				return fmt.Errorf("pricing calculation failed: %w", err)
			}
			// FR-1.2: half-court sides may only be booked off-peak.
			if court.OffPeakOnly && priceType == "PEAK" {
				return fmt.Errorf("%w: %s can only be booked during off-peak hours", ErrSlotUnavailable, court.Name)
			}
			// Whole baht per hour, matching the frontend's calculatePrice.
			amount = math.Round(amount)

			b := model.Booking{
				ID:          ids.New("b"),
				BookingCode: bookingCode,
				CourtID:     court.ID,
				UserID:      input.UserID,
				Date:        input.Date,
				StartTime:   slot.StartTime,
				EndTime:     endTime,
				IsHalfCourt: isHalfCourt,
				PriceType:   priceType,
				TotalAmount: amount,
				Status:      model.BookingPendingPayment,
				Notes:       notesVal,
				CreatedBy:   input.UserID,
				CreatedAt:   now,
				UpdatedAt:   now,
			}
			if err := tx.Create(&b).Error; err != nil {
				return err
			}
			result.Bookings = append(result.Bookings, b)
			total += amount
		}

		qrString := s.paymentService.CreatePromptPayPayload("", total)
		pay := model.Payment{
			ID:        ids.New("pay"),
			BookingID: result.Bookings[0].ID,
			Amount:    total,
			Method:    model.PaymentPromptPay,
			Status:    model.PaymentPending,
			QrPayload: &qrString,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if err := tx.Create(&pay).Error; err != nil {
			return err
		}

		result.Payment = pay
		result.TotalAmount = total
		result.PromptPayPayload = qrString
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// hourSlotEnd validates an "HH:00" start and returns its one-hour end.
func hourSlotEnd(start string) (string, int, error) {
	parts := strings.Split(start, ":")
	if len(parts) != 2 || parts[1] != "00" || len(parts[0]) != 2 {
		return "", 0, fmt.Errorf("%w: start_time must be on the hour (HH:00), got %q", ErrInvalidBooking, start)
	}
	h, err := strconv.Atoi(parts[0])
	if err != nil || h < 0 || h > 22 {
		return "", 0, fmt.Errorf("%w: invalid start hour %q", ErrInvalidBooking, start)
	}
	return fmt.Sprintf("%02d:00", h+1), h, nil
}

// ListByDate returns every non-cancelled booking on a date - what the
// availability grid needs. Personal fields are left to callers to strip.
func (s *BookingService) ListByDate(ctx context.Context, date string) ([]model.Booking, error) {
	var list []model.Booking
	err := s.db.WithContext(ctx).
		Where("date = ? AND status != ?", date, model.BookingCancelled).
		Order("start_time, court_id").
		Find(&list).Error
	return normalizeDates(list), err
}

// BookingWithPayment pairs a booking row with its group's payment (the
// payment hangs off the group's first row, so only that row has one).
type BookingWithPayment struct {
	model.Booking
	Payment *model.Payment `json:"payment,omitempty"`
}

// ListForUser returns a user's bookings, newest first, with payments.
func (s *BookingService) ListForUser(ctx context.Context, userID string) ([]BookingWithPayment, error) {
	var list []model.Booking
	if err := s.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("date DESC, start_time").
		Limit(500).
		Find(&list).Error; err != nil {
		return nil, err
	}
	return s.attachPayments(ctx, normalizeDates(list))
}

func (s *BookingService) attachPayments(ctx context.Context, list []model.Booking) ([]BookingWithPayment, error) {
	bookingIDs := make([]string, 0, len(list))
	for _, b := range list {
		bookingIDs = append(bookingIDs, b.ID)
	}
	var payments []model.Payment
	if len(bookingIDs) > 0 {
		if err := s.db.WithContext(ctx).Where("booking_id IN ?", bookingIDs).Find(&payments).Error; err != nil {
			return nil, err
		}
	}
	byBooking := make(map[string]*model.Payment, len(payments))
	for i := range payments {
		byBooking[payments[i].BookingID] = &payments[i]
	}
	out := make([]BookingWithPayment, len(list))
	for i, b := range list {
		out[i] = BookingWithPayment{Booking: b, Payment: byBooking[b.ID]}
	}
	return out, nil
}

// PaymentReview is what the staff slip queue shows for one payment: the
// payment, every booking row in its group, and who booked it.
type PaymentReview struct {
	Payment   model.Payment   `json:"payment"`
	Bookings  []model.Booking `json:"bookings"`
	UserName  string          `json:"user_name"`
	UserPhone string          `json:"user_phone"`
}

// ListPaymentsForReview returns payments in the given status (normally
// SLIP_UPLOADED) with their booking groups, oldest slip first.
func (s *BookingService) ListPaymentsForReview(ctx context.Context, status model.PaymentStatus) ([]PaymentReview, error) {
	var payments []model.Payment
	if err := s.db.WithContext(ctx).
		Where("status = ?", status).
		Order("slip_uploaded_at NULLS LAST, created_at").
		Limit(200).
		Find(&payments).Error; err != nil {
		return nil, err
	}
	out := make([]PaymentReview, 0, len(payments))
	for _, p := range payments {
		group, root, err := s.bookingGroup(s.db.WithContext(ctx), p.BookingID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				continue // orphaned payment (e.g. POS) - nothing to review here
			}
			return nil, err
		}
		r := PaymentReview{Payment: p, Bookings: group}
		if u, err := s.usrRepo.GetByID(ctx, root.UserID); err == nil && u != nil {
			r.UserName, r.UserPhone = u.Name, u.Phone
		}
		out = append(out, r)
	}
	return out, nil
}

// bookingGroup loads the booking a payment hangs off plus every row sharing
// its booking code.
func (s *BookingService) bookingGroup(tx *gorm.DB, rootBookingID string) ([]model.Booking, *model.Booking, error) {
	var root model.Booking
	if err := tx.First(&root, "id = ?", rootBookingID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	var group []model.Booking
	if err := tx.Where("booking_code = ?", root.BookingCode).Order("court_id, start_time").Find(&group).Error; err != nil {
		return nil, nil, err
	}
	return normalizeDates(group), &root, nil
}

// lockPayment loads a payment FOR UPDATE so two staff clicking verify/reject
// at once can't both act on it (and double-award points).
func lockPayment(tx *gorm.DB, paymentID string) (*model.Payment, error) {
	var p model.Payment
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&p, "id = ?", paymentID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &p, nil
}

type ReviewResult struct {
	PaymentID     string `json:"payment_id"`
	BookingCode   string `json:"booking_code"`
	Status        string `json:"status"`
	BookingsCount int    `json:"bookings_count"`
	PointsAwarded int    `json:"points_awarded"`
}

// VerifyPayment is the staff "slip OK" action (FR-3.3): marks the payment
// VERIFIED, confirms every booking in the group, and awards loyalty points
// at 1 point per booked hour (FR-4.1) through the points ledger - all in
// one transaction, so a confirmed booking always has its points and a
// retried click can't award them twice.
func (s *BookingService) VerifyPayment(ctx context.Context, paymentID, staffID, staffName string) (*ReviewResult, error) {
	var res *ReviewResult
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		p, err := lockPayment(tx, paymentID)
		if err != nil {
			return err
		}
		if p.Status != model.PaymentSlipUploaded && p.Status != model.PaymentPending {
			return fmt.Errorf("%w: payment is %s", ErrInvalidState, p.Status)
		}

		group, root, err := s.bookingGroup(tx, p.BookingID)
		if err != nil {
			return err
		}
		now := time.Now()
		if err := tx.Model(p).Updates(map[string]interface{}{
			"status":      model.PaymentVerified,
			"verified_at": now,
			"verified_by": staffID,
			"updated_at":  now,
		}).Error; err != nil {
			return err
		}

		confirmed := 0
		for _, b := range group {
			if b.Status != model.BookingPendingPayment {
				continue
			}
			if err := tx.Model(&model.Booking{}).Where("id = ?", b.ID).
				Updates(map[string]interface{}{"status": model.BookingConfirmed, "updated_at": now}).Error; err != nil {
				return err
			}
			confirmed++
		}

		points := 0
		if confirmed > 0 {
			refType, note := "Booking", fmt.Sprintf("%dh confirmed booking %s", confirmed, root.BookingCode)
			if _, err := s.usrRepo.AddPointsEntry(ctx, tx, root.UserID, model.LedgerEarnBooking, confirmed, "system", &refType, &root.ID, &note); err != nil {
				return fmt.Errorf("failed to award booking points: %w", err)
			}
			points = confirmed
		}

		res = &ReviewResult{PaymentID: p.ID, BookingCode: root.BookingCode, Status: string(model.PaymentVerified), BookingsCount: confirmed, PointsAwarded: points}
		return tx.Create(&model.AuditLog{
			ID:          ids.New("log"),
			UserID:      staffID,
			UserName:    staffName,
			Action:      "SLIP_VERIFIED_BY_STAFF",
			TargetType:  "Payment",
			TargetID:    p.ID,
			BeforeState: fmt.Sprintf(`{"status": %q}`, p.Status),
			AfterState:  fmt.Sprintf(`{"status": %q, "bookings_confirmed": %d, "points_awarded": %d}`, model.PaymentVerified, confirmed, points),
			CreatedAt:   now,
		}).Error
	})
	return res, err
}

// RejectPayment is the staff "slip not OK" action: marks the payment
// REJECTED and cancels every booking in the group so the slots free up.
func (s *BookingService) RejectPayment(ctx context.Context, paymentID, reason, staffID, staffName string) (*ReviewResult, error) {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return nil, fmt.Errorf("%w: a rejection reason is required", ErrInvalidBooking)
	}
	var res *ReviewResult
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		p, err := lockPayment(tx, paymentID)
		if err != nil {
			return err
		}
		if p.Status != model.PaymentSlipUploaded && p.Status != model.PaymentPending {
			return fmt.Errorf("%w: payment is %s", ErrInvalidState, p.Status)
		}
		group, root, err := s.bookingGroup(tx, p.BookingID)
		if err != nil {
			return err
		}
		now := time.Now()
		if err := tx.Model(p).Updates(map[string]interface{}{
			"status":        model.PaymentRejected,
			"refund_reason": reason,
			"updated_at":    now,
		}).Error; err != nil {
			return err
		}
		cancelReason := "Slip rejected: " + reason
		cancelled := 0
		for _, b := range group {
			if b.Status != model.BookingPendingPayment {
				continue
			}
			if err := tx.Model(&model.Booking{}).Where("id = ?", b.ID).Updates(map[string]interface{}{
				"status":              model.BookingCancelled,
				"cancellation_reason": cancelReason,
				"updated_at":          now,
			}).Error; err != nil {
				return err
			}
			cancelled++
		}
		res = &ReviewResult{PaymentID: p.ID, BookingCode: root.BookingCode, Status: string(model.PaymentRejected), BookingsCount: cancelled}
		return tx.Create(&model.AuditLog{
			ID:          ids.New("log"),
			UserID:      staffID,
			UserName:    staffName,
			Action:      "SLIP_REJECTED_BY_STAFF",
			TargetType:  "Payment",
			TargetID:    p.ID,
			BeforeState: fmt.Sprintf(`{"status": %q}`, p.Status),
			AfterState:  fmt.Sprintf(`{"status": %q, "bookings_cancelled": %d}`, model.PaymentRejected, cancelled),
			Reason:      &reason,
			CreatedAt:   now,
		}).Error
	})
	return res, err
}

// BookingOwner returns the user id that owns a booking, for authorization.
func (s *BookingService) BookingOwner(ctx context.Context, bookingID string) (string, error) {
	var b model.Booking
	if err := s.db.WithContext(ctx).Select("user_id").First(&b, "id = ?", bookingID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", ErrNotFound
		}
		return "", err
	}
	return b.UserID, nil
}

// normalizeDates trims the "T00:00:00Z" the pgx driver adds when a DATE
// column is scanned into a string, so the API returns plain YYYY-MM-DD.
func normalizeDates(list []model.Booking) []model.Booking {
	for i := range list {
		if len(list[i].Date) > 10 {
			list[i].Date = list[i].Date[:10]
		}
	}
	return list
}

// ListActiveCourts returns the bookable courts for the availability grid.
func (s *BookingService) ListActiveCourts(ctx context.Context) ([]model.Court, error) {
	return s.courtRepo.FetchAll(ctx, true)
}
