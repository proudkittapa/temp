package main

import (
	"strings"
	"testing"
)

func env(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

func TestCourtCountsDefaultIsTodaysLayout(t *testing.T) {
	counts, warnings := courtCountsFromEnv(env(nil))
	if counts != defaultCourtCounts || len(warnings) != 0 {
		t.Fatalf("counts = %+v, warnings = %v; want defaults, no warnings", counts, warnings)
	}
	ids := map[string]bool{}
	for _, c := range seededCourts(counts) {
		ids[c.ID] = true
	}
	// The ids existing databases already have must stay exactly the same.
	for _, id := range []string{"b_full_a", "b_half_b", "b_half_c", "bb-b-full", "bb-b-left", "bb-b-right",
		"bb-c-full", "bb-c-left", "bb-c-right", "bad-1", "bad-12", "pick-1", "pick-3", "meet-1"} {
		if !ids[id] {
			t.Errorf("default seed is missing %s", id)
		}
	}
	if len(ids) != 9+12+3+1 {
		t.Errorf("default seed has %d courts, want 25", len(ids))
	}
}

func TestCourtCountsFromEnv(t *testing.T) {
	counts, warnings := courtCountsFromEnv(env(map[string]string{
		"BASKETBALL_COURT_COUNT": "5", "BADMINTON_COURT_COUNT": " 8 ", "PICKLEBALL_COURT_COUNT": "0", "MEETING_ROOM_COUNT": "2",
	}))
	if len(warnings) != 0 || counts != (courtCounts{Basketball: 5, Badminton: 8, Pickleball: 0, MeetingRoom: 2}) {
		t.Fatalf("counts = %+v, warnings = %v", counts, warnings)
	}
	courts := seededCourts(counts)
	if len(courts) != 5*3+8+0+2 {
		t.Fatalf("got %d courts, want 25", len(courts))
	}
	byID := map[string]string{}
	groups := map[string]int{}
	for _, c := range courts {
		byID[c.ID] = c.Name
		if c.MutexGroupID != nil {
			groups[*c.MutexGroupID]++
		}
	}
	if byID["bb-e-right"] != "สนามบาสเกตบอล E (ครึ่งขวา)" || byID["bb-d-full"] != "สนามบาสเกตบอล D (เต็มสนาม)" {
		t.Errorf("courts D/E not named as expected: %q / %q", byID["bb-d-full"], byID["bb-e-right"])
	}
	if len(groups) != 5 {
		t.Errorf("got %d basketball groups, want 5", len(groups))
	}
	for g, n := range groups {
		if n != 3 {
			t.Errorf("group %s has %d courts, want full + 2 halves", g, n)
		}
	}
	if byID["meet-2"] == "" || byID["pick-1"] != "" {
		t.Errorf("meeting room 2 should exist and no pickleball court")
	}
}

func TestCourtCountsRejectBadValues(t *testing.T) {
	for _, bad := range []string{"three", "-1", "27", "2.5"} {
		counts, warnings := courtCountsFromEnv(env(map[string]string{"BASKETBALL_COURT_COUNT": bad}))
		if counts.Basketball != defaultCourtCounts.Basketball || len(warnings) != 1 || !strings.Contains(warnings[0], "BASKETBALL_COURT_COUNT") {
			t.Errorf("%q: counts = %+v, warnings = %v; want the default with one warning", bad, counts, warnings)
		}
	}
}
