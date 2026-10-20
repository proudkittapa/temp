// Package ids generates collision-resistant record identifiers. The previous
// time.Now().Format("02150405") scheme had one-second resolution, so two
// bookings (or a multi-slot booking's rows) created in the same second
// collided on primary key.
package ids

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
)

// New returns prefix + "-" + 16 random hex chars, e.g. "b-3f9a0c12d4e5b6a7".
func New(prefix string) string {
	return prefix + "-" + randomHex(8)
}

// Code returns a short human-readable code such as "BK20261021-7F3A9C",
// used for booking/order codes customers read out at the counter.
func Code(prefix, date string) string {
	return prefix + strings.ReplaceAll(date, "-", "") + "-" + strings.ToUpper(randomHex(3))
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("ids: crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}
