package service

import (
	"errors"
	"fmt"
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

	// Anything that isn't a whole hour of the day must be rejected as a bad
	// request, not passed through to the overlap query - times are compared
	// as text there, so "9:00" would sort after "10:00".
	for _, bad := range []string{"9:00", "09:30", "24:00", "25:00", "-1:00", "ab:00", "09", "", "09:00:00"} {
		if _, _, err := hourSlotEnd(bad); !errors.Is(err, ErrInvalidBooking) {
			t.Errorf("hourSlotEnd(%q) err = %v; want ErrInvalidBooking", bad, err)
		}
	}
}

func TestCheckOpenHour(t *testing.T) {
	cfg := &model.PricingConfig{OpenHour: 6, CloseHour: 24}
	for h, wantOK := range map[int]bool{5: false, 6: true, 22: true, 23: true} {
		err := checkOpenHour(cfg, fmt.Sprintf("%02d:00", h), h)
		if (err == nil) != wantOK || (err != nil && !errors.Is(err, ErrSlotUnavailable)) {
			t.Errorf("hour %d: err = %v, want open=%v", h, err, wantOK)
		}
	}
	if end, _, err := hourSlotEnd("23:00"); err != nil || end != "24:00" {
		t.Errorf("hourSlotEnd(23:00) = %q, %v", end, err)
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

func TestNoShowFreedShare(t *testing.T) {
	group := "bball-1"
	full := model.Court{ID: "full", MutexGroupID: &group, ShareOfGroup: 1}
	halfB := model.Court{ID: "half-b", MutexGroupID: &group, ShareOfGroup: 0.5}
	halfC := model.Court{ID: "half-c", MutexGroupID: &group, ShareOfGroup: 0.5}
	solo := model.Court{ID: "bad-1", ShareOfGroup: 1}
	courts := map[string]model.Court{full.ID: full, halfB.ID: halfB, halfC.ID: halfC, solo.ID: solo}
	ns := func(court string) model.Booking {
		return model.Booking{ID: "ns-" + court, CourtID: court, StartTime: "09:00", Status: model.BookingNoShow}
	}
	cases := []struct {
		name    string
		court   model.Court
		noShows []model.Booking
		want    float64
	}{
		{"same court", solo, []model.Booking{ns("bad-1")}, 1},
		{"half under a no-show full court", halfB, []model.Booking{ns("full")}, 1},
		{"full court over one no-show half", full, []model.Booking{ns("half-b")}, 0.5},
		{"full court over both halves", full, []model.Booking{ns("half-b"), ns("half-c")}, 1},
		{"same half twice (resale was a no-show too)", full, []model.Booking{ns("half-b"), ns("half-b")}, 0.5},
		{"the other half frees nothing", halfC, []model.Booking{ns("half-b")}, 0},
		{"another hour", solo, []model.Booking{{CourtID: "bad-1", StartTime: "10:00"}}, 0},
	}
	for _, c := range cases {
		got, of := noShowFreedShare(c.court, "09:00", c.noShows, courts)
		if got != c.want || (got > 0) != (of != nil) {
			t.Errorf("%s: got %v (of %v), want %v", c.name, got, of, c.want)
		}
	}
}
