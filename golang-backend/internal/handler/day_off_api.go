package handler

import (
	"net/http"
	"time"

	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
)

// DayOffHandler serves court closures (FR-1.3).
type DayOffHandler struct {
	dayOffs *service.DayOffService
}

func NewDayOffHandler(dayOffs *service.DayOffService) *DayOffHandler {
	return &DayOffHandler{dayOffs: dayOffs}
}

// GET /api/v1/days-off?from=YYYY-MM-DD&to=YYYY-MM-DD - public, so booking
// grids can show closed slots. from defaults to today; to is optional.
func (h *DayOffHandler) List(c *gin.Context) {
	from := c.DefaultQuery("from", time.Now().In(service.Bangkok).Format("2006-01-02"))
	to := c.Query("to")
	for _, d := range []string{from, to} {
		if d == "" {
			continue
		}
		if _, err := time.Parse("2006-01-02", d); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "from/to must be YYYY-MM-DD"})
			return
		}
	}
	list, err := h.dayOffs.List(c.Request.Context(), from, to)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}

// POST /api/v1/admin/days-off - manager/admin only.
func (h *DayOffHandler) Create(c *gin.Context) {
	var input service.CreateDayOffInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	actorID, actorName := actor(c)
	res, err := h.dayOffs.Create(c.Request.Context(), input, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": res})
}

// DELETE /api/v1/admin/days-off/:id - manager/admin only.
func (h *DayOffHandler) Delete(c *gin.Context) {
	actorID, actorName := actor(c)
	if err := h.dayOffs.Delete(c.Request.Context(), c.Param("id"), actorID, actorName); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}
