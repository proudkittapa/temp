package handler

import (
	"errors"
	"net/http"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/repository"
	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
)

var allowedSlipExt = map[string]string{"jpg": "jpg", "jpeg": "jpg", "png": "png", "webp": "webp"}

const maxSlipBytes = 5 << 20

// respondError maps service sentinel errors to HTTP status codes so clients
// can tell "slot taken" (409) from "bad input" (400) from a server fault.
func respondError(c *gin.Context, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, service.ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, service.ErrForbidden):
		status = http.StatusForbidden
	case errors.Is(err, repository.ErrSlotTaken), errors.Is(err, service.ErrSlotUnavailable):
		status = http.StatusConflict
	case errors.Is(err, service.ErrInvalidState):
		status = http.StatusConflict
	case errors.Is(err, service.ErrInvalidBooking):
		status = http.StatusBadRequest
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
// the booking's owner see whose it is.
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
		me := currentUserID(c)
		for i := range list {
			if me == "" || list[i].UserID != me {
				list[i].UserID = ""
				list[i].CreatedBy = ""
				list[i].Notes = nil
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}

// GET /api/v1/me/bookings - the caller's own bookings with payments.
func (h *ArenaHandler) MyBookings(c *gin.Context) {
	list, err := h.bookingService.ListForUser(c.Request.Context(), currentUserID(c))
	if err != nil {
		respondError(c, err)
		return
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
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}

// POST /api/v1/staff/payments/:id/verify - FR-3.3 slip approval: confirms
// the booking group and awards loyalty points.
func (h *ArenaHandler) VerifyPayment(c *gin.Context) {
	staffID, staffName := h.actor(c)
	res, err := h.bookingService.VerifyPayment(c.Request.Context(), c.Param("id"), staffID, staffName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": res})
}

// POST /api/v1/staff/payments/:id/reject {"reason": "..."} - cancels the
// booking group and frees its slots.
func (h *ArenaHandler) RejectPayment(c *gin.Context) {
	var input struct {
		Reason string `json:"reason" binding:"required"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "a rejection reason is required"})
		return
	}
	staffID, staffName := h.actor(c)
	res, err := h.bookingService.RejectPayment(c.Request.Context(), c.Param("id"), input.Reason, staffID, staffName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": res})
}

// actor returns the caller's id and display name for audit logs.
func (h *ArenaHandler) actor(c *gin.Context) (string, string) {
	id := currentUserID(c)
	if u, err := h.userService.GetUserProfile(c.Request.Context(), id); err == nil && u != nil {
		return id, u.Name
	}
	return id, id
}
