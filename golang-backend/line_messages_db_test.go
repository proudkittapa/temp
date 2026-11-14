package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/repository"
	"arena-backend/internal/service"
)

// fakePush stands in for LINE's push endpoint: it records what was sent
// and answers with the next queued status (200 when none is queued).
type fakePush struct {
	mu       sync.Mutex
	got      []pushCall
	statuses []int
}

type pushCall struct {
	to, text, retryKey, auth string
}

func (f *fakePush) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/bot/message/push" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body struct {
			To       string `json:"to"`
			Messages []struct {
				Type, Text string
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		defer f.mu.Unlock()
		status := http.StatusOK
		if len(f.statuses) > 0 {
			status, f.statuses = f.statuses[0], f.statuses[1:]
		}
		if status == http.StatusOK && len(body.Messages) == 1 && body.Messages[0].Type == "text" {
			f.got = append(f.got, pushCall{body.To, body.Messages[0].Text, r.Header.Get("X-Line-Retry-Key"), r.Header.Get("Authorization")})
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{}`))
	})
}

func lineMessagesSetup(t *testing.T) (*raceEnv, *service.BookingService, *service.LineNotifier, *fakePush) {
	e := raceSetup(t)
	f := &fakePush{}
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	n := service.NewLineNotifier(e.db, "chan-token", srv.URL)
	usrRepo := repository.NewUserRepository(e.db)
	courtRepo := repository.NewCourtRepository(e.db)
	pay, err := service.NewPaymentService("0812345678")
	if err != nil {
		t.Fatal(err)
	}
	bs := service.NewBookingService(e.db, repository.NewBookingRepository(e.db), usrRepo, courtRepo,
		service.NewPriceEngineService(courtRepo, service.NewMembershipService(e.db, usrRepo)), pay)
	bs.SetLineNotifier(n)
	return e, bs, n, f
}

// drain sends everything already queued (other tests' messages), so a
// test's own statuses apply to its own message.
func drain(t *testing.T, e *raceEnv) {
	t.Helper()
	if err := e.db.Model(&model.LineOutbox{}).Where("status = ?", model.LineOutboxPending).Update("status", model.LineOutboxSent).Error; err != nil {
		t.Fatal(err)
	}
}

func outboxFor(t *testing.T, e *raceEnv, userID string) []model.LineOutbox {
	t.Helper()
	var rows []model.LineOutbox
	if err := e.db.Where("user_id = ?", userID).Order("created_at").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	return rows
}

func TestLineMessagesApprovedRejectedExpired(t *testing.T) {
	e, bs, n, f := lineMessagesSetup(t)
	ctx := context.Background()
	slots := newSlots()
	drain(t, e)
	linked := e.newCustomer(t, 0)
	sub := "Umsg" + linked.ID
	if err := e.db.Model(&model.User{}).Where("id = ?", linked.ID).Update("line_user_id", sub).Error; err != nil {
		t.Fatal(err)
	}
	plain := e.newCustomer(t, 0) // no LINE: nothing queued

	book := func(u model.User, hours int) (*service.CreateBookingResult, model.Payment) {
		date, times := slots.take(t, hours)
		res, err := bs.CreateBookings(ctx, onlineBooking(u.ID, date, "bad-11", times...))
		if err != nil {
			t.Fatal(err)
		}
		seq := nextSeq()
		if _, err := bs.SaveSlip(ctx, res.Payment.ID, fmt.Sprintf("/uploads/line-%d.png", seq), fmt.Sprintf("hash-line-%d", seq), u.ID); err != nil {
			t.Fatal(err)
		}
		var p model.Payment
		e.db.First(&p, "id = ?", res.Payment.ID)
		return res, p
	}

	// Approved.
	res, p := book(linked, 2)
	if _, err := bs.VerifyPayment(ctx, p.ID, p.SlipUploadedAt, "staff-a", "Staff A"); err != nil {
		t.Fatal(err)
	}
	rows := outboxFor(t, e, linked.ID)
	if len(rows) != 1 || rows[0].Kind != service.LineKindApproved || rows[0].Status != model.LineOutboxPending ||
		!strings.Contains(rows[0].Text, res.BookingCode) || !strings.Contains(rows[0].Text, "สนามแบดมินตัน 11") || strings.Count(rows[0].Text, " น.") != 2 {
		t.Fatalf("approved message queued: %+v", rows)
	}
	sent, err := n.SendPending(ctx)
	if err != nil || sent != 1 {
		t.Fatalf("send: %d %v", sent, err)
	}
	f.mu.Lock()
	if len(f.got) != 1 || f.got[0].to != sub || f.got[0].auth != "Bearer chan-token" || len(f.got[0].retryKey) != 36 || !strings.HasPrefix(f.got[0].text, "✅ ยืนยันการจองแล้วค่ะ") {
		t.Fatalf("pushed: %+v", f.got)
	}
	f.mu.Unlock()
	if rows = outboxFor(t, e, linked.ID); rows[0].Status != model.LineOutboxSent || rows[0].SentAt == nil {
		t.Fatalf("after send: %+v", rows[0])
	}

	// Rejected, with the reason.
	_, p = book(linked, 1)
	if _, err := bs.RejectPayment(ctx, p.ID, p.SlipUploadedAt, "ยอดไม่ตรง", "staff-a", "Staff A"); err != nil {
		t.Fatal(err)
	}
	// Expired.
	expDate, expTimes := slots.take(t, 1)
	resExp, err := bs.CreateBookings(ctx, onlineBooking(linked.ID, expDate, "bad-11", expTimes...))
	if err != nil {
		t.Fatal(err)
	}
	e.db.Model(&model.Payment{}).Where("id = ?", resExp.Payment.ID).Update("created_at", time.Now().Add(-service.PaymentHoldDuration-time.Minute))
	if _, err := bs.ExpireUnpaidBookings(ctx); err != nil {
		t.Fatal(err)
	}
	rows = outboxFor(t, e, linked.ID)
	if len(rows) != 3 || rows[1].Kind != service.LineKindRejected || !strings.Contains(rows[1].Text, "เหตุผล: ยอดไม่ตรง") ||
		rows[2].Kind != service.LineKindExpired || !strings.Contains(rows[2].Text, resExp.BookingCode) || !strings.Contains(rows[2].Text, "30 นาที") {
		t.Fatalf("rejected + expired queued: %+v", rows)
	}

	// The customer without LINE gets nothing queued.
	_, p = book(plain, 1)
	if _, err := bs.VerifyPayment(ctx, p.ID, p.SlipUploadedAt, "staff-a", "Staff A"); err != nil {
		t.Fatal(err)
	}
	if got := outboxFor(t, e, plain.ID); len(got) != 0 {
		t.Fatalf("queued for a customer without LINE: %+v", got)
	}

	usage, err := n.Usage(ctx)
	if err != nil || !usage.Enabled || usage.SentThisMonth < 1 || usage.Pending < 2 {
		t.Fatalf("usage: %+v %v", usage, err)
	}
}

// LINE down: retried later with the same retry key; a 409 (already
// accepted under that key) counts as sent; a 400 is not retried.
func TestLineMessagesRetryAndFail(t *testing.T) {
	e, bs, n, f := lineMessagesSetup(t)
	ctx := context.Background()
	slots := newSlots()
	slots.next = 40 // other hours than the test above
	drain(t, e)
	u := e.newCustomer(t, 0)
	if err := e.db.Model(&model.User{}).Where("id = ?", u.ID).Update("line_user_id", "Uretry"+u.ID).Error; err != nil {
		t.Fatal(err)
	}
	date, times := slots.take(t, 1)
	res, err := bs.CreateBookings(ctx, onlineBooking(u.ID, date, "bad-11", times...))
	if err != nil {
		t.Fatal(err)
	}
	e.db.Model(&model.Payment{}).Where("id = ?", res.Payment.ID).Update("created_at", time.Now().Add(-service.PaymentHoldDuration-time.Minute))
	if _, err := bs.ExpireUnpaidBookings(ctx); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.statuses = []int{http.StatusInternalServerError}
	f.mu.Unlock()
	if sent, err := n.SendPending(ctx); err != nil || sent != 0 {
		t.Fatalf("send while LINE is down: %d %v", sent, err)
	}
	rows := outboxFor(t, e, u.ID)
	if len(rows) != 1 || rows[0].Status != model.LineOutboxPending || rows[0].Attempts != 1 || !rows[0].NextAttemptAt.After(time.Now()) {
		t.Fatalf("after a 500: %+v", rows)
	}
	key := rows[0].RetryKey
	// Due again (as if a minute had passed); LINE says it already has it.
	e.db.Model(&model.LineOutbox{}).Where("id = ?", rows[0].ID).Update("next_attempt_at", time.Now().Add(-time.Second))
	f.mu.Lock()
	f.statuses = []int{http.StatusConflict}
	f.mu.Unlock()
	if sent, err := n.SendPending(ctx); err != nil || sent != 1 {
		t.Fatalf("send after LINE is back: %d %v", sent, err)
	}
	if rows = outboxFor(t, e, u.ID); rows[0].Status != model.LineOutboxSent || rows[0].RetryKey != key {
		t.Fatalf("after a 409: %+v", rows[0])
	}

	// A message LINE refuses (e.g. a bad user id) is not retried.
	if err := e.db.Create(&model.LineOutbox{ID: "lm-bad-" + u.ID, UserID: u.ID, LineUserID: "Ubad", Kind: service.LineKindApproved,
		Text: "x", Status: model.LineOutboxPending, RetryKey: "00000000-0000-4000-8000-000000000000",
		NextAttemptAt: time.Now().Add(-time.Second), CreatedAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.statuses = []int{http.StatusBadRequest}
	f.mu.Unlock()
	if _, err := n.SendPending(ctx); err != nil {
		t.Fatal(err)
	}
	var bad model.LineOutbox
	e.db.First(&bad, "id = ?", "lm-bad-"+u.ID)
	if bad.Status != model.LineOutboxFailed || bad.LastError == nil {
		t.Fatalf("refused message: %+v", bad)
	}
}
