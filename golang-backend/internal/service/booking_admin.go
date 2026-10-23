package service

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Booking lifecycle beyond create/verify/reject: late payments, manager
// cancellations and refunds (FR-6.3), cash recorded by a manager, no-shows
// and completion.

// paidStatuses are booking rows whose money was received (or whose hour
// was played) - what cancellation, no-show and reports care about.
var paidStatuses = []model.BookingStatus{model.BookingConfirmed, model.BookingCompleted, model.BookingNoShow}

// confirmGroup confirms the group's rows after its payment was approved and
// awards 1 point per confirmed hour (FR-4.1). For a late payment (the hold
// had expired, so the rows were cancelled) the rows are first reserved
// again - all of them, or none if any slot has been taken, closed or is
// already over meanwhile (ErrLatePaymentSlotGone: refund instead).
func (s *BookingService) confirmGroup(ctx context.Context, tx *gorm.DB, p *model.Payment, group []model.Booking, root *model.Booking, now time.Time) (confirmed, points int, err error) {
	targets := map[string]bool{}
	for _, b := range group {
		if b.Status == model.BookingPendingPayment {
			targets[b.ID] = true
		}
	}
	if p.ExpiredAt != nil && len(targets) == 0 {
		if err := s.reReserve(tx, group, now); err != nil {
			return 0, 0, err
		}
		for _, b := range expiredRows(group) {
			targets[b.ID] = true
		}
	}
	for id := range targets {
		upd := tx.Model(&model.Booking{}).Where("id = ? AND status IN ?", id, []model.BookingStatus{model.BookingPendingPayment, model.BookingCancelled}).
			Updates(map[string]interface{}{"status": model.BookingConfirmed, "cancellation_reason": nil, "cancel_kind": nil, "updated_at": now})
		if upd.Error != nil {
			return 0, 0, upd.Error
		}
		if upd.RowsAffected == 0 {
			return 0, 0, fmt.Errorf("%w: the booking changed meanwhile - reload and try again", ErrInvalidState)
		}
		confirmed++
	}
	if confirmed > 0 && root.UserID != model.WalkInUserID {
		refType, note := "Booking", fmt.Sprintf("%dh confirmed booking %s", confirmed, root.BookingCode)
		if _, err := s.usrRepo.AddPointsEntry(ctx, tx, root.UserID, model.LedgerEarnBooking, confirmed, "system", &refType, &root.ID, &note); err != nil {
			return 0, 0, fmt.Errorf("failed to award booking points: %w", err)
		}
		points = confirmed
	}
	return confirmed, points, nil
}

// ErrLatePaymentSlotGone: a late payment can't be honoured because one of
// its slots is no longer available - a manager should refund it.
var ErrLatePaymentSlotGone = errors.New("late payment: the booked slot is no longer available - refund the customer instead")

// expiredRows are the group's rows cancelled because the payment hold ran
// out - the only ones a late payment may bring back (hours a manager
// cancelled, or a rejected slip's, stay cancelled).
func expiredRows(group []model.Booking) []model.Booking {
	var out []model.Booking
	for _, b := range group {
		if b.Status == model.BookingCancelled && b.CancelKind != nil && *b.CancelKind == model.CancelKindExpired {
			out = append(out, b)
		}
	}
	return out
}

// isWalkIn: booked by staff at the counter rather than by the customer.
func isWalkIn(root *model.Booking) bool { return root.CreatedBy != root.UserID }

// coversStandingHours: confirming a payment books its group's hours, so
// the money not refunded must still cover every hour that would stand -
// the booked/played ones plus, for a late payment, the expired hours it
// brings back. Only matters once part of the payment was refunded.
func coversStandingHours(p *model.Payment, group []model.Booking) error {
	if p.RefundAmount <= 0 {
		return nil
	}
	cost := keptAmount(group)
	if p.ExpiredAt != nil {
		for _, b := range expiredRows(group) {
			cost = RoundBaht(cost + b.TotalAmount)
		}
	}
	if RoundBaht(p.Amount-p.RefundAmount) < cost {
		return fmt.Errorf("%w: %.2f THB of this payment was refunded - cancel or refund the rest instead of approving", ErrInvalidState, p.RefundAmount)
	}
	return nil
}

