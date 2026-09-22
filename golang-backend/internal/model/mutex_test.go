package model

import (
	"reflect"
	"sort"
	"testing"
)

func groupID(id string) *string { return &id }

// TestConflictingCourtIDs locks in the FR-1.2 mutex rule: a group's hub (the
// full-court allocation, ShareOfGroup >= 1) is exclusive with every sibling,
// but two non-hub sub-allocations (e.g. half-court sides B and C) must NOT
// block each other. An earlier implementation treated every court sharing a
// MutexGroupID as mutually exclusive with every other, which would have
// incorrectly prevented B and C from being booked in parallel.
func TestConflictingCourtIDs(t *testing.T) {
	full := Court{ID: "full-a", MutexGroupID: groupID("bball-1"), ShareOfGroup: 1}
	halfB := Court{ID: "half-b", MutexGroupID: groupID("bball-1"), ShareOfGroup: 0.5}
	halfC := Court{ID: "half-c", MutexGroupID: groupID("bball-1"), ShareOfGroup: 0.5}
	standalone := Court{ID: "bad-1", ShareOfGroup: 1}

	tests := []struct {
		name   string
		target Court
		group  []Court
		want   []string
	}{
		{
			name:   "booking the full court conflicts with every half-court sibling",
			target: full,
			group:  []Court{full, halfB, halfC},
			want:   []string{"full-a", "half-b", "half-c"},
		},
		{
			name:   "booking half B conflicts with the full court",
			target: halfB,
			group:  []Court{full, halfB, halfC},
			want:   []string{"half-b", "full-a"},
		},
		{
			name:   "booking half B does NOT conflict with half C",
			target: halfB,
			group:  []Court{full, halfB, halfC},
			want:   []string{"half-b", "full-a"}, // half-c must be absent
		},
		{
			name:   "booking half C does NOT conflict with half B",
			target: halfC,
			group:  []Court{full, halfB, halfC},
			want:   []string{"half-c", "full-a"}, // half-b must be absent
		},
		{
			name:   "a standalone court with no group only conflicts with itself",
			target: standalone,
			group:  []Court{standalone},
			want:   []string{"bad-1"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ConflictingCourtIDs(tt.target, tt.group)
			gotSorted := append([]string{}, got...)
			wantSorted := append([]string{}, tt.want...)
			sort.Strings(gotSorted)
			sort.Strings(wantSorted)
			if !reflect.DeepEqual(gotSorted, wantSorted) {
				t.Errorf("ConflictingCourtIDs(%s) = %v, want %v", tt.target.ID, got, tt.want)
			}
		})
	}
}

func TestConflictingCourtIDs_HalfCourtsNeverBlockEachOther(t *testing.T) {
	full := Court{ID: "full-a", MutexGroupID: groupID("bball-1"), ShareOfGroup: 1}
	halfB := Court{ID: "half-b", MutexGroupID: groupID("bball-1"), ShareOfGroup: 0.5}
	halfC := Court{ID: "half-c", MutexGroupID: groupID("bball-1"), ShareOfGroup: 0.5}
	group := []Court{full, halfB, halfC}

	for _, id := range ConflictingCourtIDs(halfB, group) {
		if id == "half-c" {
			t.Fatalf("half-b's conflict set must not include half-c (they should be independently bookable), got %v", ConflictingCourtIDs(halfB, group))
		}
	}
}

func TestCourt_IsHub(t *testing.T) {
	tests := []struct {
		name  string
		share float64
		want  bool
	}{
		{"full share is a hub", 1.0, true},
		{"half share is not a hub", 0.5, false},
		{"share above 1 (defensive) is a hub", 1.2, true},
		{"zero share is not a hub", 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := Court{ShareOfGroup: tt.share}
			if got := c.IsHub(); got != tt.want {
				t.Errorf("Court{ShareOfGroup: %v}.IsHub() = %v, want %v", tt.share, got, tt.want)
			}
		})
	}
}
