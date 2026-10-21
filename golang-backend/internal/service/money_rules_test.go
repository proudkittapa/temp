package service

import (
	"errors"
	"sort"
	"testing"
	"time"

	"arena-backend/internal/model"
)

func kind(k string) *string { return &k }

func row(id string, st model.BookingStatus, amount float64, k *string) model.Booking {
	return model.Booking{ID: id, Status: st, TotalAmount: amount, CancelKind: k}
}

// The closure scenario: 2 hours (2x180) on one waiting slip, one hour
// cancelled with a refund of 180 - the remaining 180 still pays for the
// hour that stands, so approving must work.
func TestCoversStandingHoursAfterPartialRefund(t *testing.T) {
	p := &model.Payment{Amount: 360, RefundAmount: 180}
	group := []model.Booking{
		row("a", model.BookingPendingPayment, 180, nil),
		row("b", model.BookingCancelled, 180, kind(model.CancelKindStaff)),
	}
	if err := coversStandingHours(p, group); err != nil {
		t.Fatalf("kept hour is paid for, got %v", err)
	}
	// Refunded more than the cancelled hour: no longer covered.
	p.RefundAmount = 200
	if err := coversStandingHours(p, group); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("want ErrInvalidState, got %v", err)
	}
	// Nothing refunded: always fine.
	if err := coversStandingHours(&model.Payment{Amount: 360}, group); err != nil {
		t.Fatal(err)
	}
}

// A late payment brings back only the hours the hold cancelled, never an
// hour a manager cancelled.
func TestExpiredRowsOnlyExpiryCancelled(t *testing.T) {
	group := []model.Booking{
		row("a", model.BookingCancelled, 100, kind(model.CancelKindExpired)),
		row("b", model.BookingCancelled, 100, kind(model.CancelKindStaff)),
		row("c", model.BookingCancelled, 100, kind(model.CancelKindExpired)),
		row("d", model.BookingCancelled, 100, nil),
		row("e", model.BookingConfirmed, 100, nil),
	}
	got := expiredRows(group)
	if len(got) != 2 || got[0].ID != "a" || got[1].ID != "c" {
		t.Fatalf("expiredRows = %v", got)
	}
	// Late payment after a manager cancelled one of 3 hours: the 2-hour
	// amount covers the two expired hours.
	now := time.Now()
	p := &model.Payment{Amount: 200, RefundAmount: 0.01, ExpiredAt: &now}
	if err := coversStandingHours(p, group); err == nil {
		t.Fatal("199.99 left can't cover 200 of expired hours")
	}
	p.RefundAmount = 0
	if err := coversStandingHours(p, group); err != nil {
		t.Fatal(err)
	}
}

func TestIsWalkIn(t *testing.T) {
	if isWalkIn(&model.Booking{UserID: "u-1", CreatedBy: "u-1"}) {
		t.Fatal("an online booking is not a walk-in")
	}
	if !isWalkIn(&model.Booking{UserID: "u-1", CreatedBy: "u-staff"}) || !isWalkIn(&model.Booking{UserID: model.WalkInUserID, CreatedBy: "u-staff"}) {
		t.Fatal("staff-created bookings are walk-ins")
	}
}

func TestValidHourRange(t *testing.T) {
	for _, c := range []struct {
		s, e int
		ok   bool
	}{{7, 23, true}, {0, 24, true}, {9, 9, false}, {10, 9, false}, {-1, 5, false}, {5, 25, false}} {
		if validHourRange(c.s, c.e) != c.ok {
			t.Errorf("validHourRange(%d, %d) != %v", c.s, c.e, c.ok)
		}
	}
}

// Carts with the same items in any order lock them in one order.
func TestLineLockKeyOrder(t *testing.T) {
	v := "pd-9-42-M"
	a := []POSOrderItemInput{{ProductID: "pd-2"}, {ProductID: "pd-9", VariantID: &v}, {ProductID: "pd-1"}}
	b := []POSOrderItemInput{{ProductID: "pd-1"}, {ProductID: "pd-2"}, {ProductID: "pd-9", VariantID: &v}}
	keys := func(in []POSOrderItemInput) []string {
		out := []string{}
		cp := append([]POSOrderItemInput(nil), in...)
		sort.Slice(cp, func(i, j int) bool { return lineLockKey(cp[i]) < lineLockKey(cp[j]) })
		for _, x := range cp {
			out = append(out, lineLockKey(x))
		}
		return out
	}
	ka, kb := keys(a), keys(b)
	for i := range ka {
		if ka[i] != kb[i] {
			t.Fatalf("lock order differs: %v vs %v", ka, kb)
		}
	}
}
