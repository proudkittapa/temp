import React from 'react';
import {
  CourtType, Booking, BookingStatus, Payment, PaymentStatus,
  PaymentMethod, UserRole, PriceType, User, MemberType
} from '../../types';
import { StorageService, findClosure, calculatePrice, isHourOffPeak, FREE_HOUR_REWARD_IDS, isCourtSlotAvailable, normalizePhone, slotTiming, generatePromptPayPayload, LOCAL_PROMPTPAY_ID, formatBaht, findNoShow, resalePrice } from '../../mockData';
import * as api from '../../api';
import { notify, ask } from '../Dialog';
import { can } from '../../permissions';
import type { StaffPOSCore } from './useStaffPOS';
import { LocalVoucher } from './shared';
import type { useShiftActions } from './shiftActions';
import type { useVoucherActions } from './voucherActions';
import type { useSlipActions } from './slipActions';

// Walk-in bookings at the counter, including the PromptPay wait box.
export function useWalkinActions(deps: StaffPOSCore & ReturnType<typeof useShiftActions> & ReturnType<typeof useVoucherActions> & ReturnType<typeof useSlipActions>) {
  const {
    actingUser,
    bookings,
    confirmCashWithoutShift,
    courts,
    daysOff,
    gridReady,
    handleRejectSlip,
    handleVerifySlip,
    onAddAuditLog,
    onRefreshAll,
    pendingWalkin,
    pushLineMessage,
    resetVoucherCheck,
    setPendingWalkin,
    setWalkinMember,
    setWalkinName,
    setWalkinPhone,
    setWalkinSlot,
    setWalkinSuccessAlert,
    setWalkinVoucherCode,
    walkinCourtId,
    walkinDate,
    walkinName,
    walkinPayMethod,
    walkinPhone,
    walkinSlot,
    walkinVoucherCode
  } = deps;
  // Walk-in booking submission
  const handleWalkinBookingSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!walkinCourtId || !walkinSlot || !walkinName || !walkinPhone) {
      notify('กรุณากรอกข้อมูลและเลือกเวลาให้ครบถ้วน!');
      return;
    }
    if (pendingWalkin) {
      notify(`กรุณายืนยันหรือยกเลิกรายการ ${pendingWalkin.bookingCode} ที่รอชำระเงินก่อนค่ะ`);
      return;
    }
    if (!gridReady) {
      notify('กำลังโหลดการจองของวันนี้ กรุณารอสักครู่แล้วลองใหม่');
      return;
    }
    if (slotTiming(walkinDate, walkinSlot).ended) {
      notify('ช่วงเวลานี้ผ่านไปแล้ว กรุณาเลือกช่วงเวลาอื่น');
      return;
    }

    // Double booking verify - checks the mutex group (FR-1.2), not just this
    // exact court id, so a walk-in half-court booking correctly blocks the
    // full court and vice versa.
    const isOccupied = !isCourtSlotAvailable(walkinCourtId, walkinDate, walkinSlot, bookings, courts);

    if (isOccupied) {
      notify('ขออภัยค่ะ! สนามและเวลาที่เลือกถูกจองไว้แล้ว กรุณาเลือกช่วงเวลาอื่น');
      return;
    }

    // Outside opening hours (no pricing rule covers it) - the server refuses these
    const slotCourt = courts.find(c => c.id === walkinCourtId);
    if (slotCourt && !calculatePrice(slotCourt.type, walkinDate, walkinSlot, MemberType.NORMAL, slotCourt).isOpen) {
      notify('ช่วงเวลานี้อยู่นอกเวลาเปิดให้บริการ กรุณาเลือกช่วงเวลาอื่น');
      return;
    }

    // Half courts and other off-peak-only courts sell off-peak hours only
    // (the server refuses the rest).
    if (slotCourt?.offPeakOnly && calculatePrice(slotCourt.type, walkinDate, walkinSlot, MemberType.NORMAL, slotCourt).priceType !== PriceType.OFFPEAK) {
      notify('สนามนี้เปิดให้จองเฉพาะช่วง Off-Peak กรุณาเลือกเวลาอื่น');
      return;
    }

    // Special DayOff override check
    const hourNum = parseInt(walkinSlot.split(':')[0], 10);
    const blockedReason = findClosure(daysOff, walkinDate, walkinCourtId, hourNum, courts)?.reason;

    if (blockedReason) {
      // Only whoever may manage closures can book through one (the server
      // checks it too).
      if (!can(actingUser, 'manage_closures')) {
        notify(`วันที่/ช่วงเวลานี้ถูกปิดบริการ ("${blockedReason}")\nการจองกรณีพิเศษต้องให้ผู้ที่มีสิทธิ์จัดการวันปิดสนามเป็นผู้จอง`);
        return;
      }
      if (!(await ask(`วันที่/ช่วงเวลานี้ถูกปิดบริการ ("${blockedReason}")\nต้องการจองเป็นกรณีพิเศษหรือไม่?`, { title: '⚠️ ช่วงเวลาปิดบริการ', okLabel: 'จองกรณีพิเศษ' }))) {
        return;
      }
    }

    const useVoucher = walkinPayMethod === PaymentMethod.VOUCHER;
    const voucherCodeIn = walkinVoucherCode.trim().toUpperCase();
    if (useVoucher) {
      if (!voucherCodeIn) {
        notify('กรุณากรอกรหัสคูปองชั่วโมงฟรี (RW-XXXXXX)');
        return;
      }
      if (slotCourt && !isHourOffPeak(slotCourt.type, walkinDate, hourNum)) {
        notify('คูปองชั่วโมงฟรีใช้ได้เฉพาะช่วง Off-Peak เท่านั้น กรุณาเลือกเวลา Off-Peak');
        return;
      }
    }

    if (walkinPayMethod === PaymentMethod.CASH && !(await confirmCashWithoutShift())) return;

    if (api.USE_BACKEND) {
      // The server re-checks availability against every booking (online
      // and walk-in), prices the slot, and credits a registered customer
      // with this phone - the checks above are just early feedback.
      return api.createWalkInBooking({
        date: walkinDate,
        slots: [{ courtId: walkinCourtId, startTime: walkinSlot }],
        customerName: walkinName,
        customerPhone: walkinPhone,
        paymentMethod: walkinPayMethod,
        voucherCode: useVoucher ? voucherCodeIn : undefined,
        overrideClosure: !!blockedReason
      })
        .then(group => {
          const b = group.bookings[0];
          const courtName = courts.find(c => c.id === b.courtId)?.name || '';
          onAddAuditLog('WALKIN_BOOKING_CREATED_BY_STAFF', 'Booking', b.id, null, b);
          if (group.payment.status === PaymentStatus.VERIFIED) {
            // Cash or free-hour voucher: settled on the spot, already confirmed.
            const ptsNote = group.pointsAwarded > 0 ? `\n🎁 ได้รับแต้มสะสมเพิ่ม: +${group.pointsAwarded} แต้ม` : '';
            pushLineMessage(walkinPhone, `🎉 ยืนยันการจองแล้ว!\n📋 ${group.bookingCode} | สนาม ${courtName}\n📅 ${b.date} ${b.startTime}-${b.endTime}\nพบกันที่สนาม! (Walk-in ชำระหน้าเคาน์เตอร์สำเร็จ)${ptsNote}`, "CONFIRMED");
            setWalkinSuccessAlert(`จองสนามแบบ Walk-in รหัส ${group.bookingCode} สำเร็จแล้ว! ${useVoucher ? `ใช้คูปอง ${voucherCodeIn} (ฟรี 1 ชั่วโมง)` : `ยอด ${formatBaht(group.totalAmount)} บาท`} ${group.pointsAwarded > 0 ? `(🎁 มอบแต้มสะสมสมาชิก +${group.pointsAwarded} แต้มสำเร็จ!)` : ''}`);
          } else {
            setPendingWalkin({
              paymentId: group.payment.id,
              bookingCode: group.bookingCode,
              date: b.date,
              amount: group.totalAmount,
              qrPayload: group.promptPayPayload,
              label: `${courtName} ${b.date} ${b.startTime}-${b.endTime} (${walkinName})`
            });
          }
          setWalkinSlot('');
          setWalkinName('');
          setWalkinPhone('');
          setWalkinMember(null);
          setWalkinVoucherCode('');
          if (useVoucher) resetVoucherCheck();
          onRefreshAll();
        })
        .catch(err => {
          notify(`จองไม่สำเร็จ: ${err.message}`);
          onRefreshAll();
        });
    }

    const courtObj = courts.find(c => c.id === walkinCourtId);
    const normalizedPhone = normalizePhone(walkinPhone);
    const usersList = StorageService.get<User[]>('users', []);
    // A free-hour voucher books the hour for its owner, whatever phone was typed.
    const localVouchers = StorageService.get<LocalVoucher[]>('redemptions', []);
    const voucher = useVoucher ? localVouchers.find(r => r.claimCode === voucherCodeIn) : undefined;
    if (useVoucher && (!voucher || !FREE_HOUR_REWARD_IDS.includes(voucher.rewardId) || (voucher.status || 'ACTIVE') !== 'ACTIVE')) {
      notify(!voucher ? 'ไม่พบรหัสคูปองนี้'
        : !FREE_HOUR_REWARD_IDS.includes(voucher.rewardId) ? 'รหัสนี้ไม่ใช่คูปองชั่วโมงฟรี (ให้มอบของรางวัลที่แท็บ "รับของรางวัล")'
        : 'คูปองนี้ถูกใช้ไปแล้วหรือหมดอายุ');
      return;
    }
    const registeredUser = voucher ? usersList.find(u => u.id === voucher.userId) : usersList.find(u => u.role === UserRole.CUSTOMER && normalizePhone(u.phone) === normalizedPhone);
    const resolvedUserId = registeredUser ? registeredUser.id : 'u-walkin-' + Date.now();

    // Price through the same engine the grid preview uses (FR-2), instead of
    // a flat per-sport fee that ignored peak/off-peak, half-court rate and
    // membership discount - and could silently disagree with the price the
    // staff member was just shown on screen.
    const priceDetail = calculatePrice(
      courtObj?.type || CourtType.BADMINTON,
      walkinDate,
      walkinSlot,
      registeredUser?.memberType || MemberType.NORMAL,
      courtObj
    );
    const isActuallyHalf = courtObj ? courtObj.shareOfGroup < 1 : false;
    const paidInCash = walkinPayMethod === PaymentMethod.CASH;
    const settledNow = paidInCash || useVoucher;
    // An hour freed by a no-show is re-sold at the resale price (as the server).
    const resaleOf = courtObj ? findNoShow(courtObj.id, walkinDate, walkinSlot, bookings, courts) : undefined;
    const resale = courtObj ? resalePrice(courtObj, walkinDate, walkinSlot, bookings, courts, priceDetail.total) : undefined;
    const amount = useVoucher ? 0 : resale ?? priceDetail.total;

    const bookingId = 'bk-walkin-' + Date.now();
    const bkCode = `BK${walkinDate.replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

    const newBooking: Booking = {
      id: bookingId,
      bookingCode: bkCode,
      courtId: walkinCourtId,
      userId: resolvedUserId,
      userName: registeredUser ? `${registeredUser.name} (${registeredUser.memberType || 'CUSTOMER'})` : `${walkinName} (Walk-in)`,
      userPhone: normalizedPhone,
      date: walkinDate,
      startTime: walkinSlot,
      endTime: (parseInt(walkinSlot.split(':')[0], 10) + 1).toString().padStart(2, '0') + ':00',
      isHalfCourt: isActuallyHalf,
      ...(resale !== undefined && resaleOf ? { resaleOf: resaleOf.id } : {}),
      priceType: priceDetail.priceType,
      totalAmount: amount,
      // Cash is in the drawer (or a voucher paid for it), so it's confirmed
      // now; a PromptPay walk-in waits until staff see the transfer
      // (confirmPendingWalkin).
      status: settledNow ? BookingStatus.CONFIRMED : BookingStatus.PENDING_PAYMENT,
      isEventBlock: false,
      createdAt: new Date().toISOString(),
      createdBy: 'u-staff-1'
    };

    const qrPayload = settledNow ? undefined : generatePromptPayPayload(LOCAL_PROMPTPAY_ID, amount);
    const newPayment: Payment = {
      id: 'pay-walkin-' + Date.now(),
      bookingId: bookingId,
      amount,
      method: walkinPayMethod,
      status: settledNow ? PaymentStatus.VERIFIED : PaymentStatus.PENDING,
      ...(settledNow ? { verifiedAt: new Date().toISOString(), verifiedBy: 'u-staff-1' } : { qrPayload }),
      createdAt: new Date().toISOString()
    };

    // Save
    const currentBookings = StorageService.get<Booking[]>('bookings', []);
    const currentPayments = StorageService.get<Payment[]>('payments', []);
    StorageService.set('bookings', [...currentBookings, newBooking]);
    StorageService.set('payments', [...currentPayments, newPayment]);

    // Save Log
    onAddAuditLog('WALKIN_BOOKING_CREATED_BY_STAFF', 'Booking', bookingId, null, newBooking);

    if (voucher) {
      // The voucher is used up by this booking; a free hour earns no points.
      StorageService.set('redemptions', localVouchers.map(r => r.claimCode === voucher.claimCode
        ? { ...r, status: 'REDEEMED', dispensedAt: new Date().toISOString(), bookingId } : r));
      onAddAuditLog('VOUCHER_USED_FOR_BOOKING', 'Voucher', voucher.claimCode, { status: 'ACTIVE' }, { status: 'REDEEMED', bookingId });
      pushLineMessage(walkinPhone, `🎉 ยืนยันการจองแล้ว!\n📋 ${bkCode} | สนาม ${courtObj?.name}\n📅 ${walkinDate} ${walkinSlot}-${newBooking.endTime}\n🎟️ ใช้คูปองชั่วโมงฟรี ${voucher.claimCode}`, "CONFIRMED");
      setWalkinSuccessAlert(`จองสนามแบบ Walk-in รหัส ${bkCode} สำเร็จแล้ว! ใช้คูปอง ${voucher.claimCode} (ฟรี 1 ชั่วโมง)`);
    } else if (paidInCash) {
      // Points (FR-4.1: 1 per hour) only once paid.
      const pointsAdded = registeredUser ? StorageService.addPointsHour(resolvedUserId, 1) : 0;
      const ptsNote = pointsAdded > 0 ? `\n🎁 ได้รับแต้มสะสมเพิ่ม: +${pointsAdded} แต้ม` : '';
      pushLineMessage(walkinPhone, `🎉 ยืนยันการจองแล้ว!\n📋 ${bkCode} | สนาม ${courtObj?.name}\n📅 ${walkinDate} ${walkinSlot}-${newBooking.endTime}\nพบกันที่สนาม! (Walk-in ชำระหน้าเคาน์เตอร์สำเร็จ)${ptsNote}`, "CONFIRMED");
      setWalkinSuccessAlert(`จองสนามแบบ Walk-in รหัส ${bkCode} สำเร็จแล้ว! ออกใบจองและเช็คอินได้เลย ${pointsAdded > 0 ? `(🎁 มอบแต้มสะสมสมาชิก +${pointsAdded} แต้มสำเร็จ!)` : ''}`);
    } else {
      setPendingWalkin({
        paymentId: newPayment.id,
        bookingCode: bkCode,
        date: walkinDate,
        amount,
        qrPayload: qrPayload || '',
        label: `${courtObj?.name || ''} ${walkinDate} ${walkinSlot}-${newBooking.endTime} (${walkinName})`
      });
    }
    
    // reset
    setWalkinSlot('');
    setWalkinName('');
    setWalkinPhone('');
    setWalkinMember(null);
    setWalkinVoucherCode('');
    if (useVoucher) resetVoucherCheck();
    onRefreshAll();
  };

  // A PromptPay walk-in waiting for staff to see the transfer arrive.
  const confirmPendingWalkin = () => {
    if (!pendingWalkin) return;
    return handleVerifySlip(pendingWalkin.paymentId).then(ok => {
      if (ok) {
        setWalkinSuccessAlert(`จองสนามแบบ Walk-in รหัส ${pendingWalkin.bookingCode} ยืนยันการรับเงิน ${formatBaht(pendingWalkin.amount)} บาทแล้ว!`);
        setPendingWalkin(null);
      }
    });
  };

  const cancelPendingWalkin = async () => {
    if (!pendingWalkin) return;
    if (!(await ask(`ยกเลิกการจอง ${pendingWalkin.bookingCode} ที่ยังไม่ได้ชำระเงินใช่หรือไม่?`, { okLabel: 'ยกเลิกการจอง', cancelLabel: 'ไม่ยกเลิก', danger: true }))) return;
    return handleRejectSlip(pendingWalkin.paymentId, 'ยกเลิกที่เคาน์เตอร์ ยังไม่ได้ชำระเงิน').then(ok => {
      if (ok) setPendingWalkin(null);
    });
  };
  return {
    handleWalkinBookingSubmit,
    confirmPendingWalkin,
    cancelPendingWalkin
  };
}
