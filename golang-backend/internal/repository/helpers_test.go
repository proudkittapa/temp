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
	check := func(courtID string, hour int, want string) {
		t.Helper()
		got := ""
		if c := ClosureFor(closures, courtID, hour); c != nil {
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
	if c := ClosureFor(all, "pick-1", 15); c == nil {
		t.Errorf("an all-courts closure (CourtID nil) must block every court")
	}
}
