package handler

import (
	"net/http"
	"strings"

	"arena-backend/internal/model"
	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
)

const (
	ctxAuthUnavailable = "auth_unavailable"
	ctxUserID          = "user_id"
	ctxRole            = "role"
	ctxUserName        = "user_name"
	ctxAuthError       = "auth_error"
	ctxPermissions     = "permissions"
)

// Authenticate reads an optional "Authorization: Bearer <jwt>" header and,
// if it is valid, stores the caller on the context. Role and active status
// are re-read from the users table on every request rather than trusted
// from the token, so suspending or demoting someone takes effect at once
// instead of when their up-to-48h token expires.
//
// It never rejects a request itself: a missing, invalid or expired token
// just means "anonymous", so public routes keep working for a client whose
// session lapsed. RequireRole then decides per route, and reports a lapsed
// session as such.
func Authenticate(auth *service.AuthService, roles *service.RoleService) gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		if header == "" {
			c.Next()
			return
		}
		token, ok := strings.CutPrefix(header, "Bearer ")
		if !ok {
			c.Set(ctxAuthError, "malformed Authorization header")
			c.Next()
			return
		}
		claims, err := auth.ParseToken(token)
		if err != nil {
			c.Set(ctxAuthError, "session expired - please log in again")
			c.Next()
			return
		}
		// The account and its role's permissions, read fresh (one query) on
		// every request, so a suspension or a role edit applies at once.
		u, perms, err := roles.SessionUser(c.Request.Context(), claims.UserID)
		if err != nil {
			// A database hiccup: carry on as anonymous so public pages
			// (courts, pricing, availability) still load, and let
			// RequireRole answer 503 rather than 401 - a 401 makes the
			// frontend drop a perfectly valid session.
			c.Set(ctxAuthUnavailable, true)
			c.Next()
			return
		}
		if u == nil || !u.IsActive {
			c.Set(ctxAuthError, "account is suspended or no longer exists")
			c.Next()
			return
		}
		set := make(map[model.Permission]bool, len(perms))
		for _, p := range perms {
			set[p] = true
		}
		c.Set(ctxUserID, u.ID)
		c.Set(ctxRole, u.Role)
		c.Set(ctxUserName, u.Name)
		c.Set(ctxPermissions, set)
		c.Next()
	}
}

// RequireLogin rejects requests without a valid session.
func RequireLogin() gin.HandlerFunc {
	return RequirePermission()
}

// RequirePermission rejects requests without a valid session, or (when
// permissions are given) whose role has none of them - any one is enough.
func RequirePermission(perms ...model.Permission) gin.HandlerFunc {
	return func(c *gin.Context) {
		_, ok := c.Get(ctxRole)
		if !ok && c.GetBool(ctxAuthUnavailable) {
			abortJSON(c, http.StatusServiceUnavailable, "could not check your session right now - please try again")
			return
		}
		if !ok {
			msg := "login required"
			if reason := c.GetString(ctxAuthError); reason != "" {
				msg = reason
			}
			abortJSON(c, http.StatusUnauthorized, msg)
			return
		}
		if len(perms) == 0 || hasPermission(c, perms...) {
			c.Next()
			return
		}
		abortJSON(c, http.StatusForbidden, "your role is not allowed to do this")
	}
}

// hasPermission reports whether the caller's role has any of perms.
func hasPermission(c *gin.Context, perms ...model.Permission) bool {
	v, _ := c.Get(ctxPermissions)
	set, _ := v.(map[model.Permission]bool)
	for _, p := range perms {
		if set[p] {
			return true
		}
	}
	return false
}

// currentPermissions lists the caller's permissions (for /auth/me).
func currentPermissions(c *gin.Context) []model.Permission {
	v, _ := c.Get(ctxPermissions)
	set, _ := v.(map[model.Permission]bool)
	out := []model.Permission{}
	for _, p := range model.AllPermissions {
		if set[p] {
			out = append(out, p)
		}
	}
	return out
}

// seesCustomerDetails: staff-side callers may see who booked a slot and act
// on customers' bookings (e.g. upload a slip for them at the counter).
func seesCustomerDetails(c *gin.Context) bool {
	return hasPermission(c, model.PermCounterBookings, model.PermVerifySlips, model.PermCancelRefund, model.PermManageMembers)
}

func currentUserID(c *gin.Context) string {
	return c.GetString(ctxUserID)
}

func currentRole(c *gin.Context) model.UserRole {
	role, _ := c.Get(ctxRole)
	r, _ := role.(model.UserRole)
	return r
}

// actor returns the caller's id and display name for audit logs (both set
// by Authenticate, so no extra lookup).
func actor(c *gin.Context) (string, string) {
	return currentUserID(c), c.GetString(ctxUserName)
}

func abortJSON(c *gin.Context, status int, msg string) {
	c.AbortWithStatusJSON(status, gin.H{"success": false, "error": msg})
}

// LimitBody caps request bodies before anything reads them, so a huge
// upload is cut off while streaming instead of being spooled to disk first
// and only then rejected by the 5 MB slip check. Slip uploads get the slip
// limit plus room for the multipart framing; everything else 1 MB.
func LimitBody() gin.HandlerFunc {
	return func(c *gin.Context) {
		limit := int64(1 << 20)
		if strings.HasSuffix(c.Request.URL.Path, "/upload-slip") {
			limit = maxSlipBytes + 64<<10
		}
		if c.Request.ContentLength > limit {
			abortJSON(c, http.StatusRequestEntityTooLarge, "request is too large")
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		c.Next()
	}
}
