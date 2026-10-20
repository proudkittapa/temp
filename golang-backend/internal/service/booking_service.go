package service

import (
	"context"
	"errors"
	"fmt"
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
	// closed then, or an off-peak-only court at a peak hour).
	ErrSlotUnavailable = errors.New("slot not bookable")
	// ErrTooManyUnpaid: the customer already holds the maximum number of
	// unpaid booking groups.
	ErrTooManyUnpaid = errors.New("too many unpaid bookings")
	// ErrDuplicateSlip: the uploaded file is byte-for-byte a slip already
	// attached to another live payment.
	ErrDuplicateSlip = errors.New("this slip image was already used for another booking")
	// ErrSlipChanged: the customer replaced the slip after the staff member
	// opened it, so their verify/reject decision was about a different image.
	ErrSlipChanged = errors.New("the customer replaced this slip after you opened it - please review the new slip")
)

const (
	// PaymentHoldDuration is how long an online booking holds its slots
	// waiting for a payment slip before ExpireUnpaidBookings cancels it - the
	// "30 minutes" customers are told at checkout.
	PaymentHoldDuration = 30 * time.Minute
	// MaxSlotsPerBooking mirrors the customer UI's limit of 3 one-hour slots
	// per checkout.
	MaxSlotsPerBooking = 3
	// MaxUnpaidGroupsPerUser caps how many booking groups one customer can
	// hold before staff have approved a payment - awaiting a slip or awaiting
	// review - so nobody can block courts by booking and never paying.
	MaxUnpaidGroupsPerUser = 3
	// OpeningHour/ClosingHour bound bookable slots: the first slot starts at
	// 07:00 and the last ends at 23:00 (REQUIREMENTS.md FR-2.2). Pricing
	// rules must stay inside these hours too, so the UI grid, the rules and
	// what can be booked all agree.
	OpeningHour = 7
	ClosingHour = 23
)

// Bangkok is the complex's local time zone; "today" and "has this slot
// already passed" are judged in it, not in the server's zone.
var Bangkok = mustLoadLocation("Asia/Bangkok")

func mustLoadLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(err) // main imports time/tzdata, so this only fails if that's removed
	}
	return loc
}

type BookingService struct {
	db             *gorm.DB
	bkRepo         *repository.BookingRepository
	usrRepo        *repository.UserRepository
	courtRepo      *repository.CourtRepository
	priceEngine    *PriceEngineService
	paymentService *PaymentService
	now            func() time.Time // overridable in tests
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
		now:            time.Now,
	}
}

// SlotRequest is one bookable hour on one court.
type SlotRequest struct {
	CourtID   string `json:"court_id"`
	StartTime string `json:"start_time"` // "HH:00"
}

// WalkInDetails marks a booking made by staff at the counter: it is paid
// on the spot, so it is created CONFIRMED with a VERIFIED payment.
type WalkInDetails struct {
	StaffID       string
	StaffName     string
	CustomerName  string
	CustomerPhone string
	PaymentMethod model.PaymentMethod
	// OverrideClosure lets staff knowingly book through a day-off block
	// (the counter UI asks them to confirm first).
	OverrideClosure bool
}

type CreateBookingInput struct {
	Date  string        `json:"date"`
	Slots []SlotRequest `json:"slots"`
	Notes string        `json:"notes"`
	// UserID is the customer the booking is for: the caller for an online
	// booking; for a walk-in, the registered user matching the phone (if
	// any), otherwise empty.
	UserID string         `json:"user_id"`
	WalkIn *WalkInDetails `json:"-"`
}

type CreateBookingResult struct {
	BookingCode      string          `json:"booking_code"`
	TotalAmount      float64         `json:"total_amount"`
	PromptPayPayload string          `json:"promptpay_payload"`
	PointsAwarded    int             `json:"points_awarded"`
	Bookings         []model.Booking `json:"bookings"`
	Payment          model.Payment   `json:"payment"`
}

// FetchSlotsForGantt delegates timeline searches directly to BookingRepository
func (s *BookingService) FetchSlotsForGantt(ctx context.Context, date string, cType model.CourtType) ([]model.Booking, error) {
	return s.bkRepo.FetchSlotsForGantt(ctx, date, cType)
}

