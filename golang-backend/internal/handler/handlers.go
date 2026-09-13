package handler

import (
	"context"
	"net/http"
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

	result, err := h.authService.Register(context.Background(), input.Name, input.Email, input.Phone, input.Password)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"success": true,
		"message": "User registered successfully",
		"data": gin.H{
			"token": result.Token,
			"user": gin.H{
				"id":          result.User.ID,
				"name":        result.User.Name,
				"phone":       result.User.Phone,
				"role":        result.User.Role,
				"member_type": result.User.MemberType,
				"points":      result.User.Points,
			},
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

	result, err := h.authService.Login(context.Background(), input.Identity, input.Password)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"token": result.Token,
			"user": gin.H{
				"id":          result.User.ID,
				"name":        result.User.Name,
				"phone":       result.User.Phone,
				"role":        result.User.Role,
				"member_type": result.User.MemberType,
				"points":      result.User.Points,
			},
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

	results, err := h.bookingService.FetchSlotsForGantt(context.Background(), dateVal, model.CourtType(courtType))
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

// 4. Create Reservation (POST /api/v1/bookings)
func (h *ArenaHandler) CreateBooking(c *gin.Context) {
	var input struct {
		CourtID   string `json:"court_id" binding:"required"`
		Date      string `json:"date" binding:"required"`       // YYYY-MM-DD
		StartTime string `json:"start_time" binding:"required"` // HH:MM
		EndTime   string `json:"end_time" binding:"required"`   // HH:MM
		Notes     string `json:"notes"`
	}

	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	// Standard placeholder user session context
	userID := "u-guest"
	if u, exists := c.Get("user_id"); exists {
		userID = u.(string)
	}

	// is_half_court/half_court_side are no longer accepted from the client:
	// CreateNewBooking derives half-court status from Court.ShareOfGroup so a
	// caller can't request the wrong rate by lying about the flag.
	bookingInput := service.CreateBookingInput{
		CourtID:   input.CourtID,
		Date:      input.Date,
		StartTime: input.StartTime,
		EndTime:   input.EndTime,
		Notes:     input.Notes,
		UserID:    userID,
	}

	result, err := h.bookingService.CreateNewBooking(context.Background(), bookingInput)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"success": true,
		"message": "Court reservation schedule holding",
		"data": gin.H{
			"booking_id":        result.BookingID,
			"booking_code":      result.BookingCode,
			"total_amount":      result.TotalAmount,
			"promptpay_payload": result.PromptPayPayload,
		},
	})
}

// 5. Submit Payment Attachment Receipt (POST /api/v1/bookings/:id/upload-slip)
func (h *ArenaHandler) UploadSlip(c *gin.Context) {
	bookingID := c.Param("id")

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

	// Generate a secure, unique local file path to prevent collision overrides
	ext := "png" // Default fallback extension
	if file.Filename != "" {
		// Quick extraction of actual extension (e.g. filename.jpg -> jpg)
		for i := len(file.Filename) - 1; i >= 0; i-- {
			if file.Filename[i] == '.' {
				ext = file.Filename[i+1:]
				break
			}
		}
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
	result, err := h.paymentService.SaveSlipUploadedTransaction(context.Background(), bookingID, servedURL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"success": false,
			"error":   "file registered but failed to commit status update changes in db: " + err.Error(),
		})
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

	// Extract active cashier session
	input.CreatedBy = "staff-session"

	result, err := h.posService.ProcessCheckout(context.Background(), input)
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

	newBalance, err := h.userService.AdjustUserPoints(context.Background(), usrParamID, input.PointsDelta, "staff-session")
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
