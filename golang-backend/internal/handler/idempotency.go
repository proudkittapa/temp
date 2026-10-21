package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"net/http"
	"regexp"
	"time"

	"arena-backend/internal/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var idempotencyKeyRE = regexp.MustCompile(`^[A-Za-z0-9_-]{8,80}$`)

// recordingWriter keeps a copy of the response body for replay.
type recordingWriter struct {
	gin.ResponseWriter
	body bytes.Buffer
}

func (w *recordingWriter) Write(b []byte) (int, error) {
	w.body.Write(b)
	return w.ResponseWriter.Write(b)
}

// Idempotency makes a write request carrying an Idempotency-Key header
// safe to send again: the first attempt claims the key; a repeat after it
// succeeded gets the same response back (header Idempotent-Replay: true)
// without running again; a repeat while it is still running gets 409. A
// failed attempt (non-2xx - nothing was saved) releases the key so the
// client can retry. The key is bound to the caller's session and the
// endpoint (Scope); reusing it elsewhere is refused.
func Idempotency(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		key := c.GetHeader("Idempotency-Key")
		if key == "" || c.Request.Method == http.MethodGet {
			c.Next()
			return
		}
		if !idempotencyKeyRE.MatchString(key) {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"success": false, "error": "invalid Idempotency-Key"})
			return
		}
		sum := sha256.Sum256([]byte(c.GetHeader("Authorization") + "|" + c.Request.Method + " " + c.Request.URL.Path))
		scope := hex.EncodeToString(sum[:])
		// Bookkeeping outlives a cancelled request: the write may have
		// committed even if the client went away.
		store := func(run func(tx *gorm.DB) *gorm.DB) *gorm.DB {
			ctx, cancel := context.WithTimeout(context.WithoutCancel(c.Request.Context()), 5*time.Second)
			defer cancel()
			return run(db.WithContext(ctx))
		}
		claim := store(func(tx *gorm.DB) *gorm.DB {
			return tx.Clauses(clause.OnConflict{DoNothing: true}).
				Create(&model.IdempotencyKey{Key: key, Scope: scope, CreatedAt: time.Now()})
		})
		if claim.Error != nil {
			respondError(c, claim.Error)
			c.Abort()
			return
		}
		if claim.RowsAffected == 0 {
			var prev model.IdempotencyKey
			if err := store(func(tx *gorm.DB) *gorm.DB { return tx.First(&prev, "key = ?", key) }).Error; err != nil {
				respondError(c, err)
				c.Abort()
				return
			}
			switch {
			case prev.Scope != scope:
				c.AbortWithStatusJSON(http.StatusUnprocessableEntity, gin.H{"success": false, "error": "this Idempotency-Key was used for another request"})
			case !prev.Completed:
				c.AbortWithStatusJSON(http.StatusConflict, gin.H{"success": false, "error": "the same request is still being processed - check the result before trying again"})
			default:
				c.Header("Idempotent-Replay", "true")
				c.Data(prev.StatusCode, "application/json; charset=utf-8", prev.Response)
				c.Abort()
			}
			return
		}
		w := &recordingWriter{ResponseWriter: c.Writer}
		c.Writer = w
		c.Next()
		if status := w.Status(); status >= 200 && status < 300 {
			err := store(func(tx *gorm.DB) *gorm.DB {
				return tx.Model(&model.IdempotencyKey{}).Where("key = ?", key).
					Updates(map[string]any{"completed": true, "status_code": status, "response": w.body.Bytes()})
			}).Error
			if err != nil {
				log.Printf("WARNING: could not save the idempotent response for %s: %v", c.FullPath(), err)
			}
			return
		}
		if err := store(func(tx *gorm.DB) *gorm.DB {
			return tx.Where("key = ? AND NOT completed", key).Delete(&model.IdempotencyKey{})
		}).Error; err != nil {
			log.Printf("WARNING: could not release Idempotency-Key for %s: %v", c.FullPath(), err)
		}
	}
}

// PruneIdempotencyKeys drops keys older than a day (a client retries within
// seconds or minutes).
func PruneIdempotencyKeys(ctx context.Context, db *gorm.DB) error {
	return db.WithContext(ctx).Where("created_at < ?", time.Now().Add(-24*time.Hour)).Delete(&model.IdempotencyKey{}).Error
}