// reReserve checks that every expiry-cancelled row of an expired group can
// be booked again (same checks as CreateBookings, under the same locks).
func (s *BookingService) reReserve(tx *gorm.DB, group []model.Booking, now time.Time) error {
	rows := expiredRows(group)
	courtIDs := []string{}
	for _, b := range rows {
		courtIDs = append(courtIDs, b.CourtID)
	}
	if len(rows) == 0 {
		return fmt.Errorf("%w: nothing to confirm", ErrInvalidState)
	}
	date := rows[0].Date
	if err := tx.Exec("SELECT pg_advisory_xact_lock_shared(?, hashtext(?))", closureLockClass, date).Error; err != nil {
		return err
	}
	var courts []model.Court
	if err := tx.Where("id IN ?", courtIDs).Find(&courts).Error; err != nil {
		return err
	}
	byID := map[string]model.Court{}
	for _, c := range courts {
		byID[c.ID] = c
	}
	var closures []model.DayOff
	if err := tx.Where("date = ?", date).Find(&closures).Error; err != nil {
		return err
	}
	closedCourts, err := repository.ClosureCourts(tx, closures)
	if err != nil {
		return err
	}
	// Take court-group locks in the same order CreateBookings does
	// (repository.LockKey), so the two can't deadlock.
	sort.Slice(rows, func(i, j int) bool {
		ki, kj := repository.LockKey(byID[rows[i].CourtID]), repository.LockKey(byID[rows[j].CourtID])
		if ki != kj {
			return ki < kj
		}
		return rows[i].CourtID+rows[i].StartTime < rows[j].CourtID+rows[j].StartTime
	})
	locked := map[string][]model.Court{}
	for _, b := range rows {
		court, ok := byID[b.CourtID]
		if !ok {
			return fmt.Errorf("%w (court %s no longer exists)", ErrLatePaymentSlotGone, b.CourtID)
		}
		key := repository.LockKey(court)
		if _, ok := locked[key]; !ok {
			// A lock error (deadlock, timeout) is returned as it is: it is
			// retryable, not a reason to refund.
			g, err := s.bkRepo.LockCourtGroupTx(tx, court)
			if errors.Is(err, repository.ErrSlotTaken) || errors.Is(err, repository.ErrCourtGone) {
				// The court was closed or removed since: refund instead.
				return fmt.Errorf("%w (%v)", ErrLatePaymentSlotGone, err)
			}
			if err != nil {
				return err
			}
			locked[key] = g
		}
		_, hour, err := hourSlotEnd(b.StartTime)
		if err != nil {
			return err
		}
		if err := s.checkNotPast(date, []SlotRequest{{CourtID: b.CourtID, StartTime: b.StartTime}}, true); err != nil {
			return fmt.Errorf("%w (%s %s is over)", ErrLatePaymentSlotGone, court.Name, b.StartTime)
		}
		if closure := repository.ClosureFor(closures, court, closedCourts, hour); closure != nil {
			return fmt.Errorf("%w (%s is closed at %s)", ErrLatePaymentSlotGone, court.Name, b.StartTime)
		}
		if err := s.bkRepo.CheckOverlapTx(tx, court, locked[key], date, b.StartTime, b.EndTime); err != nil {
			if errors.Is(err, repository.ErrSlotTaken) {
				return fmt.Errorf("%w (%v)", ErrLatePaymentSlotGone, err)
			}
			return err
		}
	}
	return nil
}

// reversePoints takes back up to `hours` booking points (never below zero:
// points already spent on rewards stay spent). Returns how many were taken.
// If the customer already spent those points, their unused rewards are
// cancelled to cover them (as for a voided sale). Unlike a void, the
// cancellation still goes ahead when the points went on a reward already
// handed over (the venue must be able to cancel, e.g. for a closure): what
// is left is taken and the shortfall reported.
func (s *BookingService) reversePoints(ctx context.Context, tx *gorm.DB, userID string, hours int, actorID, note string, refID *string) (pointsReversal, error) {
	if hours <= 0 || userID == "" || userID == model.WalkInUserID {
		return pointsReversal{}, nil
	}
	var u model.User
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&u, "id = ?", userID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return pointsReversal{}, nil
		}
		return pointsReversal{}, err
	}
	codes, short, err := coverPointsWithRewards(ctx, tx, s.usrRepo, &u, hours, actorID, note)
	if err != nil {
		return pointsReversal{}, err
	}
	take := hours - short
	if take > 0 {
		refType := "Booking"
		if _, err := s.usrRepo.AddPointsEntry(ctx, tx, userID, model.LedgerReverseBooking, -take, actorID, &refType, refID, &note); err != nil {
			return pointsReversal{}, err
		}
	}
	return pointsReversal{Taken: take, CancelledVouchers: codes, Short: short}, nil
}

// pointsReversal is what reversePoints did: points taken back, rewards
// cancelled to cover them, and points that couldn't be taken back.
type pointsReversal struct {
	Taken             int
	CancelledVouchers []string
	Short             int
}

// applyRefund records money returned on a payment (the transfer itself is
// done by staff outside the system). REFUNDED once it covers the amount.
func applyRefund(tx *gorm.DB, p *model.Payment, amount float64, reason, actorID string, now time.Time) error {
	remaining := RoundBaht(p.Amount - p.RefundAmount)
	if amount <= 0 || amount > remaining {
		return fmt.Errorf("%w: refund must be more than 0 and at most %.2f THB", ErrInvalidBooking, remaining)
	}
	total := RoundBaht(p.RefundAmount + amount)
	updates := map[string]interface{}{
		"refund_amount": total, "refunded_at": now, "refunded_by": actorID, "refund_reason": reason, "updated_at": now,
		"refund_check_pending": false,
	}
	if total >= p.Amount {
		updates["status"] = model.PaymentRefunded
	}
	if err := tx.Model(p).Updates(updates).Error; err != nil {
		return err
	}
	p.RefundAmount = total
	return tx.Create(&model.Refund{ID: ids.New("rfd"), PaymentID: p.ID, Amount: amount, Reason: reason, RefundedBy: actorID, RefundedAt: now}).Error
}

