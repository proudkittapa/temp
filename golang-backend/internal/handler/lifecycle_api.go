package handler

import (
	"net/http"

	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
)

// POST /api/v1/admin/bookings/:id/cancel {"reason": "...", "refund": true, "booking_ids": [...]}
// - manager/admin (FR-6.3). :id is any hour of the booking group;
// booking_ids limits it to some hours, otherwise all active hours are
// cancelled. refund records the cancelled paid hours as refunded.
func (h *ArenaHandler) CancelBooking(c *gin.Context) {
	var in struct {
		Reason     string   `json:"reason"`
		Refund     bool     `json:"refund"`
		BookingIDs []string `json:"booking_ids"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	actorID, actorName := actor(c)
	res, err := h.bookingService.CancelBookings(c.Request.Context(), c.Param("id"), in.BookingIDs, in.Reason, in.Refund, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": res})
}

// POST /api/v1/admin/payments/:id/refund {"reason": "...", "amount": 250} -
// manager/admin: record a refund (e.g. a late payment whose slot was taken).
func (h *ArenaHandler) RefundPayment(c *gin.Context) {
	var in struct {
		Reason string   `json:"reason"`
		Amount *float64 `json:"amount"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	actorID, actorName := actor(c)
	p, err := h.bookingService.RefundPayment(c.Request.Context(), c.Param("id"), in.Amount, in.Reason, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": h.slips.SignPayment(*p)})
}

// POST /api/v1/admin/payments/:id/mark-cash - manager/admin: the customer
// paid this booking in cash at the counter.
func (h *ArenaHandler) MarkPaidInCash(c *gin.Context) {
	actorID, actorName := actor(c)
	res, err := h.bookingService.MarkPaidInCash(c.Request.Context(), c.Param("id"), actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": res})
}

// POST /api/v1/admin/bookings/:id/mark-cash - the same, by any hour of the
// booking (what the booking grid has).
func (h *ArenaHandler) MarkBookingPaidInCash(c *gin.Context) {
	paymentID, err := h.bookingService.PaymentForBooking(c.Request.Context(), c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.Params = append(c.Params[:0], gin.Param{Key: "id", Value: paymentID})
	h.MarkPaidInCash(c)
}

// POST /api/v1/staff/bookings/:id/no-show - staff: the customer didn't come
// for this hour.
func (h *ArenaHandler) MarkNoShow(c *gin.Context) {
	actorID, actorName := actor(c)
	b, err := h.bookingService.MarkNoShow(c.Request.Context(), c.Param("id"), actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": b})
}

// RewardHandler serves the loyalty rewards club (FR-4.2/4.3).
type RewardHandler struct {
	rewards *service.RewardService
}

func NewRewardHandler(rewards *service.RewardService) *RewardHandler {
	return &RewardHandler{rewards: rewards}
}

// GET /api/v1/rewards - public catalog.
func (h *RewardHandler) Catalog(c *gin.Context) {
	items, err := h.rewards.Catalog(c.Request.Context())
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": items})
}

// POST /api/v1/me/rewards/:id/redeem - the logged-in customer spends points.
func (h *RewardHandler) Redeem(c *gin.Context) {
	v, err := h.rewards.Redeem(c.Request.Context(), currentUserID(c), c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": v})
}

// GET /api/v1/me/vouchers
func (h *RewardHandler) MyVouchers(c *gin.Context) {
	list, err := h.rewards.MyVouchers(c.Request.Context(), currentUserID(c))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}

// GET /api/v1/staff/vouchers/:code - staff look a claim code up.
func (h *RewardHandler) Lookup(c *gin.Context) {
	v, err := h.rewards.Lookup(c.Request.Context(), c.Param("code"))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": v})
}

// POST /api/v1/staff/vouchers/:code/dispense - staff hand the reward over.
func (h *RewardHandler) Dispense(c *gin.Context) {
	actorID, actorName := actor(c)
	v, err := h.rewards.Dispense(c.Request.Context(), c.Param("code"), actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": v})
}
