package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"arena-backend/internal/model"
	"arena-backend/internal/service"
)

// Part of an approved (cash) payment refunded after its hours were
// cancelled: it stays VERIFIED, and the rest can be refunded later without
// a bank check. Needs TEST_DATABASE_URL (see concurrency_test.go).
func TestPartialRefundKeepsApprovedPayment(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	e.openTestShift(t)
	date, times := newSlots().take(t, 2)
	res, err := e.bookings.CreateBookings(ctx, service.CreateBookingInput{
		Date: date, Slots: []service.SlotRequest{{CourtID: "pick-1", StartTime: times[0]}, {CourtID: "pick-1", StartTime: times[1]}},
		WalkIn: &service.WalkInDetails{StaffID: "staff-a", StaffName: "Staff A", CustomerName: "Walk-in", CustomerPhone: "0890000099", PaymentMethod: model.PaymentCash},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Payment.Status != model.PaymentVerified {
		t.Fatalf("cash walk-in payment is %s", res.Payment.Status)
	}
	if _, err := e.bookings.CancelBookings(ctx, res.Bookings[0].ID, nil, "customer left", false, false, "mgr-a", "Manager A"); err != nil {
		t.Fatal(err)
	}
	part := 100.0
	p, err := e.bookings.RefundPayment(ctx, res.Payment.ID, &part, "part back", false, "mgr-a", "Manager A")
	if err != nil {
		t.Fatalf("first refund: %v", err)
	}
	if p.Status != model.PaymentVerified || p.RefundAmount != 100 {
		t.Fatalf("after refunding 100 of %.2f: %s, refunded %.2f - want VERIFIED, 100", p.Amount, p.Status, p.RefundAmount)
	}
	p, err = e.bookings.RefundPayment(ctx, res.Payment.ID, nil, "the rest", false, "mgr-a", "Manager A")
	if err != nil {
		t.Fatalf("second refund (no bank check needed for cash): %v", err)
	}
	if p.Status != model.PaymentRefunded || p.RefundAmount != p.Amount {
		t.Errorf("after refunding the rest: %s, refunded %.2f of %.2f", p.Status, p.RefundAmount, p.Amount)
	}
}

// The audit trail's "before" is the state before the change (GORM writes
// the new values into the struct an update is made from).
func TestAuditBeforeStateIsTheOldState(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	date, times := newSlots().take(t, 1)
	u := e.newCustomer(t, 0)
	_, p := e.bookWithSlip(t, u, date, "pick-2", times[0])
	if _, err := e.bookings.VerifyPayment(ctx, p.ID, p.SlipUploadedAt, "staff-a", "Staff A"); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := e.db.Raw("SELECT before_state::text FROM audit_logs WHERE action = 'SLIP_VERIFIED_BY_STAFF' AND target_id = ?", p.ID).Scan(&before).Error; err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(before, string(model.PaymentSlipUploaded)) {
		t.Errorf("approval logged before = %s, want status SLIP_UPLOADED", before)
	}
}

// A no-show can't be undone into a court closed since: the closure didn't
// list it (nobody held the hour) and nobody would be told.
func TestUndoNoShowRespectsClosures(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	date, times := newSlots().take(t, 1)
	u := e.newCustomer(t, 0)
	res, err := e.bookings.CreateBookings(ctx, onlineBooking(u.ID, date, "pick-3", times[0]))
	if err != nil {
		t.Fatal(err)
	}
	if err := e.db.Model(&model.Booking{}).Where("id = ?", res.Bookings[0].ID).Update("status", model.BookingNoShow).Error; err != nil {
		t.Fatal(err)
	}
	court := "pick-3"
	closure, err := e.closures.Create(ctx, service.CreateDayOffInput{Date: date, CourtID: &court, Reason: "repairs", IsFullDay: true}, "mgr-a", "Manager A")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.bookings.UndoNoShow(ctx, res.Bookings[0].ID, "staff-a", "Staff A"); !errors.Is(err, service.ErrSlotUnavailable) {
		t.Fatalf("undo on a closed court: %v, want ErrSlotUnavailable", err)
	}
	if err := e.closures.Delete(ctx, closure.DayOff.ID, "mgr-a", "Manager A"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.bookings.UndoNoShow(ctx, res.Bookings[0].ID, "staff-a", "Staff A"); err != nil {
		t.Fatalf("undo once the closure is gone: %v", err)
	}
}

// A full court has two halves at most (a third would book the same floor
// twice - halves don't block each other).
func TestFullCourtHasTwoHalvesAtMost(t *testing.T) {
	e := raceSetup(t)
	_, err := service.NewCourtAdminService(e.db).Create(context.Background(), service.CourtInput{
		Name: "Court A third half", Type: model.CourtBasketball, HalfCourt: true, HalfOf: "b_full_a",
	}, "admin-a", "Admin A")
	if !errors.Is(err, service.ErrInvalidState) {
		t.Fatalf("third half of b_full_a: %v, want ErrInvalidState", err)
	}
}
