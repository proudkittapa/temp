package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"arena-backend/internal/repository"
	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// A database hiccup while loading the session user must not break public
// pages for logged-in visitors, and must not answer 401 (which makes the
// frontend throw away a valid session) on protected ones.
func TestAuthenticateDuringDatabaseOutage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	// Nothing listens on port 1, so every query fails.
	db, err := gorm.Open(postgres.Open("postgres://x:y@127.0.0.1:1/z?sslmode=disable&connect_timeout=1"), &gorm.Config{DisableAutomaticPing: true})
	if err != nil {
		t.Fatal(err)
	}
	users := repository.NewUserRepository(db)
	auth := service.NewAuthService(users, repository.NewAuditRepository(db), []byte("secret"), nil)
	token, err := auth.IssueTokenForTest("u-1", "CUSTOMER")
	if err != nil {
		t.Fatal(err)
	}

	r := gin.New()
	api := r.Group("/", Authenticate(auth, service.NewUserService(db, users), service.NewRoleService(db)))
	api.GET("/public", func(c *gin.Context) { c.Status(http.StatusOK) })
	api.GET("/private", RequireLogin(), func(c *gin.Context) { c.Status(http.StatusOK) })

	get := func(path string) int {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		r.ServeHTTP(w, req)
		return w.Code
	}
	if code := get("/public"); code != http.StatusOK {
		t.Errorf("public page: %d, want 200", code)
	}
	if code := get("/private"); code != http.StatusServiceUnavailable {
		t.Errorf("protected page: %d, want 503", code)
	}
}
