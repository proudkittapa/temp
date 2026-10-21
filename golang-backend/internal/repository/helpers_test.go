package repository

import (
	"testing"

	"arena-backend/internal/model"
)

func TestLockKeyGroupsMutexCourtsTogether(t *testing.T) {
	g := "bball-court-1"
	full := model.Court{ID: "b_full_a", MutexGroupID: &g}
	half := model.Court{ID: "b_half_c", MutexGroupID: &g}
	solo := model.Court{ID: "bad-1"}
	if LockKey(full) != LockKey(half) {
		t.Errorf("courts in one mutex group must share a lock key: %s vs %s", LockKey(full), LockKey(half))
	}
	if LockKey(solo) == LockKey(full) {
		t.Errorf("a standalone court must not share its group's lock key")
	}
}

func TestClosureFor(t *testing.T) {
	court1, court2 := "bad-1", "bad-2"
	nine, twelve := 9, 12
	closures := []model.DayOff{
		{ID: "partial", CourtID: &court1, IsFullDay: false, StartHour: &nine, EndHour: &twelve},
		{ID: "whole-court2", CourtID: &court2, IsFullDay: true},
	}
	closed := map[string]model.Court{"bad-1": {ID: "bad-1", ShareOfGroup: 1}, "bad-2": {ID: "bad-2", ShareOfGroup: 1}}
	check := func(courtID string, hour int, want string) {
		t.Helper()
		got := ""
		if c := ClosureFor(closures, model.Court{ID: courtID, ShareOfGroup: 1}, closed, hour); c != nil {
			got = c.ID
		}
		if got != want {
			t.Errorf("ClosureFor(%s, %d) = %q, want %q", courtID, hour, got, want)
		}
	}
	check("bad-1", 8, "")
	check("bad-1", 9, "partial")
	check("bad-1", 11, "partial")
	check("bad-1", 12, "")
	check("bad-2", 20, "whole-court2")
	check("bad-3", 10, "")

	all := []model.DayOff{{ID: "everything", IsFullDay: true}}
	if c := ClosureFor(all, model.Court{ID: "pick-1", ShareOfGroup: 1}, nil, 15); c == nil {
		t.Errorf("an all-courts closure (CourtID nil) must block every court")
	}
}

// Closures follow the same group rule as bookings: closing a full court
// closes its halves, closing a half closes the full court but not the other
// half, and nothing leaks into another basketball court's group.
func TestClosureForCourtGroups(t *testing.T) {
	gA, gB := "bball-court-1", "bball-court-2"
	courts := map[string]model.Court{
		"a-full":  {ID: "a-full", MutexGroupID: &gA, ShareOfGroup: 1},
		"a-left":  {ID: "a-left", MutexGroupID: &gA, ShareOfGroup: 0.5},
		"a-right": {ID: "a-right", MutexGroupID: &gA, ShareOfGroup: 0.5},
		"b-full":  {ID: "b-full", MutexGroupID: &gB, ShareOfGroup: 1},
		"b-left":  {ID: "b-left", MutexGroupID: &gB, ShareOfGroup: 0.5},
	}
	closedBy := func(closedID, targetID string) bool {
		id := closedID
		closures := []model.DayOff{{ID: "c", CourtID: &id, IsFullDay: true}}
		return ClosureFor(closures, courts[targetID], courts, 10) != nil
	}
	cases := []struct {
		closed, target string
		want           bool
	}{
		{"a-full", "a-full", true},
		{"a-full", "a-left", true},
		{"a-full", "a-right", true},
		{"a-left", "a-full", true},
		{"a-left", "a-left", true},
		{"a-left", "a-right", false},
		{"a-full", "b-full", false},
		{"a-full", "b-left", false},
		{"b-left", "a-full", false},
	}
	for _, c := range cases {
		if got := closedBy(c.closed, c.target); got != c.want {
			t.Errorf("closing %s blocks %s = %v, want %v", c.closed, c.target, got, c.want)
		}
	}
}
