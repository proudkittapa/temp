package main

// Race tests on a real PostgreSQL: the same actions sent at the same moment
// (two staff members, a customer and a background job, double clicks) must
// leave the data as if they had run one after the other - one booking per
// slot, no stock below zero, points that match their ledger, cash totals that
// match the closed shift.
//
// They need an empty database of their own, because they drop and recreate
// its schema:
//
//	createdb arena_test
//	TEST_DATABASE_URL='postgres://USER:PASSWORD@localhost:5432/arena_test?sslmode=disable' \
//	  go test -run Concurrency -count=1 .
//
// Without TEST_DATABASE_URL they are skipped. The database name must end in
// "_test", so a real database can't be wiped by mistake. CONCURRENCY_ROUNDS
// (default 15) sets how often each race is repeated.

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/repository"
	"arena-backend/internal/service"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type raceEnv struct {
	db       *gorm.DB
	bookings *service.BookingService
	pos      *service.POSService
	rewards  *service.RewardService
	shifts   *service.ShiftService
	closures *service.DayOffService
}

var (
	raceOnce   sync.Once
	raceShared *raceEnv
	raceErr    error
	raceSeq    atomic.Int64 // unique phones, ids and slip hashes
)

// raceSetup builds the schema once (exactly as the server does at start) and
// the services on top of it.
func raceSetup(t *testing.T) *raceEnv {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set (see concurrency_test.go)")
	}
	raceOnce.Do(func() { raceShared, raceErr = newRaceEnv(dsn) })
	if raceErr != nil {
		t.Fatal(raceErr)
	}
	return raceShared
}

func newRaceEnv(dsn string) (*raceEnv, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, fmt.Errorf("TEST_DATABASE_URL: %w", err)
	}
	if name := strings.TrimPrefix(u.Path, "/"); !strings.HasSuffix(name, "_test") {
		return nil, fmt.Errorf("TEST_DATABASE_URL must name a database ending in _test (got %q): the tests drop its schema", name)
	}
	setupDB, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		return nil, err
	}
	if err := setupDB.Exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public").Error; err != nil {
		return nil, err
	}
	if err := setupSchema(setupDB); err != nil {
		return nil, err
	}
	buildPerfIndexes(context.Background(), dsn)
	if sqlSetup, err := setupDB.DB(); err == nil {
		sqlSetup.Close()
	}

	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		return nil, err
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(20)
	if err := service.NewRoleService(db).SeedBuiltins(context.Background()); err != nil {
		return nil, err
	}
	usrRepo := repository.NewUserRepository(db)
	courtRepo := repository.NewCourtRepository(db)
	pay, err := service.NewPaymentService("0812345678")
	if err != nil {
		return nil, err
	}
	price := service.NewPriceEngineService(courtRepo, service.NewMembershipService(db, usrRepo))
	return &raceEnv{
		db:       db,
		bookings: service.NewBookingService(db, repository.NewBookingRepository(db), usrRepo, courtRepo, price, pay),
		pos:      service.NewPOSService(db, usrRepo),
		rewards:  service.NewRewardService(db, usrRepo),
		shifts:   service.NewShiftService(db),
		closures: service.NewDayOffService(db),
	}, nil
}

func raceRounds() int {
	if n, err := strconv.Atoi(os.Getenv("CONCURRENCY_ROUNDS")); err == nil && n > 0 {
		return n
	}
	return 15
}

func nextSeq() int64 { return raceSeq.Add(1) }

// together runs each fn in its own goroutine, all released at the same
// moment (each after a random pause of up to 2 ms, so every order of
// arrival happens over the rounds), and returns their errors in the same
// order.
func together(fns ...func() error) []error {
	errs := make([]error, len(fns))
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i, fn := range fns {
		wg.Add(1)
		go func(i int, fn func() error) {
			defer wg.Done()
			<-start
			time.Sleep(time.Duration(rand.IntN(2000)) * time.Microsecond)
			errs[i] = fn()
		}(i, fn)
	}
	close(start)
	wg.Wait()
	return errs
}

// expectOnly fails the test for an error that isn't one of the expected
// "you lost the race" answers. ErrBusy (retries used up) is allowed but
// logged: it is a correct answer, just one the customer has to retry.
func expectOnly(t *testing.T, what string, err error, allowed ...error) {
	t.Helper()
	if err == nil {
		return
	}
	if errors.Is(err, service.ErrBusy) {
		t.Logf("%s: busy (retries used up): %v", what, err)
		return
	}
	for _, a := range allowed {
		if errors.Is(err, a) {
			return
		}
	}
	t.Errorf("%s: unexpected error: %v", what, err)
}