// keptAmount is what the group's still-standing hours cost: hours booked
// (awaiting payment or confirmed) or played (completed, no-show). Money
// beyond that, not yet refunded, is refundable.
func keptAmount(group []model.Booking) float64 {
	sum := 0.0
	for _, b := range group {
		switch b.Status {
		case model.BookingPendingPayment, model.BookingConfirmed, model.BookingCompleted, model.BookingNoShow:
			sum += b.TotalAmount
		}
	}
	return RoundBaht(sum)
}

// moneyReceived: a transfer or cash arrived (or a slip says so) - refunds
// are possible. A REJECTED payment with a slip may still have real money
// behind it (its booking was cancelled before the slip was reviewed).
func moneyReceived(p *model.Payment) bool {
	switch p.Status {
	case model.PaymentVerified, model.PaymentSlipUploaded, model.PaymentRefunded:
		return true
	case model.PaymentRejected, model.PaymentExpired:
		return p.SlipURL != nil && *p.SlipURL != ""
	}
	return false
}

// CancelResult reports what a cancellation did.
type CancelResult struct {
	BookingCode     string  `json:"booking_code"`
	Cancelled       int     `json:"cancelled"`
	RefundAmount    float64 `json:"refund_amount"`
	PointsReversed  int     `json:"points_reversed"`
	PaymentStatus   string  `json:"payment_status"`
	RemainingActive int     `json:"remaining_active"`
	// RefundNeedsCheck: a refund was asked for a slip nobody has verified,
	// so none was recorded - check the bank account, then refund the
	// payment (RefundPayment with bank_checked).
	RefundNeedsCheck bool `json:"refund_needs_check,omitempty"`
	// Rewards cancelled because their points came from these hours, and
	// points that couldn't be taken back (spent on a reward handed over).
	CancelledVouchers []string `json:"cancelled_vouchers,omitempty"`
	PointsShort       int      `json:"points_short,omitempty"`
	// StartedHours: cancelled hours that had already started (allowed,
	// owner 2026-10-23 - and recorded in the audit log).
	StartedHours int `json:"started_hours,omitempty"`
}

