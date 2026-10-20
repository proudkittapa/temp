package handler

import (
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
)

type ArenaHandler struct {
	authService        *service.AuthService
	userService        *service.UserService
	membershipService  *service.MembershipService
	priceEngineService *service.PriceEngineService
	paymentService     *service.PaymentService
	bookingService     *service.BookingService
	auditLogService    *service.AuditLogService
	posService         *service.POSService
}

func NewArenaHandler(
	authService *service.AuthService,
	userService *service.UserService,
	membershipService *service.MembershipService,
	priceEngineService *service.PriceEngineService,
	paymentService *service.PaymentService,
	bookingService *service.BookingService,
	auditLogService *service.AuditLogService,
	posService *service.POSService,
) *ArenaHandler {
	return &ArenaHandler{
		authService:        authService,
		userService:        userService,
		membershipService:  membershipService,
		priceEngineService: priceEngineService,
		paymentService:     paymentService,
		bookingService:     bookingService,
		auditLogService:    auditLogService,
		posService:         posService,
	}
}

// 1. Register User (POST /api/v1/auth/register)
func (h *ArenaHandler) Register(c *gin.Context) {
	var input struct {
		Name     string `json:"name" binding:"required"`
		Email    string `json:"email"`
		Phone    string `json:"phone" binding:"required"`
		Password string `json:"password" binding:"required"`
	}

	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	if len(input.Password) < 6 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "password must be at least 6 characters"})
		return
	}

	result, err := h.authService.Register(c.Request.Context(), input.Name, input.Email, input.Phone, input.Password)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"success": true,
		"message": "User registered successfully",
		"data": gin.H{
			"token": result.Token,
			"user":  result.User,
		},
	})
}

// 2. Login Handle (POST /api/v1/auth/login)
func (h *ArenaHandler) Login(c *gin.Context) {
	var input struct {
		Identity string `json:"identity" binding:"required"` // Email or Phone ID
		Password string `json:"password" binding:"required"`
	}

	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	result, err := h.authService.Login(c.Request.Context(), input.Identity, input.Password)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"token": result.Token,
			"user":  result.User,
		},
	})
}

// 3. Obtain Gantt Grid Slots (GET /api/v1/courts/slots)
func (h *ArenaHandler) GetSlots(c *gin.Context) {
	dateVal := c.Query("date")
	courtType := c.Query("court_type")

	if dateVal == "" {
		dateVal = time.Now().Format("2006-01-02")
	}

	results, err := h.bookingService.FetchSlotsForGantt(c.Request.Context(), dateVal, model.CourtType(courtType))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"date":         dateVal,
			"courts_slots": results,
		},
	})
}

// 4. Create Reservation (POST /api/v1/bookings) - requires login. Books one
// or more one-hour slots on a date as a single group with one payment.
func (h *ArenaHandler) CreateBooking(c *gin.Context) {
	var input struct {
		Date  string                `json:"date" binding:"required"` // YYYY-MM-DD
		Slots []service.SlotRequest `json:"slots" binding:"required"`
		Notes string                `json:"notes"`
	}

	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	// The booking always belongs to the authenticated caller; member
	// discount and half-court status are resolved server-side, never taken
	// from the request.
	result, err := h.bookingService.CreateBookings(c.Request.Context(), service.CreateBookingInput{
		Date:   input.Date,
		Slots:  input.Slots,
		Notes:  input.Notes,
		UserID: currentUserID(c),
	})
	if err != nil {
		respondError(c, err)
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"success": true,
		"message": "Court reservation schedule holding",
		"data":    result,
	})
}

// 5. Submit Payment Attachment Receipt (POST /api/v1/bookings/:id/upload-slip)
func (h *ArenaHandler) UploadSlip(c *gin.Context) {
	bookingID := c.Param("id")

	owner, err := h.bookingService.BookingOwner(c.Request.Context(), bookingID)
	if err != nil {
		respondError(c, err)
		return
	}
	if owner != currentUserID(c) && !isStaff(currentRole(c)) {
		respondError(c, service.ErrForbidden)
		return
	}

	// Parse incoming file from the form data field "slip" (or fallback to "image")
	file, err := c.FormFile("slip")
	if err != nil {
		file, err = c.FormFile("image")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"success": false,
				"error":   "missing file: please upload slip image file in multipart form-data under field 'slip' or 'image'",
			})
			return
		}
	}

	// Only image extensions are kept: /uploads is served statically, so an
	// uploaded .html/.svg would otherwise be served back as active content.
	ext, ok := allowedSlipExt[strings.ToLower(strings.TrimPrefix(filepath.Ext(file.Filename), "."))]
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "slip must be a JPG, PNG or WEBP image"})
		return
	}
	if file.Size > maxSlipBytes {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "slip image must be 5 MB or smaller"})
		return
	}

	fileName := "slip_" + bookingID + "_" + time.Now().Format("20060102150405") + "." + ext
	filePath := "./uploads/slips/" + fileName

	// Save the physical file directly onto the local server filesystem storage
	if err := c.SaveUploadedFile(file, filePath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"success": false,
			"error":   "failed to write attachment to disk: " + err.Error(),
		})
		return
	}

	// Generate client-accessible relative static path
	servedURL := "/uploads/slips/" + fileName

	// Update the database records atomically inside our dedicated payment service
	result, err := h.paymentService.SaveSlipUploadedTransaction(c.Request.Context(), bookingID, servedURL)
	if err != nil {
		respondError(c, err)
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Payment receipt uploaded successfully. Our cashier matching engine has queued verification.",
		"data": gin.H{
			"slip_url": result.SlipURL,
			"status":   result.Status,
		},
	})
}

// 6. POS Order Dispatcher (POST /api/v1/pos/order)
func (h *ArenaHandler) ProcessPOSCheckout(c *gin.Context) {
	var input service.CheckoutInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	input.CreatedBy = currentUserID(c)

	result, err := h.posService.ProcessCheckout(c.Request.Context(), input)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Checkout transactional sales saved",
		"data":    result,
	})
}

// 7. Manual Member Points Modifiers (POST /api/v1/admin/users/:id/adjust-points)
func (h *ArenaHandler) ModifyPoints(c *gin.Context) {
	usrParamID := c.Param("id")
	var input struct {
		PointsDelta int `json:"points_delta" binding:"required"`
	}

	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	newBalance, err := h.userService.AdjustUserPoints(c.Request.Context(), usrParamID, input.PointsDelta, currentUserID(c))
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Loyalty points balance modified by dashboard management",
		"data": gin.H{
			"user_id":     usrParamID,
			"new_balance": newBalance,
		},
	})
}
