package service

import (
	"context"
	"errors"
	"fmt"
	"os"
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
	// ErrBusy: a transient clash (e.g. no free code after several tries) -
	// trying again is expected to work.
	ErrBusy = errors.New("the system was busy - please try again")
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
	// DefaultOpenHour/DefaultCloseHour are the opening hours a new database
	// starts with (07:00-23:00, REQUIREMENTS.md FR-2.2); admins change them
	// in PricingConfig.OpenHour/CloseHour.
	DefaultOpenHour  = 7
	DefaultCloseHour = 23
)

// No-show rules (owner decisions 2026-10-21): staff can mark a no-show
// from NO_SHOW_GRACE_MINUTES after the hour starts (default 15); the hour is
// then free, and booking it costs the court's normal hourly price x
// NO_SHOW_RESALE_PRICE_PERCENT / 100 (default 50, 100 = full price) - in
// place of member and half-court discounts.
func NoShowGraceMinutes() int { return envIntRange("NO_SHOW_GRACE_MINUTES", 15, 0, 120) }
func NoShowResalePercent() int {
	return envIntRange("NO_SHOW_RESALE_PRICE_PERCENT", 50, 0, 100)
}

func envIntRange(name string, def, min, max int) int {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < min || n > max {
		return def
	}
	return n
}

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
	// VoucherCode pays for one off-peak hour with a FREE_OFFPEAK_HOUR reward
	// voucher (PaymentMethod VOUCHER): the hour costs 0, the voucher is used
	// up in the same transaction, and the booking belongs to the voucher's
	// owner. No loyalty points are earned for a free hour.
	VoucherCode string
}

// ErrVoucherNotUsable: the code isn't an active, unexpired free-hour voucher.
var ErrVoucherNotUsable = errors.New("voucher can't be used for a free hour")

