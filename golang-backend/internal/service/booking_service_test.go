package service

import (
	"errors"
	"testing"
	"time"

	"arena-backend/internal/model"
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

func TestCheckNotPast(t *testing.T) {
	// 2026-10-20 18:20 in Bangkok.
	s := &BookingService{now: func() time.Time { return time.Date(2026, 10, 20, 18, 20, 0, 0, Bangkok) }}
	ok := func(date, start string) {
		t.Helper()
		if err := s.checkNotPast(date, []SlotRequest{{CourtID: "bad-1", StartTime: start}}); err != nil {
			t.Errorf("%s %s: unexpected error %v", date, start, err)
		}
	}
	bad := func(date, start string) {
		t.Helper()
		if err := s.checkNotPast(date, []SlotRequest{{CourtID: "bad-1", StartTime: start}}); !errors.Is(err, ErrInvalidBooking) {
			t.Errorf("%s %s: err = %v, want ErrInvalidBooking", date, start, err)
		}
	}
	ok("2026-10-20", "18:00") // in progress - walk-ins can still take it
	ok("2026-10-20", "19:00")
	ok("2026-10-21", "07:00")
	bad("2026-10-20", "17:00") // ended at 18:00
	bad("2026-10-19", "20:00")
	bad("20-10-2026", "20:00")
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
