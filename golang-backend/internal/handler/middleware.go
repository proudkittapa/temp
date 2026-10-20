package handler

import (
	"net/http"
	"strings"

	"arena-backend/internal/model"
	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
)

const (
	ctxUserID = "user_id"
	ctxRole   = "role"
)

// Authenticate reads an optional "Authorization: Bearer <jwt>" header and,
// if it is valid, stores the caller's user id and role on the context. It
// never rejects on its own - RequireAuth/RequireRole decide that per route -
// but a present-yet-invalid token is a 401 rather than silently anonymous,
// so an expired session surfaces to the client instead of acting as a guest.
func Authenticate(auth *service.AuthService) gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		if header == "" {
			c.Next()
			return
		}
		token, ok := strings.CutPrefix(header, "Bearer ")
		if !ok {
			abortJSON(c, http.StatusUnauthorized, "malformed Authorization header")
			return
		}
		claims, err := auth.ParseToken(token)
		if err != nil {
			abortJSON(c, http.StatusUnauthorized, err.Error())
			return
		}
		c.Set(ctxUserID, claims.UserID)
		c.Set(ctxRole, model.UserRole(claims.Role))
		c.Next()
	}
}

// RequireRole rejects requests without a valid token, or (when roles are
// given) whose role isn't one of them. RequireRole() with no roles just
// requires being logged in.
func RequireRole(roles ...model.UserRole) gin.HandlerFunc {
	return func(c *gin.Context) {
		role, ok := c.Get(ctxRole)
		if !ok {
			abortJSON(c, http.StatusUnauthorized, "login required")
			return
		}
		if len(roles) == 0 {
			c.Next()
			return
		}
		for _, r := range roles {
			if role == r {
				c.Next()
				return
			}
		}
		abortJSON(c, http.StatusForbidden, "your role is not allowed to do this")
	}
}

// Staff-side role sets, mirroring the frontend's role switcher.
var (
	StaffRoles   = []model.UserRole{model.RoleStaff, model.RoleManager, model.RoleAdmin}
	ManagerRoles = []model.UserRole{model.RoleManager, model.RoleAdmin}
)

func currentUserID(c *gin.Context) string {
	return c.GetString(ctxUserID)
}

func currentRole(c *gin.Context) model.UserRole {
	role, _ := c.Get(ctxRole)
	r, _ := role.(model.UserRole)
	return r
}

func isStaff(r model.UserRole) bool {
	for _, s := range StaffRoles {
		if r == s {
			return true
		}
	}
	return false
}

func abortJSON(c *gin.Context, status int, msg string) {
	c.AbortWithStatusJSON(status, gin.H{"success": false, "error": msg})
}