// plannedSlot is a validated, priced slot waiting to be locked and inserted.
type plannedSlot struct {
	court     model.Court
	startTime string
	endTime   string
	amount    float64
	priceType string
}

// CreateBookings books every requested slot under one booking code with a
// single payment for the combined total, all in one transaction: if any slot
// is taken, closed, or not allowed, nothing is written. Used for both online
// customer bookings (PENDING_PAYMENT, PromptPay) and staff walk-ins
// (confirmed and paid at the counter, points awarded immediately).
func (s *BookingService) CreateBookings(ctx context.Context, input CreateBookingInput) (*CreateBookingResult, error) {
	if len(input.Slots) == 0 {
		return nil, fmt.Errorf("%w: select at least one slot", ErrInvalidBooking)
	}
	if len(input.Slots) > MaxSlotsPerBooking {
		return nil, fmt.Errorf("%w: at most %d slots per booking", ErrInvalidBooking, MaxSlotsPerBooking)
	}
	if err := s.checkNotPast(input.Date, input.Slots, input.WalkIn != nil); err != nil {
		return nil, err
	}

	// Member type comes from the resolved user record, never from client
	// input. A walk-in without an account prices at NORMAL.
	memberType := model.MemberNormal
	var bookingUser *model.User
	if input.UserID != "" {
		u, err := s.usrRepo.GetByID(ctx, input.UserID)
		if err != nil {
			return nil, err
		}
		if u == nil {
			return nil, fmt.Errorf("%w: unknown user", ErrInvalidBooking)
		}
		bookingUser, memberType = u, u.MemberType
	} else if input.WalkIn == nil {
		return nil, fmt.Errorf("%w: unknown user", ErrInvalidBooking)
	}

	if input.WalkIn == nil {
		unpaid, err := s.countUnpaidGroups(ctx, input.UserID)
		if err != nil {
			return nil, err
		}
		if unpaid >= MaxUnpaidGroupsPerUser {
			return nil, fmt.Errorf("%w: you already have %d bookings awaiting payment or slip review - please wait for them to be confirmed", ErrTooManyUnpaid, unpaid)
		}
	}

	// Everything that doesn't need locks - courts, closures, prices - is
	// loaded once, before the transaction, so it isn't repeated per slot and
	// doesn't run on a second pool connection while row locks are held.
	planned, err := s.planSlots(ctx, input, memberType)
	if err != nil {
		return nil, err
	}

	var notesVal *string
	if input.Notes != "" {
		notesVal = &input.Notes
	}
	customerName, customerPhone := customerContact(bookingUser, input.WalkIn)
	userID, createdBy := input.UserID, input.UserID
	status, payStatus, payMethod := model.BookingPendingPayment, model.PaymentPending, model.PaymentPromptPay
	if input.WalkIn != nil {
		if userID == "" {
			userID = model.WalkInUserID
		}
		createdBy = input.WalkIn.StaffID
		if input.WalkIn.PaymentMethod != "" {
			payMethod = input.WalkIn.PaymentMethod
		}
		// Cash is in the drawer, so the booking is confirmed at once. A
		// PromptPay walk-in waits like an online booking until staff see
		// the transfer and confirm it (POST /staff/payments/:id/verify,
		// which also awards the points) - it used to be confirmed and
		// earn points before any money had arrived.
		if payMethod == model.PaymentCash {
			status, payStatus = model.BookingConfirmed, model.PaymentVerified
		}
	}

	result := &CreateBookingResult{}
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		code, err := uniqueBookingCode(tx, input.Date)
		if err != nil {
			return err
		}
		result.BookingCode = code

		now := s.now()
		locked := map[string][]model.Court{} // LockKey -> locked group
		total := 0.0
		for _, p := range planned {
			key := repository.LockKey(p.court)
			group, ok := locked[key]
			if !ok {
				if group, err = s.bkRepo.LockCourtGroupTx(tx, p.court); err != nil {
					return err
				}
				locked[key] = group
			}
			if err := s.bkRepo.CheckOverlapTx(tx, p.court, group, input.Date, p.startTime, p.endTime); err != nil {
				return err
			}

			b := model.Booking{
				ID:            ids.New("b"),
				BookingCode:   code,
				CourtID:       p.court.ID,
				UserID:        userID,
				CustomerName:  customerName,
				CustomerPhone: customerPhone,
				Date:          input.Date,
				StartTime:     p.startTime,
				EndTime:       p.endTime,
				// Derived from the court's configuration, never from client
				// input, so a caller can't pick the cheaper rate.
				IsHalfCourt: p.court.ShareOfGroup < 1,
				PriceType:   p.priceType,
				TotalAmount: p.amount,
				Status:      status,
				Notes:       notesVal,
				CreatedBy:   createdBy,
				CreatedAt:   now,
				UpdatedAt:   now,
			}
			if err := tx.Create(&b).Error; err != nil {
				return err
			}
			result.Bookings = append(result.Bookings, b)
			total += p.amount
		}

		pay := model.Payment{
			ID:        ids.New("pay"),
			BookingID: result.Bookings[0].ID,
			Amount:    total,
			Method:    payMethod,
			Status:    payStatus,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if total <= 0 {
			return fmt.Errorf("%w: the total must be more than 0 THB", ErrInvalidBooking)
		}
		if payMethod == model.PaymentPromptPay {
			qrString, err := s.paymentService.CreatePromptPayPayload(total)
			if err != nil {
				return err
			}
			pay.QrPayload = &qrString
			result.PromptPayPayload = qrString
		}
		if payStatus == model.PaymentVerified {
			pay.VerifiedAt, pay.VerifiedBy = &now, &input.WalkIn.StaffID
		}
		if err := tx.Create(&pay).Error; err != nil {
			return err
		}
		result.Payment = pay
		result.TotalAmount = total

		if input.WalkIn != nil {
			// Paid in cash at the counter, so loyalty points (FR-4.1: 1 per
			// hour) are earned now; a PromptPay walk-in earns them when
			// staff confirm the transfer.
			if bookingUser != nil && payStatus == model.PaymentVerified {
				refType, note := "Booking", fmt.Sprintf("%dh walk-in booking %s", len(result.Bookings), code)
				if _, err := s.usrRepo.AddPointsEntry(ctx, tx, bookingUser.ID, model.LedgerEarnBooking, len(result.Bookings), "system", &refType, &result.Bookings[0].ID, &note); err != nil {
					return fmt.Errorf("failed to award booking points: %w", err)
				}
				result.PointsAwarded = len(result.Bookings)
			}
			return tx.Create(&model.AuditLog{
				ID:         ids.New("log"),
				UserID:     input.WalkIn.StaffID,
				UserName:   input.WalkIn.StaffName,
				Action:     "WALKIN_BOOKING_CREATED",
				TargetType: "Booking",
				TargetID:   result.Bookings[0].ID,
				AfterState: model.AuditJSON(map[string]any{
					"booking_code": code, "slots": len(result.Bookings), "total": total,
					"payment_method": payMethod, "closure_override": input.WalkIn.OverrideClosure,
				}),
				CreatedAt: now,
			}).Error
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// planSlots validates and prices every requested slot without taking locks,
// and returns them in lock order (see repository.LockKey).
func (s *BookingService) planSlots(ctx context.Context, input CreateBookingInput, memberType model.MemberType) ([]plannedSlot, error) {
	courtIDs := make([]string, 0, len(input.Slots))
	for _, sl := range input.Slots {
		courtIDs = append(courtIDs, sl.CourtID)
	}
	courts, err := s.courtRepo.FetchByIDs(ctx, courtIDs)
	if err != nil {
		return nil, err
	}
	closures, err := s.courtRepo.ListDayOffs(ctx, input.Date)
	if err != nil {
		return nil, err
	}
	quoter, err := s.priceEngine.NewSlotQuoter(ctx, input.Date, memberType)
	if err != nil {
		return nil, err
	}

	seen := map[string]bool{}
	planned := make([]plannedSlot, 0, len(input.Slots))
	for _, sl := range input.Slots {
		endTime, hour, err := hourSlotEnd(sl.StartTime)
		if err != nil {
			return nil, err
		}
		key := sl.CourtID + "@" + sl.StartTime
		if seen[key] {
			return nil, fmt.Errorf("%w: slot %s %s requested twice", ErrInvalidBooking, sl.CourtID, sl.StartTime)
		}
		seen[key] = true

		court, ok := courts[sl.CourtID]
		if !ok {
			return nil, fmt.Errorf("%w: court %q does not exist", ErrInvalidBooking, sl.CourtID)
		}
		if !court.IsActive {
			return nil, fmt.Errorf("%w: %s is currently closed for booking", ErrSlotUnavailable, court.Name)
		}
		if closure := repository.ClosureFor(closures, court.ID, hour); closure != nil &&
			(input.WalkIn == nil || !input.WalkIn.OverrideClosure) {
			return nil, fmt.Errorf("%w: %s is closed at %s (%s)", ErrSlotUnavailable, court.Name, sl.StartTime, closure.Reason)
		}

		amount, priceType, open, err := quoter.Quote(court.Type, hour, court.ShareOfGroup < 1)
		if err != nil {
			return nil, fmt.Errorf("pricing calculation failed: %w", err)
		}
		if !open {
			return nil, fmt.Errorf("%w: %s is outside opening hours", ErrSlotUnavailable, sl.StartTime)
		}
		// FR-1.2: half-court sides may only be booked off-peak.
		if court.OffPeakOnly && priceType != "OFFPEAK" {
			return nil, fmt.Errorf("%w: %s can only be booked during off-peak hours", ErrSlotUnavailable, court.Name)
		}
		planned = append(planned, plannedSlot{court: court, startTime: sl.StartTime, endTime: endTime, amount: amount, priceType: priceType})
	}

	sort.Slice(planned, func(i, j int) bool {
		ki, kj := repository.LockKey(planned[i].court), repository.LockKey(planned[j].court)
		if ki != kj {
			return ki < kj
		}
		if planned[i].court.ID != planned[j].court.ID {
			return planned[i].court.ID < planned[j].court.ID
		}
		return planned[i].startTime < planned[j].startTime
	})
	return planned, nil
}

// checkNotPast rejects dates before today and slots that are over, judged
// in Bangkok time. At the counter a slot already in progress is still
// bookable (a walk-in at 18:20 can take the 18:00 hour, staff can see the
// court is free); online it must not have started yet - otherwise a
// customer could pay for a full hour at 18:55.
func (s *BookingService) checkNotPast(date string, slots []SlotRequest, walkIn bool) error {
	day, err := time.ParseInLocation("2006-01-02", date, Bangkok)
	if err != nil {
		return fmt.Errorf("%w: date must be YYYY-MM-DD", ErrInvalidBooking)
	}
	now := s.now().In(Bangkok)
	for _, sl := range slots {
		_, hour, err := hourSlotEnd(sl.StartTime)
		if err != nil {
			return err
		}
		if !day.Add(time.Duration(hour+1) * time.Hour).After(now) {
			return fmt.Errorf("%w: %s %s has already passed", ErrInvalidBooking, date, sl.StartTime)
		}
		if !walkIn && !day.Add(time.Duration(hour)*time.Hour).After(now) {
			return fmt.Errorf("%w: %s %s has already started - book it at the counter", ErrInvalidBooking, date, sl.StartTime)
		}
	}
	return nil
}

func customerContact(u *model.User, w *WalkInDetails) (*string, *string) {
	name, phone := "", ""
	if u != nil {
		name, phone = u.Name, u.Phone
	}
	if w != nil {
		if strings.TrimSpace(w.CustomerName) != "" {
			name = strings.TrimSpace(w.CustomerName)
		}
		if p := repository.NormalizePhone(w.CustomerPhone); p != "" {
			phone = p
		}
	}
	var np, pp *string
	if name != "" {
		np = &name
	}
	if phone != "" {
		pp = &phone
	}
	return np, pp
}

// uniqueBookingCode picks a booking code no existing row uses. Codes carry
// only 24 random bits per date, and verify/reject act on a whole group by
// code, so a collision would merge two customers' groups - this check is
// what keeps codes one-per-group. (Two transactions racing to the same new
// code is a ~1-in-16M coincidence on top of that, and bookingGroup also
// filters by user, so it can never cross customers.)
func uniqueBookingCode(tx *gorm.DB, date string) (string, error) {
	for i := 0; i < 5; i++ {
		code := ids.Code("BK", date)
		var n int64
		if err := tx.Model(&model.Booking{}).Where("booking_code = ?", code).Count(&n).Error; err != nil {
			return "", err
		}
		if n == 0 {
			return code, nil
		}
	}
	return "", errors.New("could not allocate a unique booking code, please retry")
}

// hourSlotEnd validates an "HH:00" start and returns its one-hour end.
func hourSlotEnd(start string) (string, int, error) {
	parts := strings.Split(start, ":")
	if len(parts) != 2 || parts[1] != "00" || len(parts[0]) != 2 {
		return "", 0, fmt.Errorf("%w: start_time must be on the hour (HH:00), got %q", ErrInvalidBooking, start)
	}
	h, err := strconv.Atoi(parts[0])
	if err != nil || h < OpeningHour || h >= ClosingHour {
		return "", 0, fmt.Errorf("%w: start hour %q is outside opening hours (%02d:00-%02d:00)", ErrInvalidBooking, start, OpeningHour, ClosingHour)
	}
	return fmt.Sprintf("%02d:00", h+1), h, nil
}

// countUnpaidGroups counts the user's booking groups whose payment staff
// haven't approved yet: still waiting for a slip (PENDING) or with a slip
// waiting for review (SLIP_UPLOADED). Counting only PENDING let a customer
// upload any image to escape the cap - and the 30-minute expiry, which only
// applies to PENDING - and hold any number of courts.
func (s *BookingService) countUnpaidGroups(ctx context.Context, userID string) (int, error) {
	var n int64
	err := s.db.WithContext(ctx).Model(&model.Payment{}).
		Joins("JOIN bookings ON bookings.id = payments.booking_id").
		Where("bookings.user_id = ? AND payments.status IN ?", userID,
			[]model.PaymentStatus{model.PaymentPending, model.PaymentSlipUploaded}).
		Count(&n).Error
	return int(n), err
}

// ExpireUnpaidBookings cancels online bookings whose payment is still
// PENDING (no slip uploaded) after PaymentHoldDuration, freeing their slots.
// Bookings with an uploaded slip are left for staff to verify or reject.
// main runs this every minute.
func (s *BookingService) ExpireUnpaidBookings(ctx context.Context) (int, error) {
	cutoff := s.now().Add(-PaymentHoldDuration)
	var stale []model.Payment
	if err := s.db.WithContext(ctx).
		Where("status = ? AND method = ? AND created_at < ?", model.PaymentPending, model.PaymentPromptPay, cutoff).
		Order("created_at").Limit(500).Find(&stale).Error; err != nil {
		return 0, err
	}
	// One payment that can't be expired (e.g. its booking rows are gone)
	// must not stop the rest: errors are collected and the loop goes on.
	var errs []error
	expired := 0
	reason := fmt.Sprintf("Expired: no payment slip within %d minutes", int(PaymentHoldDuration.Minutes()))
	for _, p := range stale {
		cancelled := false
		err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			locked, err := lockPayment(tx, p.ID)
			if err != nil {
				return err
			}
			if locked.Status != model.PaymentPending {
				return nil // a slip arrived in the meantime
			}
			group, _, err := s.bookingGroup(tx, locked.BookingID)
			if err != nil {
				return err
			}
			now := s.now()
			if err := tx.Model(locked).Updates(map[string]interface{}{
				"status": model.PaymentRejected, "refund_reason": reason, "updated_at": now,
			}).Error; err != nil {
				return err
			}
			if _, err := cancelPending(tx, group, reason, now); err != nil {
				return err
			}
			cancelled = true
			return tx.Create(&model.AuditLog{
				ID:          ids.New("log"),
				UserID:      "system",
				UserName:    "SYSTEM_EXPIRY",
				Action:      "BOOKING_EXPIRED_UNPAID",
				TargetType:  "Payment",
				TargetID:    locked.ID,
				BeforeState: model.AuditJSON(map[string]any{"status": model.PaymentPending}),
				AfterState:  model.AuditJSON(map[string]any{"status": model.PaymentRejected, "bookings_cancelled": len(group)}),
				Reason:      &reason,
				CreatedAt:   now,
			}).Error
		})
		switch {
		case err == nil && cancelled:
			expired++ // counted only once the transaction has committed
		case err != nil && !errors.Is(err, ErrNotFound):
			errs = append(errs, fmt.Errorf("payment %s: %w", p.ID, err))
		}
	}
	return expired, errors.Join(errs...)
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
	list = normalizeDates(list)

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
// SLIP_UPLOADED) with their booking groups, oldest slip first. Loads
// payments, root bookings, group rows and users in four batched queries
// rather than several per payment.
func (s *BookingService) ListPaymentsForReview(ctx context.Context, status model.PaymentStatus) ([]PaymentReview, error) {
	db := s.db.WithContext(ctx)
	var payments []model.Payment
	if err := db.Where("status = ?", status).
		Order("slip_uploaded_at NULLS LAST, created_at").
		Limit(200).
		Find(&payments).Error; err != nil {
		return nil, err
	}
	if len(payments) == 0 {
		return []PaymentReview{}, nil
	}

	rootIDs := make([]string, len(payments))
	for i, p := range payments {
		rootIDs[i] = p.BookingID
	}
	var roots []model.Booking
	if err := db.Where("id IN ?", rootIDs).Find(&roots).Error; err != nil {
		return nil, err
	}
	rootByID := map[string]model.Booking{}
	codes, userIDs := []string{}, []string{}
	for _, r := range roots {
		rootByID[r.ID] = r
		codes = append(codes, r.BookingCode)
		userIDs = append(userIDs, r.UserID)
	}

	var rows []model.Booking
	if err := db.Where("booking_code IN ?", codes).Order("court_id, start_time").Find(&rows).Error; err != nil {
		return nil, err
	}
	rows = normalizeDates(rows)
	var users []model.User
	if err := db.Where("id IN ?", userIDs).Find(&users).Error; err != nil {
		return nil, err
	}
	userByID := map[string]model.User{}
	for _, u := range users {
		userByID[u.ID] = u
	}

	out := make([]PaymentReview, 0, len(payments))
	for _, p := range payments {
		root, ok := rootByID[p.BookingID]
		if !ok {
			continue // orphaned payment (e.g. POS) - nothing to review here
		}
		r := PaymentReview{Payment: p}
		for _, b := range rows {
			if sameGroup(root, b) {
				r.Bookings = append(r.Bookings, b)
			}
		}
		if u, ok := userByID[root.UserID]; ok {
			r.UserName, r.UserPhone = u.Name, u.Phone
		}
		if root.CustomerName != nil {
			r.UserName = *root.CustomerName
		}
		if root.CustomerPhone != nil {
			r.UserPhone = *root.CustomerPhone
		}
		out = append(out, r)
	}
	return out, nil
}

// sameGroup: rows of one booking group share code, owner and date.
func sameGroup(root, b model.Booking) bool {
	return b.BookingCode == root.BookingCode && b.UserID == root.UserID && b.Date[:10] == root.Date[:10]
}

// bookingGroup loads a booking plus every row in its group. Matching on
// owner and date as well as code means even a booking-code collision can
// never pull another customer's bookings into a verify/reject.
func (s *BookingService) bookingGroup(tx *gorm.DB, bookingID string) ([]model.Booking, *model.Booking, error) {
	var root model.Booking
	if err := tx.First(&root, "id = ?", bookingID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	if len(root.Date) > 10 {
		root.Date = root.Date[:10]
	}
	var group []model.Booking
	if err := tx.Where("booking_code = ? AND user_id = ? AND date = ?", root.BookingCode, root.UserID, root.Date).
		Order("court_id, start_time").Find(&group).Error; err != nil {
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

// groupPayment finds the payment for the group containing bookingID - it
// hangs off the group's first row, so it is looked up across all rows
// rather than by bookingID alone (which 404'd for any other row).
func (s *BookingService) groupPayment(tx *gorm.DB, bookingID string, lock bool) (*model.Payment, *model.Booking, error) {
	group, root, err := s.bookingGroup(tx, bookingID)
	if err != nil {
		return nil, nil, err
	}
	ids := make([]string, len(group))
	for i, b := range group {
		ids[i] = b.ID
	}
	q := tx
	if lock {
		q = q.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	var p model.Payment
	if err := q.Where("booking_id IN ?", ids).First(&p).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	return &p, root, nil
}

// CheckSlipUpload confirms the caller may attach a slip to bookingID's
// payment right now (owner or staff, payment still awaiting review) and
// returns that payment. The handler calls it before writing anything to
// disk, so a refused upload never leaves a file behind.
func (s *BookingService) CheckSlipUpload(ctx context.Context, bookingID, callerID string, callerIsStaff bool) (*model.Payment, error) {
	p, root, err := s.groupPayment(s.db.WithContext(ctx), bookingID, false)
	if err != nil {
		return nil, err
	}
	if root.UserID != callerID && !callerIsStaff {
		return nil, ErrForbidden
	}
	if err := slipAcceptable(p); err != nil {
		return nil, err
	}
	return p, nil
}

func slipAcceptable(p *model.Payment) error {
	if p.Method != model.PaymentPromptPay {
		return fmt.Errorf("%w: this booking was paid at the counter", ErrInvalidState)
	}
	// Re-uploading is fine while the slip awaits review, but not once staff
	// verified or rejected it (or it expired) - that would put a settled
	// payment back in the queue.
	if p.Status != model.PaymentPending && p.Status != model.PaymentSlipUploaded {
		return fmt.Errorf("%w: payment is already %s", ErrInvalidState, p.Status)
	}
	return nil
}

// SaveSlip records an uploaded slip on a payment, re-checking its state
// under a row lock (it may have changed since CheckSlipUpload). slipHash is
// the file's SHA-256: the same file already attached to another payment
// that is still live (anything but REJECTED) is refused, so one transfer
// can't be presented as payment for several bookings. Only byte-identical
// files are caught - a re-screenshot of the same slip still needs staff
// to compare transfer references. Returns the slip URL it replaced, if
// any, so the caller can delete the old file.
func (s *BookingService) SaveSlip(ctx context.Context, paymentID, servedURL, slipHash string) (string, error) {
	var previous string
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		p, err := lockPayment(tx, paymentID)
		if err != nil {
			return err
		}
		if err := slipAcceptable(p); err != nil {
			return err
		}
		var reused int64
		if err := tx.Model(&model.Payment{}).
			Where("slip_hash = ? AND id <> ? AND status <> ?", slipHash, p.ID, model.PaymentRejected).
			Count(&reused).Error; err != nil {
			return err
		}
		if reused > 0 {
			return ErrDuplicateSlip
		}
		if p.SlipURL != nil {
			previous = *p.SlipURL
		}
		now := s.now()
		return tx.Model(p).Updates(map[string]interface{}{
			"status":           model.PaymentSlipUploaded,
			"slip_url":         servedURL,
			"slip_hash":        slipHash,
			"slip_uploaded_at": now,
			"updated_at":       now,
		}).Error
	})
	// Two uploads of one file racing past the check above meet the unique
	// index instead.
	if repository.IsUniqueViolation(err) {
		return "", ErrDuplicateSlip
	}
	return previous, err
}

// checkSlipVersion makes sure the slip staff reviewed is still the one on
// the payment: seenSlipAt is the slip_uploaded_at they were shown. A
// payment without a slip (e.g. a walk-in confirmed at the counter) has
// nothing to compare.
func checkSlipVersion(p *model.Payment, seenSlipAt *time.Time) error {
	if p.SlipUploadedAt == nil {
		return nil
	}
	if seenSlipAt == nil {
		return fmt.Errorf("%w: expected_slip_uploaded_at is required for a payment with a slip", ErrInvalidBooking)
	}
	if !p.SlipUploadedAt.Equal(*seenSlipAt) {
		return ErrSlipChanged
	}
	return nil
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
func (s *BookingService) VerifyPayment(ctx context.Context, paymentID string, seenSlipAt *time.Time, staffID, staffName string) (*ReviewResult, error) {
	var res *ReviewResult
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		p, err := lockPayment(tx, paymentID)
		if err != nil {
			return err
		}
		if p.Status != model.PaymentSlipUploaded && p.Status != model.PaymentPending {
			return fmt.Errorf("%w: payment is %s", ErrInvalidState, p.Status)
		}
		if err := checkSlipVersion(p, seenSlipAt); err != nil {
			return err
		}

		group, root, err := s.bookingGroup(tx, p.BookingID)
		if err != nil {
			return err
		}
		now := s.now()
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
		if confirmed > 0 && root.UserID != model.WalkInUserID {
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
			BeforeState: model.AuditJSON(map[string]any{"status": p.Status}),
			AfterState:  model.AuditJSON(map[string]any{"status": model.PaymentVerified, "bookings_confirmed": confirmed, "points_awarded": points}),
			CreatedAt:   now,
		}).Error
	})
	return res, err
}

// RejectPayment is the staff "slip not OK" action: marks the payment
// REJECTED and cancels every booking in the group so the slots free up.
func (s *BookingService) RejectPayment(ctx context.Context, paymentID string, seenSlipAt *time.Time, reason, staffID, staffName string) (*ReviewResult, error) {
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
		if err := checkSlipVersion(p, seenSlipAt); err != nil {
			return err
		}
		group, root, err := s.bookingGroup(tx, p.BookingID)
		if err != nil {
			return err
		}
		now := s.now()
		if err := tx.Model(p).Updates(map[string]interface{}{
			"status":        model.PaymentRejected,
			"refund_reason": reason,
			"updated_at":    now,
		}).Error; err != nil {
			return err
		}
		cancelled, err := cancelPending(tx, group, "Slip rejected: "+reason, now)
		if err != nil {
			return err
		}
		res = &ReviewResult{PaymentID: p.ID, BookingCode: root.BookingCode, Status: string(model.PaymentRejected), BookingsCount: cancelled}
		return tx.Create(&model.AuditLog{
			ID:          ids.New("log"),
			UserID:      staffID,
			UserName:    staffName,
			Action:      "SLIP_REJECTED_BY_STAFF",
			TargetType:  "Payment",
			TargetID:    p.ID,
			BeforeState: model.AuditJSON(map[string]any{"status": p.Status}),
			AfterState:  model.AuditJSON(map[string]any{"status": model.PaymentRejected, "bookings_cancelled": cancelled}),
			Reason:      &reason,
			CreatedAt:   now,
		}).Error
	})
	return res, err
}