// newCustomer adds a customer with the given points, recorded in the ledger
// too (the ledger must always add up to the balance).
func (e *raceEnv) newCustomer(t *testing.T, points int) model.User {
	t.Helper()
	n := nextSeq()
	now := time.Now()
	u := model.User{
		ID: fmt.Sprintf("usr-race-%d", n), Name: fmt.Sprintf("Race %d", n), Phone: fmt.Sprintf("09%08d", n),
		Role: model.RoleCustomer, MemberType: model.MemberNormal, IsActive: true, Points: points,
		PasswordHash: "-", CreatedAt: now, UpdatedAt: now,
	}
	if err := e.db.Create(&u).Error; err != nil {
		t.Fatal(err)
	}
	if points != 0 {
		if err := e.db.Create(&model.PointsLedgerEntry{
			ID: fmt.Sprintf("led-race-%d", n), UserID: u.ID, Type: model.LedgerAdjustManual, Points: points,
			CreatedAt: now, CreatedBy: "test",
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	return u
}

// slots hands out weekday off-peak hours (08:00-16:00, when the basketball
// halves can be booked too) 2-29 days ahead, never the same one twice, so
// each round races on fresh slots.
type slots struct {
	dates []string
	next  int
}

func newSlots() *slots {
	bkk := time.FixedZone("ICT", 7*3600)
	today := time.Now().In(bkk)
	s := &slots{}
	for d := 2; d <= 29; d++ {
		day := today.AddDate(0, 0, d)
		if wd := day.Weekday(); wd != time.Saturday && wd != time.Sunday {
			s.dates = append(s.dates, day.Format("2006-01-02"))
		}
	}
	return s
}

// take returns a date and n consecutive start times on it.
func (s *slots) take(t *testing.T, n int) (string, []string) {
	t.Helper()
	const first, last = 8, 16 // start hours
	perDay := last - first + 1
	for s.next/perDay < len(s.dates) {
		day, h := s.next/perDay, first+s.next%perDay
		if h+n-1 > last {
			s.next = (day + 1) * perDay
			continue
		}
		s.next += n
		times := make([]string, n)
		for i := range times {
			times[i] = fmt.Sprintf("%02d:00", h+i)
		}
		return s.dates[day], times
	}
	t.Fatal("ran out of test slots: lower CONCURRENCY_ROUNDS")
	return "", nil
}

func onlineBooking(userID, date, court string, times ...string) service.CreateBookingInput {
	in := service.CreateBookingInput{Date: date, UserID: userID}
	for _, st := range times {
		in.Slots = append(in.Slots, service.SlotRequest{CourtID: court, StartTime: st})
	}
	return in
}

// book makes an online booking and uploads a slip for it, returning the
// payment as the slip queue shows it.
func (e *raceEnv) bookWithSlip(t *testing.T, user model.User, date, court string, times ...string) (*service.CreateBookingResult, model.Payment) {
	t.Helper()
	ctx := context.Background()
	res, err := e.bookings.CreateBookings(ctx, onlineBooking(user.ID, date, court, times...))
	if err != nil {
		t.Fatalf("booking %s %s %v: %v", court, date, times, err)
	}
	n := nextSeq()
	if _, err := e.bookings.SaveSlip(ctx, res.Payment.ID, fmt.Sprintf("/uploads/race-%d.png", n), fmt.Sprintf("hash-race-%d", n), user.ID); err != nil {
		t.Fatalf("slip: %v", err)
	}
	var p model.Payment
	if err := e.db.First(&p, "id = ?", res.Payment.ID).Error; err != nil {
		t.Fatal(err)
	}
	return res, p
}

// checkLedger: every balance equals the sum of its ledger and none is below
// zero.
func (e *raceEnv) checkLedger(t *testing.T) {
	t.Helper()
	var bad []struct {
		ID     string
		Points int
		Ledger int
	}
	if err := e.db.Raw(`SELECT u.id, u.points, COALESCE(l.total, 0) AS ledger FROM users u
		LEFT JOIN (SELECT user_id, SUM(points) AS total FROM points_ledger_entries GROUP BY user_id) l ON l.user_id = u.id
		WHERE u.points <> COALESCE(l.total, 0) OR u.points < 0`).Scan(&bad).Error; err != nil {
		t.Fatal(err)
	}
	for _, b := range bad {
		t.Errorf("user %s: points %d, ledger adds up to %d", b.ID, b.Points, b.Ledger)
	}
}

// activeOn returns the courts holding an active booking at that hour.
func (e *raceEnv) activeOn(t *testing.T, date, start string, courts ...string) map[string]int64 {
	t.Helper()
	var rows []struct {
		CourtID string
		N       int64
	}
	if err := e.db.Raw(`SELECT court_id, COUNT(*) AS n FROM bookings WHERE date = ? AND start_time = ? AND court_id IN ?
		AND status IN ('PENDING_PAYMENT', 'CONFIRMED') GROUP BY court_id`, date, start, courts).Scan(&rows).Error; err != nil {
		t.Fatal(err)
	}
	out := map[string]int64{}
	for _, r := range rows {
		out[r.CourtID] = r.N
	}
	return out
}

// Several customers book the same hour at once: one gets it.
func TestConcurrencyDoubleBooking(t *testing.T) {
	e := raceSetup(t)
	sl := newSlots()
	ctx := context.Background()
	for round := 0; round < raceRounds(); round++ {
		date, times := sl.take(t, 1)
		var fns []func() error
		for i := 0; i < 6; i++ {
			u := e.newCustomer(t, 0)
			fns = append(fns, func() error {
				_, err := e.bookings.CreateBookings(ctx, onlineBooking(u.ID, date, "bad-1", times[0]))
				return err
			})
		}
		won := 0
		for i, err := range together(fns...) {
			if err == nil {
				won++
			}
			expectOnly(t, fmt.Sprintf("round %d booking %d", round, i), err, service.ErrSlotUnavailable, repository.ErrSlotTaken)
		}
		held := e.activeOn(t, date, times[0], "bad-1")["bad-1"]
		if won != 1 || held != 1 {
			t.Errorf("round %d: %d bookings succeeded, %d active on the slot - want exactly 1", round, won, held)
		}
	}
}

// Two customers book overlapping two-hour blocks (10-12 and 11-13): they
// share an hour, so only one block can stand.
func TestConcurrencyOverlappingBlocks(t *testing.T) {
	e := raceSetup(t)
	sl := newSlots()
	ctx := context.Background()
	for round := 0; round < raceRounds(); round++ {
		date, times := sl.take(t, 3)
		a, b := e.newCustomer(t, 0), e.newCustomer(t, 0)
		errs := together(
			func() error {
				_, err := e.bookings.CreateBookings(ctx, onlineBooking(a.ID, date, "bad-6", times[0], times[1]))
				return err
			},
			func() error {
				_, err := e.bookings.CreateBookings(ctx, onlineBooking(b.ID, date, "bad-6", times[1], times[2]))
				return err
			},
		)
		won := 0
		for i, err := range errs {
			if err == nil {
				won++
			}
			expectOnly(t, fmt.Sprintf("round %d block %d", round, i), err, service.ErrSlotUnavailable, repository.ErrSlotTaken)
		}
		if won != 1 {
			t.Errorf("round %d: %d of the two overlapping blocks were booked, want 1", round, won)
		}
		for _, st := range times {
			if n := e.activeOn(t, date, st, "bad-6")["bad-6"]; n > 1 {
				t.Errorf("round %d: %d active bookings at %s", round, n, st)
			}
		}
	}
}

// The full basketball court and its two halves at the same hour: either the
// full court is booked, or the halves - never the full court with a half.
func TestConcurrencyFullVersusHalfCourt(t *testing.T) {
	e := raceSetup(t)
	sl := newSlots()
	ctx := context.Background()
	courts := []string{"b_full_a", "b_half_b", "b_half_c"}
	for round := 0; round < raceRounds(); round++ {
		date, times := sl.take(t, 1)
		var fns []func() error
		for _, c := range courts {
			u := e.newCustomer(t, 0)
			fns = append(fns, func() error {
				_, err := e.bookings.CreateBookings(ctx, onlineBooking(u.ID, date, c, times[0]))
				return err
			})
		}
		won := map[string]bool{}
		for i, err := range together(fns...) {
			if err == nil {
				won[courts[i]] = true
			}
			expectOnly(t, fmt.Sprintf("round %d %s", round, courts[i]), err, service.ErrSlotUnavailable, repository.ErrSlotTaken)
		}
		active := e.activeOn(t, date, times[0], courts...)
		fullOnly := won["b_full_a"] && !won["b_half_b"] && !won["b_half_c"]
		halves := !won["b_full_a"] && won["b_half_b"] && won["b_half_c"]
		if !fullOnly && !halves {
			t.Errorf("round %d: booked %v - want the full court alone or both halves", round, won)
		}
		if active["b_full_a"] > 0 && (active["b_half_b"] > 0 || active["b_half_c"] > 0) {
			t.Errorf("round %d: full court and a half are both active: %v", round, active)
		}
	}
}

// Staff approves a slip while another staff member cancels the booking with
// a refund: either it was approved and then refunded, or cancelled first
// (the approval then refused) - never a confirmed hour on a closed payment,
// nor points left over.
func TestConcurrencyApproveVersusCancel(t *testing.T) {
	e := raceSetup(t)
	sl := newSlots()
	ctx := context.Background()
	for round := 0; round < raceRounds(); round++ {
		date, times := sl.take(t, 1)
		u := e.newCustomer(t, 0)
		res, p := e.bookWithSlip(t, u, date, "bad-2", times[0])
		errs := together(
			func() error {
				_, err := e.bookings.VerifyPayment(ctx, p.ID, p.SlipUploadedAt, "staff-a", "Staff A")
				return err
			},
			func() error {
				_, err := e.bookings.CancelBookings(ctx, res.Bookings[0].ID, nil, "customer called", true, false, "", "staff-b", "Staff B")
				return err
			},
		)
		expectOnly(t, fmt.Sprintf("round %d approve", round), errs[0], service.ErrInvalidState)
		expectOnly(t, fmt.Sprintf("round %d cancel", round), errs[1], service.ErrInvalidState)

		var after model.Payment
		if err := e.db.First(&after, "id = ?", p.ID).Error; err != nil {
			t.Fatal(err)
		}
		var standing int64
		e.db.Model(&model.Booking{}).Where("booking_code = ? AND status IN ?", res.BookingCode,
			[]model.BookingStatus{model.BookingPendingPayment, model.BookingConfirmed}).Count(&standing)
		var points int
		e.db.Model(&model.User{}).Select("points").Where("id = ?", u.ID).Scan(&points)
		switch {
		case errs[1] != nil:
			// the cancel lost: it can only lose to nothing - flag it
			t.Errorf("round %d: cancel failed: %v", round, errs[1])
		case after.Status == model.PaymentRefunded:
			if errs[0] != nil || after.RefundAmount != after.Amount {
				t.Errorf("round %d: refunded %.2f of %.2f (approve error %v)", round, after.RefundAmount, after.Amount, errs[0])
			}
		case after.Status == model.PaymentRejected:
			if errs[0] == nil || !after.RefundCheckPending {
				t.Errorf("round %d: cancelled first but approve said %v, refund check pending %v", round, errs[0], after.RefundCheckPending)
			}
		default:
			t.Errorf("round %d: payment ended %s", round, after.Status)
		}
		if standing != 0 || points != 0 {
			t.Errorf("round %d: %d hours still standing, %d points left", round, standing, points)
		}
	}
	e.checkLedger(t)
}

// The customer sends the slip at the moment the unpaid hold runs out: either
// the slip came in time (hold kept), or the hold expired and the slip is a
// late one (hours released, waiting for a manager) - never a slip on time
// with the hours already given away.
func TestConcurrencySlipVersusExpiry(t *testing.T) {
	e := raceSetup(t)
	sl := newSlots()
	ctx := context.Background()
	for round := 0; round < raceRounds(); round++ {
		date, times := sl.take(t, 1)
		u := e.newCustomer(t, 0)
		res, err := e.bookings.CreateBookings(ctx, onlineBooking(u.ID, date, "bad-3", times[0]))
		if err != nil {
			t.Fatal(err)
		}
		// the hold ran out a minute ago
		old := time.Now().Add(-service.PaymentHoldDuration - time.Minute)
		if err := e.db.Model(&model.Payment{}).Where("id = ?", res.Payment.ID).Update("created_at", old).Error; err != nil {
			t.Fatal(err)
		}
		n := nextSeq()
		errs := together(
			func() error {
				_, err := e.bookings.SaveSlip(ctx, res.Payment.ID, fmt.Sprintf("/uploads/race-%d.png", n), fmt.Sprintf("hash-race-%d", n), u.ID)
				return err
			},
			func() error {
				_, err := e.bookings.ExpireUnpaidBookings(ctx)
				return err
			},
		)
		expectOnly(t, fmt.Sprintf("round %d slip", round), errs[0], service.ErrInvalidState)
		expectOnly(t, fmt.Sprintf("round %d expiry", round), errs[1])

		var p model.Payment
		if err := e.db.First(&p, "id = ?", res.Payment.ID).Error; err != nil {
			t.Fatal(err)
		}
		held := e.activeOn(t, date, times[0], "bad-3")["bad-3"]
		switch {
		case p.ExpiredAt == nil:
			if p.Status != model.PaymentSlipUploaded || held != 1 || errs[0] != nil {
				t.Errorf("round %d: not expired but payment %s, %d hours held, slip error %v", round, p.Status, held, errs[0])
			}
		default:
			if held != 0 {
				t.Errorf("round %d: expired but the hour is still held", round)
			}
			if errs[0] == nil && p.Status != model.PaymentSlipUploaded {
				t.Errorf("round %d: late slip accepted but payment is %s", round, p.Status)
			}
		}
		if errs[0] == nil && p.SlipUploads != 1 {
			t.Errorf("round %d: %d slips counted, want 1", round, p.SlipUploads)
		}
	}
}

// A double click on "redeem": the points pay for one reward only.
func TestConcurrencyRedeemTwice(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	reward := model.RewardCatalogItem{ID: "rw-race", Name: "Race water", Emoji: "💧", PointsCost: 60, Kind: model.RewardKindItem, IsActive: true}
	if err := e.db.Create(&reward).Error; err != nil {
		t.Fatal(err)
	}
	for round := 0; round < raceRounds(); round++ {
		u := e.newCustomer(t, 100)
		var fns []func() error
		for i := 0; i < 5; i++ {
			fns = append(fns, func() error {
				_, err := e.rewards.Redeem(ctx, u.ID, reward.ID)
				return err
			})
		}
		won := 0
		for i, err := range together(fns...) {
			if err == nil {
				won++
			}
			expectOnly(t, fmt.Sprintf("round %d redeem %d", round, i), err, service.ErrInsufficientPointsForReward)
		}
		var vouchers int64
		e.db.Model(&model.Voucher{}).Where("user_id = ?", u.ID).Count(&vouchers)
		var points int
		e.db.Model(&model.User{}).Select("points").Where("id = ?", u.ID).Scan(&points)
		if won != 1 || vouchers != 1 || points != 40 {
			t.Errorf("round %d: %d redeemed, %d vouchers, %d points left - want 1, 1, 40", round, won, vouchers, points)
		}
	}
	e.checkLedger(t)
}

// Customers buy the last items at once: no more are sold than in stock.
func TestConcurrencyCheckoutOversell(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	for round := 0; round < raceRounds(); round++ {
		prod := model.Product{ID: fmt.Sprintf("prd-race-%d", nextSeq()), Name: "Race drink", Category: model.ProductFB, Price: 20, Stock: 3, IsActive: true, CreatedAt: time.Now()}
		if err := e.db.Create(&prod).Error; err != nil {
			t.Fatal(err)
		}
		var fns []func() error
		for i := 0; i < 7; i++ {
			fns = append(fns, func() error {
				_, err := e.pos.ProcessCheckout(ctx, service.CheckoutInput{
					Type: model.OrderFB, PaymentMeth: model.PaymentPromptPay, CreatedBy: "staff-a", CreatedByName: "Staff A",
					Items: []service.POSOrderItemInput{{ProductID: prod.ID, Qty: 1}},
				})
				return err
			})
		}
		sold := 0
		for i, err := range together(fns...) {
			if err == nil {
				sold++
			}
			expectOnly(t, fmt.Sprintf("round %d sale %d", round, i), err, service.ErrOutOfStock)
		}
		var stock int
		e.db.Model(&model.Product{}).Select("stock").Where("id = ?", prod.ID).Scan(&stock)
		var lines int64
		e.db.Model(&model.OrderItem{}).Where("product_id = ?", prod.ID).Count(&lines)
		if sold != 3 || stock != 0 || lines != 3 {
			t.Errorf("round %d: %d sold, stock %d, %d order lines - want 3, 0, 3", round, sold, stock, lines)
		}
	}
}

// A confirmed booking is cancelled (points taken back) while the customer
// spends those points on a reward: the balance never goes below zero and the
// ledger still adds up.
func TestConcurrencyCancelVersusRedeem(t *testing.T) {
	e := raceSetup(t)
	sl := newSlots()
	ctx := context.Background()
	for round := 0; round < raceRounds(); round++ {
		date, times := sl.take(t, 2)
		u := e.newCustomer(t, 0)
		res, p := e.bookWithSlip(t, u, date, "bad-4", times...)
		if _, err := e.bookings.VerifyPayment(ctx, p.ID, p.SlipUploadedAt, "staff-a", "Staff A"); err != nil {
			t.Fatal(err)
		}
		var earned int
		e.db.Model(&model.User{}).Select("points").Where("id = ?", u.ID).Scan(&earned)
		if earned <= 0 {
			t.Fatalf("round %d: the confirmed booking earned %d points", round, earned)
		}
		reward := model.RewardCatalogItem{ID: fmt.Sprintf("rw-race-%d", nextSeq()), Name: "Race towel", Emoji: "🧺", PointsCost: earned, Kind: model.RewardKindItem, IsActive: true}
		if err := e.db.Create(&reward).Error; err != nil {
			t.Fatal(err)
		}
		errs := together(
			func() error {
				_, err := e.rewards.Redeem(ctx, u.ID, reward.ID)
				return err
			},
			func() error {
				_, err := e.bookings.CancelBookings(ctx, res.Bookings[0].ID, nil, "rain", true, false, "", "staff-b", "Staff B")
				return err
			},
		)
		expectOnly(t, fmt.Sprintf("round %d redeem", round), errs[0], service.ErrInsufficientPointsForReward)
		expectOnly(t, fmt.Sprintf("round %d cancel", round), errs[1])
		var points int
		e.db.Model(&model.User{}).Select("points").Where("id = ?", u.ID).Scan(&points)
		var active int64
		e.db.Model(&model.Voucher{}).Where("user_id = ? AND status = ?", u.ID, model.VoucherActive).Count(&active)
		// Whatever the order: the hours are gone, so are their points - and
		// a voucher bought with them is cancelled.
		if points != 0 || active != 0 {
			t.Errorf("round %d: %d points and %d active vouchers left after the cancel", round, points, active)
		}
	}
	e.checkLedger(t)
}

// A cash sale is voided while the shift is being closed: the cash counted at
// close matches what the shift's sales add up to afterwards (the void is in
// it, or refused because the shift was closed).
func TestConcurrencyVoidVersusShiftClose(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	prod := model.Product{ID: "prd-race-cash", Name: "Race snack", Category: model.ProductFB, Price: 35, Stock: 100000, IsActive: true, CreatedAt: time.Now()}
	if err := e.db.Create(&prod).Error; err != nil {
		t.Fatal(err)
	}
	for round := 0; round < raceRounds(); round++ {
		sh, err := e.shifts.Open(ctx, 500, "race test: float reset", "staff-a", "Staff A")
		if err != nil {
			t.Fatal(err)
		}
		var orders []string
		for i := 0; i < 2; i++ {
			out, err := e.pos.ProcessCheckout(ctx, service.CheckoutInput{
				Type: model.OrderFB, PaymentMeth: model.PaymentCash, CreatedBy: "staff-a", CreatedByName: "Staff A",
				Items: []service.POSOrderItemInput{{ProductID: prod.ID, Qty: 1}},
			})
			if err != nil {
				t.Fatal(err)
			}
			orders = append(orders, out.Order.ID)
		}
		errs := together(
			func() error {
				_, err := e.pos.VoidOrder(ctx, orders[0], "wrong item", "staff-a", "Staff A")
				return err
			},
			func() error {
				_, err := e.shifts.Close(ctx, 570, 0, "race test", "staff-a", "Staff A", false)
				return err
			},
		)
		expectOnly(t, fmt.Sprintf("round %d void", round), errs[0], service.ErrInvalidState)
		if errs[1] != nil {
			t.Fatalf("round %d close: %v", round, errs[1])
		}
		var closed model.Shift
		if err := e.db.First(&closed, "id = ?", sh.Shift.ID).Error; err != nil {
			t.Fatal(err)
		}
		var nowSum float64
		e.db.Model(&model.Order{}).Select("COALESCE(SUM(total_amount), 0)").
			Where("payment_method = ? AND created_at >= ? AND created_at < ? AND status <> ?", model.PaymentCash, closed.OpenedAt, *closed.ClosedAt, model.OrderCancelled).
			Scan(&nowSum)
		want := 70.0
		if errs[0] == nil {
			want = 35
		}
		if closed.CashOrdersAtClose == nil || *closed.CashOrdersAtClose != nowSum || nowSum != want {
			t.Errorf("round %d: counted at close %v, sales now add up to %.2f, want %.2f (void error %v)", round, closed.CashOrdersAtClose, nowSum, want, errs[0])
		}
	}
}

// openTestShift opens the drawer (closing one left open), with a note so
// the float needn't match the last count.
func (e *raceEnv) openTestShift(t *testing.T) *service.ShiftView {
	t.Helper()
	ctx := context.Background()
	if cur, err := e.shifts.Current(ctx); err != nil {
		t.Fatal(err)
	} else if cur != nil {
		if _, err := e.shifts.Close(ctx, 0, 0, "race test cleanup", "staff-a", "Staff A", false); err != nil {
			t.Fatal(err)
		}
	}
	sh, err := e.shifts.Open(ctx, 500, "race test: float reset", "staff-a", "Staff A")
	if err != nil {
		t.Fatal(err)
	}
	return sh
}

// A manager closes a court for an hour while a customer books that hour:
// either the booking is refused (closed), or it got in first and the
// closure lists it among the affected bookings - never a booking in the
// closed window that nobody was told about. Odd rounds close court B's full
// court while the left half is booked (a closure covers its halves).
func TestConcurrencyClosureVersusBooking(t *testing.T) {
	e := raceSetup(t)
	sl := newSlots()
	ctx := context.Background()
	for round := 0; round < raceRounds(); round++ {
		date, times := sl.take(t, 1)
		closeCourt, bookCourt := "bad-8", "bad-8"
		if round%2 == 1 {
			closeCourt, bookCourt = "bb-b-full", "bb-b-left"
		}
		hour, _ := strconv.Atoi(times[0][:2])
		end := hour + 1
		u := e.newCustomer(t, 0)
		var booked *service.CreateBookingResult
		var closure *service.CreateDayOffResult
		errs := together(
			func() (err error) {
				booked, err = e.bookings.CreateBookings(ctx, onlineBooking(u.ID, date, bookCourt, times[0]))
				return err
			},
			func() (err error) {
				// The booking does more work before it reaches the lock;
				// a longer pause lets it win some rounds too.
				time.Sleep(time.Duration(rand.IntN(8000)) * time.Microsecond)
				closure, err = e.closures.Create(ctx, service.CreateDayOffInput{
					Date: date, CourtID: &closeCourt, Reason: "race test closure", StartHour: &hour, EndHour: &end,
				}, "mgr-a", "Manager A")
				return err
			},
		)
		expectOnly(t, fmt.Sprintf("round %d booking", round), errs[0], service.ErrSlotUnavailable)
		if errs[1] != nil {
			t.Fatalf("round %d closure: %v", round, errs[1])
		}
		listed := false
		for _, b := range closure.AffectedBookings {
			if b.CourtID == bookCourt && b.StartTime == times[0] {
				listed = true
			}
		}
		held := e.activeOn(t, date, times[0], bookCourt)[bookCourt]
		switch {
		case errs[0] == nil:
			if !listed || held != 1 || booked == nil {
				t.Errorf("round %d: booking went through but the closure listed it %v (held %d)", round, listed, held)
			}
		case listed || held != 0:
			t.Errorf("round %d: booking refused but listed %v, held %d", round, listed, held)
		}
	}
}

// A rental is returned while a manager voids it: the item comes back into
// stock once, and the deposit is settled once (given back by the return or
// by the void) - the drawer's deposits add up to zero.
func TestConcurrencyRentalReturnVersusVoid(t *testing.T) {
	e := raceSetup(t)
	ctx := context.Background()
	e.openTestShift(t)
	prod := model.Product{ID: "prd-race-rent", Name: "Race racket", Category: model.ProductEquipment, Price: 50, IsRental: true,
		Deposit: 100, Stock: 1000, IsActive: true, CreatedAt: time.Now()}
	if err := e.db.Create(&prod).Error; err != nil {
		t.Fatal(err)
	}
	for round := 0; round < raceRounds(); round++ {
		var before int
		e.db.Model(&model.Product{}).Select("stock").Where("id = ?", prod.ID).Scan(&before)
		out, err := e.pos.ProcessCheckout(ctx, service.CheckoutInput{
			Type: model.OrderEquipmentRent, PaymentMeth: model.PaymentCash, CreatedBy: "staff-a", CreatedByName: "Staff A",
			Items: []service.POSOrderItemInput{{ProductID: prod.ID, Qty: 1}},
		})
		if err != nil {
			t.Fatal(err)
		}
		var item model.OrderItem
		if err := e.db.First(&item, "order_id = ?", out.Order.ID).Error; err != nil {
			t.Fatal(err)
		}
		errs := together(
			func() error {
				_, err := e.pos.ReturnRentalItem(ctx, item.ID, 0, "", "staff-a", "Staff A")
				return err
			},
			func() error {
				_, err := e.pos.VoidOrder(ctx, out.Order.ID, "wrong racket", "mgr-a", "Manager A")
				return err
			},
		)
		expectOnly(t, fmt.Sprintf("round %d return", round), errs[0], service.ErrInvalidState)
		expectOnly(t, fmt.Sprintf("round %d void", round), errs[1], service.ErrInvalidState)
		if errs[1] != nil {
			t.Errorf("round %d: void refused: %v", round, errs[1])
		}
		var after int
		e.db.Model(&model.Product{}).Select("stock").Where("id = ?", prod.ID).Scan(&after)
		var o model.Order
		if err := e.db.First(&o, "id = ?", out.Order.ID).Error; err != nil {
			t.Fatal(err)
		}
		if after != before {
			t.Errorf("round %d: stock %d before the rental, %d after return + void", round, before, after)
		}
		if o.DepositSettledAt == nil || o.DepositReturned+o.DepositKept != o.DepositAmount || o.DepositAmount != 100 {
			t.Errorf("round %d: deposit %.2f, returned %.2f, kept %.2f, settled %v", round, o.DepositAmount, o.DepositReturned, o.DepositKept, o.DepositSettledAt)
		}
	}
	cur, err := e.shifts.Current(ctx)
	if err != nil || cur == nil {
		t.Fatalf("shift: %v", err)
	}
	if cur.CashDeposits != 0 {
		t.Errorf("drawer deposits add up to %.2f, want 0 (each taken and given back once)", cur.CashDeposits)
	}
}

// A manager records a booking as paid in cash while the shift is being
// closed: the cash is either in the closed shift's count or refused (no
// shift open) - never paid into a shift after it was counted. Odd rounds
// use an expired booking (booked again under the date's closure lock) and
// add a closure created on that date at the same moment, the lock order the
// three share.
func TestConcurrencyCashPaymentVersusShiftClose(t *testing.T) {
	e := raceSetup(t)
	sl := newSlots()
	ctx := context.Background()
	for round := 0; round < raceRounds(); round++ {
		date, times := sl.take(t, 1)
		u := e.newCustomer(t, 0)
		res, err := e.bookings.CreateBookings(ctx, onlineBooking(u.ID, date, "bad-9", times[0]))
		if err != nil {
			t.Fatal(err)
		}
		expired := round%2 == 1
		if expired {
			old := time.Now().Add(-service.PaymentHoldDuration - time.Minute)
			e.db.Model(&model.Payment{}).Where("id = ?", res.Payment.ID).Update("created_at", old)
			if _, err := e.bookings.ExpireUnpaidBookings(ctx); err != nil {
				t.Fatal(err)
			}
		}
		sh := e.openTestShift(t)
		fns := []func() error{
			func() error {
				_, err := e.bookings.MarkPaidInCash(ctx, res.Payment.ID, "mgr-a", "Manager A")
				return err
			},
			func() error {
				time.Sleep(time.Duration(rand.IntN(4000)) * time.Microsecond) // as above: both orders
				_, err := e.shifts.Close(ctx, 500, 0, "race test", "staff-a", "Staff A", false)
				return err
			},
		}
		if expired {
			other := "bad-10"
			fns = append(fns, func() error {
				_, err := e.closures.Create(ctx, service.CreateDayOffInput{Date: date, CourtID: &other, Reason: "race test", IsFullDay: true}, "mgr-b", "Manager B")
				return err
			})
		}
		errs := together(fns...)
		expectOnly(t, fmt.Sprintf("round %d cash", round), errs[0], service.ErrNoOpenShift)
		if errs[1] != nil {
			t.Fatalf("round %d close: %v", round, errs[1])
		}
		if expired && errs[2] != nil {
			t.Errorf("round %d closure: %v", round, errs[2])
		}
		var closed model.Shift
		if err := e.db.First(&closed, "id = ?", sh.Shift.ID).Error; err != nil {
			t.Fatal(err)
		}
		var nowSum float64
		e.db.Model(&model.Payment{}).Select("COALESCE(SUM(amount), 0)").
			Where("method = ? AND verified_at >= ? AND verified_at < ? AND status IN ?", model.PaymentCash, closed.OpenedAt, *closed.ClosedAt,
				[]model.PaymentStatus{model.PaymentVerified, model.PaymentRefunded}).Scan(&nowSum)
		var p model.Payment
		if err := e.db.First(&p, "id = ?", res.Payment.ID).Error; err != nil {
			t.Fatal(err)
		}
		want := 0.0
		if errs[0] == nil {
			want = p.Amount
			if p.Status != model.PaymentVerified || p.Method != model.PaymentCash {
				t.Errorf("round %d: recorded but payment is %s %s", round, p.Status, p.Method)
			}
		} else if p.Status == model.PaymentVerified {
			t.Errorf("round %d: refused but payment is VERIFIED", round)
		}
		if closed.CashBookingsAtClose == nil || *closed.CashBookingsAtClose != nowSum || nowSum != want {
			t.Errorf("round %d: cash bookings at close %v, now add up to %.2f, want %.2f (cash error %v)", round, closed.CashBookingsAtClose, nowSum, want, errs[0])
		}
	}
}

// The customer re-sends the slip while staff approve it: one wins (approved
// with the slip staff saw, or refused because a new slip came), and the two
// never deadlock - they take the payment and customer locks in the same
// order (deadlocks would be retried, so the database's own counter is
// checked).
func TestConcurrencySlipReuploadVersusApprove(t *testing.T) {
	e := raceSetup(t)
	sl := newSlots()
	ctx := context.Background()
	deadlocks := func() int64 {
		var n int64
		e.db.Raw("SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()").Scan(&n)
		return n
	}
	before := deadlocks()
	for round := 0; round < raceRounds(); round++ {
		date, times := sl.take(t, 1)
		u := e.newCustomer(t, 0)
		_, p := e.bookWithSlip(t, u, date, "bad-12", times[0])
		n := nextSeq()
		errs := together(
			func() error {
				_, err := e.bookings.SaveSlip(ctx, p.ID, fmt.Sprintf("/uploads/race-%d.png", n), fmt.Sprintf("hash-race-%d", n), u.ID)
				return err
			},
			func() error {
				_, err := e.bookings.VerifyPayment(ctx, p.ID, p.SlipUploadedAt, "staff-a", "Staff A")
				return err
			},
		)
		expectOnly(t, fmt.Sprintf("round %d re-upload", round), errs[0], service.ErrInvalidState)
		expectOnly(t, fmt.Sprintf("round %d approve", round), errs[1], service.ErrSlipChanged)
		if (errs[0] == nil) == (errs[1] == nil) {
			t.Errorf("round %d: re-upload %v, approve %v - want exactly one to win", round, errs[0], errs[1])
		}
	}
	time.Sleep(200 * time.Millisecond) // the statistics collector is a moment behind
	if d := deadlocks() - before; d > 0 {
		t.Errorf("%d deadlock(s) between re-upload and approve", d)
	}
}
