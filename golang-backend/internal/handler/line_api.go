package handler

import (
	"errors"
	"log"
	"net/http"
	"strconv"

	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
)

// LINE login endpoints (service.LineLogin). All are public: start and
// callback also accept a signed-in customer (linking LINE to the account).
type LineHandler struct {
	line     *service.LineLogin
	notifier *service.LineNotifier // nil = LINE messages off
}

func NewLineHandler(line *service.LineLogin, notifier *service.LineNotifier) *LineHandler {
	return &LineHandler{line: line, notifier: notifier}
}

// GET /api/v1/admin/line/usage - this month's LINE messages (Settings).
func (h *LineHandler) Usage(c *gin.Context) {
	u, err := h.notifier.Usage(c.Request.Context())
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": u})
}

// GET /api/v1/auth/line - whether the "เข้าสู่ระบบด้วย LINE" button shows.
func (h *LineHandler) Status(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"enabled": h.line.Enabled()}})
}

// lineFail answers a LINE login error: the user-facing sentinel's text
// only (the wrapped detail goes to the log).
func lineFail(c *gin.Context, err error) {
	var tooMany *service.TooManySignupsError
	switch {
	case errors.As(err, &tooMany):
		c.Header("Retry-After", strconv.Itoa(int(tooMany.RetryAfter.Seconds())+1))
		c.JSON(http.StatusTooManyRequests, gin.H{"success": false, "error": err.Error()})
	case errors.Is(err, service.ErrLineNotConfigured):
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "error": service.ErrLineNotConfigured.Error()})
	case errors.Is(err, service.ErrLineLoginFailed):
		log.Printf("LINE login: %v\n", err)
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": service.ErrLineLoginFailed.Error()})
	case errors.Is(err, service.ErrLineStaffAccount), errors.Is(err, service.ErrAccountSuspended):
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": err.Error()})
	case errors.Is(err, service.ErrLineAlreadyLinked), errors.Is(err, service.ErrLinePhoneTaken):
		c.JSON(http.StatusConflict, gin.H{"success": false, "error": err.Error()})
	case errors.Is(err, service.ErrInvalidPhone), errors.Is(err, service.ErrInvalidRegistration):
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
	default:
		log.Printf("LINE login: %v\n", err)
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "LINE sign-in failed - please try again"})
	}
}

// POST /api/v1/auth/line/start {link?} - LINE's authorize URL and the state
// the browser keeps. link=true (signed-in customer): add LINE to this
// account instead of signing in.
func (h *LineHandler) Start(c *gin.Context) {
	var input struct {
		Link bool `json:"link"`
	}
	if c.Request.ContentLength > 0 {
		if err := c.ShouldBindJSON(&input); err != nil {
			badBody(c, err)
			return
		}
	}
	linkUser := ""
	if input.Link {
		if linkUser = currentUserID(c); linkUser == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "login required"})
			return
		}
	}
	authURL, state, err := h.line.Start(c.Request.Context(), linkUser)
	if err != nil {
		lineFail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"url": authURL, "state": state}})
}

// POST /api/v1/auth/line/callback {code, state} - after LINE sends the
// browser back. Answers a session, the linked account, or needs_phone with
// a sign-up token.
func (h *LineHandler) Callback(c *gin.Context) {
	var input struct {
		Code  string `json:"code" binding:"required"`
		State string `json:"state" binding:"required"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		badBody(c, err)
		return
	}
	res, err := h.line.Callback(c.Request.Context(), input.Code, input.State, currentUserID(c))
	if err != nil {
		lineFail(c, err)
		return
	}
	switch {
	case res.Auth != nil:
		c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"token": res.Auth.Token, "user": res.Auth.User}})
	case res.Linked != nil:
		c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"linked": true, "user": res.Linked}})
	default:
		c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"needs_phone": true, "signup_token": res.SignupToken, "name": res.Name}})
	}
}

// POST /api/v1/auth/line/complete {signup_token, name, phone} - a new LINE
// user's account, with the phone number they typed.
func (h *LineHandler) Complete(c *gin.Context) {
	var input struct {
		SignupToken string `json:"signup_token" binding:"required"`
		Name        string `json:"name"`
		Phone       string `json:"phone" binding:"required"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		badBody(c, err)
		return
	}
	res, err := h.line.CompleteSignup(c.Request.Context(), input.SignupToken, input.Name, input.Phone, c.ClientIP())
	if err != nil {
		lineFail(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": gin.H{"token": res.Token, "user": res.User}})
}
