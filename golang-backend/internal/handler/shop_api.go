package handler

import (
	"net/http"
	"strconv"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
)

// ShopHandler serves the counter shop (products, sales, rentals) and the
// admin reports built from the database.
type ShopHandler struct {
	pos      *service.POSService
	reports  *service.ReportService
	bookings *service.BookingService
	shifts   *service.ShiftService
}

func NewShopHandler(pos *service.POSService, reports *service.ReportService, bookings *service.BookingService, shifts *service.ShiftService) *ShopHandler {
	return &ShopHandler{pos: pos, reports: reports, bookings: bookings, shifts: shifts}
}

func today() string { return service.BangkokToday() }

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
	from, to, err := service.BangkokDay(date) // valid: Summary accepted it
	if err != nil {
		respondError(c, err)
		return
	}
	orders, err := h.pos.TotalsBetween(c.Request.Context(), from, to)
	if err != nil {
		respondError(c, err)
		return
	}
	data := gin.H{
		"date": sum.Date, "cash_received": sum.CashReceived, "promptpay_verified": sum.PromptPayVerified,
		"refunded": sum.Refunded, "paid_bookings": sum.PaidBookings,
		"orders_cash": orders.Cash, "orders_promptpay": orders.PromptPay, "fb_sales": orders.FB,
		"equipment_sales": orders.EquipmentSales, "rental_income": orders.Rentals, "orders_count": orders.Count,
	}
	if blindCount(c) {
		// Anything the cash could be worked out from is withheld too.
		for _, k := range []string{"cash_received", "orders_cash", "fb_sales", "equipment_sales", "rental_income"} {
			data[k] = 0
		}
		data["blind"] = true
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
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
// orders of the month for the export (FR-7.4). Each fetch is audit-logged
// as an export (customer names and phones leave the system).
func (h *ShopHandler) MonthReport(c *gin.Context) {
	month := c.DefaultQuery("month", today()[:7])
	r, err := h.reports.MonthReport(c.Request.Context(), month)
	if err != nil {
		respondError(c, err)
		return
	}
	actorID, actorName := actor(c)
	if err := h.reports.LogExport(c.Request.Context(), month, c.Query("kind"), actorID, actorName); err != nil {
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

// POST /api/v1/admin/orders/:id/void {"reason": "..."} - managers: cancel
// today's counter sale (stock back, points back, out of the drawer).
func (h *ShopHandler) VoidOrder(c *gin.Context) {
	var in struct {
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	actorID, actorName := actor(c)
	o, err := h.pos.VoidOrder(c.Request.Context(), c.Param("id"), in.Reason, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": o})
}

// GET /api/v1/staff/shift - staff: the open shift with cash taken so far
// (data is null when no shift is open).
func (h *ShopHandler) CurrentShift(c *gin.Context) {
	sh, err := h.shifts.Current(c.Request.Context())
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": blindShift(c, sh)})
}

// blindCount: counter staff count the drawer without knowing what it should
// hold (owner decision 2026-10-21) - the expected cash and the day's cash
// totals go to managers and admins only. The close result (with the
// difference) is shown once the count is in.
func blindCount(c *gin.Context) bool { return currentRole(c) == model.RoleStaff }

func blindShift(c *gin.Context, sh *service.ShiftView) *service.ShiftView {
	if sh == nil || !blindCount(c) {
		return sh
	}
	cp := *sh
	cp.CashBookings, cp.CashOrders, cp.Expected, cp.Blind = 0, 0, 0, true
	return &cp
}

// POST /api/v1/staff/shift/open {"opening_float": 2000} - staff (FR-6.1).
func (h *ShopHandler) OpenShift(c *gin.Context) {
	var in struct {
		OpeningFloat float64 `json:"opening_float"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	actorID, actorName := actor(c)
	sh, err := h.shifts.Open(c.Request.Context(), in.OpeningFloat, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": blindShift(c, sh)})
}

// POST /api/v1/staff/shift/close {"counted_cash": 5230, "notes": "..."} -
// staff (FR-6.2): stores expected cash and over/short; a note is required
// when the count is off.
func (h *ShopHandler) CloseShift(c *gin.Context) {
	var in struct {
		CountedCash *float64 `json:"counted_cash"`
		Notes       string   `json:"notes"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || in.CountedCash == nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "counted_cash is required"})
		return
	}
	actorID, actorName := actor(c)
	sh, err := h.shifts.Close(c.Request.Context(), *in.CountedCash, in.Notes, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": sh})
}

// GET /api/v1/admin/shifts?from=YYYY-MM-DD&to=YYYY-MM-DD - managers: shifts
// with expected, counted and over/short (default: the last 30 days).
func (h *ShopHandler) ListShifts(c *gin.Context) {
	now := time.Now().In(service.Bangkok)
	from, err := time.ParseInLocation("2006-01-02", c.DefaultQuery("from", now.AddDate(0, 0, -30).Format("2006-01-02")), service.Bangkok)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "from must be YYYY-MM-DD"})
		return
	}
	to, err := time.ParseInLocation("2006-01-02", c.DefaultQuery("to", now.Format("2006-01-02")), service.Bangkok)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "to must be YYYY-MM-DD"})
		return
	}
	list, err := h.shifts.List(c.Request.Context(), from, to.AddDate(0, 0, 1))
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": list})
}
