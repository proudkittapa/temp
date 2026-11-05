package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"gorm.io/gorm"
)

// Trusted devices (owner decision 2026-11-05, TODO section 0): a browser
// that signed in with the right password gets a random key; while an
// account is locked by wrong passwords from elsewhere, a browser holding a
// key for that account may still sign in - with the right password. A
// browser used by several people (the counter PC) holds one key per
// account; it sends up to MaxDeviceTokens of them.
const (
	trustedDeviceTTL  = 90 * 24 * time.Hour // renewed at every sign-in on it
	maxDevicesPerUser = 20                  // the oldest are forgotten
	MaxDeviceTokens   = 10                  // keys one sign-in may send
	maxDeviceTokenLen = 100
)

func hashDeviceToken(token string) string {
	h := sha256.Sum256([]byte("device:" + token))
	return hex.EncodeToString(h[:])
}

func newDeviceToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// matchTrustedDevice returns the unexpired device, among the keys sent, that
// belongs to one of userIDs (the accounts the typed phone/email matches),
// with the key that matched; nil when there is none.
func (s *AuthService) matchTrustedDevice(ctx context.Context, tokens []string, userIDs []string) (*model.TrustedDevice, string, error) {
	if len(tokens) == 0 || len(userIDs) == 0 {
		return nil, "", nil
	}
	byHash := map[string]string{}
	for i, t := range tokens {
		if i >= MaxDeviceTokens {
			break
		}
		if t != "" && len(t) <= maxDeviceTokenLen {
			byHash[hashDeviceToken(t)] = t
		}
	}
	if len(byHash) == 0 {
		return nil, "", nil
	}
	hashes := make([]string, 0, len(byHash))
	for h := range byHash {
		hashes = append(hashes, h)
	}
	var found []model.TrustedDevice
	if err := s.db(ctx).Where("token_hash IN ? AND user_id IN ? AND expires_at > ?", hashes, userIDs, time.Now()).
		Order("last_used_at DESC").Limit(1).Find(&found).Error; err != nil {
		return nil, "", err
	}
	if len(found) == 0 {
		return nil, "", nil
	}
	return &found[0], byHash[found[0].TokenHash], nil
}

// rememberDevice renews the device the user signed in on (when its key was
// sent) or makes a new one, and returns the key for the browser to keep.
// Only the newest maxDevicesPerUser devices of a user are kept.
func (s *AuthService) rememberDevice(ctx context.Context, userID string, dev *model.TrustedDevice, token string) (string, error) {
	now := time.Now()
	db := s.db(ctx)
	if dev != nil && dev.UserID == userID {
		err := db.Model(&model.TrustedDevice{}).Where("id = ?", dev.ID).
			Updates(map[string]any{"last_used_at": now, "expires_at": now.Add(trustedDeviceTTL)}).Error
		return token, err
	}
	token, err := newDeviceToken()
	if err != nil {
		return "", err
	}
	if err := db.Create(&model.TrustedDevice{ID: ids.New("dev"), UserID: userID, TokenHash: hashDeviceToken(token),
		CreatedAt: now, LastUsedAt: now, ExpiresAt: now.Add(trustedDeviceTTL)}).Error; err != nil {
		return "", err
	}
	if err := db.Exec("DELETE FROM trusted_devices WHERE user_id = ? AND id NOT IN "+
		"(SELECT id FROM trusted_devices WHERE user_id = ? ORDER BY last_used_at DESC, id DESC LIMIT ?)",
		userID, userID, maxDevicesPerUser).Error; err != nil {
		return "", err
	}
	return token, nil
}

// pruneTrustedDevices forgets devices past their expiry (with the login
// failures, every minute).
func (s *AuthService) pruneTrustedDevices(ctx context.Context) error {
	return s.db(ctx).Where("expires_at < ?", time.Now()).Delete(&model.TrustedDevice{}).Error
}

func (s *AuthService) db(ctx context.Context) *gorm.DB { return s.devicesDB.WithContext(ctx) }
