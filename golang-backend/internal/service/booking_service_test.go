package service

import (
	"errors"
	"testing"
	"time"

	"arena-backend/internal/model"
)

func TestHourSlotEnd(t *testing.T) {
	valid := map[string]string{"07:00": "08:00", "09:00": "10:00", "22:00": "23:00"}
	for start, wantEnd := range valid {
		end, _, err := hourSlotEnd(start)
		if err != nil || end != wantEnd {
			t.Errorf("hourSlotEnd(%q) = %q, %v; want %q", start, end, err, wantEnd)
		}
	}

	// Anything that isn't a whole hour inside opening hours (07:00-23:00)
	// must be rejected as a bad request, not passed through to the overlap
	// query - times are compared as text there, so "9:00" would sort after
	// "10:00".
	for _, bad := range []string{"9:00", "09:30", "23:00", "24:00", "00:00", "06:00", "ab:00", "09", "", "09:00:00"} {
		if _, _, err := hourSlotEnd(bad); !errors.Is(err, ErrInvalidBooking) {
			t.Errorf("hourSlotEnd(%q) err = %v; want ErrInvalidBooking", bad, err)
		}
	}
}

func TestCheckNotPast(t *testing.T) {
	// 2026-10-20 18:20 in Bangkok.
	s := &BookingService{now: func() time.Time { return time.Date(2026, 10, 20, 18, 20, 0, 0, Bangkok) }}
	check := func(date, start string, walkIn, wantOK bool) {
		t.Helper()
		err := s.checkNotPast(date, []SlotRequest{{CourtID: "bad-1", StartTime: start}}, walkIn)
		if wantOK && err != nil {
			t.Errorf("%s %s walkIn=%v: unexpected error %v", date, start, walkIn, err)
		}
		if !wantOK && !errors.Is(err, ErrInvalidBooking) {
			t.Errorf("%s %s walkIn=%v: err = %v, want ErrInvalidBooking", date, start, walkIn, err)
		}
	}
	for _, walkIn := range []bool{true, false} {
		check("2026-10-20", "19:00", walkIn, true)
		check("2026-10-21", "07:00", walkIn, true)
		check("2026-10-20", "17:00", walkIn, false) // ended at 18:00
		check("2026-10-19", "20:00", walkIn, false)
		check("20-10-2026", "20:00", walkIn, false)
	}
	// In progress: staff at the counter can still sell it; online it's too late.
	check("2026-10-20", "18:00", true, true)
	check("2026-10-20", "18:00", false, false)
}

func TestRuleForHourTreatsUncoveredHoursAsClosed(t *testing.T) {
	rules := []model.PricingRule{
		{ID: "op", StartHour: 7, EndHour: 17, PriceType: "OFFPEAK", IsActive: true},
		{ID: "peak", StartHour: 17, EndHour: 22, PriceType: "PEAK", IsActive: true},
		{ID: "off", StartHour: 22, EndHour: 23, PriceType: "OFFPEAK", IsActive: false},
	}
	for hour, want := range map[int]string{3: "", 7: "op", 16: "op", 17: "peak", 21: "peak", 22: "", 23: ""} {
		got := ""
		if r := RuleForHour(rules, hour); r != nil {
			got = r.ID
		}
		if got != want {
			t.Errorf("RuleForHour(%d) = %q, want %q", hour, got, want)
		}
	}
}
