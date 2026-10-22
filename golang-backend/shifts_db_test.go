package main

import (
	"context"
	"errors"
	"testing"

	"arena-backend/internal/service"
)

// A new shift's float must match the cash counted at the last close, or
// come with a note. Needs TEST_DATABASE_URL (see concurrency_test.go).
func TestShiftOpeningFloatMatchesLastCount(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	// Start from a closed shift counted at 1234.50.
	if cur, err := e.shifts.Current(ctx); err != nil {
		t.Fatal(err)
	} else if cur == nil {
		if _, err := e.shifts.Open(ctx, 0, "test start", "staff-a", "Staff A"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.shifts.Close(ctx, 1234.5, "test count", "staff-a", "Staff A", false); err != nil {
		t.Fatal(err)
	}
	if last, err := e.shifts.LastCount(ctx); err != nil || last == nil || *last != 1234.5 {
		t.Fatalf("LastCount = %v, %v - want 1234.50", last, err)
	}

	// Different float, no note: refused, nothing opened.
	if _, err := e.shifts.Open(ctx, 1000, "  ", "staff-b", "Staff B"); !errors.Is(err, service.ErrInvalidBooking) {
		t.Fatalf("float 1000 after a count of 1234.50 without a note: %v, want ErrInvalidBooking", err)
	}
	if cur, _ := e.shifts.Current(ctx); cur != nil {
		t.Fatal("a shift was opened anyway")
	}
	// The same float needs no note.
	sh, err := e.shifts.Open(ctx, 1234.5, "", "staff-b", "Staff B")
	if err != nil {
		t.Fatalf("float equal to the last count: %v", err)
	}
	if sh.Shift.OpeningNote != nil {
		t.Errorf("note stored for a matching float: %q", *sh.Shift.OpeningNote)
	}
	if _, err := e.shifts.Close(ctx, 1234.5, "", "staff-b", "Staff B", false); err != nil {
		t.Fatal(err)
	}
	// A different float with a note: opened, note kept.
	sh, err = e.shifts.Open(ctx, 1000, "took 234.50 to the bank", "staff-b", "Staff B")
	if err != nil {
		t.Fatalf("float with a note: %v", err)
	}
	if sh.Shift.OpeningNote == nil || *sh.Shift.OpeningNote != "took 234.50 to the bank" {
		t.Errorf("opening note = %v", sh.Shift.OpeningNote)
	}
	if _, err := e.shifts.Close(ctx, 1000, "", "staff-b", "Staff B", false); err != nil {
		t.Fatal(err)
	}
}
