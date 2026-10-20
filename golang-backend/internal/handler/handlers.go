package handler

import (
	"errors"
	"net/http"
	"os"
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
		if errors.Is(err, service.ErrDuplicateUser) {
			c.JSON(http.StatusConflict, gin.H{"success": false, "error": err.Error()})
		} else if errors.Is(err, service.ErrInvalidPhone) {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "registration failed, please try again"})
		}
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
	results = sanitizeBookings(c, results)

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
// :id may be any booking row in the group. Ownership and payment state are
// checked before anything touches the disk, so a refused upload never
// leaves a publicly served file behind; a replaced slip's old file is
// deleted once the new one is recorded.
func (h *ArenaHandler) UploadSlip(c *gin.Context) {
	bookingID := c.Param("id")

	payment, err := h.bookingService.CheckSlipUpload(c.Request.Context(), bookingID, currentUserID(c), isStaff(currentRole(c)))
	if err != nil {
		respondError(c, err)
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

	// Named by payment (server-generated id), never by client input.
	fileName := "slip_" + payment.ID + "_" + time.Now().Format("20060102150405") + "." + ext
	filePath := filepath.Join(slipDir, fileName)
	if err := c.SaveUploadedFile(file, filePath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "failed to store slip image"})
		return
	}
	servedURL := slipURLPrefix + fileName

	previous, err := h.bookingService.SaveSlip(c.Request.Context(), payment.ID, servedURL)
	if err != nil {
		_ = os.Remove(filePath) // state changed since the check - don't keep the file
		respondError(c, err)
		return
	}
	removeSlipFile(previous)

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Payment receipt uploaded successfully. Our cashier matching engine has queued verification.",
		"data": gin.H{
			"slip_url": servedURL,
			"status":   model.PaymentSlipUploaded,
		},
	})
}

const (
	slipDir       = "./uploads/slips"
	slipURLPrefix = "/uploads/slips/"
)

// removeSlipFile deletes a previously stored slip by its served URL. Only
// names inside slipDir are touched.
func removeSlipFile(servedURL string) {
	name, ok := strings.CutPrefix(servedURL, slipURLPrefix)
	if !ok || name == "" || strings.ContainsAny(name, `/\`) {
		return
	}
	_ = os.Remove(filepath.Join(slipDir, name))
}

// 6. POS Order Dispatcher (POST /api/v1/pos/order)
func (h *ArenaHandler) ProcessPOSCheckout(c *gin.Context) {
	var input service.CheckoutInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	input.CreatedBy, _ = actor(c)

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
