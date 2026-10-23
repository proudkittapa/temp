package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/service"
)

// Owner rules of 2026-10-23. Need TEST_DATABASE_URL (see concurrency_test.go).

// MAX_HOURS_PER_BOOKING: 3 by default, configurable.
func TestMaxHoursPerBookingFromEnv(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	sl := newSlots()
	book := func(n int) error {
		date, times := sl.take(t, n)
		_, err := e.bookings.CreateBookings(ctx, onlineBooking(e.newCustomer(t, 0).ID, date, "meet-1", times...))
		return err
	}
	if err := book(4); !errors.Is(err, service.ErrInvalidBooking) {
		t.Fatalf("4 hours with the default: %v, want ErrInvalidBooking", err)
	}
	if err := book(3); err != nil {
		t.Fatalf("3 hours with the default: %v", err)
	}
	t.Setenv("MAX_HOURS_PER_BOOKING", "4")
	if err := book(4); err != nil {
		t.Fatalf("4 hours with MAX_HOURS_PER_BOOKING=4: %v", err)
	}
}

// A counter walk-in paid by transfer expires after the hold like an
// online booking, freeing the court.
func TestWalkInTransferExpires(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	date, times := newSlots().take(t, 1)
	res, err := e.bookings.CreateBookings(ctx, service.CreateBookingInput{
		Date: date, Slots: []service.SlotRequest{{CourtID: "pick-2", StartTime: times[0]}},
		WalkIn: &service.WalkInDetails{StaffID: "staff-a", StaffName: "Staff A", CustomerName: "Walk-in", CustomerPhone: "0890000098", PaymentMethod: model.PaymentPromptPay},
	})
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-service.PaymentHoldDuration - time.Minute)
	e.db.Model(&model.Payment{}).Where("id = ?", res.Payment.ID).Update("created_at", old)
	if _, err := e.bookings.ExpireUnpaidBookings(ctx); err != nil {
		t.Fatal(err)
	}
	var p model.Payment
	e.db.First(&p, "id = ?", res.Payment.ID)
	if p.Status != model.PaymentExpired {
		t.Errorf("walk-in transfer after the hold: payment %s, want EXPIRED", p.Status)
	}
	if n := e.activeOn(t, date, times[0], "pick-2")["pick-2"]; n != 0 {
		t.Errorf("the court is still held (%d)", n)
	}
}

// Cash taken out at close (banked) sets what the next float should be.
func TestBankedCashSetsNextFloat(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	e.openTestShift(t) // float 500
	if _, err := e.shifts.Close(ctx, 500, 600, "", "staff-a", "Staff A", false); !errors.Is(err, service.ErrInvalidBooking) {
		t.Fatalf("banking more than counted: %v, want ErrInvalidBooking", err)
	}
	if _, err := e.shifts.Close(ctx, 500, 350, "", "staff-a", "Staff A", false); err != nil {
		t.Fatal(err)
	}
	if last, err := e.shifts.LastCount(ctx); err != nil || last == nil || *last != 150 {
		t.Fatalf("next float after counting 500 and banking 350: %v, %v - want 150", last, err)
	}
	if _, err := e.shifts.Open(ctx, 150, "", "staff-b", "Staff B"); err != nil {
		t.Fatalf("opening with what was left, no note: %v", err)
	}
	if _, err := e.shifts.Close(ctx, 150, 0, "", "staff-b", "Staff B", false); err != nil {
		t.Fatal(err)
	}
}

// Vouchers can be claimed for VOUCHER_VALID_DAYS (default 365).
func TestVoucherValidFor365Days(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	reward := model.RewardCatalogItem{ID: "rw-year", Name: "Year water", Emoji: "💧", PointsCost: 5, Kind: model.RewardKindItem, IsActive: true}
	if err := e.db.Create(&reward).Error; err != nil {
		t.Fatal(err)
	}
	v, err := e.rewards.Redeem(ctx, e.newCustomer(t, 10).ID, reward.ID)
	if err != nil {
		t.Fatal(err)
	}
	if days := v.ExpiresAt.Sub(v.CreatedAt).Hours() / 24; days < 364.9 || days > 365.1 {
		t.Errorf("voucher valid for %.1f days, want 365", days)
	}
}