// CancelBookings is the manager/admin cancellation (FR-6.3). bookingID is
// any row of the group; onlyIDs limits it to some hours of the group (e.g.
// the one hour a closure hits), otherwise every active hour is cancelled.
// A reason is required and audit-logged. With refund=true the price of the
// cancelled paid hours is recorded as refunded. Points earned for cancelled
// confirmed hours are taken back.
//
// bankChecked: the manager confirmed the money is in the bank account. A
// slip staff haven't approved yet proves nothing (any image uploads), so
// its refund is recorded only with that confirmation; without it the hours
// are cancelled and RefundNeedsCheck tells the caller to check and refund
// later (RefundPayment).
func (s *BookingService) CancelBookings(ctx context.Context, bookingID string, onlyIDs []string, reason string, wantRefund, bankChecked bool, actorID, actorName string) (*CancelResult, error) {
	reason = strings.TrimSpace(reason)
	if err := checkText("reason", reason); err != nil {
		return nil, err
	}
	if reason == "" {
		return nil, fmt.Errorf("%w: a cancellation reason is required", ErrInvalidBooking)
	}
	res := &CancelResult{}
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		// A retried attempt starts over: the payment may have changed
		// meanwhile (e.g. a slip arrived), so decide refund afresh.
		*res = CancelResult{}
		refund := wantRefund
		p, root, err := s.groupPayment(tx, bookingID, true)
		if err != nil {
			return err
		}
		group, _, err := s.bookingGroup(tx, root.ID)
		if err != nil {
			return err
		}
		want := map[string]bool{}
		for _, id := range onlyIDs {
			want[id] = true
		}
		var cancel []model.Booking
		active := 0
		for _, b := range group {
			isActive := b.Status == model.BookingPendingPayment || b.Status == model.BookingConfirmed
			if len(want) > 0 && want[b.ID] {
				if !isActive {
					return fmt.Errorf("%w: %s %s is %s and can't be cancelled", ErrInvalidState, b.Date, b.StartTime, b.Status)
				}
				cancel = append(cancel, b)
			} else if len(want) == 0 && isActive {
				cancel = append(cancel, b)
			} else if isActive {
				active++
			}
		}
		if len(want) > 0 && len(cancel) != len(want) {
			return fmt.Errorf("%w: some booking ids are not part of this booking", ErrInvalidBooking)
		}
		if len(cancel) == 0 {
			return fmt.Errorf("%w: nothing left to cancel in this booking", ErrInvalidState)
		}
		// refund = "refund what was received for these hours": nothing to do
		// when no money arrived (an unpaid hold), so callers can always ask.
		moneyIn := p.Status == model.PaymentVerified || (p.Status == model.PaymentSlipUploaded && bankChecked)
		if refund && p.Status == model.PaymentSlipUploaded && !bankChecked {
			res.RefundNeedsCheck = true
		}
		if !moneyIn {
			refund = false
		}

		now := s.now()
		paidHours, paidAmount := 0, 0.0
		for _, b := range cancel {
			// Only if it is still active: a no-show or completion recorded a
			// moment ago by someone else must not be overwritten (and its
			// point taken back twice).
			upd := tx.Model(&model.Booking{}).Where("id = ? AND status IN ?", b.ID,
				[]model.BookingStatus{model.BookingPendingPayment, model.BookingConfirmed}).Updates(map[string]interface{}{
				"status": model.BookingCancelled, "cancellation_reason": "Cancelled by " + actorName + ": " + reason,
				"cancel_kind": model.CancelKindStaff, "updated_at": now,
			})
			if upd.Error != nil {
				return upd.Error
			}
			if upd.RowsAffected == 0 {
				return fmt.Errorf("%w: %s %s changed meanwhile - reload and try again", ErrInvalidState, b.Date, b.StartTime)
			}
			// Only paid hours earned a point - a free (voucher) hour didn't.
			if b.Status == model.BookingConfirmed && b.TotalAmount > 0 {
				paidHours++
			}
			paidAmount = RoundBaht(paidAmount + b.TotalAmount)
		}
		res.Cancelled, res.RemainingActive, res.BookingCode = len(cancel), active, root.BookingCode
		for _, b := range cancel {
			if s.hourStarted(b.Date, b.StartTime) {
				res.StartedHours++
			}
		}

		rev, err := s.reversePoints(ctx, tx, root.UserID, paidHours, actorID,
			fmt.Sprintf("%dh of booking %s cancelled: %s", paidHours, root.BookingCode, reason), &root.ID)
		if err != nil {
			return err
		}
		res.PointsReversed, res.CancelledVouchers, res.PointsShort = rev.Taken, rev.CancelledVouchers, rev.Short

		// A free hour paid with a voucher: give the voucher back instead of
		// a (zero) refund.
		if p.Method == model.PaymentVoucher {
			cancelIDs := make([]string, len(cancel))
			for i, b := range cancel {
				cancelIDs[i] = b.ID
			}
			if err := tx.Model(&model.Voucher{}).Where("booking_id IN ?", cancelIDs).Updates(map[string]interface{}{
				"status": model.VoucherActive, "dispensed_at": nil, "dispensed_by": nil, "booking_id": nil,
			}).Error; err != nil {
				return err
			}
			refund = false
		}

		switch {
		case refund:
			if err := applyRefund(tx, p, paidAmount, reason, actorID, now); err != nil {
				return err
			}
			res.RefundAmount = paidAmount
		case active > 0 && (p.Status == model.PaymentPending || p.Status == model.PaymentExpired):
			// Unpaid and some hours stay: the customer now owes less, so the
			// amount and its QR shrink - otherwise they'd pay for the
			// cancelled hours too and nothing could refund them.
			newAmount := RoundBaht(p.Amount - paidAmount)
			qr, err := s.paymentService.CreatePromptPayPayload(newAmount)
			if err != nil {
				return err
			}
			if err := tx.Model(p).Updates(map[string]interface{}{"amount": newAmount, "qr_payload": qr, "updated_at": now}).Error; err != nil {
				return err
			}
		}
		// Nothing left in the group: close a payment still waiting -
		// REFUNDED if something was refunded, else REJECTED (a slip that
		// was sent can still be refunded later, see RefundPayment).
		if active == 0 && (p.Status == model.PaymentPending || p.Status == model.PaymentSlipUploaded) {
			st := model.PaymentRejected
			if p.RefundAmount > 0 {
				st = model.PaymentRefunded
			}
			if err := tx.Model(p).Updates(map[string]interface{}{"status": st, "refund_reason": reason, "updated_at": now}).Error; err != nil {
				return err
			}
		}
		// Remember the refund that couldn't be recorded, so it isn't lost
		// once the payment leaves the slip queue.
		if res.RefundNeedsCheck {
			if err := tx.Model(p).Update("refund_check_pending", true).Error; err != nil {
				return err
			}
		}
		if err := tx.First(p, "id = ?", p.ID).Error; err != nil {
			return err
		}
		res.PaymentStatus = string(p.Status)

		return tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: actorID, UserName: actorName,
			Action: "BOOKING_CANCELLED", TargetType: "Booking", TargetID: root.ID,
			BeforeState: model.AuditJSON(map[string]any{"booking_code": root.BookingCode, "hours": len(cancel)}),
			AfterState: model.AuditJSON(map[string]any{
				"cancelled": len(cancel), "refund_amount": res.RefundAmount, "points_reversed": res.PointsReversed, "payment_status": p.Status,
				"vouchers_cancelled": res.CancelledVouchers, "points_short": res.PointsShort, "started_hours": res.StartedHours,
			}),
			Reason: &reason, CreatedAt: now,
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// RefundPayment records a refund for a payment whose money arrived but no
// booking stands for it - typically a late payment whose slot was taken
// meanwhile. Hours still booked must be cancelled first (CancelBookings
// with refund does both at once). amount nil = everything not yet refunded.
//
// Only an approved (VERIFIED) payment proves the money arrived; for any
// other (a slip still waiting, rejected or sent after expiry) the manager
// must confirm with bankChecked that the transfer is in the bank account -
// otherwise a fake slip turns into a real refund.
func (s *BookingService) RefundPayment(ctx context.Context, paymentID string, amount *float64, reason string, bankChecked bool, actorID, actorName string) (*model.Payment, error) {
	reason = strings.TrimSpace(reason)
	if err := checkText("reason", reason); err != nil {
		return nil, err
	}
	if reason == "" {
		return nil, fmt.Errorf("%w: a refund reason is required", ErrInvalidBooking)
	}
	var p *model.Payment
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		var err error
		if p, err = lockPayment(tx, paymentID); err != nil {
			return err
		}
		if !moneyReceived(p) {
			return fmt.Errorf("%w: payment is %s - no money was received to refund", ErrInvalidState, p.Status)
		}
		if p.Status != model.PaymentVerified && !bankChecked {
			return fmt.Errorf("%w: this slip was never approved - check that the transfer is in the bank account, then confirm the refund", ErrInvalidState)
		}
		group, root, err := s.bookingGroup(tx, p.BookingID)
		if err != nil {
			return err
		}
		now := s.now()
		// A slip still waiting: the manager refunds instead of confirming,
		// so its hours are released.
		pendingRows := 0
		for i, b := range group {
			if b.Status == model.BookingPendingPayment {
				if err := tx.Model(&model.Booking{}).Where("id = ? AND status = ?", b.ID, model.BookingPendingPayment).Updates(map[string]interface{}{
					"status": model.BookingCancelled, "cancellation_reason": "Refunded: " + reason,
					"cancel_kind": model.CancelKindRefunded, "updated_at": now,
				}).Error; err != nil {
					return err
				}
				group[i].Status = model.BookingCancelled
				pendingRows++
			}
		}
		// Hours still confirmed or played keep their money; the rest of
		// what was paid (cancelled hours) can be refunded - also when only
		// some hours of the group were cancelled.
		refundable := RoundBaht(p.Amount - p.RefundAmount - keptAmount(group))
		if refundable <= 0 {
			return fmt.Errorf("%w: nothing to refund - every paid hour still stands (cancel the hours with refund instead)", ErrInvalidState)
		}
		amt := refundable
		if amount != nil {
			amt = RoundBaht(*amount)
			if amt > refundable {
				return fmt.Errorf("%w: at most %.2f THB can be refunded (the rest pays for hours still booked)", ErrInvalidBooking, refundable)
			}
		}
		if err := applyRefund(tx, p, amt, reason, actorID, now); err != nil {
			return err
		}
		// A waiting slip whose hours were all released is closed now, so
		// it leaves the review queue and the customer's unpaid count. Not an
		// approved payment: part of it refunded leaves it VERIFIED (it turns
		// REFUNDED when all is back), or the rest couldn't be refunded
		// without a bank check and it would read as fully refunded.
		if keptAmount(group) == 0 && p.Status != model.PaymentRefunded && p.Status != model.PaymentVerified {
			if err := tx.Model(p).Updates(map[string]interface{}{"status": model.PaymentRefunded, "updated_at": now}).Error; err != nil {
				return err
			}
		}
		if err := tx.First(p, "id = ?", p.ID).Error; err != nil {
			return err
		}
		return tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: actorID, UserName: actorName,
			Action: "PAYMENT_REFUNDED", TargetType: "Payment", TargetID: p.ID,
			AfterState: model.AuditJSON(map[string]any{"booking_code": root.BookingCode, "refunded": amt, "refund_total": p.RefundAmount, "status": p.Status}),
			Reason:     &reason, CreatedAt: now,
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return p, nil
}

// MarkPaidInCash is a manager/admin recording that the customer paid this
// booking in cash at the counter (e.g. an online booking settled in
// person). The payment becomes a VERIFIED cash payment - counted in the
// day's cash drawer - and the group is confirmed with points, exactly like
// an approved slip. Works on an expired booking too, if its slots are still
// free.
func (s *BookingService) MarkPaidInCash(ctx context.Context, paymentID, actorID, actorName string) (*ReviewResult, error) {
	var res *ReviewResult
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		p, err := lockPayment(tx, paymentID)
		if err != nil {
			return err
		}
		// Before Updates below: GORM writes the new values into p.
		beforeMethod := p.Method
		// A transfer slip waiting for review is decided by approving or
		// rejecting it - recording cash on top would count money twice.
		if p.Status == model.PaymentSlipUploaded {
			return fmt.Errorf("%w: a transfer slip is waiting for review - approve or reject the slip instead of recording cash", ErrInvalidState)
		}
		if p.Status != model.PaymentPending && p.Status != model.PaymentExpired {
			return fmt.Errorf("%w: payment is %s", ErrInvalidState, p.Status)
		}
		// The whole amount is recorded as cash received, so a payment part
		// of which was refunded can't be settled this way.
		if p.RefundAmount > 0 {
			return fmt.Errorf("%w: part of this payment was refunded - it can't be recorded as paid in cash", ErrInvalidState)
		}
		group, root, err := s.bookingGroup(tx, p.BookingID)
		if err != nil {
			return err
		}
		if err := lockGroupUser(tx, root); err != nil {
			return err
		}
		// An expired group is booked again (reReserve, under the date's
		// closure lock): take that lock before the drawer, the order
		// CreateBookings uses, so the two can't deadlock behind a queued
		// shift close and day-off.
		if p.Status == model.PaymentExpired {
			if err := tx.Exec("SELECT pg_advisory_xact_lock_shared(?, hashtext(?))", closureLockClass, root.Date).Error; err != nil {
				return err
			}
		}
		// Cash into the drawer: needs an open shift, and waits for a shift
		// close in progress (see lockDrawerForCash) before taking the time.
		if err := lockDrawerForCash(tx); err != nil {
			return err
		}
		now := s.now()
		before := p.Status
		if p.Status == model.PaymentExpired && p.ExpiredAt == nil {
			p.ExpiredAt = &now
		}
		confirmed, points, err := s.confirmGroup(ctx, tx, p, group, root, now)
		if err != nil {
			return err
		}
		if err := tx.Model(p).Updates(map[string]interface{}{
			"method": model.PaymentCash, "status": model.PaymentVerified, "verified_at": now, "verified_by": actorID, "updated_at": now,
		}).Error; err != nil {
			return err
		}
		res = &ReviewResult{PaymentID: p.ID, BookingCode: root.BookingCode, Status: string(model.PaymentVerified), BookingsCount: confirmed, PointsAwarded: points, Late: p.ExpiredAt != nil}
		return tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: actorID, UserName: actorName,
			Action: "PAID_IN_CASH_RECORDED", TargetType: "Payment", TargetID: p.ID,
			BeforeState: model.AuditJSON(map[string]any{"status": before, "method": beforeMethod}),
			AfterState:  model.AuditJSON(map[string]any{"status": model.PaymentVerified, "method": model.PaymentCash, "amount": p.Amount, "bookings_confirmed": confirmed}),
			CreatedAt:   now,
		}).Error
	})
	return res, err
}

