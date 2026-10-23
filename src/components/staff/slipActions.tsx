import { Booking, BookingStatus, Payment, PaymentStatus } from '../../types';
import { StorageService, bookingGroupOf, formatBaht, roundBaht, isPaidBooking } from '../../mockData';
import * as api from '../../api';
import { notify, askText, ask } from '../Dialog';
import type { StaffPOSCore } from './useStaffPOS';
import { askRefundMethod } from './shared';


// Slip review queue: approve, reject, refund a payment.
export function useSlipActions(deps: StaffPOSCore) {
  const {
    courts,
    onAddAuditLog,
    onRefreshAll,
    pushLineMessage,
    rejectReason,
    reviewQueue,
    setRejectId,
    setRejectReason,
    shift,
    slipVersionShown
  } = deps;
  // Phase 1 CORE: Approve Bank Slips (Slip Verification). Also confirms a
  // PromptPay walk-in once staff see the transfer arrive. Resolves to
  // whether it succeeded.
  const handleVerifySlip = (paymentId: string): Promise<boolean> => {
    if (api.USE_BACKEND) {
      const entry = reviewQueue.find(r => r.payment.id === paymentId);
      // Send the slip version staff were shown, so the server refuses the
      // approval if the customer swapped the slip in the meantime.
      return api.verifyPayment(paymentId, slipVersionShown(paymentId))
        .then(res => {
          if (entry) {
            // One line per booked hour: a group can span courts and
            // non-adjacent hours, so a single "first start - last end"
            // range would misreport it.
            const lines = entry.bookings.map(b => {
              const courtName = courts.find(c => c.id === b.courtId)?.name || 'สนามกีฬาทั่วไป';
              return `- ${courtName} ${b.date} ${b.startTime}–${b.endTime}`;
            }).join('\n');
            const ptsNote = res.pointsAwarded > 0 ? `\n🎁 และได้รับแต้มสะสมเพิ่ม: +${res.pointsAwarded} แต้ม!` : '';
            pushLineMessage(entry.bookings[0]?.userPhone || '', `🎉 ยืนยันการจองแล้ว!\n📋 ${res.bookingCode}\n${lines}\nพบกันที่สนาม!${ptsNote}`, "CONFIRMED");
          }
          onAddAuditLog('SLIP_VERIFIED_BY_STAFF', 'Payment', paymentId, { status: entry?.payment.status ?? PaymentStatus.PENDING }, { status: PaymentStatus.VERIFIED });
          onRefreshAll();
          notify(`ยืนยันเรียบร้อยแล้ว! อนุมัติ ${res.bookingsCount} สล็อต ${res.pointsAwarded > 0 ? `(🎁 มอบคะแนนสะสมสมาชิก +${res.pointsAwarded} แต้ม)` : ''}`);
          return true;
        })
        .catch(err => {
          notify(`อนุมัติไม่สำเร็จ: ${err.message}`);
          onRefreshAll();
          return false;
        });
    }

    const allPayments = StorageService.get<Payment[]>('payments', []);
    const allBookings = StorageService.get<Booking[]>('bookings', []);

    const paymentObj = allPayments.find(p => p.id === paymentId);
    if (!paymentObj) return Promise.resolve(false);
    if (paymentObj.status !== PaymentStatus.SLIP_UPLOADED && paymentObj.status !== PaymentStatus.PENDING) {
      notify(`รายการนี้ถูกดำเนินการไปแล้ว (${paymentObj.status})`);
      onRefreshAll();
      return Promise.resolve(false);
    }
    // After a partial refund, what is left of the payment must still pay
    // for the hours that stand (as on the server).
    const rootForCheck = allBookings.find(b => b.id === paymentObj.bookingId);
    const standing = rootForCheck ? bookingGroupOf(rootForCheck, allBookings)
      .filter(b => b.status === BookingStatus.PENDING_PAYMENT || isPaidBooking(b)).reduce((n, b) => n + b.totalAmount, 0) : 0;
    if ((paymentObj.refundAmount || 0) > 0 && roundBaht(paymentObj.amount - (paymentObj.refundAmount || 0)) < roundBaht(standing)) {
      notify('เงินที่เหลือหลังคืนเงินไม่พอสำหรับชั่วโมงที่ยังจองอยู่ อนุมัติไม่ได้');
      return Promise.resolve(false);
    }

    const updatedPayments = allPayments.map(p => {
      if (p.id === paymentId) {
        return {
          ...p,
          status: PaymentStatus.VERIFIED,
          verifiedAt: new Date().toISOString(),
          verifiedBy: 'u-staff-1' // Current mock staff
        };
      }
      return p;
    });

    // The payment covers the whole booking group (up to 3 hours), so every
    // hour still awaiting payment is confirmed - not just the row the
    // payment hangs off - and points are awarded for exactly those hours
    // (FR-4.1: 1 point per hour), as the backend does.
    const rootBooking = allBookings.find(b => b.id === paymentObj.bookingId);
    const toConfirm = rootBooking
      ? bookingGroupOf(rootBooking, allBookings).filter(b => b.status === BookingStatus.PENDING_PAYMENT)
      : [];
    const confirmIds = new Set(toConfirm.map(b => b.id));

    let ptsAdded = 0;
    if (rootBooking && rootBooking.userId && toConfirm.length > 0) {
      ptsAdded = StorageService.addPointsHour(rootBooking.userId, toConfirm.length);
    }

    if (rootBooking && toConfirm.length > 0) {
      const lines = toConfirm.map(b => {
        const courtName = courts.find(c => c.id === b.courtId)?.name || 'สนามกีฬาทั่วไป';
        return `- ${courtName} ${b.date} ${b.startTime}–${b.endTime}`;
      }).join('\n');
      const ptsNote = ptsAdded > 0 ? `\n🎁 และได้รับแต้มสะสมเพิ่ม: +${ptsAdded} แต้ม!` : '';
      pushLineMessage(rootBooking.userPhone, `🎉 ยืนยันการจองแล้ว!\n📋 ${rootBooking.bookingCode}\n${lines}\nพบกันที่สนาม!${ptsNote}`, "CONFIRMED");
    }

    const updatedBookings = allBookings.map(b =>
      confirmIds.has(b.id) ? { ...b, status: BookingStatus.CONFIRMED } : b
    );

    StorageService.set('payments', updatedPayments);
    StorageService.set('bookings', updatedBookings);

    onAddAuditLog('SLIP_VERIFIED_BY_STAFF', 'Payment', paymentId, { status: paymentObj.status }, { status: PaymentStatus.VERIFIED });
    
    onRefreshAll();
    notify(`ยืนยันความถูกต้องเรียบร้อยแล้ว! อนุมัติ ${toConfirm.length} สล็อตและส่งไลน์ไปแจ้งเรียบร้อย ${ptsAdded > 0 ? `(🎁 มอบคะแนนสะสมสมาชิก +${ptsAdded} แต้ม)` : ''}`);
    return Promise.resolve(true);
  };

  // Phase 1 CORE: Reject Fraud Bank Slips (or cancel an unpaid walk-in).
  // Resolves to whether it succeeded.
  const handleRejectSlip = (paymentId: string, reason: string = rejectReason): Promise<boolean> => {
    if (!reason) {
      notify('กรุณากรอกสาเหตุการปฎิเสธสลิปด้วยค่ะ');
      return Promise.resolve(false);
    }

    if (api.USE_BACKEND) {
      const entry = reviewQueue.find(r => r.payment.id === paymentId);
      return api.rejectPayment(paymentId, reason, slipVersionShown(paymentId))
        .then(res => {
          if (entry) {
            pushLineMessage(entry.bookings[0]?.userPhone || '', `❌ การจองถูกยกเลิกเนื่องจากตรวจสอบความถูกต้องสลิปไม่ผ่าน\nรหัส: ${res.bookingCode}\nเหตุผล: ${reason}\nหากมีข้อสงสัยติดต่อ LINE OA ได้นะคะ`, "CANCELLED");
          }
          onAddAuditLog('SLIP_REJECTED_BY_STAFF', 'Payment', paymentId, { status: entry?.payment.status ?? PaymentStatus.PENDING }, { status: PaymentStatus.REJECTED, reason });
          setRejectId(null);
          setRejectReason('');
          onRefreshAll();
          notify('ปฏิเสธรายการแล้ว ระบบยกเลิกเวลาที่จองไว้แล้ว');
          return true;
        })
        .catch(err => {
          notify(`ปฏิเสธไม่สำเร็จ: ${err.message}`);
          onRefreshAll();
          return false;
        });
    }

    const allPayments = StorageService.get<Payment[]>('payments', []);
    const allBookings = StorageService.get<Booking[]>('bookings', []);

    const paymentObj = allPayments.find(p => p.id === paymentId);
    if (!paymentObj) return Promise.resolve(false);
    if (paymentObj.status !== PaymentStatus.SLIP_UPLOADED && paymentObj.status !== PaymentStatus.PENDING) {
      notify(`รายการนี้ถูกดำเนินการไปแล้ว (${paymentObj.status})`);
      onRefreshAll();
      return Promise.resolve(false);
    }

    const updatedPayments = allPayments.map(p => {
      if (p.id === paymentId) {
        return { ...p, status: PaymentStatus.REJECTED, refundReason: reason };
      }
      return p;
    });

    // Cancel every hour of the group still awaiting payment, so none of
    // them is left pending - and blocking its slot - forever.
    const rootBooking = allBookings.find(b => b.id === paymentObj.bookingId);
    const cancelIds = new Set(
      (rootBooking ? bookingGroupOf(rootBooking, allBookings) : [])
        .filter(b => b.status === BookingStatus.PENDING_PAYMENT)
        .map(b => b.id)
    );
    if (rootBooking) {
      const rejectMsg = `❌ การจองถูกยกเลิกเนื่องจากตรวจสอบความถูกต้องสลิปไม่ผ่าน\nรหัส: ${rootBooking.bookingCode}\nเหตุผล: ${reason}\nหากมีข้อสงสัยติดต่อ LINE OA ได้นะคะ`;
      pushLineMessage(rootBooking.userPhone, rejectMsg, "CANCELLED");
    }

    const updatedBookings = allBookings.map(b =>
      cancelIds.has(b.id)
        ? { ...b, status: BookingStatus.CANCELLED, cancellationReason: `สลิปไม่ผ่านเกณฑ์: ${reason}` }
        : b
    );

    StorageService.set('payments', updatedPayments);
    StorageService.set('bookings', updatedBookings);

    onAddAuditLog('SLIP_REJECTED_BY_STAFF', 'Payment', paymentId, { status: paymentObj.status }, { status: PaymentStatus.REJECTED, reason });
    
    setRejectId(null);
    setRejectReason('');
    onRefreshAll();
    notify('ปฏิเสธรายการแล้ว ระบบยกเลิกเวลาที่จองไว้แล้ว');
    return Promise.resolve(true);
  };

  // Manager/admin refund of a payment with no booking standing for it -
  // e.g. a late payment whose slot was taken meanwhile.
  // Manager: the bank account shows no transfer from this customer, so a
  // refund that was waiting for that check is closed with nothing refunded.
  const handleDismissRefundCheck = async (pay: Payment) => {
    const reason = await askText('ตรวจแล้วไม่พบเงินโอนเข้าบัญชีจากลูกค้ารายนี้ — เหตุผล (จำเป็น):', { title: 'ไม่ต้องคืนเงิน', okLabel: 'บันทึก ไม่ต้องคืน' });
    if (!reason) return;
    return api.dismissRefundCheck(pay.id, reason)
      .then(() => {
        onAddAuditLog('REFUND_NOT_NEEDED', 'Payment', pay.id, null, { reason });
        onRefreshAll();
        notify('บันทึกแล้ว: ไม่มีเงินเข้า ไม่ต้องคืน');
      })
      .catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
  };

  const handleRefundPayment = async (pay: Payment) => {
    const reason = await askText(`เหตุผลการคืนเงิน ${formatBaht(pay.amount - (pay.refundAmount || 0))} บาท (จำเป็น):`, { title: '💸 คืนเงิน', okLabel: 'บันทึกคืนเงิน' });
    if (!reason) return;
    // A slip nobody approved proves nothing: the manager confirms the
    // transfer is really in the bank account (the server requires it;
    // browser-only mode asks the same).
    const bankChecked = pay.status !== PaymentStatus.VERIFIED;
    if (bankChecked && !(await ask('สลิปนี้ยังไม่เคยได้รับอนุมัติ — ตรวจในบัญชีธนาคารแล้วว่าเงินโอนเข้ามาจริง?', { title: '💸 ยืนยันยอดเงินเข้า', okLabel: 'ตรวจแล้ว เงินเข้าจริง', cancelLabel: 'ยังไม่ได้ตรวจ' }))) return;
    // Transfer or cash from the drawer (cash needs an open shift; the
    // server checks it too).
    const refundMethod = await askRefundMethod(formatBaht(pay.amount - (pay.refundAmount || 0)));
    if (!refundMethod) return;
    if (refundMethod === 'CASH' && !shift && !api.USE_BACKEND) { notify('ต้องเปิดกะลิ้นชักก่อนจ่ายเงินสด'); return; }
    if (api.USE_BACKEND) {
      return api.refundPayment(pay.id, reason, undefined, bankChecked, refundMethod)
        .then(p => {
          onAddAuditLog('PAYMENT_REFUNDED', 'Payment', pay.id, null, { refundAmount: p.refundAmount, reason });
          onRefreshAll();
          notify(`บันทึกคืนเงิน ${formatBaht(p.refundAmount || 0)} บาทแล้ว`);
        })
        .catch(err => notify(`คืนเงินไม่สำเร็จ: ${err.message}`));
    }
    const allBookings = StorageService.get<Booking[]>('bookings', []);
    const root = allBookings.find(b => b.id === pay.bookingId);
    const group = root ? bookingGroupOf(root, allBookings) : [];
    const groupIds = new Set(group.map(b => b.id));
    // As on the server: only what no standing (paid) hour still pays for.
    const kept = group.filter(isPaidBooking).reduce((n, b) => n + b.totalAmount, 0);
    const amount = roundBaht(pay.amount - (pay.refundAmount || 0) - kept);
    if (amount <= 0) { notify('ไม่มียอดให้คืน — ชั่วโมงที่จ่ายแล้วยังจองอยู่ (ให้ยกเลิกชั่วโมงพร้อมคืนเงินแทน)'); return; }
    StorageService.set('bookings', allBookings.map(b => groupIds.has(b.id) && b.status === BookingStatus.PENDING_PAYMENT
      ? { ...b, status: BookingStatus.CANCELLED, cancellationReason: `คืนเงิน: ${reason}` } : b));
    const at = new Date().toISOString();
    StorageService.set('payments', StorageService.get<Payment[]>('payments', []).map(p => p.id === pay.id
      ? { ...p, status: kept > 0 ? p.status : PaymentStatus.REFUNDED, refundAmount: roundBaht((p.refundAmount || 0) + amount), refundReason: reason,
          refundedAt: at, refunds: [...(p.refunds || []), { amount, at, method: refundMethod }] } : p));
    onAddAuditLog('PAYMENT_REFUNDED', 'Payment', pay.id, null, { refundAmount: amount, reason, bankChecked });
    onRefreshAll();
  };
  return {
    handleVerifySlip,
    handleRejectSlip,
    handleRefundPayment,
    handleDismissRefundCheck
  };
}
