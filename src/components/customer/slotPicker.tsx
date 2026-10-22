import React from 'react';
import {
  Court, CourtType, PriceType, BookingStatus, MemberType
} from '../../types';
import { findClosure, calculatePrice, slotTiming, openSlotHours, formatBaht, roundBaht, lastBookableDate, getTodayDateStr, isHourOffPeak, isCourtSlotAvailable, findConflictingBooking } from '../../mockData';
import { notify } from '../Dialog';
import type { CustomerPanelCore } from './useCustomerPanel';
import { SlotState } from './shared';


// Step 1: sport, date and hours - the grid and list views and their price preview.
export function useSlotPicker(deps: CustomerPanelCore) {
  const {
    bookings,
    courts,
    daysOff,
    loggedInUser,
    openCourts,
    selectedDate,
    selectedSlots,
    selectedType,
    setOpenCourts,
    setSelectedSlots,
    setSelectedType
  } = deps;
  const handleCourtTypeChange = (type: CourtType) => {
    setSelectedType(type);
    setSelectedSlots([]);
  };

  // Slots within the opening hours (admin setting, default 07:00-23:00)
  const getAvailableSlots = () => openSlotHours().map(start => {
    const hourNum = parseInt(start, 10);
    return { start, end: `${String(hourNum + 1).padStart(2, '0')}:00`, hourNum };
  });


  // Helper to get Price Information inside layout
  const currentPriceDetails = () => {
    if (!selectedDate || selectedSlots.length === 0) return { total: 0, original: 0, priceType: PriceType.NORMAL };
    let total = 0;
    let original = 0;
    const currentEffectiveMemberType = loggedInUser ? (loggedInUser.memberType || MemberType.NORMAL) : MemberType.NORMAL;
    selectedSlots.forEach(s => {
      const court = courts.find(c => c.id === s.courtId);
      const detail = calculatePrice(selectedType, selectedDate, s.startTime, currentEffectiveMemberType, court);
      total = roundBaht(total + detail.total);
      // "Before discount" = this court's own price for a normal customer
      // (calculatePrice's `original` is the full-court rate, which made a
      // half court look discounted).
      original = roundBaht(original + calculatePrice(selectedType, selectedDate, s.startTime, MemberType.NORMAL, court).total);
    });
    return {
      total,
      original,
      priceType: PriceType.NORMAL
    };
  };

  const handleToggleSlotInGrid = (courtId: string, startTime: string) => {
    if (!loggedInUser) {
      notify('🔒 ขออภัยค่ะ! กรุณาลงชื่อเข้าใช้ระบบ (Login) หรือสมัครสมาชิกใหม่ด้านบนก่อน จึงจะสามารถเลือกสนามและช่วงเวลาสำหรับจองเล่นกีฬาได้ค่ะ 🌟');
      const consoleElem = document.getElementById('customer-auth-console');
      if (consoleElem) {
        consoleElem.scrollIntoView({ behavior: 'smooth' });
      }
      return;
    }
    const existsIdx = selectedSlots.findIndex(s => s.courtId === courtId && s.startTime === startTime);
    if (existsIdx > -1) {
      setSelectedSlots(selectedSlots.filter((_, i) => i !== existsIdx));
    } else {
      // Constraint 1: max 3 hours total per booking
      if (selectedSlots.length >= 3) {
        notify('คุณสามารถจองได้สูงสุดไม่เกิน 3 ชั่วโมง (3 สล็อต) ต่อการจอง 1 ครั้งค่ะ');
        return;
      }
      
      // Constraint 2: max 3 unique courts per booking
      const currentCourts = selectedSlots.map(s => s.courtId);
      const uniqueCourts = new Set([...currentCourts, courtId]);
      if (uniqueCourts.size > 3) {
        notify('คุณสามารถเลือกสนามได้ไม่เกิน 3 สนาม ต่อการจอง 1 ครั้งค่ะ');
        return;
      }

      // Check slot double booking. Uses the shared mutex-group check (FR-1.2)
      // instead of a plain per-court lookup, so e.g. booking half-court B is
      // correctly blocked when the full court is already booked, and vice
      // versa - a same-court-id-only check would miss that conflict.
      if (!isCourtSlotAvailable(courtId, selectedDate, startTime, bookings, courts)) {
        notify('ขออภัยค่ะ! ช่วงเวลานี้ถูกผู้อื่นจองไปแล้ว กรุณาเลือกเวลาอื่น');
        return;
      }

      // Check peak constraint for half-court resources (FR-1.2)
      const targetCourt = courts.find(c => c.id === courtId);
      if (targetCourt?.offPeakOnly && !isHourOffPeak(targetCourt.type, selectedDate, parseInt(startTime.split(':')[0], 10))) {
        notify('⚠️ ขออภัยค่ะ สนามครึ่งสนาม (B / C) เปิดให้บริการจองเฉพาะช่วง Off-Peak เท่านั้นค่ะ');
        return;
      }

      // Online bookings open a configurable number of days ahead (server rule)
      if (selectedDate > lastBookableDate()) {
        notify(`ขออภัยค่ะ เปิดให้จองออนไลน์ล่วงหน้าได้ถึงวันที่ ${lastBookableDate()} เท่านั้น`);
        return;
      }

      // Already started: online bookings must start in the future (server rule)
      if (slotTiming(selectedDate, startTime).started) {
        notify('ขออภัยค่ะ ช่วงเวลานี้เริ่มไปแล้ว จองออนไลน์ไม่ได้ กรุณาติดต่อเคาน์เตอร์');
        return;
      }

      // Outside opening hours (no pricing rule covers it) - the server refuses these
      if (targetCourt && !calculatePrice(targetCourt.type, selectedDate, startTime, MemberType.NORMAL, targetCourt).isOpen) {
        notify('ขออภัยค่ะ ช่วงเวลานี้อยู่นอกเวลาเปิดให้บริการ');
        return;
      }

      // Check Special DayOff block
      const hourNum = parseInt(startTime.split(':')[0], 10);
      const blockedItem = findClosure(daysOff, selectedDate, courtId, hourNum, courts);

      if (blockedItem) {
        notify(`ขออภัยค่ะ! สนามปิดให้บริการในช่วงเวลานี้ชั่วคราว \nสาเหตุ: "${blockedItem.reason}"\nกรุณาเลือกรอบเวลาอื่นหรือสนามกีฬาอื่นค่ะ`);
        return;
      }

      setSelectedSlots([...selectedSlots, { courtId, startTime }]);
    }
  };
  const slotStatus = (court: Court, time: string, hourNum: number): SlotState => {
    // A reservation on this court or a mutex-group sibling (FR-1.2, e.g. the full court)
    const matchedBooking = findConflictingBooking(court.id, selectedDate, time, bookings, courts);
    if (matchedBooking) {
      return { kind: 'booked', pending: matchedBooking.status === BookingStatus.PENDING_PAYMENT, mine: !!loggedInUser && matchedBooking.userId === loggedInUser.id };
    }
    const closure = findClosure(daysOff, selectedDate, court.id, hourNum, courts);
    if (closure) return { kind: 'closed', reason: closure.reason };
    // Online, an hour can only be booked before it starts (the server
    // refuses it after - the counter can still sell it).
    if (slotTiming(selectedDate, time).started) return { kind: 'started' };
    const price = calculatePrice(court.type, selectedDate, time, loggedInUser ? (loggedInUser.memberType || MemberType.NORMAL) : MemberType.NORMAL, court);
    // No pricing rule covers this hour: the server refuses it.
    if (!price.isOpen) return { kind: 'notOpen' };
    // Peak/off-peak from the rule the price uses: a NORMAL-rate hour (the
    // meeting room) is neither, and an off-peak-only court takes OFFPEAK
    // hours only, as on the server.
    const isPeak = price.priceType === PriceType.PEAK;
    if (court.offPeakOnly && price.priceType !== PriceType.OFFPEAK) return { kind: 'peakBlocked' };
    const selected = selectedSlots.some(sl => sl.courtId === court.id && sl.startTime === time);
    return { kind: selected ? 'selected' : 'free', price: price.total, isPeak, isOffPeak: price.priceType === PriceType.OFFPEAK };
  };
  // Bookable grid cells act as toggle buttons for keyboards and screen
  // readers too (Tab to reach, Enter/Space to pick).
  const cellButton = (courtId: string, time: string, pressed: boolean) => ({
    role: 'button' as const,
    tabIndex: 0,
    'aria-pressed': pressed,
    'aria-label': `${courts.find(c => c.id === courtId)?.name || ''} ${time}`,
    onClick: () => handleToggleSlotInGrid(courtId, time),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggleSlotInGrid(courtId, time); }
    }
  });
  const SLOT_LABEL: Record<Exclude<SlotState['kind'], 'free' | 'selected'>, string> = {
    booked: 'จองแล้ว', closed: 'ปิดสนาม', started: 'หมดเวลาจอง', peakBlocked: 'เฉพาะ Off-Peak', notOpen: 'ปิดบริการ'
  };

  // Phone list view: one card per court; tapping it shows its hours as big
  // buttons (3 per row). Unavailable hours stay visible, greyed, with why.
  const renderCourtList = () => {
    const list = courts.filter(c => c.type === selectedType);
    if (list.length === 0) return <p className="text-center text-slate-400 py-10 font-bold">ไม่มีสนามประเภทนี้</p>;
    const slots = getAvailableSlots();
    return (
      <div id="court-list" className="space-y-2">
        {list.map(court => {
          const states = slots.map(sl => ({ time: sl.start, st: slotStatus(court, sl.start, sl.hourNum) }));
          const freeCount = states.filter(x => x.st.kind === 'free' || x.st.kind === 'selected').length;
          const selectedHere = states.filter(x => x.st.kind === 'selected').length;
          const open = openCourts[court.id] ?? selectedHere > 0;
          return (
            <div key={court.id} className={`border rounded-xl bg-white ${selectedHere ? 'border-emerald-500' : 'border-slate-200'}`}>
              <button type="button" onClick={() => setOpenCourts(o => ({ ...o, [court.id]: !open }))}
                className="w-full flex items-center justify-between gap-2 px-4 min-h-[52px] text-left">
                <span>
                  <span className="block font-bold text-slate-900 text-base">{court.name}</span>
                  <span className="text-xs text-slate-500">
                    {freeCount > 0 ? `ว่าง ${freeCount} ชม.` : 'เต็ม / ไม่เปิด'}
                    {court.offPeakOnly && ' · เฉพาะ Off-Peak'}
                    {selectedHere > 0 && <span className="text-emerald-700 font-bold"> · เลือก {selectedHere}</span>}
                  </span>
                </span>
                <span className="text-slate-400 text-lg">{open ? '▴' : '▾'}</span>
              </button>
              {open && (
                <div className="grid grid-cols-3 gap-2 px-3 pb-3">
                  {states.map(({ time, st }) => {
                    const bookable = st.kind === 'free' || st.kind === 'selected';
                    return (
                      <button key={time} type="button" disabled={!bookable}
                        onClick={() => handleToggleSlotInGrid(court.id, time)}
                        className={`min-h-[52px] rounded-lg border px-1 py-1 text-center leading-tight ${
                          st.kind === 'selected' ? 'bg-emerald-600 border-emerald-600 text-white'
                          : st.kind === 'free' ? (st.isPeak ? 'bg-amber-50 border-amber-200 text-slate-900' : 'bg-white border-slate-300 text-slate-900')
                          : 'bg-slate-100 border-slate-100 text-slate-400'
                        }`}>
                        <span className="block text-sm font-bold">{time}</span>
                        <span className="block text-xs">
                          {bookable ? `${formatBaht((st as { price: number }).price)}฿${(st as { isPeak: boolean }).isPeak ? ' · Peak' : ''}` : SLOT_LABEL[st.kind as keyof typeof SLOT_LABEL]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // Quick date buttons: today, tomorrow, the day after (within the window).
  const quickDates = [0, 1, 2].map(n => {
    const d = new Date(`${getTodayDateStr()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    const iso = d.toISOString().slice(0, 10);
    return { iso, label: ['วันนี้', 'พรุ่งนี้', 'มะรืน'][n] };
  }).filter(q => q.iso <= lastBookableDate());
  return {
    handleCourtTypeChange,
    getAvailableSlots,
    currentPriceDetails,
    handleToggleSlotInGrid,
    slotStatus,
    cellButton,
    SLOT_LABEL,
    renderCourtList,
    quickDates
  };
}
