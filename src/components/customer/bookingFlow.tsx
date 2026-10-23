import React from 'react';
import {
  Booking, BookingStatus,
  Payment, PaymentStatus, PaymentMethod, MemberType, LineMessage, DayOff
} from '../../types';
import { StorageService, findClosure, calculatePrice, generatePromptPayPayload, LOCAL_PROMPTPAY_ID, slotTiming, normalizePhone, formatBaht, isCourtSlotAvailable, expireUnpaidLocal, unpaidGroupsLocal, LOCAL_MAX_UNPAID_GROUPS } from '../../mockData';
import { prepareSlipImage, SlipImageError } from '../../slipImage';
import * as api from '../../api';
import { notify } from '../Dialog';
import type { CustomerPanelCore } from './useCustomerPanel';
import type { useSlotPicker } from './slotPicker';

// Steps 2-3: confirm the booking, pay by PromptPay, upload the slip; LINE notices.
export function useBookingFlow(deps: CustomerPanelCore & ReturnType<typeof useSlotPicker>) {
  const {
    bookings,
    courts,
    currentBooking,
    currentPriceDetails,
    loggedInUser,
    memberName,
    onAddAuditLog,
    onRefreshAll,
    selectedDate,
    selectedSlots,
    selectedType,
    sessionStillMine,
    setActiveStep,
    setBookingSuccessAlert,
    setCurrentBooking,
    setCurrentPayment,
    setLineMessages,
    setNowTick,
    setQrCodePayload,
    setSelectedSlots
  } = deps;
  // LINE OA Simulation notifier helper
  const triggerLineNotification = (messageText: string, phone: string, name: string, type: "CREATED" | "CONFIRMED" | "REMINDER" | "CANCELLED") => {
    const newMessage: LineMessage = {
      id: 'lm-' + Date.now(),
      timestamp: new Date().toISOString(),
      recipientPhone: phone || '08XXXXXXXX',
      recipientName: name || 'ลูกค้าทั่วไป',
      type,
      text: messageText
    };

    const currentLine = StorageService.get<LineMessage[]>('line_messages', []);
    const updated = [newMessage, ...currentLine];
    StorageService.set('line_messages', updated);
    setLineMessages(updated);
  };

  // Phase 1 Core Booking Submission
  const handleProceedToCheckout = () => {
    if (!loggedInUser) {
      notify('🔒 ขออภัยค่ะ! กรุณาลงชื่อเข้าใช้ (Login) หรือสมัครสมาชิกใหม่ด้านบนก่อน เพื่อทำรายการจองและแสตมป์ยอดส่วนลดประจำตัวผู้เล่นค่ะ 🌟');
      return;
    }
    if (selectedSlots.length === 0) {
      notify('กรุณาเลือกสนาม และช่วงเวลาต้องการจองอย่างน้อย 1 ชั่วโมง!');
      return;
    }
    // Taken meanwhile? Checks the whole court group (a half court blocks
    // the full court and vice versa), as the server does.
    const occupied = selectedSlots.find(s => !isCourtSlotAvailable(s.courtId, selectedDate, s.startTime, bookings, courts));

    if (occupied) {
      const cName = courts.find(c => c.id === occupied.courtId)?.name || 'สนาม';
      notify(`ขออภัยค่ะ! ช่วงเวลา ${occupied.startTime} น. ของ ${cName} ถูกผู้อื่นจองไปแล้วระหว่างทำรายการ กรุณาเลือกสล็อตอื่น`);
      return;
    }

    setActiveStep(2);
  };

  const handleBookingSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loggedInUser) {
      notify('🔒 กรุณาลงชื่อเข้าใช้ระบบก่อนค่ะ!');
      return;
    }
    if (selectedSlots.length === 0) {
      notify('กรุณาเลือกวันเวลาที่จอง!');
      return;
    }

    if (api.USE_BACKEND) {
      if (!sessionStillMine()) return;
      // The server prices every slot itself (member discount, half-court
      // rate) and books them all-or-nothing, so the shown total is only a
      // preview - the response's amounts are what get stored and paid.
      return api.createBookings(selectedDate, selectedSlots)
        .then(group => {
          setCurrentBooking(group.bookings[0]);
          setCurrentPayment(group.payment);
          setQrCodePayload(group.promptPayPayload);
          setActiveStep(3);
          const breakdown = group.bookings.map(b => {
            const cName = courts.find(c => c.id === b.courtId)?.name || 'สนาม';
            return `- ${cName} เวลา ${b.startTime}-${b.endTime} (${formatBaht(b.totalAmount)} บาท)`;
          }).join('\n');
          triggerLineNotification(
            `✅ รับคำขอจองแล้ว (${group.bookings.length} รายการ)\n📋 รหัสจองกลุ่ม: ${group.bookingCode}\n📅 วันที่: ${selectedDate}\nรายละเอียด:\n${breakdown}\n💰 ยอดที่ต้องชำระทั้งหมด: ${formatBaht(group.totalAmount)} บาท\n\nกรุณาชำระและอัปโหลด slip ภายใน 30 นาที หากไม่ชำระระบบจะยกเลิกออโต้`,
            normalizePhone(loggedInUser.phone || ''), memberName, "CREATED"
          );
          setBookingSuccessAlert(`สร้างรายการจองรวม ${group.bookings.length} รายการสำเร็จ รหัสกลุ่มคือ ${group.bookingCode} แล้ว! กรุณาชำระเงินและอัพโหลดสลิป`);
          onRefreshAll();
        })
        .catch(err => {
          notify(`ขออภัยค่ะ จองไม่สำเร็จ: ${err.message}`);
          onRefreshAll(); // reload availability - someone may have taken the slot
        });
    }

    // Browser-only mode: the server's checks, on fresh data - the customer
    // may have waited on step 2 while someone else booked or the hour began.
    expireUnpaidLocal();
    const unpaid = unpaidGroupsLocal(loggedInUser.id);
    if (unpaid >= LOCAL_MAX_UNPAID_GROUPS) {
      notify(`คุณมีการจองที่รอชำระ/รอตรวจสลิปอยู่ ${unpaid} รายการแล้ว กรุณารอให้ยืนยันก่อนจองเพิ่ม`);
      return;
    }
    const freshBookings = StorageService.get<Booking[]>('bookings', []);
    const freshClosures = StorageService.get<DayOff[]>('days_off', []);
    for (const sl of selectedSlots) {
      const cName = courts.find(c => c.id === sl.courtId)?.name || 'สนาม';
      if (!isCourtSlotAvailable(sl.courtId, selectedDate, sl.startTime, freshBookings, courts)) {
        notify(`${cName} ${sl.startTime} เพิ่งถูกจองไป กรุณาเลือกเวลาอื่น`);
        setActiveStep(1);
        onRefreshAll();
        return;
      }
      if (slotTiming(selectedDate, sl.startTime).started) {
        notify(`${cName} ${sl.startTime} เริ่มไปแล้ว จองออนไลน์ไม่ได้`);
        setActiveStep(1);
        return;
      }
      if (findClosure(freshClosures, selectedDate, sl.courtId, parseInt(sl.startTime, 10), courts)) {
        notify(`${cName} ปิดบริการในช่วง ${sl.startTime}`);
        setActiveStep(1);
        return;
      }
    }

    const priceInfo = currentPriceDetails();
    const cleanPhone = normalizePhone(loggedInUser.phone || '');
    const mainBookingId = 'bk-' + Date.now();
    const bkCode = `BK${selectedDate.replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

    const newBookings: Booking[] = selectedSlots.map((slotItem, index) => {
      // Half-court status comes from the court itself (B/C are half-shares),
      // as on the server.
      const bookedCourt = courts.find(c => c.id === slotItem.courtId);
      const singlePrice = calculatePrice(selectedType, selectedDate, slotItem.startTime, loggedInUser.memberType || MemberType.NORMAL, bookedCourt);
      const isActuallyHalf = bookedCourt ? bookedCourt.shareOfGroup < 1 : false;

      return {
        id: index === 0 ? mainBookingId : `bk-${Date.now()}-${index}`,
        bookingCode: bkCode,
        courtId: slotItem.courtId,
        userId: loggedInUser.id,
        userName: `${loggedInUser.name} ${loggedInUser.memberType && loggedInUser.memberType !== MemberType.NORMAL ? `(${loggedInUser.memberType})` : ''}`,
        userPhone: cleanPhone,
        date: selectedDate,
        startTime: slotItem.startTime,
        endTime: (parseInt(slotItem.startTime.split(':')[0], 10) + 1).toString().padStart(2, '0') + ':00',
        isHalfCourt: isActuallyHalf,
        priceType: singlePrice.priceType,
        totalAmount: singlePrice.total,
        status: BookingStatus.PENDING_PAYMENT,
        isEventBlock: false,
        createdAt: new Date().toISOString(),
        createdBy: 'customer'
      };
    });

    // Create PromptPay QR Payload based on total
    const qrPayload = generatePromptPayPayload(LOCAL_PROMPTPAY_ID, priceInfo.total);

    const newPayment: Payment = {
      id: 'pay-' + Date.now(),
      bookingId: mainBookingId,
      amount: priceInfo.total,
      method: PaymentMethod.PROMPTPAY,
      status: PaymentStatus.PENDING,
      qrPayload,
      createdAt: new Date().toISOString()
    };

    // Save state
    const currentBookings = StorageService.get<Booking[]>('bookings', []);
    const currentPayments = StorageService.get<Payment[]>('payments', []);

    StorageService.set('bookings', [...currentBookings, ...newBookings]);
    StorageService.set('payments', [...currentPayments, newPayment]);

    setCurrentBooking(newBookings[0]); // Use first as main reference
    setCurrentPayment(newPayment);
    setQrCodePayload(qrPayload);
    setActiveStep(3);

    // Save logs
    newBookings.forEach(b => {
      onAddAuditLog('BOOKING_CREATED_BY_CUSTOMER', 'Booking', b.id, null, b);
    });

    // Trigger LINE Notification (Module 5 Specification)
    const breakdown = newBookings.map(b => {
      const cName = courts.find(c => c.id === b.courtId)?.name || 'สนาม';
      return `- ${cName} เวลา ${b.startTime}-${b.endTime} (${formatBaht(b.totalAmount)} บาท)`;
    }).join('\n');

    const textMessage = `✅ รับคำขอจองแล้ว (${newBookings.length} รายการ)\n📋 รหัสจองกลุ่ม: ${bkCode}\n📅 วันที่: ${selectedDate}\nรายละเอียด:\n${breakdown}\n💰 ยอดที่ต้องชำระทั้งหมด: ${formatBaht(priceInfo.total)} บาท\n\nกรุณาชำระและอัปโหลด slip ภายใน 30 นาที หากไม่ชำระระบบจะยกเลิกออโต้`;
    triggerLineNotification(textMessage, cleanPhone, memberName, "CREATED");

    setBookingSuccessAlert(`สร้างรายการจองรวม ${newBookings.length} รายการสำเร็จ รหัสกลุ่มคือ ${bkCode} แล้ว! กรุณาชำระเงินและอัพโหลดสลิป`);
    onRefreshAll();
  };

  // Simulating Slip uploading
  // Re-opens the QR + slip upload step for a booking still awaiting payment,
  // so a customer who left the page (or uploaded the wrong slip) can pay or
  // re-send it from their booking history instead of losing the booking.
  const handleReopenPayment = (booking: Booking, payment: Payment) => {
    setCurrentBooking(booking);
    setCurrentPayment(payment);
    setQrCodePayload(payment.qrPayload || '');
    setActiveStep(3);
    setNowTick(Date.now());
    setTimeout(() => document.getElementById('promptpay-qr-display')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };

  const handleSlipUploadSimulation = (mockImgUrl: string, realFile?: File) => {
    if (!currentBooking) return;

    if (api.USE_BACKEND) {
      if (!sessionStillMine()) return;
      // Upload the chosen file; for the sample buttons, fetch the sample
      // image so the backend still receives a real file.
      const getFile: Promise<Blob> = realFile
        ? prepareSlipImage(realFile)
        : fetch(mockImgUrl).then(r => {
            if (!r.ok) throw new Error('could not load sample slip image');
            return r.blob();
          });
      return getFile
        .then(file => api.uploadSlip(currentBooking.id, file, (file as File).name || realFile?.name || 'sample-slip.jpg'))
        .then(() => {
          setBookingSuccessAlert("ส่งสลิปเรียบร้อยแล้ว! พนักงานจะตรวจสอบและยืนยันการจอง ดูสถานะได้ที่รายการจองด้านล่าง");
          setActiveStep(1);
          setSelectedSlots([]);
          onRefreshAll();
        })
        .catch(err => notify(err instanceof SlipImageError ? err.message : `ส่งสลิปไม่สำเร็จ: ${err.message}`));
    }

    // Only a payment still waiting for its money can take a slip (as on the
    // server) - not a cancelled, approved or refunded one.
    const target = StorageService.get<Payment[]>('payments', []).find(p => p.bookingId === currentBooking.id);
    if (!target || ![PaymentStatus.PENDING, PaymentStatus.SLIP_UPLOADED, PaymentStatus.EXPIRED].includes(target.status)) {
      notify(`รายการนี้ส่งสลิปไม่ได้แล้ว${target ? ` (${target.status})` : ''}`);
      onRefreshAll();
      return;
    }


    // Update system states
    const allPayments = StorageService.get<Payment[]>('payments', []);
    const updatedPayments = allPayments.map(p => {
      if (p.bookingId === currentBooking.id) {
        return {
          ...p,
          status: PaymentStatus.SLIP_UPLOADED,
          slipUrl: mockImgUrl,
          slipUploadedAt: new Date().toISOString()
        };
      }
      return p;
    });

    StorageService.set('payments', updatedPayments);
    
    // Save state change in logs
    onAddAuditLog('SLIP_UPLOADED_BY_CUSTOMER', 'Payment', currentBooking.id, { status: PaymentStatus.PENDING }, { status: PaymentStatus.SLIP_UPLOADED, slipUrl: mockImgUrl });

    setBookingSuccessAlert("ส่งสลิปเรียบร้อยแล้ว! พนักงานจะตรวจสอบและยืนยันการจอง ดูสถานะได้ที่รายการจองด้านล่าง");
    setActiveStep(1); // Return to booking screen
    setSelectedSlots([]);
    onRefreshAll();
  };

  // Standard static slip samples
  const SLIP_SAMPLES = [
    { name: 'สลิปยอดถูกต้อง (KTB Bank)', url: 'https://images.unsplash.com/photo-1554415707-6e8cfc93fe23?w=300&q=80' },
    { name: 'สลิปยอดฝากเงิน (SCB Bank)', url: 'https://images.unsplash.com/photo-1628157582853-a796fa650a6a?w=300&q=80' },
  ];
  return {
    triggerLineNotification,
    handleProceedToCheckout,
    handleBookingSubmit,
    handleReopenPayment,
    handleSlipUploadSimulation,
    SLIP_SAMPLES
  };
}
