package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// serveWebsite serves the built React app from dir on the same address as
// the API - for one-service hosting such as Render (render.yaml), where no
// Caddy sits in front. The normal deploy (deploy/) keeps Caddy and leaves
// STATIC_DIR unset. Same rules as deploy/Caddyfile: built files cached for
// good, the page re-checked, unknown paths get index.html (/line-callback
// included), and the browser safety headers.
func serveWebsite(router *gin.Engine, dir string) {
	index := filepath.Join(dir, "index.html")
	router.Use(func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("X-Frame-Options", "DENY")
		c.Next()
	})
	router.NoRoute(func(c *gin.Context) {
		p := c.Request.URL.Path
		if strings.HasPrefix(p, "/api/") || (c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead) {
			c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "not found"})
			return
		}
		// path.Clean on a rooted path can't climb above dir.
		file := filepath.Join(dir, filepath.FromSlash(path.Clean("/"+p)))
		if fi, err := os.Stat(file); err == nil && !fi.IsDir() {
			if strings.HasPrefix(p, "/assets/") {
				c.Header("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				c.Header("Cache-Control", "no-cache")
			}
			c.File(file)
			return
		}
		c.Header("Cache-Control", "no-cache")
		c.File(index)
	})
}

// bootstrapAdmin: for hosting without a server shell (Render's free plan),
// BOOTSTRAP_ADMIN_PHONE makes the customer registered with that phone the
// admin - only while the installation has no admin at all, so once there
// is one, nobody can use the setting (or register that number later) to
// become admin. Checked every minute by the jobs loop. Remove the setting
// after the first sign-in as admin.
func bootstrapAdmin(ctx context.Context, db *gorm.DB) error {
	phone := repository.NormalizePhone(os.Getenv("BOOTSTRAP_ADMIN_PHONE"))
	if phone == "" {
		return nil
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// One promotion even with several servers starting together.
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", migrationLockKey+1).Error; err != nil {
			return err
		}
		var admins int64
		if err := tx.Model(&model.User{}).Where("role = ?", model.RoleAdmin).Count(&admins).Error; err != nil || admins > 0 {
			return err
		}
		var u []model.User
		if err := tx.Where("phone = ? AND role = ?", phone, model.RoleCustomer).Limit(2).Find(&u).Error; err != nil || len(u) != 1 {
			return err
		}
		if err := tx.Model(&model.User{}).Where("id = ?", u[0].ID).Update("role", model.RoleAdmin).Error; err != nil {
			return err
		}
		log.Printf("BOOTSTRAP_ADMIN_PHONE: %s (%s) is now the admin. Remove the setting.\n", u[0].Name, u[0].Phone)
		return tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: "system", UserName: "BOOTSTRAP_ADMIN_PHONE",
			Action: "USER_ROLE_CHANGED", TargetType: "User", TargetID: u[0].ID,
			BeforeState: model.AuditJSON(map[string]any{"role": model.RoleCustomer}),
			AfterState:  model.AuditJSON(map[string]any{"role": model.RoleAdmin}),
			CreatedAt:   time.Now(),
		}).Error
	})
}