// PaymentForBooking returns the id of the payment covering bookingID's
// group (the booking grid knows bookings, not payments).
func (s *BookingService) PaymentForBooking(ctx context.Context, bookingID string) (string, error) {
	p, _, err := s.groupPayment(s.db.WithContext(ctx), bookingID, false)
	if err != nil {
		return "", err
	}
	return p.ID, nil
}

// MarkNoShow records that the customer didn't come for one booked hour.
// Only a confirmed (or auto-completed) hour that has already started can
// be marked; the hour's loyalty point is taken back - points are for hours
// played. The payment is kept (no refund for a no-show).
func (s *BookingService) MarkNoShow(ctx context.Context, bookingID, actorID, actorName string) (*model.Booking, error) {
	var b model.Booking
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		var rev pointsReversal // reset per attempt
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&b, "id = ?", bookingID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		if len(b.Date) > 10 {
			b.Date = b.Date[:10]
		}
		if b.Status != model.BookingConfirmed && b.Status != model.BookingCompleted {
			return fmt.Errorf("%w: booking is %s", ErrInvalidState, b.Status)
		}
		day, err := time.ParseInLocation("2006-01-02", b.Date, Bangkok)
		if err != nil {
			return err
		}
		_, hour, err := hourSlotEnd(b.StartTime)
		if err != nil {
			return err
		}
		now := s.now()
		cfg, err := s.courtRepo.GetPricingConfig(ctx)
		if err != nil {
			return err
		}
		grace := noShowGrace(cfg)
		if day.Add(time.Duration(hour)*time.Hour + time.Duration(grace)*time.Minute).After(now) {
			return fmt.Errorf("%w: a no-show can be marked from %d minutes after the hour starts", ErrInvalidState, grace)
		}
		before := b.Status
		upd := tx.Model(&model.Booking{}).Where("id = ? AND status = ?", b.ID, before).Updates(map[string]interface{}{"status": model.BookingNoShow, "updated_at": now})
		if upd.Error != nil {
			return upd.Error
		}
		if upd.RowsAffected == 0 {
			return fmt.Errorf("%w: the booking changed meanwhile - reload and try again", ErrInvalidState)
		}
		b.Status = model.BookingNoShow
		if b.TotalAmount > 0 { // a free (voucher) hour earned no point to take back
			r, err := s.reversePoints(ctx, tx, b.UserID, 1, actorID, fmt.Sprintf("No-show %s %s (%s)", b.Date, b.StartTime, b.BookingCode), &b.ID)
			if err != nil {
				return err
			}
			rev = r
		}
		return tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: actorID, UserName: actorName,
			Action: "BOOKING_NO_SHOW", TargetType: "Booking", TargetID: b.ID,
			BeforeState: model.AuditJSON(map[string]any{"status": before}),
			AfterState: model.AuditJSON(map[string]any{"status": model.BookingNoShow, "points_reversed": rev.Taken,
				"vouchers_cancelled": rev.CancelledVouchers, "points_short": rev.Short}),
			CreatedAt: now,
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return &b, nil
}

