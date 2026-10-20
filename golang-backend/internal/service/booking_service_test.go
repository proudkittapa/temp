package service

import (
	"errors"
	"testing"
)

func TestHourSlotEnd(t *testing.T) {
	valid := map[string]string{"07:00": "08:00", "09:00": "10:00", "22:00": "23:00", "00:00": "01:00"}
	for start, wantEnd := range valid {
		end, _, err := hourSlotEnd(start)
		if err != nil || end != wantEnd {
			t.Errorf("hourSlotEnd(%q) = %q, %v; want %q", start, end, err, wantEnd)
		}
	}

	// Anything that isn't a whole hour (or would run past midnight) must be
	// rejected as a bad request, not passed through to the overlap query -
	// times are compared as text there, so "9:00" would sort after "10:00".
	for _, bad := range []string{"9:00", "09:30", "23:00", "24:00", "ab:00", "09", "", "09:00:00"} {
		if _, _, err := hourSlotEnd(bad); !errors.Is(err, ErrInvalidBooking) {
			t.Errorf("hourSlotEnd(%q) err = %v; want ErrInvalidBooking", bad, err)
		}
	}
}
