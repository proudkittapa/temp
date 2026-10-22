package handler

import (
	"net/http"

	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
)

// CourtHandler lets admins manage courts (the public list is GET /courts).
type CourtHandler struct {
	courts *service.CourtAdminService
}

func NewCourtHandler(courts *service.CourtAdminService) *CourtHandler {
	return &CourtHandler{courts: courts}
}

// GET /api/v1/admin/courts - managers/admins: every court, closed ones too.
func (h *CourtHandler) List(c *gin.Context) {
	list, err := h.courts.List(c.Request.Context())
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}

// POST /api/v1/admin/courts {"name": "...", "type": "BADMINTON", "half_court": false} - admins.
func (h *CourtHandler) Create(c *gin.Context) {
	var in service.CourtInput
	if err := c.ShouldBindJSON(&in); err != nil {
		badBody(c, err)
		return
	}
	actorID, actorName := actor(c)
	court, err := h.courts.Create(c.Request.Context(), in, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": court})
}

// PUT /api/v1/admin/courts/:id {"name": "...", "is_active": false, "off_peak_only": true} - admins.
// Closing a court stops new bookings; upcoming_bookings in the answer says
// how many existing ones still need to be moved or cancelled.
func (h *CourtHandler) Update(c *gin.Context) {
	var in service.CourtInput
	if err := c.ShouldBindJSON(&in); err != nil {
		badBody(c, err)
		return
	}
	actorID, actorName := actor(c)
	res, err := h.courts.Update(c.Request.Context(), c.Param("id"), in, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": res})
}