// UndoNoShow puts a no-show back to CONFIRMED - the customer came after
// all (late) - and gives back the points the no-show took (rewards
// cancelled to cover them stay cancelled; their points are what is given
// back). Refused once the freed hour was sold again: a booking on the same
// or a conflicting court at that hour holds it. The minute job marks the
// hour COMPLETED again if it has already ended.
func (s *BookingService) UndoNoShow(ctx context.Context, bookingID, actorID, actorName string) (*UndoNoShowResult, error) {
	var peek model.Booking
	if err := s.db.WithContext(ctx).Select("id", "user_id", "court_id", "date").Take(&peek, "id = ?", bookingID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var court model.Court
	if err := s.db.WithContext(ctx).Take(&court, "id = ?", peek.CourtID).Error; err != nil {
		return nil, err
	}
	res := &UndoNoShowResult{}
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		*res = UndoNoShowResult{} // a retried attempt starts over
		// Lock order as a new booking: customer, the date's closure lock,
		// court group, then rows.
		if peek.UserID != "" && peek.UserID != model.WalkInUserID {
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("id").Take(&model.User{}, "id = ?", peek.UserID).Error; err != nil &&
				!errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
		}
		date := peek.Date
		if len(date) > 10 {
			date = date[:10]
		}
		if err := tx.Exec("SELECT pg_advisory_xact_lock_shared(?, hashtext(?))", closureLockClass, date).Error; err != nil {
			return err
		}
		group, err := s.bkRepo.LockCourtGroupTx(tx, court)
		if err != nil {
			return err
		}
		var b model.Booking
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&b, "id = ?", bookingID).Error; err != nil {
			return err
		}
		if len(b.Date) > 10 {
			b.Date = b.Date[:10]
		}
		if b.Status != model.BookingNoShow {
			return fmt.Errorf("%w: booking is %s, not a no-show", ErrInvalidState, b.Status)
		}
		// A closure made since the no-show (it didn't list this hour as
		// affected, nobody was holding it) - the hour can't come back.
		var closures []model.DayOff
		if err := tx.Where("date = ?", b.Date).Find(&closures).Error; err != nil {
			return err
		}
		closedCourts, err := repository.ClosureCourts(tx, closures)
		if err != nil {
			return err
		}
		if _, hour, err := hourSlotEnd(b.StartTime); err != nil {
			return err
		} else if closure := repository.ClosureFor(closures, court, closedCourts, hour); closure != nil {
			return fmt.Errorf("%w: %s is closed at %s (%s) - remove the closure first", ErrSlotUnavailable, court.Name, b.StartTime, closure.Reason)
		}
		if err := s.bkRepo.CheckOverlapTx(tx, court, group, b.Date, b.StartTime, b.EndTime); err != nil {
			if errors.Is(err, repository.ErrSlotTaken) {
				return fmt.Errorf("%w: the hour was already sold to another customer", repository.ErrSlotTaken)
			}
			return err
		}
		now := s.now()
		if err := tx.Model(&model.Booking{}).Where("id = ?", b.ID).
			Updates(map[string]interface{}{"status": model.BookingConfirmed, "updated_at": now}).Error; err != nil {
			return err
		}
		b.Status = model.BookingConfirmed
		// What the no-show mark(s) took and earlier undos haven't given back
		// (both write their note with this prefix on this booking).
		var net int
		if err := tx.Model(&model.PointsLedgerEntry{}).Select("COALESCE(SUM(points), 0)").
			Where("ref_type = ? AND ref_id = ? AND note LIKE ?", "Booking", b.ID, "No-show%").Scan(&net).Error; err != nil {
			return err
		}
		if give := -net; give > 0 {
			refType, note := "Booking", fmt.Sprintf("No-show undone %s %s (%s)", b.Date, b.StartTime, b.BookingCode)
			if _, err := s.usrRepo.AddPointsEntry(ctx, tx, b.UserID, model.LedgerEarnBooking, give, actorID, &refType, &b.ID, &note); err != nil {
				return err
			}
			res.PointsRestored = give
		}
		res.Booking = b
		return tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: actorID, UserName: actorName,
			Action: "BOOKING_NO_SHOW_UNDONE", TargetType: "Booking", TargetID: b.ID,
			BeforeState: model.AuditJSON(map[string]any{"status": model.BookingNoShow}),
			AfterState:  model.AuditJSON(map[string]any{"status": model.BookingConfirmed, "points_restored": res.PointsRestored}),
			CreatedAt:   now,
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// UndoNoShowResult is the restored booking and the points given back.
type UndoNoShowResult struct {
	Booking        model.Booking `json:"booking"`
	PointsRestored int           `json:"points_restored"`
}

// DismissRefundCheck closes a refund waiting for a bank check when the
// manager found no money from this customer in the account - nothing to
// refund. Audit-logged with the reason.
func (s *BookingService) DismissRefundCheck(ctx context.Context, paymentID, reason, actorID, actorName string) (*model.Payment, error) {
	reason = strings.TrimSpace(reason)
	if err := checkText("reason", reason); err != nil {
		return nil, err
	}
	if reason == "" {
		return nil, fmt.Errorf("%w: a reason is required", ErrInvalidBooking)
	}
	var p model.Payment
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&p, "id = ?", paymentID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		if !p.RefundCheckPending {
			return fmt.Errorf("%w: this payment has no refund waiting for a check", ErrInvalidState)
		}
		now := s.now()
		if err := tx.Model(&p).Updates(map[string]interface{}{"refund_check_pending": false, "updated_at": now}).Error; err != nil {
			return err
		}
		p.RefundCheckPending = false
		return tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: actorID, UserName: actorName,
			Action: "REFUND_NOT_NEEDED", TargetType: "Payment", TargetID: p.ID,
			BeforeState: model.AuditJSON(map[string]any{"refund_check_pending": true}),
			AfterState:  model.AuditJSON(map[string]any{"refund_check_pending": false}),
			Reason:      &reason, CreatedAt: now,
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// CompleteFinishedBookings marks confirmed hours whose end has passed
// (Bangkok time) as COMPLETED. main runs it every minute.
func (s *BookingService) CompleteFinishedBookings(ctx context.Context) (int64, error) {
	now := s.now().In(Bangkok)
	today, clock := now.Format("2006-01-02"), now.Format("15:04")
	res := s.db.WithContext(ctx).Model(&model.Booking{}).
		Where("status = ? AND (date < ? OR (date = ? AND end_time <= ?))", model.BookingConfirmed, today, today, clock).
		Updates(map[string]interface{}{"status": model.BookingCompleted, "updated_at": s.now()})
	return res.RowsAffected, res.Error
}

// DaySummary is what the counter's cash-drawer report needs from bookings
// for one day (Bangkok): money received, by method, and refunds recorded.
type DaySummary struct {
	Date              string  `json:"date"`
	CashReceived      float64 `json:"cash_received"`
	PromptPayVerified float64 `json:"promptpay_verified"`
	// Refunds recorded that day of money counted as received (an approved
	// payment), split by how it was paid; Refunded is their sum.
	Refunded          float64 `json:"refunded"`
	RefundedCash      float64 `json:"refunded_cash"`
	RefundedPromptPay float64 `json:"refunded_promptpay"`
	// Refunds of transfers that were never approved (e.g. a waiting slip
	// cancelled with a refund): not in the received totals, so not in
	// Refunded either.
	RefundedNotReceived float64 `json:"refunded_not_received"`
	PaidBookings        int64   `json:"paid_bookings"`
}

// Summary totals payments approved on date by method (cash goes in the
// drawer) and refunds recorded that day.
func (s *BookingService) Summary(ctx context.Context, date string) (*DaySummary, error) {
	from, to, err := BangkokDay(date)
	if err != nil {
		return nil, err
	}
	out := &DaySummary{Date: date}
	db := s.db.WithContext(ctx)
	sum := func(method model.PaymentMethod) (float64, error) {
		var v float64
		err := db.Model(&model.Payment{}).Select("COALESCE(SUM(amount), 0)").
			Where("method = ? AND verified_at >= ? AND verified_at < ? AND status IN ?", method, from, to,
				[]model.PaymentStatus{model.PaymentVerified, model.PaymentRefunded}).
			Scan(&v).Error
		return v, err
	}
	if out.CashReceived, err = sum(model.PaymentCash); err != nil {
		return nil, err
	}
	if out.PromptPayVerified, err = sum(model.PaymentPromptPay); err != nil {
		return nil, err
	}
	var refunds []struct {
		Method   model.PaymentMethod
		Received bool
		Total    float64
	}
	if err := db.Table("refunds r").Joins("JOIN payments p ON p.id = r.payment_id").
		Select("p.method AS method, p.verified_at IS NOT NULL AS received, COALESCE(SUM(r.amount), 0) AS total").
		Where("r.refunded_at >= ? AND r.refunded_at < ?", from, to).
		Group("p.method, p.verified_at IS NOT NULL").Scan(&refunds).Error; err != nil {
		return nil, err
	}
	for _, r := range refunds {
		switch {
		case !r.Received:
			out.RefundedNotReceived += r.Total
		case r.Method == model.PaymentCash:
			out.RefundedCash += r.Total
		default:
			out.RefundedPromptPay += r.Total
		}
	}
	out.RefundedCash, out.RefundedPromptPay = RoundBaht(out.RefundedCash), RoundBaht(out.RefundedPromptPay)
	out.RefundedNotReceived = RoundBaht(out.RefundedNotReceived)
	out.Refunded = out.RefundedCash + out.RefundedPromptPay
	if err := db.Model(&model.Booking{}).Where("date = ? AND status IN ?", date, paidStatuses).Count(&out.PaidBookings).Error; err != nil {
		return nil, err
	}
	out.CashReceived, out.PromptPayVerified, out.Refunded = RoundBaht(out.CashReceived), RoundBaht(out.PromptPayVerified), RoundBaht(out.Refunded)
	return out, nil
}
