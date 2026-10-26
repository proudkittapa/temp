package main

import (
	"context"
	"fmt"
	"testing"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/service"
)

// Background jobs. Need TEST_DATABASE_URL (see concurrency_test.go).

// One server holds the job lease: a second can't take it while it is
// renewed, takes it once it has expired, and gets it at once after the
// holder releases it at shutdown.
func TestJobLeaseOneServer(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	e.db.Exec("DELETE FROM job_leases")
	t.Cleanup(func() { e.db.Exec("DELETE FROM job_leases") })
	a, b := newJobLease(e.db), newJobLease(e.db)
	if !a.acquire(ctx) {
		t.Fatal("first server didn't get a free lease")
	}
	if b.acquire(ctx) {
		t.Fatal("second server got a lease the first holds")
	}
	if !a.acquire(ctx) {
		t.Fatal("holder couldn't renew its lease")
	}
	// The holder stops renewing: once the lease has run out, the other
	// server takes over, and the old holder no longer has it.
	e.db.Exec("UPDATE job_leases SET expires_at = now() - interval '1 second'")
	if !b.acquire(ctx) {
		t.Fatal("second server didn't take an expired lease")
	}
	if a.acquire(ctx) {
		t.Fatal("old holder still got the lease after the takeover")
	}
	// Shutdown hands over at once.
	b.release()
	if !a.acquire(ctx) {
		t.Fatal("lease not free after the holder released it")
	}
	// Two at the same moment: exactly one wins.
	e.db.Exec("DELETE FROM job_leases")
	for round := 0; round < 20; round++ {
		e.db.Exec("DELETE FROM job_leases")
		ls := []*jobLease{newJobLease(e.db), newJobLease(e.db), newJobLease(e.db)}
		got := make(chan bool, len(ls))
		for _, l := range ls {
			go func(l *jobLease) { got <- l.acquire(ctx) }(l)
		}
		n := 0
		for range ls {
			if <-got {
				n++
			}
		}
		if n != 1 {
			t.Fatalf("round %d: %d servers got the lease, want 1", round, n)
		}
	}
}

// A backlog larger than one batch is completed in full; a booking a
// request has locked is skipped and completed on the next run; future
// hours are left alone.
func TestCompleteFinishedBookingsBatches(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	const n = service.CompleteBatch*2 + 500
	base := time.Date(1990, 1, 1, 0, 0, 0, 0, time.UTC)
	rows := make([]model.Booking, 0, n+1)
	for i := 0; i < n; i++ {
		rows = append(rows, model.Booking{ID: fmt.Sprintf("cfb-%d", i), CourtID: "bad-1", UserID: "walk-in",
			Date: base.AddDate(0, 0, i).Format("2006-01-02"), StartTime: "10:00", EndTime: "11:00",
			Status: model.BookingConfirmed, CreatedAt: base, UpdatedAt: base})
	}
	future := time.Now().AddDate(0, 0, 400).Format("2006-01-02")
	rows = append(rows, model.Booking{ID: "cfb-future", CourtID: "bad-1", UserID: "walk-in", Date: future,
		StartTime: "10:00", EndTime: "11:00", Status: model.BookingConfirmed, CreatedAt: base, UpdatedAt: base})
	if err := e.db.CreateInBatches(rows, 500).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.db.Where("id LIKE 'cfb-%'").Delete(&model.Booking{}) })

	// A request holds one of them (e.g. a cancel in progress).
	tx := e.db.Begin()
	if err := tx.Exec("SELECT 1 FROM bookings WHERE id = 'cfb-7' FOR UPDATE").Error; err != nil {
		t.Fatal(err)
	}
	done, err := e.bookings.CompleteFinishedBookings(ctx)
	tx.Rollback()
	if err != nil {
		t.Fatal(err)
	}
	count := func(status model.BookingStatus) int64 {
		var c int64
		e.db.Model(&model.Booking{}).Where("id LIKE 'cfb-%' AND status = ?", status).Count(&c)
		return c
	}
	if done < n-1 || count(model.BookingCompleted) != n-1 {
		t.Fatalf("first run completed %d (%d in the table), want %d - all but the locked one", done, count(model.BookingCompleted), n-1)
	}
	if _, err := e.bookings.CompleteFinishedBookings(ctx); err != nil {
		t.Fatal(err)
	}
	if c := count(model.BookingCompleted); c != n {
		t.Errorf("after the second run %d completed, want %d", c, n)
	}
	if c := count(model.BookingConfirmed); c != 1 {
		t.Errorf("%d still confirmed, want 1 (the future hour)", c)
	}
}