// cancelPending cancels the group's rows that are still PENDING_PAYMENT.
func cancelPending(tx *gorm.DB, group []model.Booking, reason string, now time.Time) (int, error) {
	cancelled := 0
	for _, b := range group {
		if b.Status != model.BookingPendingPayment {
			continue
		}
		if err := tx.Model(&model.Booking{}).Where("id = ?", b.ID).Updates(map[string]interface{}{
			"status":              model.BookingCancelled,
			"cancellation_reason": reason,
			"updated_at":          now,
		}).Error; err != nil {
			return cancelled, err
		}
		cancelled++
	}
	return cancelled, nil
}

// ListActiveCourts returns the bookable courts for the availability grid.
func (s *BookingService) ListActiveCourts(ctx context.Context) ([]model.Court, error) {
	return s.courtRepo.FetchAll(ctx, true)
}

// FindCustomerByPhone returns the registered customer with this phone, if
// any - used to credit a walk-in booking to an existing account. Phones are
// compared digits-only, so a member who registered as "081-234-5678" is
// found when staff type "0812345678" (and vice versa).
func (s *BookingService) FindCustomerByPhone(ctx context.Context, phone string) (*model.User, error) {
	u, err := s.usrRepo.GetByPhone(ctx, phone)
	if err != nil || u == nil || u.Role != model.RoleCustomer {
		return nil, err
	}
	return u, nil
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
