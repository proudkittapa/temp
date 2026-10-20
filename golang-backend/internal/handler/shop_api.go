package handler

import (
	"net/http"
	"strconv"
	"time"

	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
)

// ShopHandler serves the counter shop (products, sales, rentals) and the
// admin reports built from the database.
type ShopHandler struct {
	pos      *service.POSService
	reports  *service.ReportService
	bookings *service.BookingService
}

func NewShopHandler(pos *service.POSService, reports *service.ReportService, bookings *service.BookingService) *ShopHandler {
	return &ShopHandler{pos: pos, reports: reports, bookings: bookings}
}

func today() string { return time.Now().In(service.Bangkok).Format("2006-01-02") }

// GET /api/v1/staff/products - staff: the active catalog with stock (and
// shoe sizes). GET /api/v1/admin/products - managers: including inactive.
func (h *ShopHandler) ListProducts(includeInactive bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		list, err := h.pos.ListProducts(c.Request.Context(), includeInactive)
		if err != nil {
			respondError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
	}
}

// POST /api/v1/admin/products {"products": [{...}]} - managers: add one
// product (form) or many (Excel import).
func (h *ShopHandler) CreateProducts(c *gin.Context) {
	var in struct {
		Products []service.ProductInput `json:"products"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	actorID, actorName := actor(c)
	list, err := h.pos.CreateProducts(c.Request.Context(), in.Products, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}

// PUT /api/v1/admin/products/:id - managers: edit name/price/category/active.
func (h *ShopHandler) UpdateProduct(c *gin.Context) {
	var in service.ProductInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	actorID, actorName := actor(c)
	p, err := h.pos.UpdateProduct(c.Request.Context(), c.Param("id"), in, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": p})
}

// POST /api/v1/admin/products/:id/stock {"delta": 10, "variant_id": "...", "reason": "..."}
// - managers: restock or correct the count, with a reason (audited).
func (h *ShopHandler) AdjustStock(c *gin.Context) {
	var in struct {
		Delta     int     `json:"delta"`
		VariantID *string `json:"variant_id"`
		Reason    string  `json:"reason"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	actorID, actorName := actor(c)
	p, err := h.pos.AdjustStock(c.Request.Context(), c.Param("id"), in.VariantID, in.Delta, in.Reason, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": p})
}

// POST /api/v1/pos/order - staff: sell F&B/equipment or rent out rackets and
// shoes. Prices come from the catalog; customer_phone credits the points.
func (h *ShopHandler) Checkout(c *gin.Context) {
	var input service.CheckoutInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	input.CreatedBy, input.CreatedByName = actor(c)
	result, err := h.pos.ProcessCheckout(c.Request.Context(), input)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": result})
}

// GET /api/v1/staff/orders?date=YYYY-MM-DD - staff: that day's counter
// orders (default today).
func (h *ShopHandler) ListOrders(c *gin.Context) {
	list, err := h.pos.OrdersOnDate(c.Request.Context(), c.DefaultQuery("date", today()))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}

// GET /api/v1/staff/rentals - staff: rentals with items still out.
func (h *ShopHandler) ActiveRentals(c *gin.Context) {
	list, err := h.pos.ActiveRentals(c.Request.Context())
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}

// POST /api/v1/staff/rentals/items/:id/return - staff: the item is back.
func (h *ShopHandler) ReturnRental(c *gin.Context) {
	actorID, actorName := actor(c)
	o, err := h.pos.ReturnRentalItem(c.Request.Context(), c.Param("id"), actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": o})
}

// GET /api/v1/staff/summary?date=YYYY-MM-DD - staff: money received that
// day by method for the cash drawer - bookings (approved payments, refunds)
// and counter orders.
func (h *ShopHandler) DaySummary(c *gin.Context) {
	date := c.DefaultQuery("date", today())
	sum, err := h.bookings.Summary(c.Request.Context(), date)
	if err != nil {
		respondError(c, err)
		return
	}
	from, _ := time.ParseInLocation("2006-01-02", date, service.Bangkok)
	orders, err := h.pos.TotalsBetween(c.Request.Context(), from, from.AddDate(0, 0, 1))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{
		"date": sum.Date, "cash_received": sum.CashReceived, "promptpay_verified": sum.PromptPayVerified,
		"refunded": sum.Refunded, "paid_bookings": sum.PaidBookings,
		"orders_cash": orders.Cash, "orders_promptpay": orders.PromptPay, "fb_sales": orders.FB,
		"equipment_sales": orders.EquipmentSales, "rental_income": orders.Rentals, "orders_count": orders.Count,
	}})
}

// GET /api/v1/admin/dashboard?date=YYYY-MM-DD - managers (FR-7.2).
func (h *ShopHandler) Dashboard(c *gin.Context) {
	d, err := h.reports.Dashboard(c.Request.Context(), c.DefaultQuery("date", today()))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": d})
}

// GET /api/v1/admin/report?month=YYYY-MM - managers: bookings and counter
// orders of the month for the export (FR-7.4).
func (h *ShopHandler) MonthReport(c *gin.Context) {
	r, err := h.reports.MonthReport(c.Request.Context(), c.DefaultQuery("month", today()[:7]))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": r})
}

// GET /api/v1/admin/audit-logs?search=&target_type=&limit=&offset= -
// admins only (FR-7.3, RBAC "Inspect Anti-Fraud Audit Trail").
func (h *ShopHandler) AuditLogs(c *gin.Context) {
	limit, _ := strconv.Atoi(c.Query("limit"))
	offset, _ := strconv.Atoi(c.Query("offset"))
	logs, total, err := h.reports.AuditLogs(c.Request.Context(), service.AuditQuery{
		Search: c.Query("search"), TargetType: c.Query("target_type"), Limit: limit, Offset: offset,
	})
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": logs, "total": total})
}
