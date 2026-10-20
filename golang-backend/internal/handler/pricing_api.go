package handler

import (
	"net/http"

	"arena-backend/internal/model"
	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
)

// PricingHandler serves pricing rules, member discounts and the half-court
// rate - read publicly (so clients preview exactly what will be charged),
// edited by admins only.
type PricingHandler struct {
	pricing *service.PricingAdminService
}

func NewPricingHandler(pricing *service.PricingAdminService) *PricingHandler {
	return &PricingHandler{pricing: pricing}
}

// GET /api/v1/pricing
func (h *PricingHandler) Snapshot(c *gin.Context) {
	snap, err := h.pricing.Snapshot(c.Request.Context())
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": snap})
}

type pricingRuleInput struct {
	CourtType    model.CourtType `json:"court_type" binding:"required"`
	DayType      string          `json:"day_type" binding:"required"`
	StartHour    *int            `json:"start_hour" binding:"required"`
	EndHour      *int            `json:"end_hour" binding:"required"`
	PricePerHour *float64        `json:"price_per_hour" binding:"required"`
	PriceType    string          `json:"price_type" binding:"required"`
	Label        string          `json:"label"`
	IsActive     *bool           `json:"is_active"`
}

func (in pricingRuleInput) toModel(id string) model.PricingRule {
	active := true
	if in.IsActive != nil {
		active = *in.IsActive
	}
	return model.PricingRule{
		ID: id, CourtType: in.CourtType, DayType: in.DayType, StartHour: *in.StartHour, EndHour: *in.EndHour,
		PricePerHour: *in.PricePerHour, PriceType: in.PriceType, Label: in.Label, IsActive: active,
	}
}

// POST /api/v1/admin/pricing-rules and PUT /api/v1/admin/pricing-rules/:id
func (h *PricingHandler) SaveRule(c *gin.Context) {
	var in pricingRuleInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	actorID, actorName := actor(c)
	rule, err := h.pricing.SaveRule(c.Request.Context(), in.toModel(c.Param("id")), actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	status := http.StatusOK
	if c.Param("id") == "" {
		status = http.StatusCreated
	}
	c.JSON(status, gin.H{"success": true, "data": rule})
}

// DELETE /api/v1/admin/pricing-rules/:id
func (h *PricingHandler) DeleteRule(c *gin.Context) {
	actorID, actorName := actor(c)
	if err := h.pricing.DeleteRule(c.Request.Context(), c.Param("id"), actorID, actorName); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// PUT /api/v1/admin/member-discounts/:member_type
func (h *PricingHandler) UpdateMemberDiscount(c *gin.Context) {
	var in struct {
		Name            string   `json:"name" binding:"required"`
		DiscountPercent *float64 `json:"discount_percent" binding:"required"`
		IsActive        *bool    `json:"is_active" binding:"required"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	actorID, actorName := actor(c)
	d, err := h.pricing.UpdateMemberDiscount(c.Request.Context(), model.MemberDiscount{
		MemberType: model.MemberType(c.Param("member_type")), Name: in.Name, DiscountPercent: *in.DiscountPercent, IsActive: *in.IsActive,
	}, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": d})
}

// PUT /api/v1/admin/pricing-config {"half_court_rate_percent": 50,
// "max_advance_days": 30, "open_hour": 7, "close_hour": 23} - any field may
// be omitted.
func (h *PricingHandler) UpdateConfig(c *gin.Context) {
	var in struct {
		HalfCourtRatePercent *float64 `json:"half_court_rate_percent"`
		MaxAdvanceDays       *int     `json:"max_advance_days"`
		OpenHour             *int     `json:"open_hour"`
		CloseHour            *int     `json:"close_hour"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || (in.HalfCourtRatePercent == nil && in.MaxAdvanceDays == nil && in.OpenHour == nil && in.CloseHour == nil) {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "send half_court_rate_percent, max_advance_days, open_hour and/or close_hour"})
		return
	}
	actorID, actorName := actor(c)
	cfg, err := h.pricing.UpdateConfig(c.Request.Context(), in.HalfCourtRatePercent, in.MaxAdvanceDays, in.OpenHour, in.CloseHour, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": cfg})
}