// Audit entries older than AUDIT_RETENTION_DAYS (default 730) are deleted,
// newer ones kept.
func TestAuditRetention(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	old := model.AuditLog{ID: "log-retention-old", UserID: "test", UserName: "Test", Action: "TEST", TargetType: "Test", TargetID: "x", CreatedAt: time.Now().AddDate(0, 0, -800)}
	recent := model.AuditLog{ID: "log-retention-new", UserID: "test", UserName: "Test", Action: "TEST", TargetType: "Test", TargetID: "x", CreatedAt: time.Now().AddDate(0, 0, -700)}
	if err := e.db.Create(&old).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.db.Create(&recent).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := service.PruneAuditLogs(ctx, e.db); err != nil {
		t.Fatal(err)
	}
	var left []string
	e.db.Model(&model.AuditLog{}).Where("id IN ?", []string{old.ID, recent.ID}).Pluck("id", &left)
	if len(left) != 1 || left[0] != recent.ID {
		t.Errorf("after pruning: %v, want only the 700-day-old entry", left)
	}
}

// The no-show re-sale price is an admin setting: saved, reported to the
// screens, and used for the freed hour's price.
func TestNoShowResaleIsAdminSetting(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	pricing := service.NewPricingAdminService(e.db)
	zero := 0
	if _, err := pricing.UpdateConfig(ctx, service.ConfigInput{NoShowResalePercent: &zero}, "admin-a", "Admin A"); !errors.Is(err, service.ErrInvalidBooking) {
		t.Fatalf("0 %%: %v, want ErrInvalidBooking", err)
	}
	pct, grace := 80, 20
	if _, err := pricing.UpdateConfig(ctx, service.ConfigInput{NoShowResalePercent: &pct, NoShowGraceMinutes: &grace}, "admin-a", "Admin A"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		e.db.Model(&model.PricingConfig{}).Where("id = ?", "global").Updates(map[string]any{"no_show_resale_percent": nil, "no_show_grace_minutes": nil})
	})
	snap, err := pricing.Snapshot(ctx)
	if err != nil || snap.NoShowResalePercent != 80 || snap.NoShowGraceMinutes != 20 {
		t.Fatalf("snapshot: %+v %v - want 80 %%, 20 min", snap, err)
	}
	// A no-show's hour (weekday off-peak badminton, 180 THB) re-sells at 80 %.
	date, times := newSlots().take(t, 1)
	first, err := e.bookings.CreateBookings(ctx, onlineBooking(e.newCustomer(t, 0).ID, date, "bad-7", times[0]))
	if err != nil {
		t.Fatal(err)
	}
	e.db.Model(&model.Booking{}).Where("id = ?", first.Bookings[0].ID).Update("status", model.BookingNoShow)
	again, err := e.bookings.CreateBookings(ctx, onlineBooking(e.newCustomer(t, 0).ID, date, "bad-7", times[0]))
	if err != nil {
		t.Fatal(err)
	}
	if again.TotalAmount != 144 {
		t.Errorf("re-sold no-show hour costs %.2f, want 144 (80 %% of 180)", again.TotalAmount)
	}
}

// A kept rental deposit is income on the day it was kept.
func TestKeptDepositIsIncome(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	e.openTestShift(t)
	prod := model.Product{ID: "prd-kept", Name: "Kept racket", Category: model.ProductEquipment, Price: 50, IsRental: true, Deposit: 100, Stock: 10, IsActive: true, CreatedAt: time.Now()}
	if err := e.db.Create(&prod).Error; err != nil {
		t.Fatal(err)
	}
	day := time.Now().In(service.Bangkok)
	from := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, service.Bangkok)
	to := from.AddDate(0, 0, 1)
	before, err := e.pos.TotalsBetween(ctx, from, to)
	if err != nil {
		t.Fatal(err)
	}
	out, err := e.pos.ProcessCheckout(ctx, service.CheckoutInput{Type: model.OrderEquipmentRent, PaymentMeth: model.PaymentCash,
		CreatedBy: "staff-a", CreatedByName: "Staff A", Items: []service.POSOrderItemInput{{ProductID: prod.ID, Qty: 1}}})
	if err != nil {
		t.Fatal(err)
	}
	var item model.OrderItem
	e.db.First(&item, "order_id = ?", out.Order.ID)
	if _, err := e.pos.ReturnRentalItem(ctx, item.ID, 40, "broken grip", "staff-a", "Staff A"); err != nil {
		t.Fatal(err)
	}
	after, err := e.pos.TotalsBetween(ctx, from, to)
	if err != nil {
		t.Fatal(err)
	}
	if got := after.KeptDeposits - before.KeptDeposits; got != 40 {
		t.Errorf("kept deposits went up by %.2f, want 40", got)
	}
	if got := after.Rentals - before.Rentals; got != 90 {
		t.Errorf("rental income went up by %.2f, want 90 (50 fee + 40 kept)", got)
	}
}
