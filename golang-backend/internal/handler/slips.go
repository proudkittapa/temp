package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"arena-backend/internal/model"
	"github.com/gin-gonic/gin"
)

// Slip images show the customer's bank and account details, so they are
// not served publicly. A payment's slip_url is stored as
// "/uploads/slips/<file>" but handed out (only to the booking's owner and
// staff) as a signed, expiring link:
//
//	/api/v1/slips/<file>?exp=<unix>&sig=<hmac>
//
// A signed link rather than a bearer token because the frontend shows
// slips with a plain <img src>, which can't send an Authorization header.

const slipLinkPath = "/api/v1/slips/"

// SlipSigner signs and checks slip links.
type SlipSigner struct {
	key []byte
	now func() time.Time
}

// NewSlipSigner derives the slip-link key from the server secret, so it is
// separate from the JWT signing key but needs no extra configuration.
func NewSlipSigner(secret []byte) *SlipSigner {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte("slip-link-v1"))
	return &SlipSigner{key: m.Sum(nil), now: time.Now}
}

func (s *SlipSigner) sig(name string, exp int64) string {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte(name + "|" + strconv.FormatInt(exp, 10)))
	return hex.EncodeToString(m.Sum(nil))
}

// Sign turns a stored slip URL into a link valid for one to two hours. The
// expiry is rounded to the hour so the link (and the browser's cached image)
// stays the same across page refreshes within that hour.
func (s *SlipSigner) Sign(stored string) string {
	name, ok := strings.CutPrefix(stored, slipURLPrefix)
	if !ok || name == "" || strings.ContainsAny(name, `/\`) {
		return ""
	}
	exp := (s.now().Unix()/3600 + 2) * 3600
	return slipLinkPath + name + "?exp=" + strconv.FormatInt(exp, 10) + "&sig=" + s.sig(name, exp)
}

// SignPayment returns p with its slip URL replaced by a signed link.
func (s *SlipSigner) SignPayment(p model.Payment) model.Payment {
	if p.SlipURL != nil {
		signed := s.Sign(*p.SlipURL)
		p.SlipURL = &signed
	}
	return p
}

// Serve handles GET /api/v1/slips/:name.
func (s *SlipSigner) Serve(c *gin.Context) {
	name := c.Param("name")
	exp, err := strconv.ParseInt(c.Query("exp"), 10, 64)
	if err != nil || name == "" || strings.ContainsAny(name, `/\`) || strings.HasPrefix(name, ".") ||
		s.now().Unix() > exp || !hmac.Equal([]byte(c.Query("sig")), []byte(s.sig(name, exp))) {
		abortJSON(c, http.StatusForbidden, "this slip link is invalid or has expired - reload the page")
		return
	}
	c.Header("Cache-Control", "private, max-age=3600")
	c.Header("X-Content-Type-Options", "nosniff")
	c.File(filepath.Join(slipDir, name))
}
