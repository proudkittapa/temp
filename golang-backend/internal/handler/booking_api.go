package handler

import (
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/repository"
	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
)

var allowedSlipExt = map[string]string{"jpg": "jpg", "jpeg": "jpg", "png": "png", "webp": "webp"}

const maxSlipBytes = 5 << 20

// Messages for errors that aren't the client's to read in detail.
const (
	msgBusy     = "the system was busy - please try again"
	msgInternal = "internal server error - please try again"
)

// respondError maps service sentinel errors to HTTP status codes so clients
// can tell "slot taken" (409) from "bad input" (400) from a server fault.
// An unrecognised error is a server fault: it is logged here and the client
// gets a generic message (the text may hold SQL, constraint or driver
// details).
func respondError(c *gin.Context, err error) {
	status := http.StatusInternalServerError
	if repository.IsRetryableConflict(err) || errors.Is(err, service.ErrBusy) {
		c.JSON(http.StatusConflict, gin.H{"success": false, "error": msgBusy})
		return
	}
	switch {
	case errors.Is(err, service.ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, service.ErrForbidden):
		status = http.StatusForbidden
	case errors.Is(err, repository.ErrSlotTaken), errors.Is(err, service.ErrSlotUnavailable), errors.Is(err, repository.ErrInsufficientPoints):
		status = http.StatusConflict
	case errors.Is(err, service.ErrInvalidState):
		status = http.StatusConflict
	case errors.Is(err, service.ErrInvalidBooking):
		status = http.StatusBadRequest
	case errors.Is(err, service.ErrTooManyUnpaid):
		status = http.StatusTooManyRequests
	case errors.Is(err, service.ErrDuplicateSlip), errors.Is(err, service.ErrSlipChanged),
		errors.Is(err, service.ErrLatePaymentSlotGone), errors.Is(err, service.ErrInsufficientPointsForReward),
		errors.Is(err, service.ErrVoucherNotUsable), errors.Is(err, service.ErrOutOfStock):
		status = http.StatusConflict
	}
	if status == http.StatusInternalServerError {
		log.Printf("ERROR %s %s: %v", c.Request.Method, c.FullPath(), err)
		c.JSON(status, gin.H{"success": false, "error": msgInternal})
		return
	}
	c.JSON(status, gin.H{"success": false, "error": err.Error()})
}

// GET /api/v1/auth/me - the logged-in user's current profile (points etc.).
func (h *ArenaHandler) Me(c *gin.Context) {
	u, err := h.userService.GetUserProfile(c.Request.Context(), currentUserID(c))
	if err != nil {
		respondError(c, err)
		return
	}
	if u == nil {
		respondError(c, service.ErrNotFound)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": u})
}

// GET /api/v1/courts - active courts.
func (h *ArenaHandler) ListCourts(c *gin.Context) {
	courts, err := h.bookingService.ListActiveCourts(c.Request.Context())
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": courts})
}

// GET /api/v1/bookings?date=YYYY-MM-DD - every active booking on a date, for
// the availability grid. Anyone may see that a slot is taken; only staff and
// the booking's owner see the rest (see sanitizeBookings).
func (h *ArenaHandler) ListBookings(c *gin.Context) {
	date := c.Query("date")
	if _, err := time.Parse("2006-01-02", date); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "date query parameter must be YYYY-MM-DD"})
		return
	}
	list, err := h.bookingService.ListByDate(c.Request.Context(), date)
	if err != nil {
		respondError(c, err)
		return
	}
	if !isStaff(currentRole(c)) {
		c.JSON(http.StatusOK, gin.H{"success": true, "data": sanitizeBookings(c, list)})
		return
	}
	// Staff also get each row's group payment, so receipts show how it
	// was paid.
	pays, err := h.bookingService.PaymentsByGroupOnDate(c.Request.Context(), date)
	if err != nil {
		respondError(c, err)
		return
	}
	type staffBooking struct {
		model.Booking
		Payment *service.GroupPayment `json:"payment,omitempty"`
	}
	out := make([]staffBooking, len(list))
	for i, b := range list {
		out[i] = staffBooking{Booking: b}
		if p, ok := pays[b.BookingCode+"|"+b.UserID]; ok {
			out[i].Payment = &p
		}
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": out})
}

// sanitizeBookings reduces other people's bookings to what an availability
// view needs - court, date, time, status - for anyone but staff. Booking
// ids and codes are withheld too: the code is what customers quote at the
// counter, so leaking it would let a stranger claim someone's reservation.
func sanitizeBookings(c *gin.Context, list []model.Booking) []model.Booking {
	if isStaff(currentRole(c)) {
		return list
	}
	me := currentUserID(c)
	out := make([]model.Booking, len(list))
	for i, b := range list {
		if me != "" && b.UserID == me {
			out[i] = b
			continue
		}
		out[i] = model.Booking{
			CourtID:      b.CourtID,
			Date:         b.Date,
			StartTime:    b.StartTime,
			EndTime:      b.EndTime,
			IsHalfCourt:  b.IsHalfCourt,
			Status:       b.Status,
			IsEventBlock: b.IsEventBlock,
			EventName:    b.EventName,
		}
	}
	return out
}

