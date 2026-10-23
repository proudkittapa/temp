import {
  Booking, BookingStatus, Payment, PaymentStatus,
  PaymentMethod, MemberType, LedgerEntryType, PointsLedgerEntry
} from '../../types';
import { StorageService, calculatePrice, findConflictingBooking, bookingGroupOf, generatePromptPayPayload, LOCAL_PROMPTPAY_ID, formatBaht, roundBaht, resalePrice, noShowOpenAt, slotTiming } from '../../mockData';
import * as api from '../../api';
import { notify, ask, dialog } from '../Dialog';
import type { StaffPOSCore } from './useStaffPOS';
import { LocalVoucher, planPointsCover, applyPointsCover } from './shared';
import type { useShiftActions } from './shiftActions';

// Actions on one booking from its detail dialog: cancel/refund, cash payment, no-show and its undo.
export function useBookingActions(deps: StaffPOSCore & ReturnType<typeof useShiftActions>) {
  const {
    bookingPool,
    closeBookingDetail,
    confirmCashWithoutShift,
    courts,
    onAddAuditLog,
    onRefreshAll,
    payments
  } = deps;
  const handleCancelBooking = async (booking: Booking) => {
    const allBookings = bookingPool();
    const group = bookingGroupOf(booking, allBookings).filter(b => b.status === BookingStatus.PENDING_PAYMENT || b.status === BookingStatus.CONFIRMED);
    // A slip waiting for review means the customer has (probably) sent the
    // money for the unpaid hours too, so their refund is offered as well.
    const groupIdSet = new Set(bookingGroupOf(booking, allBookings).map(b => b.id));
    const payStatus = api.USE_BACKEND ? booking.paymentStatus : payments.find(p => groupIdSet.has(p.bookingId))?.status;
    const slipIn = payStatus === PaymentStatus.SLIP_UPLOADED;
    const paidOf = (list: Booking[]) => roundBaht(list.filter(b => b.status === BookingStatus.CONFIRMED || (slipIn && b.status === BookingStatus.PENDING_PAYMENT))
      .reduce((s, b) => s + b.totalAmount, 0));
    const groupPaid = paidOf(group), hourPaid = paidOf([booking]);
    // One dialog: reason, which hours, and whether a refund is recorded.
    // Nothing to refund on a free (voucher) hour - the voucher is given back instead.
    const answer = await dialog({
      title: `ยกเลิกการจอง ${booking.bookingCode}`,
      // Allowed after the hour has started (owner 2026-10-23), with a
      // warning - the server records it in the audit log.
      message: `${booking.date} ${booking.startTime}-${booking.endTime} · ${booking.userName}${group.some(b => slotTiming(b.date, b.startTime).started) ? '\n⚠️ มีชั่วโมงที่เริ่มเล่นไปแล้ว — การยกเลิกนี้จะถูกบันทึกในประวัติการตรวจสอบ (Audit Log)' : ''}`,
      input: { label: 'เหตุผล (จำเป็น - บันทึกใน Audit Log)', required: true },
      choices: group.length > 1 ? [
        { value: 'all', label: `ยกเลิกทั้งหมด ${group.length} ชั่วโมง` },
        { value: 'one', label: `ยกเลิกเฉพาะ ${booking.startTime}-${booking.endTime}` }
      ] : undefined,
      checkbox: groupPaid > 0 ? {
        label: `บันทึกว่าคืนเงินค่าสนามที่${slipIn ? 'ลูกค้าโอนมา — สลิปยังไม่ได้อนุมัติ: ติ๊กเมื่อตรวจแล้วว่าเงินเข้าบัญชีจริง' : 'ชำระแล้ว'} (โอนคืนลูกค้าเอง) — ${group.length > 1 ? `ทั้งหมด ${formatBaht(groupPaid)} / ชั่วโมงนี้ ${formatBaht(hourPaid)}` : formatBaht(groupPaid)} บาท`,
        // Ticking it for a slip nobody approved says "I checked the bank
        // account" (sent as bank_checked) - so it starts unticked then.
        defaultChecked: !slipIn
      } : undefined,
      okLabel: 'ยืนยันยกเลิก',
      cancelLabel: 'ไม่ยกเลิก',
      danger: true
    });
    if (!answer) return;
    const reason = answer.text.trim();
    const wholeGroup = group.length <= 1 || answer.choice === 'all';
    const target = wholeGroup ? group : [booking];
    const refund = answer.checked && paidOf(target) > 0;

    if (api.USE_BACKEND) {
      // Ticking the box for a slip still waiting is the manager's word that
      // the transfer is in the bank account (the server requires it).
      return api.cancelBooking(booking.id, reason, refund, wholeGroup ? undefined : [booking.id], 'staff', refund && slipIn)
        .then(res => {
          onAddAuditLog('BOOKING_CANCELLED_BY_MANAGER', 'Booking', booking.id, null, { ...res, reason });
          closeBookingDetail();
          onRefreshAll();
          notify(`ยกเลิก ${res.cancelled} ชั่วโมงแล้ว${res.refundAmount ? ` · บันทึกคืนเงิน ${formatBaht(res.refundAmount)} บาท` : ''}${res.pointsReversed ? ` · หักแต้มคืน ${res.pointsReversed}` : ''}${res.cancelledVouchers.length ? `\nยกเลิกคูปองที่แลกด้วยแต้มนี้: ${res.cancelledVouchers.join(', ')}` : ''}${res.pointsShort ? `\n⚠️ ลูกค้าใช้แต้ม ${res.pointsShort} แต้มแลกของรางวัลที่รับไปแล้ว หักคืนไม่ได้` : ''}${res.refundNeedsCheck ? '\n⚠️ ยังไม่บันทึกคืนเงิน: สลิปยังไม่ได้อนุมัติ — ตรวจยอดในบัญชีก่อน แล้วคืนเงินที่หน้าเคาน์เตอร์ แท็บ "อนุมัติ Slip โอน" → รอตรวจยอดก่อนคืนเงิน' : ''}`);
        })
        .catch(err => notify(`ยกเลิกไม่สำเร็จ: ${err.message}`));
    }

    // Browser-only mode: same rules on localStorage.
    const ids = new Set(target.map(b => b.id));
    const paidRows = target.filter(b => b.status === BookingStatus.CONFIRMED);
    const refundAmount = paidOf(target);
    StorageService.set('bookings', allBookings.map(b => ids.has(b.id)
      ? { ...b, status: BookingStatus.CANCELLED, cancellationReason: `ยกเลิกโดยผู้จัดการ: ${reason}` } : b));
    const groupIds = new Set(bookingGroupOf(booking, allBookings).map(b => b.id));
    const remaining = group.length - target.length;
    StorageService.set('payments', StorageService.get<Payment[]>('payments', []).map(p => {
      if (!groupIds.has(p.bookingId)) return p;
      if (refund) {
        const total = roundBaht((p.refundAmount || 0) + refundAmount);
        // A refunded waiting slip can't be approved any more; with nothing
        // left standing the payment is closed as refunded.
        const at = new Date().toISOString();
        return { ...p, refundAmount: total, refundReason: reason, refundedAt: at, refundedBy: 'manager',
          refunds: [...(p.refunds || []), { amount: refundAmount, at }],
          status: total >= p.amount || remaining === 0 ? PaymentStatus.REFUNDED : p.status };
      }
      if (remaining === 0 && (p.status === PaymentStatus.PENDING || p.status === PaymentStatus.SLIP_UPLOADED)) {
        return { ...p, status: PaymentStatus.REJECTED, refundReason: reason };
      }
      // Some hours of an unpaid group: the customer now owes less, with a
      // QR for the new amount (as the server does).
      if (remaining > 0 && (p.status === PaymentStatus.PENDING || p.status === PaymentStatus.EXPIRED)) {
        const amount = roundBaht(p.amount - target.reduce((n, b) => n + b.totalAmount, 0));
        return { ...p, amount, qrPayload: generatePromptPayPayload(LOCAL_PROMPTPAY_ID, amount) };
      }
      return p;
    }));
    // A cancelled voucher hour hands the voucher back to the customer.
    StorageService.set('redemptions', StorageService.get<LocalVoucher[]>('redemptions', []).map(r => r.bookingId && ids.has(r.bookingId)
      ? { ...r, status: 'ACTIVE', dispensedAt: undefined, bookingId: undefined } : r));
    const paidPointRows = paidRows.filter(b => b.totalAmount > 0);
    // As the server's reversePoints: unused rewards bought with these points
    // are cancelled to cover them; what still can't be covered is reported.
    const cover = paidPointRows.length ? planPointsCover(booking.userId, paidPointRows.length) : { cancel: [], short: 0 };
    const coverCodes = applyPointsCover(booking.userId, cover.cancel, `${booking.bookingCode} cancelled`, 'manager');
    const reversed = paidPointRows.length ? StorageService.addLedgerEntry(booking.userId, LedgerEntryType.REVERSE_BOOKING, -paidPointRows.length, 'manager', { note: `${paidPointRows.length}h of ${booking.bookingCode} cancelled: ${reason}` }) : 0;
    onAddAuditLog('BOOKING_CANCELLED_BY_MANAGER', 'Booking', booking.id, null, { cancelled: target.length, refund, refundAmount: refund ? refundAmount : 0, reason });
    closeBookingDetail();
    onRefreshAll();
    notify(`ยกเลิก ${target.length} ชั่วโมงแล้ว${refund ? ` · บันทึกคืนเงิน ${formatBaht(refundAmount)} บาท` : ''}${reversed ? ` · หักแต้มคืน ${-reversed}` : ''}${coverCodes.length ? `\nยกเลิกคูปองที่แลกด้วยแต้มนี้: ${coverCodes.join(', ')}` : ''}${cover.short ? `\n⚠️ ลูกค้าใช้แต้ม ${cover.short} แต้มแลกของรางวัลที่รับไปแล้ว หักคืนไม่ได้` : ''}`);
  };

  // Manager/admin: the customer paid this unpaid booking in cash at the
  // counter - confirms it like an approved slip (counted in the cash drawer).
  const handleMarkPaidInCash = async (booking: Booking) => {
    if (!(await confirmCashWithoutShift())) return;
    if (!(await ask(`ยืนยันว่าได้รับเงินสดสำหรับการจอง ${booking.bookingCode} แล้ว?`, { okLabel: 'ได้รับเงินสดแล้ว' }))) return;
    const done = (count: number, pts: number) => {
      onAddAuditLog('PAID_IN_CASH_RECORDED', 'Booking', booking.id, null, { bookingCode: booking.bookingCode });
      closeBookingDetail();
      onRefreshAll();
      notify(`บันทึกรับเงินสดแล้ว ยืนยัน ${count} ชั่วโมง${pts ? ` (+${pts} แต้ม)` : ''}`);
    };
    if (api.USE_BACKEND) {
      return api.markBookingPaidInCash(booking.id)
        .then(res => done(res.bookingsCount, res.pointsAwarded))
        .catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }
    const allBookings = StorageService.get<Booking[]>('bookings', []);
    const group = bookingGroupOf(booking, allBookings);
    const groupIds = new Set(group.map(b => b.id));
    const groupPay = StorageService.get<Payment[]>('payments', []).find(p => groupIds.has(p.bookingId));
    // As on the server: a waiting slip is approved or rejected instead, and
    // a payment with a refund can't turn into cash (it would over-count the
    // drawer).
    if (groupPay?.status === PaymentStatus.SLIP_UPLOADED) {
      notify('มีสลิปรอตรวจอยู่ — อนุมัติหรือปฏิเสธสลิปที่แท็บอนุมัติสลิปแทน');
      return;
    }
    if (groupPay && (![PaymentStatus.PENDING, PaymentStatus.EXPIRED].includes(groupPay.status) || (groupPay.refundAmount || 0) > 0)) {
      notify(`การชำระเงินของรายการนี้ถูกดำเนินการไปแล้ว (${groupPay.status})`);
      onRefreshAll();
      return;
    }
    const pending = group.filter(b => b.status === BookingStatus.PENDING_PAYMENT);
    const pendingIds = new Set(pending.map(b => b.id));
    StorageService.set('bookings', allBookings.map(b => pendingIds.has(b.id) ? { ...b, status: BookingStatus.CONFIRMED } : b));
    StorageService.set('payments', StorageService.get<Payment[]>('payments', []).map(p => groupIds.has(p.bookingId)
      ? { ...p, method: PaymentMethod.CASH, status: PaymentStatus.VERIFIED, verifiedAt: new Date().toISOString(), verifiedBy: 'manager' } : p));
    const pts = pending.length ? StorageService.addPointsHour(booking.userId, pending.length) : 0;
    done(pending.length, pts);
  };

  // Any staff: the customer didn't come for this (already started) hour.
  // The hour's loyalty point is taken back; the payment is kept.
  const handleMarkNoShow = async (booking: Booking) => {
    if (Date.now() < noShowOpenAt(booking.date, booking.startTime).getTime()) {
      notify('ยังบันทึก "ไม่มา" ไม่ได้ — รอให้เลยเวลาเริ่มตามที่กำหนดก่อน');
      return;
    }
    const court = courts.find(c => c.id === booking.courtId);
    // The price the freed hour will sell at (a walk-in, non-member).
    const resale = court ? resalePrice(court, booking.date, booking.startTime, [{ ...booking, status: BookingStatus.NO_SHOW }], courts,
      calculatePrice(court.type, booking.date, booking.startTime, MemberType.NORMAL, court).total) : undefined;
    if (!(await ask(`บันทึกว่าลูกค้าไม่มาใช้สนาม ${booking.startTime}-${booking.endTime} (${booking.bookingCode})?\nไม่คืนเงิน · สนามจะว่างให้ขายต่อ${resale !== undefined ? ` ราคาพิเศษ ${formatBaht(resale)} บาท` : ''}`, { okLabel: 'บันทึกไม่มา' }))) return;
    const done = () => {
      onAddAuditLog('BOOKING_NO_SHOW', 'Booking', booking.id, { status: booking.status }, { status: BookingStatus.NO_SHOW });
      closeBookingDetail();
      onRefreshAll();
      notify(`บันทึกไม่มาแล้ว — ${court?.name ?? 'สนาม'} ${booking.startTime} ว่างแล้ว ขายต่อได้${resale !== undefined ? ` ราคา ${formatBaht(resale)} บาท` : ''}`);
    };
    if (api.USE_BACKEND) {
      return api.markNoShow(booking.id).then(done).catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }
    // Re-read: the screen's copy may be stale, and marking twice would take
    // the point back twice (the server refuses a second mark).
    const stored = StorageService.get<Booking[]>('bookings', []);
    const current = stored.find(b => b.id === booking.id)?.status;
    if (current !== BookingStatus.CONFIRMED && current !== BookingStatus.COMPLETED) {
      notify('บันทึกไม่สำเร็จ: การจองนี้ไม่ได้อยู่ในสถานะยืนยันแล้ว');
      closeBookingDetail();
      onRefreshAll();
      return;
    }
    StorageService.set('bookings', stored.map(b => b.id === booking.id ? { ...b, status: BookingStatus.NO_SHOW } : b));
    if (booking.totalAmount > 0) { // a free (voucher) hour earned no point to take back
      applyPointsCover(booking.userId, planPointsCover(booking.userId, 1).cancel, `no-show ${booking.bookingCode}`, 'staff');
      StorageService.addLedgerEntry(booking.userId, LedgerEntryType.REVERSE_BOOKING, -1, 'staff', { refType: 'Booking', refId: booking.id, note: `No-show ${booking.date} ${booking.startTime}` });
    }
    done();
  };

  // Any staff: the customer marked as a no-show came after all (late). The
  // booking is confirmed again and its points come back - unless the freed
  // hour was already sold to someone else.
  const handleUndoNoShow = async (booking: Booking) => {
    if (!(await ask(`ลูกค้ามาใช้สนามแล้ว — ยกเลิกการบันทึก "ไม่มา" ของ ${booking.startTime}-${booking.endTime} (${booking.bookingCode})?\nการจองกลับเป็นยืนยันแล้ว และคืนแต้มที่หักไป (ทำไม่ได้ถ้าขายชั่วโมงนี้ให้คนอื่นไปแล้ว)`, { okLabel: 'ลูกค้ามาแล้ว' }))) return;
    const done = (points: number) => {
      onAddAuditLog('BOOKING_NO_SHOW_UNDONE', 'Booking', booking.id, { status: BookingStatus.NO_SHOW }, { status: BookingStatus.CONFIRMED, pointsRestored: points });
      closeBookingDetail();
      onRefreshAll();
      notify(`ยกเลิก "ไม่มา" แล้ว — การจองกลับเป็นยืนยันแล้ว${points > 0 ? ` · คืนแต้ม ${points} แต้ม` : ''}`);
    };
    if (api.USE_BACKEND) {
      return api.undoNoShow(booking.id).then(r => done(r.pointsRestored)).catch(err => notify(`ยกเลิกไม่สำเร็จ: ${err.message}`));
    }
    const stored = StorageService.get<Booking[]>('bookings', []);
    if (stored.find(b => b.id === booking.id)?.status !== BookingStatus.NO_SHOW) {
      notify('ยกเลิกไม่สำเร็จ: การจองนี้ไม่ได้อยู่ในสถานะ "ไม่มา" แล้ว');
      closeBookingDetail();
      onRefreshAll();
      return;
    }
    if (findConflictingBooking(booking.courtId, booking.date, booking.startTime, stored, courts)) {
      notify('ยกเลิกไม่สำเร็จ: ชั่วโมงนี้ขายให้ลูกค้าคนอื่นไปแล้ว');
      return;
    }
    StorageService.set('bookings', stored.map(b => b.id === booking.id ? { ...b, status: BookingStatus.CONFIRMED } : b));
    // What the no-show mark(s) took and earlier undos haven't given back.
    const net = StorageService.get<PointsLedgerEntry[]>('points_ledger', [])
      .filter(e => e.refId === booking.id && e.note?.startsWith('No-show'))
      .reduce((n, e) => n + e.points, 0);
    const given = -net > 0 ? StorageService.addLedgerEntry(booking.userId, LedgerEntryType.EARN_BOOKING, -net, 'staff',
      { refType: 'Booking', refId: booking.id, note: `No-show undone ${booking.date} ${booking.startTime}` }) : 0;
    done(given);
  };
  return {
    handleCancelBooking,
    handleMarkPaidInCash,
    handleMarkNoShow,
    handleUndoNoShow
  };
}