// loadFreeHourVoucher finds an ACTIVE, unexpired FREE_OFFPEAK_HOUR voucher.
// With lock=true the row is locked so it can be used up exactly once.
func loadFreeHourVoucher(db *gorm.DB, code string, now time.Time, lock bool) (*model.Voucher, error) {
	q := db
	if lock {
		q = q.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	var v model.Voucher
	if err := q.First(&v, "code = ?", strings.ToUpper(strings.TrimSpace(code))).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, fmt.Errorf("%w: no voucher %s", ErrVoucherNotUsable, code)
		}
		return nil, err
	}
	var item model.RewardCatalogItem
	if err := db.First(&item, "id = ?", v.RewardID).Error; err != nil {
		return nil, err
	}
	switch {
	case item.Kind != model.RewardKindFreeOffPeakHour:
		return nil, fmt.Errorf("%w: %s is a %s voucher, not a free court hour", ErrVoucherNotUsable, v.Code, item.Name)
	case v.Status != model.VoucherActive:
		return nil, fmt.Errorf("%w: %s is %s", ErrVoucherNotUsable, v.Code, v.Status)
	case now.After(v.ExpiresAt):
		return nil, fmt.Errorf("%w: %s expired on %s", ErrVoucherNotUsable, v.Code, v.ExpiresAt.In(Bangkok).Format("2006-01-02"))
	}
	return &v, nil
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
	resaleOf  *string // a no-show's booking id: re-sold at the resale price
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

	// A free-hour voucher pays for exactly one hour and the booking is the
	// voucher owner's, whatever phone was typed at the counter.
	useVoucher := input.WalkIn != nil && input.WalkIn.VoucherCode != ""
	if input.WalkIn != nil && (input.WalkIn.PaymentMethod == model.PaymentVoucher) != useVoucher {
		return nil, fmt.Errorf("%w: payment_method VOUCHER and voucher_code go together", ErrInvalidBooking)
	}
	if useVoucher {
		if len(input.Slots) != 1 {
			return nil, fmt.Errorf("%w: a free-hour voucher covers exactly one hour", ErrInvalidBooking)
		}
		v, err := loadFreeHourVoucher(s.db.WithContext(ctx), input.WalkIn.VoucherCode, s.now(), false)
		if err != nil {
			return nil, err
		}
		input.UserID = v.UserID
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

	// Online bookings open MaxAdvanceDays ahead (configurable by admins);
	// staff at the counter may book further out, e.g. for tournaments.
	if input.WalkIn == nil {
		if err := s.checkBookingWindow(ctx, input.Date); err != nil {
			return nil, err
		}
	}

	// Early, unlocked check for a friendly error; repeated under a lock
	// inside the transaction below.
	if input.WalkIn == nil {
		if err := s.checkUnpaidCap(s.db.WithContext(ctx), input.UserID); err != nil {
			return nil, err
		}
	}

	// Everything that doesn't need locks - courts, closures, prices - is
	// loaded once, before the transaction, so it isn't repeated per slot and
	// doesn't run on a second pool connection while row locks are held.
	planned, err := s.planSlots(ctx, input, memberType)
	if err != nil {
		return nil, err
	}
	if useVoucher {
		// FR-4.2: the reward is one free hour *during off-peak hours*.
		if planned[0].priceType != "OFFPEAK" {
			return nil, fmt.Errorf("%w: the free-hour voucher is for off-peak hours only", ErrSlotUnavailable)
		}
		planned[0].amount = 0
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
		if payMethod == model.PaymentCash || payMethod == model.PaymentVoucher {
			status, payStatus = model.BookingConfirmed, model.PaymentVerified
		}
	}

	result := &CreateBookingResult{}
	err = repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		*result = CreateBookingResult{} // a retried attempt starts over
		// Lock the customer's row first (before any court rows, the same
		// order AddPointsEntry follows later in this transaction), so two
		// bookings sent at the same moment by one customer run one after
		// the other: each then sees the other's unpaid group, and the cap
		// can't be raced.
		if bookingUser != nil {
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("id").First(&model.User{}, "id = ?", bookingUser.ID).Error; err != nil {
				return err
			}
			if input.WalkIn == nil {
				if err := s.checkUnpaidCap(tx, input.UserID); err != nil {
					return err
				}
			}
		}
		// Lock the voucher now; it is used up below once the booking row
		// exists, so it can't pay for two hours.
		var voucher *model.Voucher
		if useVoucher {
			if voucher, err = loadFreeHourVoucher(tx, input.WalkIn.VoucherCode, s.now(), true); err != nil {
				return err
			}
		}
		// Closures were checked before the transaction; one created since
		// would be missed. Take this date's closure lock (shared, so
		// bookings don't wait for each other; DayOffService.Create takes it
		// exclusively) and check again against what is committed now.
		if err := tx.Exec("SELECT pg_advisory_xact_lock_shared(?, hashtext(?))", closureLockClass, input.Date).Error; err != nil {
			return err
		}
		var closures []model.DayOff
		if err := tx.Where("date = ?", input.Date).Find(&closures).Error; err != nil {
			return err
		}
		closedCourts, err := repository.ClosureCourts(tx, closures)
		if err != nil {
			return err
		}
		if input.WalkIn == nil || !input.WalkIn.OverrideClosure {
			for _, p := range planned {
				_, hour, _ := hourSlotEnd(p.startTime)
				if closure := repository.ClosureFor(closures, p.court, closedCourts, hour); closure != nil {
					return fmt.Errorf("%w: %s is closed at %s (%s)", ErrSlotUnavailable, p.court.Name, p.startTime, closure.Reason)
				}
			}
		}

		code, err := uniqueBookingCode(tx, input.Date)
		if err != nil {
			return err
		}
		result.BookingCode = code

		// Cash into the drawer: needs an open shift, and waits for a shift
		// close in progress before taking the time, so the sale lands in
		// exactly one shift.
		if payMethod == model.PaymentCash {
			if err := lockDrawerForCash(tx); err != nil {
				return err
			}
		}
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
				ResaleOf:    p.resaleOf,
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
			total = RoundBaht(total + p.amount)
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
		if voucher != nil {
			if err := tx.Model(voucher).Updates(map[string]interface{}{
				"status": model.VoucherRedeemed, "dispensed_at": now, "dispensed_by": input.WalkIn.StaffID,
				"booking_id": result.Bookings[0].ID,
			}).Error; err != nil {
				return err
			}
		}
		if total <= 0 && !useVoucher {
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
			if bookingUser != nil && payStatus == model.PaymentVerified && !useVoucher {
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
					"payment_method": payMethod, "closure_override": input.WalkIn.OverrideClosure, "voucher_code": input.WalkIn.VoucherCode,
				}),
				CreatedAt: now,
			}).Error
		}
		// Online bookings are audit-logged too (they used to appear only
		// once a slip was approved).
		var actorName string
		if bookingUser != nil {
			actorName = bookingUser.Name
		}
		return tx.Create(&model.AuditLog{
			ID:         ids.New("log"),
			UserID:     input.UserID,
			UserName:   actorName,
			Action:     "BOOKING_CREATED",
			TargetType: "Booking",
			TargetID:   result.Bookings[0].ID,
			AfterState: model.AuditJSON(map[string]any{
				"booking_code": code, "slots": len(result.Bookings), "total": total, "payment_method": payMethod,
			}),
			CreatedAt: now,
		}).Error
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
	closedCourts, err := repository.ClosureCourts(s.db.WithContext(ctx), closures)
	if err != nil {
		return nil, err
	}
	quoter, err := s.priceEngine.NewSlotQuoter(ctx, input.Date, memberType)
	if err != nil {
		return nil, err
	}
	cfg, err := s.courtRepo.GetPricingConfig(ctx)
	if err != nil {
		return nil, err
	}
	// Hours freed by a no-show this date: booking one is a resale.
	var noShows []model.Booking
	if err := s.db.WithContext(ctx).Where("date = ? AND status = ?", input.Date, model.BookingNoShow).Find(&noShows).Error; err != nil {
		return nil, err
	}
	courtByID := map[string]model.Court{}
	if len(noShows) > 0 {
		all, err := s.courtRepo.FetchAll(ctx, false)
		if err != nil {
			return nil, err
		}
		for _, c := range all {
			courtByID[c.ID] = c
		}
	}

	seen := map[string]bool{}
	planned := make([]plannedSlot, 0, len(input.Slots))
	for _, sl := range input.Slots {
		endTime, hour, err := hourSlotEnd(sl.StartTime)
		if err != nil {
			return nil, err
		}
		if err := checkOpenHour(cfg, sl.StartTime, hour); err != nil {
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
		if closure := repository.ClosureFor(closures, court, closedCourts, hour); closure != nil &&
			(input.WalkIn == nil || !input.WalkIn.OverrideClosure) {
			return nil, fmt.Errorf("%w: %s is closed at %s (%s)", ErrSlotUnavailable, court.Name, sl.StartTime, closure.Reason)
		}

		amount, priceType, open, err := quoter.Quote(court.Type, hour, court.ShareOfGroup < 1)
		if err != nil {
			return nil, fmt.Errorf("pricing calculation failed: %w", err)
		}
		if !open {
			// Inside the opening hours, but no pricing rule covers this
			// sport/day/hour - the rules decide which hours each sport opens.
			return nil, fmt.Errorf("%w: %s is not open at %s (no price set for that hour)", ErrSlotUnavailable, court.Name, sl.StartTime)
		}
		// FR-1.2: half-court sides may only be booked off-peak.
		if court.OffPeakOnly && priceType != "OFFPEAK" {
			return nil, fmt.Errorf("%w: %s can only be booked during off-peak hours", ErrSlotUnavailable, court.Name)
		}
		var resaleOf *string
		for _, ns := range noShows {
			if other, ok := courtByID[ns.CourtID]; ok && ns.StartTime == sl.StartTime && model.CourtsConflict(court, other) {
				id := ns.ID
				resaleOf = &id
				base, err := quoter.BasePrice(court.Type, hour)
				if err != nil {
					return nil, fmt.Errorf("pricing calculation failed: %w", err)
				}
				amount = RoundBaht(base * float64(NoShowResalePercent()) / 100)
				break
			}
		}
		planned = append(planned, plannedSlot{court: court, startTime: sl.StartTime, endTime: endTime, amount: amount, priceType: priceType, resaleOf: resaleOf})
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
		// A member's name comes from their account; the typed name is for
		// walk-ins without one.
		if u == nil && strings.TrimSpace(w.CustomerName) != "" {
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
	return "", ErrBusy
}

// hourSlotEnd validates an "HH:00" start (00:00-23:00) and returns its
// one-hour end. Whether that hour is open is checkOpenHour's job: existing
// bookings stay valid when the opening hours change later.
func hourSlotEnd(start string) (string, int, error) {
	parts := strings.Split(start, ":")
	if len(parts) != 2 || parts[1] != "00" || len(parts[0]) != 2 {
		return "", 0, fmt.Errorf("%w: start_time must be on the hour (HH:00), got %q", ErrInvalidBooking, start)
	}
	h, err := strconv.Atoi(parts[0])
	if err != nil || h < 0 || h > 23 {
		return "", 0, fmt.Errorf("%w: start_time must be on the hour (HH:00), got %q", ErrInvalidBooking, start)
	}
	return fmt.Sprintf("%02d:00", h+1), h, nil
}

// checkOpenHour refuses a slot outside the configured opening hours.
func checkOpenHour(cfg *model.PricingConfig, start string, hour int) error {
	if hour < cfg.OpenHour || hour >= cfg.CloseHour {
		return fmt.Errorf("%w: %s is outside opening hours (%02d:00-%02d:00)", ErrSlotUnavailable, start, cfg.OpenHour, cfg.CloseHour)
	}
	return nil
}

// checkBookingWindow refuses an online booking further ahead than the
// configured PricingConfig.MaxAdvanceDays (Bangkok calendar days).
func (s *BookingService) checkBookingWindow(ctx context.Context, date string) error {
	cfg, err := s.courtRepo.GetPricingConfig(ctx)
	if err != nil {
		return err
	}
	day, err := time.ParseInLocation("2006-01-02", date, Bangkok)
	if err != nil {
		return fmt.Errorf("%w: date must be YYYY-MM-DD", ErrInvalidBooking)
	}
	y, m, d := s.now().In(Bangkok).Date()
	last := time.Date(y, m, d, 0, 0, 0, 0, Bangkok).AddDate(0, 0, cfg.MaxAdvanceDays)
	if day.After(last) {
		return fmt.Errorf("%w: online bookings open %d days ahead (up to %s)", ErrInvalidBooking, cfg.MaxAdvanceDays, last.Format("2006-01-02"))
	}
	return nil
}

// closureLockClass namespaces the per-date advisory lock that serializes
// closure creation against in-flight bookings (see CreateBookings).
const closureLockClass = 4201

// checkUnpaidCap refuses a new online booking when the customer already has
// MaxUnpaidGroupsPerUser groups awaiting payment or review.
func (s *BookingService) checkUnpaidCap(db *gorm.DB, userID string) error {
	unpaid, err := countUnpaidGroups(db, userID)
	if err != nil {
		return err
	}
	if unpaid >= MaxUnpaidGroupsPerUser {
		return fmt.Errorf("%w: you already have %d bookings awaiting payment or slip review - please wait for them to be confirmed", ErrTooManyUnpaid, unpaid)
	}
	return nil
}

// countUnpaidGroups counts the user's booking groups whose payment staff
// haven't approved yet: still waiting for a slip (PENDING) or with a slip
// waiting for review (SLIP_UPLOADED). Counting only PENDING let a customer
// upload any image to escape the cap - and the 30-minute expiry, which only
// applies to PENDING - and hold any number of courts.
func countUnpaidGroups(db *gorm.DB, userID string) (int, error) {
	var n int64
	err := db.Model(&model.Payment{}).
		Joins("JOIN bookings ON bookings.id = payments.booking_id").
		Where("bookings.user_id = ? AND payments.status IN ?", userID,
			[]model.PaymentStatus{model.PaymentPending, model.PaymentSlipUploaded}).
		// Only bookings the customer made: a walk-in staff made for them
		// (waiting for a transfer, never auto-expired) isn't theirs to clear.
		Where("bookings.created_by = bookings.user_id").
		Count(&n).Error
	return int(n), err
}

// ExpireUnpaidBookings cancels online bookings whose payment is still
// PENDING (no slip uploaded) after PaymentHoldDuration, freeing their slots.
// Bookings with an uploaded slip are left for staff to verify or reject.
// A walk-in paid by transfer at the counter (made by staff, so created_by
// is not the customer) never expires: the customer is there and may
// already be playing; staff confirm the transfer or cancel it themselves.
// main runs this every minute.
func (s *BookingService) ExpireUnpaidBookings(ctx context.Context) (int, error) {
	cutoff := s.now().Add(-PaymentHoldDuration)
	var stale []model.Payment
	if err := s.db.WithContext(ctx).
		Where("status = ? AND method = ? AND created_at < ?", model.PaymentPending, model.PaymentPromptPay, cutoff).
		Where("EXISTS (SELECT 1 FROM bookings b WHERE b.id = payments.booking_id AND b.created_by = b.user_id)").
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
		err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
			cancelled = false // a retried attempt starts over
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
				"status": model.PaymentExpired, "expired_at": now, "refund_reason": reason, "updated_at": now,
			}).Error; err != nil {
				return err
			}
			if _, err := cancelPending(tx, group, reason, model.CancelKindExpired, now); err != nil {
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
				AfterState:  model.AuditJSON(map[string]any{"status": model.PaymentExpired, "bookings_cancelled": len(group)}),
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

// GroupPayment is how a booking group was (or is to be) paid, for the
// counter's receipts.
type GroupPayment struct {
	Method model.PaymentMethod `json:"method"`
	Status model.PaymentStatus `json:"status"`
	// Who took the money and when (approved slip or cash at the counter).
	VerifiedAt     *time.Time `json:"verified_at,omitempty"`
	VerifiedByName string     `json:"verified_by_name,omitempty"`
}

// PaymentsByGroupOnDate maps "booking_code|user_id" to the payment of every
// booking group on a date (a group's rows all share its date).
func (s *BookingService) PaymentsByGroupOnDate(ctx context.Context, date string) (map[string]GroupPayment, error) {
	var rows []struct {
		BookingCode    string
		UserID         string
		Method         model.PaymentMethod
		Status         model.PaymentStatus
		VerifiedAt     *time.Time
		VerifiedByName *string
	}
	err := s.db.WithContext(ctx).Table("payments p").
		Select("b.booking_code, b.user_id, p.method, p.status, p.verified_at, v.name AS verified_by_name").
		Joins("JOIN bookings b ON b.id = p.booking_id").
		Joins("LEFT JOIN users v ON v.id = p.verified_by").
		Where("b.date = ?", date).
		Scan(&rows).Error
	out := make(map[string]GroupPayment, len(rows))
	for _, r := range rows {
		gp := GroupPayment{Method: r.Method, Status: r.Status, VerifiedAt: r.VerifiedAt}
		if r.VerifiedByName != nil {
			gp.VerifiedByName = *r.VerifiedByName
		}
		out[r.BookingCode+"|"+r.UserID] = gp
	}
	return out, err
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

// lockGroupUser locks the booking's customer row before any court locks,
// the same order CreateBookings uses (user, then courts), so confirming a
// late payment and a new booking by the same customer can't deadlock.
func lockGroupUser(tx *gorm.DB, root *model.Booking) error {
	if root.UserID == "" || root.UserID == model.WalkInUserID {
		return nil
	}
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("id").First(&model.User{}, "id = ?", root.UserID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	return err
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
	// verified or rejected it - that would put a settled payment back in the
	// queue. An EXPIRED payment accepts a slip: the customer paid but sent
	// the slip after the hold ran out (late payment). Staff then confirm it
	// if the slots are still free, or a manager refunds it.
	if p.Status != model.PaymentPending && p.Status != model.PaymentSlipUploaded && p.Status != model.PaymentExpired {
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
// to compare transfer references. A slip counts as used until staff reject
// it (Payment.SlipReleased) - a booking cancelled for another reason keeps
// its slip, since the money behind it may still be refunded. Returns the
// slip URL it replaced, if any (the file is kept as evidence).
func (s *BookingService) SaveSlip(ctx context.Context, paymentID, servedURL, slipHash, actorID string) (string, error) {
	var previous string
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		p, err := lockPayment(tx, paymentID)
		if err != nil {
			return err
		}
		if err := slipAcceptable(p); err != nil {
			return err
		}
		var reused int64
		if err := tx.Model(&model.Payment{}).
			Where("slip_hash = ? AND id <> ? AND NOT slip_released", slipHash, p.ID).
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
		before := p.Status
		if err := tx.Model(p).Updates(map[string]interface{}{
			"status":           model.PaymentSlipUploaded,
			"slip_url":         servedURL,
			"slip_hash":        slipHash,
			"slip_uploaded_at": now,
			"updated_at":       now,
		}).Error; err != nil {
			return err
		}
		// In the audit log, so the trail shows when the money was claimed
		// (and slip replacements), not only the approval.
		var actor model.User
		_ = tx.Select("name").Take(&actor, "id = ?", actorID).Error // name is cosmetic
		return tx.Create(&model.AuditLog{
			ID:          ids.New("log"),
			UserID:      actorID,
			UserName:    actor.Name,
			Action:      "SLIP_UPLOADED",
			TargetType:  "Payment",
			TargetID:    p.ID,
			BeforeState: model.AuditJSON(map[string]any{"status": before}),
			AfterState:  model.AuditJSON(map[string]any{"status": model.PaymentSlipUploaded, "replaced_previous_slip": previous != ""}),
			CreatedAt:   now,
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
	// Late: the payment came after the hold had expired, and the slots were
	// reserved again.
	Late bool `json:"late,omitempty"`
}

// VerifyPayment is the staff "slip OK" action (FR-3.3): marks the payment
// VERIFIED, confirms every booking in the group, and awards loyalty points
// at 1 point per booked hour (FR-4.1) through the points ledger - all in
// one transaction, so a confirmed booking always has its points and a
// retried click can't award them twice.
func (s *BookingService) VerifyPayment(ctx context.Context, paymentID string, seenSlipAt *time.Time, staffID, staffName string) (*ReviewResult, error) {
	var res *ReviewResult
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
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
		// Without a slip only a counter walk-in can be confirmed (staff saw
		// the transfer arrive); an online booking needs the customer's slip
		// - or a manager recording cash.
		if p.Status == model.PaymentPending && !isWalkIn(root) {
			return fmt.Errorf("%w: no slip has been uploaded for this booking yet", ErrInvalidState)
		}
		// Part of it was already sent back (e.g. one hour of the group was
		// cancelled with a refund): what is left must still pay for every
		// hour that would stand, or the hours would be booked on money the
		// customer no longer paid.
		if err := coversStandingHours(p, group); err != nil {
			return err
		}
		if err := lockGroupUser(tx, root); err != nil {
			return err
		}
		now := s.now()
		// A late slip (the hold had expired) re-reserves the slots first;
		// if one has been taken meanwhile this fails with
		// ErrLatePaymentSlotGone and a manager refunds instead.
		confirmed, points, err := s.confirmGroup(ctx, tx, p, group, root, now)
		if err != nil {
			return err
		}
		if err := tx.Model(p).Updates(map[string]interface{}{
			"status":      model.PaymentVerified,
			"verified_at": now,
			"verified_by": staffID,
			"updated_at":  now,
		}).Error; err != nil {
			return err
		}

		res = &ReviewResult{PaymentID: p.ID, BookingCode: root.BookingCode, Status: string(model.PaymentVerified), BookingsCount: confirmed, PointsAwarded: points, Late: p.ExpiredAt != nil}
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
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
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
		// The slip was judged not to be a real payment, so the file may be
		// used again (e.g. the right transfer re-sent for a new booking).
		if err := tx.Model(p).Updates(map[string]interface{}{
			"status":        model.PaymentRejected,
			"refund_reason": reason,
			"slip_released": true,
			"updated_at":    now,
		}).Error; err != nil {
			return err
		}
		cancelled, err := cancelPending(tx, group, "Slip rejected: "+reason, model.CancelKindSlipRejected, now)
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

// cancelPending cancels the group's rows that are still PENDING_PAYMENT,
// recording why (kind: model.CancelKind*).
func cancelPending(tx *gorm.DB, group []model.Booking, reason, kind string, now time.Time) (int, error) {
	cancelled := 0
	for _, b := range group {
		if b.Status != model.BookingPendingPayment {
			continue
		}
		if err := tx.Model(&model.Booking{}).Where("id = ? AND status = ?", b.ID, model.BookingPendingPayment).Updates(map[string]interface{}{
			"status":              model.BookingCancelled,
			"cancellation_reason": reason,
			"cancel_kind":         kind,
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