// POST /api/v1/staff/bookings - a counter walk-in, paid on the spot: booked
// CONFIRMED through the same availability/pricing checks as online bookings
// (so walk-ins and online bookings can never double-book each other), and
// credited to the registered customer with that phone, if there is one.
func (h *ArenaHandler) CreateWalkInBooking(c *gin.Context) {
	var input struct {
		Date            string                `json:"date" binding:"required"`
		Slots           []service.SlotRequest `json:"slots" binding:"required"`
		CustomerName    string                `json:"customer_name" binding:"required"`
		CustomerPhone   string                `json:"customer_phone" binding:"required"`
		PaymentMethod   model.PaymentMethod   `json:"payment_method"`
		OverrideClosure bool                  `json:"override_closure"`
		Notes           string                `json:"notes"`
		VoucherCode     string                `json:"voucher_code"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	if input.PaymentMethod != "" && input.PaymentMethod != model.PaymentCash && input.PaymentMethod != model.PaymentPromptPay && input.PaymentMethod != model.PaymentVoucher {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "payment_method must be CASH, PROMPTPAY or VOUCHER"})
		return
	}
	customer, err := h.bookingService.FindCustomerByPhone(c.Request.Context(), input.CustomerPhone)
	if err != nil {
		respondError(c, err)
		return
	}
	userID := ""
	if customer != nil {
		userID = customer.ID
	}
	staffID, staffName := actor(c)
	result, err := h.bookingService.CreateBookings(c.Request.Context(), service.CreateBookingInput{
		Date:   input.Date,
		Slots:  input.Slots,
		Notes:  input.Notes,
		UserID: userID,
		WalkIn: &service.WalkInDetails{
			StaffID:         staffID,
			StaffName:       staffName,
			CustomerName:    input.CustomerName,
			CustomerPhone:   input.CustomerPhone,
			PaymentMethod:   input.PaymentMethod,
			OverrideClosure: input.OverrideClosure,
			VoucherCode:     input.VoucherCode,
		},
	})
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": result})
}

// GET /api/v1/me/bookings - the caller's own bookings with payments.
func (h *ArenaHandler) MyBookings(c *gin.Context) {
	list, err := h.bookingService.ListForUser(c.Request.Context(), currentUserID(c))
	if err != nil {
		respondError(c, err)
		return
	}
	for i := range list {
		if list[i].Payment != nil {
			signed := h.slips.SignPayment(*list[i].Payment)
			list[i].Payment = &signed
		}
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}

// GET /api/v1/staff/payments?status=SLIP_UPLOADED - the slip review queue.
func (h *ArenaHandler) ListPaymentsForReview(c *gin.Context) {
	status := model.PaymentStatus(c.DefaultQuery("status", string(model.PaymentSlipUploaded)))
	list, err := h.bookingService.ListPaymentsForReview(c.Request.Context(), status)
	if err != nil {
		respondError(c, err)
		return
	}
	for i := range list {
		list[i].Payment = h.slips.SignPayment(list[i].Payment)
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}

// reviewInput is the body of verify/reject. ExpectedSlipUploadedAt is the
// slip_uploaded_at of the slip the staff member looked at; the server
// refuses the decision if the customer has since replaced the slip.
type reviewInput struct {
	ExpectedSlipUploadedAt *time.Time `json:"expected_slip_uploaded_at"`
	Reason                 string     `json:"reason"`
}

// POST /api/v1/staff/payments/:id/verify {"expected_slip_uploaded_at": "..."}
// - FR-3.3 slip approval: confirms the booking group and awards loyalty points.
func (h *ArenaHandler) VerifyPayment(c *gin.Context) {
	var input reviewInput
	if err := c.ShouldBindJSON(&input); err != nil && !errors.Is(err, io.EOF) {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	staffID, staffName := actor(c)
	res, err := h.bookingService.VerifyPayment(c.Request.Context(), c.Param("id"), input.ExpectedSlipUploadedAt, staffID, staffName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": res})
}

// POST /api/v1/staff/payments/:id/reject {"reason": "...", "expected_slip_uploaded_at": "..."}
// - cancels the booking group and frees its slots.
func (h *ArenaHandler) RejectPayment(c *gin.Context) {
	var input reviewInput
	if err := c.ShouldBindJSON(&input); err != nil || strings.TrimSpace(input.Reason) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "a rejection reason is required"})
		return
	}
	staffID, staffName := actor(c)
	res, err := h.bookingService.RejectPayment(c.Request.Context(), c.Param("id"), input.ExpectedSlipUploadedAt, input.Reason, staffID, staffName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": res})
}
