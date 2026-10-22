import React, { useState, useEffect, useRef } from 'react';
import {
  Court, CourtType, Booking, BookingStatus, Payment, PaymentStatus,
  PaymentMethod, Product, ProductCat, Order, OrderStatus, OrderType, UserRole, PriceType, DayOff, User, MemberType, LedgerEntryType, Shift, PointsLedgerEntry, LineMessage, AddAuditLog
} from '../../types';
import { StorageService, findClosure, getTodayDateStr, calculatePrice, isHourOffPeak, FREE_HOUR_REWARD_IDS, isCourtSlotAvailable, findConflictingBooking, bookingGroupOf, normalizePhone, slotTiming, generatePromptPayPayload, LOCAL_PROMPTPAY_ID, formatBaht, roundBaht, isPaidBooking, localDateOf, formatDate, businessInfo, findNoShow, resalePrice, noShowOpenAt } from '../../mockData';
import * as api from '../../api';
import { notify, ask, askText, dialog } from '../Dialog';
import { useLiveLoad, useLiveTick } from '../../useLiveTick';
import { can, canUseCounter, Permission } from '../../permissions';
import { createContext, useContext } from 'react';

export interface StaffPOSProps {
  currentUserRole: UserRole;
  onAddAuditLog: AddAuditLog;
  triggerRefresh: number;
  onRefreshAll: () => void;
}

// Browser-only mode: a shift's cash taken (same rule as the server: cash
// payments approved and non-voided cash orders while the shift was open).
export function localShiftView(sh: Shift, payments: Payment[], orders: Order[]): api.ShiftView {
  const from = sh.openedAt, to = sh.closedAt || '9999';
  const cashBookings = roundBaht(payments.filter(p => p.method === PaymentMethod.CASH && p.verifiedAt && p.verifiedAt >= from && p.verifiedAt < to &&
    (p.status === PaymentStatus.VERIFIED || p.status === PaymentStatus.REFUNDED)).reduce((n, p) => n + p.amount, 0));
  const cashOrders = roundBaht(orders.filter(o => o.paymentMethod === PaymentMethod.CASH && o.status !== OrderStatus.CANCELLED &&
    o.createdAt >= from && o.createdAt < to).reduce((n, o) => n + o.totalAmount, 0));
  // Rental deposits: taken (voided rentals too) minus given back.
  const cashDeposits = roundBaht(orders.reduce((n, o) =>
    n + (o.createdAt >= from && o.createdAt < to ? o.depositAmount ?? 0 : 0)
      - (o.depositSettledAt && o.depositSettledAt >= from && o.depositSettledAt < to ? o.depositReturned ?? 0 : 0), 0));
  return { ...sh, cashBookings, cashOrders, cashDeposits,
    expected: sh.expectedCash ?? roundBaht(sh.openingFloat + cashBookings + cashOrders + cashDeposits) };
}

// Browser-only mode keeps reward vouchers in localStorage ("redemptions").
export interface LocalVoucher { id: string; claimCode: string; rewardId: string; rewardName: string; userId: string; userName: string; pointsSpent?: number; status?: string; bookingId?: string; dispensedAt?: string }



// State and handlers of StaffPOS (moved here as they were). The panel
// and its tab components read them through StaffPOSContext.
export function useStaffPOS({ currentUserRole, onAddAuditLog, triggerRefresh, onRefreshAll }: StaffPOSProps) {
  // Master states
  const [courts, setCourts] = useState<Court[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [daysOff, setDaysOff] = useState<DayOff[]>([]);
  const [users, setUsers] = useState<User[]>([]);

  // Sub Module tab state
  const [activePosTab, setActivePosTab] = useState<'walkin' | 'slips' | 'fb' | 'rentals' | 'todays_total' | 'vouchers'>('walkin');

  // Walk-in booking state
  const [posGridSportType, setPosGridSportType] = useState<CourtType>(CourtType.BADMINTON);
  const [walkinCourtId, setWalkinCourtId] = useState<string>('');
  const [walkinDate, setWalkinDate] = useState<string>('');
  // API mode: the date whose bookings are loaded. Until it matches
  // walkinDate the grid would show every slot free, so it waits.
  const [loadedDate, setLoadedDate] = useState<string>('');
  const gridReady = !api.USE_BACKEND || loadedDate === walkinDate;
  const [walkinSlot, setWalkinSlot] = useState<string>('');
  const [walkinName, setWalkinName] = useState<string>('');
  const [walkinPhone, setWalkinPhone] = useState<string>('');
  // One id per cart / rental form until it is sold: a retry after a lost
  // response repeats it (the server answers with the first sale), a changed
  // cart or the next sale gets a new one.
  const cartActionId = useRef('');
  const rentalActionId = useRef('');
  // The member picked in each phone box: their name comes from the
  // database, so the name box is locked while one is linked.
  const [walkinMember, setWalkinMember] = useState<api.MemberMatch | null>(null);
  const [cartMember, setCartMember] = useState<api.MemberMatch | null>(null);
  const [rentalMember, setRentalMember] = useState<api.MemberMatch | null>(null);
  const memberPhoneHandlers = (member: api.MemberMatch | null, setMember: (m: api.MemberMatch | null) => void,
    setPhone: (p: string) => void, setName: (n: string) => void) => ({
    onChange: (phone: string) => {
      setPhone(phone);
      if (member && normalizePhone(phone) !== member.phone) { setMember(null); setName(''); }
    },
    onPick: (m: api.MemberMatch) => { setMember(m); setName(m.name); },
  });
  const [walkinPayMethod, setWalkinPayMethod] = useState<PaymentMethod>(PaymentMethod.PROMPTPAY);
  // RW-XXXXXX code of a free off-peak hour reward, when paying with one
  const [walkinVoucherCode, setWalkinVoucherCode] = useState<string>('');
  const [walkinSuccessAlert, setWalkinSuccessAlert] = useState<string | null>(null);
  // A PromptPay walk-in is created awaiting payment: staff show this QR
  // (with the price the server actually charges, member discount included)
  // and confirm only once the transfer has arrived.
  const [pendingWalkin, setPendingWalkin] = useState<{
    paymentId: string; bookingCode: string; date: string; amount: number; qrPayload: string; label: string;
  } | null>(null);

  // Receipt printed preview overlay target states
  const [selectedReceiptBooking, setSelectedReceiptBooking] = useState<Booking | null>(null);
  const [selectedReceiptOrder, setSelectedReceiptOrder] = useState<Order | null>(null);

  // F&B & Product cart state
  const [cartItems, setCartItems] = useState<{ product: Product; qty: number }[]>([]);
  const [cartCustomerName, setCartCustomerName] = useState<string>('');
  const [cartCourtId, setCartCourtId] = useState<string>('');
  const [cartPayMethod, setCartPayMethod] = useState<PaymentMethod>(PaymentMethod.PROMPTPAY);
  const [cartSuccessAlert, setCartSuccessAlert] = useState<string | null>(null);
  // A registered customer's phone links the sale to them (name on the bill,
  // their history). Counter sales earn no points - only court bookings do.
  const [cartCustomerPhone, setCartCustomerPhone] = useState<string>('');

  // Rental items list
  const [rentalCourtId, setRentalCourtId] = useState<string>('');
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [rentalCustomerPhone, setRentalCustomerPhone] = useState<string>('');
  // Shoes are rented by size: gender filter + the chosen size variant (FR-5.3).
  const [rentalShoeGender, setRentalShoeGender] = useState<'M' | 'F'>('M');
  const [rentalVariantId, setRentalVariantId] = useState<string>('');
  // Reset only when what is being sold changes (a refresh rebuilds the
  // cart's objects without changing it).
  const cartSig = JSON.stringify([cartItems.map(i => [i.product.id, i.qty]), cartPayMethod, cartCustomerPhone, cartCustomerName, cartCourtId]);
  useEffect(() => { cartActionId.current = ''; }, [cartSig]);
  useEffect(() => { rentalActionId.current = ''; }, [selectedProductId, rentalVariantId, rentalCustomerPhone, rentalCourtId]);
  // Rentals still out (any day); in browser-only mode derived from orders.
  const [activeRentalOrders, setActiveRentalOrders] = useState<Order[]>([]);

  // Cash drawer shift (FR-6.1/6.2): opened with a float, closed with a count.
  const [shift, setShift] = useState<api.ShiftView | null>(null);
  const [shiftHistory, setShiftHistory] = useState<api.ShiftView[]>([]);
  const [shiftFloatInput, setShiftFloatInput] = useState<string>('');
  const [shiftCountInput, setShiftCountInput] = useState<string>('');
  const [shiftNote, setShiftNote] = useState<string>('');
  const [closedShift, setClosedShift] = useState<api.ShiftView | null>(null);

  // Reject slip state
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<string>('');

  // API mode: slip review queue comes from the backend and needs a staff login
  // The one shared session, if its role may use the counter (a signed-in
  // customer gets the sign-in form with a note instead).
  const [staffUser, setStaffUser] = useState<User | null>(() => {
    const u = api.USE_BACKEND ? api.getSession('staff')?.user ?? null : null;
    return canUseCounter(u) ? u : null;
  });
  const [staffIdentity, setStaffIdentity] = useState<string>('');
  const [staffPassword, setStaffPassword] = useState<string>('');
  const [staffApiError, setStaffApiError] = useState<string | null>(null);
  // The walk-in grid's own load error: kept apart from staffApiError, which
  // the main load clears on success - sharing one made the banner flicker
  // on and off with whichever load finished last.
  const [gridError, setGridError] = useState<string | null>(null);
  const [reviewQueue, setReviewQueue] = useState<api.PaymentForReview[]>([]);
  // The slip version (upload time) each card first showed staff. Approve and
  // reject send this, not the latest reloaded one: the queue refreshes every
  // 15 s, and a slip the customer replaced while staff were checking the old
  // one in another tab must not be approved unseen - the server refuses the
  // mismatch, and the card asks staff to look at the new slip first.
  const [seenSlip, setSeenSlip] = useState<Record<string, string | undefined>>({});
  useEffect(() => {
    setSeenSlip(prev => {
      const missing = reviewQueue.filter(r => !(r.payment.id in prev));
      if (missing.length === 0) return prev;
      const next = { ...prev };
      missing.forEach(r => { next[r.payment.id] = r.payment.slipUploadedAt; });
      return next;
    });
  }, [reviewQueue]);
  const slipVersionShown = (paymentId: string) =>
    paymentId in seenSlip ? seenSlip[paymentId] : reviewQueue.find(r => r.payment.id === paymentId)?.payment.slipUploadedAt;
  // API mode: today's booking money by method, for the cash-drawer report.
  const [daySummary, setDaySummary] = useState<api.DaySummary | null>(null);
  // API mode: today's bookings for the day report - `bookings` holds the
  // walk-in tab's chosen date, which need not be today.
  const [todayBookingsApi, setTodayBookingsApi] = useState<Booking[]>([]);
  // Reward voucher check at the counter (FR-4.3).
  const [voucherCode, setVoucherCode] = useState<string>('');
  const [voucherFound, setVoucherFound] = useState<{ code: string; reward: string; customer: string; name: string; phone: string; freeHour: boolean; status: string; expires?: string } | null>(null);
  const [voucherError, setVoucherError] = useState<string | null>(null);

  // Effects key on the id and role, not the object: the session check below
  // replaces staffUser with the server's fresh copy on every refresh.
  const staffUserId = staffUser?.id;
  const staffRole = staffUser?.role;
  // Live data: reload every 15 s while the screen is visible (new slips,
  // other counters' bookings and sales) and when staff come back to it.
  const liveTick = useLiveTick(15000);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  useLiveLoad(isCurrent => {
    if (!api.USE_BACKEND || !staffUserId) return;
    const isManager = can(staffUser, 'view_reports');
    return Promise.all([api.listPaymentsForReview(), api.daySummary(getTodayDateStr()), api.listProducts(), api.listOrders(getTodayDateStr()), api.activeRentals(),
      api.currentShift(), isManager ? api.listShifts() : Promise.resolve([] as api.ShiftView[]), api.listBookingsByDate(getTodayDateStr(), 'staff')])
      .then(([queue, summary, prods, dayOrders, rentals, openShift, history, todays]) => {
        if (!isCurrent()) return;
        setTodayBookingsApi(todays);
        setShift(openShift);
        setShiftHistory(history);
        setReviewQueue(queue);
        setDaySummary(summary);
        setProducts(prods);
        setOrders(dayOrders);
        setActiveRentalOrders(rentals);
        setStaffApiError(null);
        setLastSyncAt(Date.now());
      })
      .catch(err => {
        if (!isCurrent()) return;
        if (err instanceof api.ApiError && err.status === 401) setStaffUser(null);
        setStaffApiError(err.message);
      });
  }, [triggerRefresh, staffUserId, staffRole], liveTick);

  // API mode: the walk-in grid shows the backend's bookings for the chosen
  // date (online + walk-in), so the counter can't sell a slot that was
  // already booked online. Also re-validates the staff session.
  useLiveLoad(async isCurrent => {
    if (!api.USE_BACKEND || !staffUserId || !walkinDate) return;
    try {
      const me = await api.refreshMe('staff');
      if (!isCurrent()) return;
      if (!me || !canUseCounter(me)) {
        // Signed out, or the role lost its counter permissions.
        setStaffUser(null);
        setStaffApiError('เซสชันพนักงานหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
        return;
      }
      // Name or role changed by an admin since sign-in.
      setStaffUser(me);
      const [apiCourts, dayBookings, closures] = await Promise.all([
        api.listCourts(),
        api.listBookingsByDate(walkinDate, 'staff'),
        api.listDaysOff(walkinDate, walkinDate),
        // Price previews read it; a failure here mustn't block the grid.
        api.syncPricingCache().catch(() => undefined)
      ]);
      if (!isCurrent()) return;
      setCourts(apiCourts);
      setBookings(dayBookings);
      setDaysOff(closures);
      setLoadedDate(walkinDate);
      setGridError(null);
    } catch (err) {
      if (isCurrent()) setGridError(err instanceof Error ? err.message : String(err));
    }
  }, [triggerRefresh, staffUserId, walkinDate], liveTick);

  const handleStaffLogin = (e: React.FormEvent) => {
    e.preventDefault();
    staffLoginWith(staffIdentity, staffPassword);
  };

  const staffLoginWith = (identity: string, password: string) => {
    setStaffApiError(null);
    api.login('staff', identity, password)
      .then(user => {
        if (!canUseCounter(user)) {
          setStaffApiError('บัญชีนี้ไม่มีสิทธิ์ใช้หน้าเคาน์เตอร์ - เข้าสู่ระบบด้วยบัญชีพนักงาน');
          return;
        }
        setStaffUser(user);
        setStaffIdentity('');
        setStaffPassword('');
      })
      .catch(err => setStaffApiError(err.message));
  };

  // Nothing of the last staff member's session is left on screen for the
  // next one.
  const handleStaffLogout = () => {
    api.logout('staff');
    setStaffUser(null);
    setReviewQueue([]);
    setSeenSlip({});
    setGridError(null);
    setStaffApiError(null);
    setDaySummary(null);
    setTodayBookingsApi([]);
    setShift(null);
    setShiftHistory([]);
    setClosedShift(null);
    setCountLocked(false);
    setPendingWalkin(null);
    setSelectedReceiptBooking(null);
    setSelectedReceiptOrder(null);
    setCartItems([]);
    setVoucherCode('');
    setVoucherFound(null);
    setVoucherError(null);
    setRejectId(null);
    setRejectReason('');
    setWalkinSuccessAlert(null);
    setCartSuccessAlert(null);
  };

  // Load everything
  useEffect(() => {
    const rawCourts = StorageService.get<Court[]>('courts', []);
    const rawBookings = StorageService.get<Booking[]>('bookings', []);
    const rawPayments = StorageService.get<Payment[]>('payments', []);
    const rawProducts = StorageService.get<Product[]>('products', []);
    const rawOrders = StorageService.get<Order[]>('orders', []);
    const rawDaysOff = StorageService.get<DayOff[]>('days_off', []);
    const rawUsers = StorageService.get<User[]>('users', []);

    // In API mode courts/bookings come from the backend (effect above).
    if (!api.USE_BACKEND) {
      setCourts(rawCourts.filter(c => c.isActive));
      setBookings(rawBookings);
    }
    setPayments(rawPayments);
    // In API mode products and orders come from the backend (effect above).
    if (!api.USE_BACKEND) {
      const shifts = StorageService.get<Shift[]>('shifts', []).map(sh => localShiftView(sh, rawPayments, rawOrders));
      setShift(shifts.find(sh => !sh.closedAt) || null);
      setShiftHistory(shifts.filter(sh => sh.closedAt).reverse());
      setProducts(rawProducts.filter(p => p.isActive));
      setOrders(rawOrders);
      setActiveRentalOrders(rawOrders.filter(o => o.type === OrderType.EQUIPMENT_RENT && o.status === OrderStatus.PREPARING));
    }
    if (!api.USE_BACKEND) setDaysOff(rawDaysOff);
    setUsers(rawUsers);

    // Default to today, but keep the date staff picked across refreshes
    // (every booking action triggers one, which used to jump back to today).
    setWalkinDate(prev => prev || getTodayDateStr());

  }, [triggerRefresh, liveTick]);

  // Handle first load of selections
  useEffect(() => {
    if (courts.length > 0 && !walkinCourtId) {
      setWalkinCourtId(courts[0].id);
    }
    const rentalProducts = products.filter(p => p.isRental);
    if (rentalProducts.length > 0 && !selectedProductId) {
      setSelectedProductId(rentalProducts[0].id);
    }
  }, [courts, products]);

  // A PromptPay walk-in left waiting can be settled elsewhere - approved in
  // the slip queue, cancelled, or expired after the payment hold - and would
  // then block every new walk-in. Drop it once its payment is no longer
  // waiting (API mode: as seen in the walk-in date's bookings).
  // Until the reloaded lists include it, its absence means nothing.
  const pendingSeen = React.useRef(false);
  useEffect(() => {
    if (!pendingWalkin) { pendingSeen.current = false; return; }
    let status: PaymentStatus | undefined;
    let present: boolean;
    if (api.USE_BACKEND) {
      if (walkinDate !== pendingWalkin.date) return;
      // Cancelled rows are left out of the list.
      const row = bookings.find(b => b.bookingCode === pendingWalkin.bookingCode);
      present = !!row;
      status = row?.paymentStatus;
    } else {
      const pay = payments.find(p => p.id === pendingWalkin.paymentId);
      present = !!pay;
      status = pay?.status;
    }
    if (present) pendingSeen.current = true;
    if ((pendingSeen.current && !present) || (status && status !== PaymentStatus.PENDING)) setPendingWalkin(null);
  }, [bookings, payments, pendingWalkin, walkinDate]);

  // Standard line push simulation
  const pushLineMessage = (phone: string, text: string, type: "CREATED" | "CONFIRMED" | "REMINDER" | "CANCELLED") => {
    const rawLine = StorageService.get<LineMessage[]>('line_messages', []);
    const newMsg = {
      id: 'lm-' + Date.now(),
      timestamp: new Date().toISOString(),
      recipientPhone: phone,
      recipientName: 'ลูกค้า',
      type,
      text
    };
    StorageService.set('line_messages', [newMsg, ...rawLine]);
  };

  // A used free-hour voucher: clear the voucher check (it would still show
  // the code as usable) and go back to the default payment method.
  const resetVoucherCheck = () => {
    setVoucherCode('');
    setVoucherFound(null);
    setVoucherError(null);
    setWalkinPayMethod(PaymentMethod.PROMPTPAY);
  };

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

  // Managers/admins may cancel, refund and record cash (FR-6.3); every
  // staff member may mark a no-show. API mode: the signed-in staff account's
  // role; browser-only mode: the role switcher.
  // Who is acting: the signed-in account (API mode) or the demo role picked
  // in the switcher (browser-only mode, built-in role permissions).
  const actingUser = api.USE_BACKEND ? staffUser : { role: currentUserRole };
  const canManageBookings = can(actingUser, 'cancel_refund');
  // Each counter tab needs one of these permissions; tabs a role lacks are
  // hidden, and the panel opens on the first tab it may use.
  const TAB_PERMISSIONS: Record<typeof activePosTab, Permission[]> = {
    walkin: ['counter_bookings'], slips: ['verify_slips'], fb: ['sell_rent'], rentals: ['sell_rent'],
    vouchers: ['sell_rent', 'counter_bookings'], todays_total: ['day_summary', 'shifts']
  };
  const tabAllowed = (t: typeof activePosTab) => can(actingUser, ...TAB_PERMISSIONS[t]);
  const firstAllowedTab = (Object.keys(TAB_PERMISSIONS) as (typeof activePosTab)[]).find(tabAllowed);
  useEffect(() => {
    if (!tabAllowed(activePosTab) && firstAllowedTab) setActivePosTab(firstAllowedTab);
  }, [activePosTab, firstAllowedTab]);
  // Blind cash count (owner decision 2026-10-21): counter staff count the
  // drawer without seeing what it should hold; managers/admins see it. In
  // API mode the server withholds the figures (shift.blind).
  const blindCount = api.USE_BACKEND ? !!shift?.blind : !can(actingUser, 'view_reports');
  // Once a blind count is confirmed it can't be changed (only explained).
  const [countLocked, setCountLocked] = useState(false);

  const closeBookingDetail = () => {
    setSelectedReceiptBooking(null);
    setSelectedReceiptOrder(null);
  };

  // Cash only with a drawer shift open (owner decision 2026-10-21): cash
  // taken outside a shift is in no shift's count, so the drawer never adds
  // up. The server refuses it too. Offers to go and open the shift.
  // Take staff to the shift box: switch tab, scroll it into view (on a
  // short screen it opens below the fold) and put the cursor in the float.
  const goOpenShift = () => {
    setActivePosTab('todays_total');
    setTimeout(() => {
      document.getElementById('shift-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      document.getElementById('shift-float')?.focus({ preventScroll: true });
    }, 50);
  };
  const confirmCashWithoutShift = async (): Promise<boolean> => {
    if (shift) return true;
    if (await ask('ต้องเปิดกะลิ้นชักก่อนรับเงินสด\nนับเงินทอนในลิ้นชัก แล้วกด "เปิดกะ" ที่แท็บ "ยอดลิ้นชักวันนี้"',
      { title: '⚠️ ยังไม่ได้เปิดกะ', okLabel: 'ไปเปิดกะ', cancelLabel: 'ปิด' })) {
      goOpenShift();
    }
    return false;
  };

  // One counter action at a time: a double click or an impatient second tap
  // must not send the same sale, booking or refund twice. Wraps the button
  // handlers (not the handlers they call), and `busy` greys the buttons.
  const busyRef = React.useRef(false);
  const [busy, setBusy] = useState(false);
  const guarded = <A extends unknown[]>(fn: (...args: A) => unknown) => async (...args: A) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await fn(...args); } finally { busyRef.current = false; setBusy(false); }
  };

  // Manager/admin cancellation of a booking (this hour or the whole group),
  // optionally recording a refund of what was paid. Reason required.
  // Every booking row this screen has loaded: in API mode the walk-in
  // tab's date plus today's (the day report); a booking opened from either
  // list finds its whole group here.
  const bookingPool = (): Booking[] => api.USE_BACKEND
    ? [...new Map([...bookings, ...todayBookingsApi].map(x => [x.id, x])).values()]
    : StorageService.get<Booking[]>('bookings', []);

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
      message: `${booking.date} ${booking.startTime}-${booking.endTime} · ${booking.userName}`,
      input: { label: 'เหตุผล (จำเป็น - บันทึกใน Audit Log)', required: true },
      choices: group.length > 1 ? [
        { value: 'all', label: `ยกเลิกทั้งหมด ${group.length} ชั่วโมง` },
        { value: 'one', label: `ยกเลิกเฉพาะ ${booking.startTime}-${booking.endTime}` }
      ] : undefined,
      checkbox: groupPaid > 0 ? {
        label: `บันทึกว่าคืนเงินค่าสนามที่${slipIn ? 'ลูกค้าโอนมาแล้ว (สลิปรอตรวจ)' : 'ชำระแล้ว'} (โอนคืนลูกค้าเอง) — ${group.length > 1 ? `ทั้งหมด ${formatBaht(groupPaid)} / ชั่วโมงนี้ ${formatBaht(hourPaid)}` : formatBaht(groupPaid)} บาท`,
        defaultChecked: true
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
      return api.cancelBooking(booking.id, reason, refund, wholeGroup ? undefined : [booking.id])
        .then(res => {
          onAddAuditLog('BOOKING_CANCELLED_BY_MANAGER', 'Booking', booking.id, null, { ...res, reason });
          closeBookingDetail();
          onRefreshAll();
          notify(`ยกเลิก ${res.cancelled} ชั่วโมงแล้ว${res.refundAmount ? ` · บันทึกคืนเงิน ${formatBaht(res.refundAmount)} บาท` : ''}${res.pointsReversed ? ` · หักแต้มคืน ${res.pointsReversed}` : ''}${res.cancelledVouchers.length ? `\nยกเลิกคูปองที่แลกด้วยแต้มนี้: ${res.cancelledVouchers.join(', ')}` : ''}${res.pointsShort ? `\n⚠️ ลูกค้าใช้แต้ม ${res.pointsShort} แต้มแลกของรางวัลที่รับไปแล้ว หักคืนไม่ได้` : ''}`);
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
    const reversed = paidPointRows.length ? StorageService.addLedgerEntry(booking.userId, LedgerEntryType.REVERSE_BOOKING, -paidPointRows.length, 'manager', { note: `${paidPointRows.length}h of ${booking.bookingCode} cancelled: ${reason}` }) : 0;
    onAddAuditLog('BOOKING_CANCELLED_BY_MANAGER', 'Booking', booking.id, null, { cancelled: target.length, refund, refundAmount: refund ? refundAmount : 0, reason });
    closeBookingDetail();
    onRefreshAll();
    notify(`ยกเลิก ${target.length} ชั่วโมงแล้ว${refund ? ` · บันทึกคืนเงิน ${formatBaht(refundAmount)} บาท` : ''}${reversed ? ` · หักแต้มคืน ${-reversed}` : ''}`);
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

  // Manager/admin refund of a payment with no booking standing for it -
  // e.g. a late payment whose slot was taken meanwhile.
  const handleRefundPayment = async (pay: Payment) => {
    const reason = await askText(`เหตุผลการคืนเงิน ${formatBaht(pay.amount - (pay.refundAmount || 0))} บาท (จำเป็น):`, { title: '💸 คืนเงิน', okLabel: 'บันทึกคืนเงิน' });
    if (!reason) return;
    if (api.USE_BACKEND) {
      return api.refundPayment(pay.id, reason)
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
          refundedAt: at, refunds: [...(p.refunds || []), { amount, at }] } : p));
    onAddAuditLog('PAYMENT_REFUNDED', 'Payment', pay.id, null, { refundAmount: amount, reason });
    onRefreshAll();
  };

  // Reward voucher check: look the code up, then mark it handed over.
  // Browser-only mode keeps vouchers in localStorage ("redemptions").
  const handleLookupVoucher = () => {
    setVoucherError(null);
    setVoucherFound(null);
    const code = voucherCode.trim().toUpperCase();
    if (!code) return;
    if (api.USE_BACKEND) {
      return api.lookupVoucher(code)
        .then(v => setVoucherFound({ code: v.code, reward: `${v.rewardEmoji} ${v.rewardName}`, customer: `${v.userName || ''} ${v.userPhone || ''}`,
          name: v.userName || '', phone: v.userPhone || '', freeHour: v.rewardKind === 'FREE_OFFPEAK_HOUR', status: v.status,
          expires: formatDate(v.expiresAt) }))
        .catch(err => setVoucherError(err instanceof api.ApiError && err.status === 404 ? 'ไม่พบรหัสนี้' : err.message));
    }
    const v = StorageService.get<LocalVoucher[]>('redemptions', []).find(r => r.claimCode === code);
    if (!v) { setVoucherError('ไม่พบรหัสนี้'); return; }
    const owner = StorageService.get<User[]>('users', []).find(u => u.id === v.userId);
    setVoucherFound({ code: v.claimCode, reward: v.rewardName, customer: `${v.userName} ${owner?.phone || ''}`, name: owner?.name || v.userName,
      phone: owner?.phone || '', freeHour: FREE_HOUR_REWARD_IDS.includes(v.rewardId), status: v.status || 'ACTIVE' });
  };

  // A free off-peak hour is used by booking it: open the walk-in form with
  // the voucher and the customer filled in; staff pick the court and hour.
  const handleUseFreeHourVoucher = () => {
    if (!voucherFound) return;
    setWalkinPayMethod(PaymentMethod.VOUCHER);
    setWalkinVoucherCode(voucherFound.code);
    setWalkinName(voucherFound.name);
    setWalkinPhone(voucherFound.phone);
    setActivePosTab('walkin');
  };

  const handleDispenseVoucher = () => {
    if (!voucherFound) return;
    const code = voucherFound.code;
    const done = () => {
      onAddAuditLog('VOUCHER_DISPENSED', 'Voucher', code, { status: 'ACTIVE' }, { status: 'REDEEMED' });
      setVoucherFound({ ...voucherFound, status: 'REDEEMED' });
      notify(`มอบของรางวัล ${voucherFound.reward} แล้ว`);
    };
    if (api.USE_BACKEND) {
      return api.dispenseVoucher(code).then(done).catch(err => setVoucherError(err.message));
    }
    const list = StorageService.get<LocalVoucher[]>('redemptions', []);
    if (list.find(r => r.claimCode === code)?.status === 'REDEEMED') { setVoucherError('รหัสนี้รับของไปแล้ว'); return; }
    StorageService.set('redemptions', list.map(r => r.claimCode === code ? { ...r, status: 'REDEEMED', dispensedAt: new Date().toISOString() } : r));
    done();
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

  // F&B Add to Receipt Cart
  const handleAddToCart = (product: Product) => {
    if (product.stock <= 0) {
      notify('ขออภัยค่ะ! สินค้าชิ้นนี้หมดคลังชั่วคราว ขัดข้องการเช็กเอาท์');
      return;
    }

    const exists = cartItems.find(item => item.product.id === product.id);
    if (exists) {
      if (exists.qty >= product.stock) {
        notify('ไม่สามารถเพิ่มได้เกินจำนวนสินค้าที่มีอยู่ในระบบคลัง');
        return;
      }
      setCartItems(cartItems.map(item => 
        item.product.id === product.id ? { ...item, qty: item.qty + 1 } : item
      ));
    } else {
      setCartItems([...cartItems, { product, qty: 1 }]);
    }
  };

  const handleUpdateCartQty = (productId: string, val: number) => {
    const matched = cartItems.find(item => item.product.id === productId);
    if (!matched) return;
    
    const newQty = matched.qty + val;
    if (newQty <= 0) {
      setCartItems(cartItems.filter(item => item.product.id !== productId));
    } else {
      if (newQty > matched.product.stock) {
        notify('จำนวนเกินสินค้าที่มีในตู้แช่/คลัง');
        return;
      }
      setCartItems(cartItems.map(item => 
        item.product.id === productId ? { ...item, qty: newQty } : item
      ));
    }
  };

  // Checkout of the cart (F&B and/or equipment for sale). An all-equipment
  // cart is recorded as an equipment sale, anything else as F&B.
  const handleCartCheckout = async () => {
    if (cartItems.length === 0) {
      notify('รถเข็นใบเสร็จว่างเปล่า! กรุณากดสินค้าเติมตระกร้า');
      return;
    }
    if (cartPayMethod === PaymentMethod.CASH && !(await confirmCashWithoutShift())) return;
    const type = cartItems.every(i => i.product.category === ProductCat.EQUIPMENT) ? OrderType.EQUIPMENT_SALE : OrderType.FB;
    const done = (orderCode: string, total: number) => {
      setCartItems([]);
      setCartCustomerName('');
      setCartCourtId('');
      setCartCustomerPhone('');
      setCartMember(null);
      setCartSuccessAlert(`ใบเสร็จ ${orderCode} ตัดสต๊อกเรียบร้อย! ชำระผ่าน ${cartPayMethod === PaymentMethod.CASH ? 'เงินสด' : 'โอน/พร้อมเพย์'} ยอดเงิน ${formatBaht(total)} บาท`);
      onRefreshAll();
    };

    if (api.USE_BACKEND) {
      // The server prices the items, checks and takes the stock, and
      // credits the customer with this phone.
      cartActionId.current ||= api.newActionId();
      return api.checkout({
        type, paymentMethod: cartPayMethod, customerName: cartCustomerName, customerPhone: cartCustomerPhone,
        courtId: cartCourtId || undefined, items: cartItems.map(i => ({ productId: i.product.id, qty: i.qty })),
        idempotencyKey: cartActionId.current
      })
        .then(r => {
          cartActionId.current = '';
          onAddAuditLog('ORDER_CREATED_BY_STAFF', 'Order', r.order.id, null, { orderCode: r.order.orderCode, total: r.order.totalAmount });
          done(r.order.orderCode, r.order.totalAmount);
        })
        .catch(err => { notify(`ขายไม่สำเร็จ: ${err.message}`); onRefreshAll(); });
    }

    // Browser-only mode: same rules on localStorage, with fresh stock.
    const rawProducts = StorageService.get<Product[]>('products', []);
    for (const item of cartItems) {
      const live = rawProducts.find(p => p.id === item.product.id);
      if (!live || live.stock < item.qty) {
        notify(`${item.product.name}: เหลือในคลัง ${live?.stock ?? 0} ชิ้น`);
        return;
      }
    }
    const totalAmount = roundBaht(cartItems.reduce((acc, current) => acc + (current.product.price * current.qty), 0));
    const orderId = 'o-' + Date.now();
    const orderCode = `OD${getTodayDateStr().replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;
    const customer = cartCustomerPhone.trim()
      ? users.find(u => u.role === UserRole.CUSTOMER && normalizePhone(u.phone) === normalizePhone(cartCustomerPhone))
      : undefined;

    const newOrder: Order = {
      id: orderId,
      orderCode,
      userId: customer?.id,
      customerName: cartCustomerName || customer?.name || 'ลูกค้าทั่วไป (Walk-in)',
      courtId: cartCourtId || undefined,
      type,
      status: OrderStatus.DELIVERED,
      totalAmount,
      paidAmount: totalAmount,
      paymentMethod: cartPayMethod,
      createdAt: new Date().toISOString(),
      createdBy: 'u-staff-1',
      items: cartItems.map(item => ({
        id: 'oi-' + Math.random().toString(36).substring(7),
        orderId,
        productId: item.product.id,
        qty: item.qty,
        unitPrice: item.product.price
      }))
    };
    StorageService.set('products', rawProducts.map(p => {
      const match = cartItems.find(item => item.product.id === p.id);
      return match ? { ...p, stock: p.stock - match.qty } : p;
    }));
    StorageService.set('orders', [...StorageService.get<Order[]>('orders', []), newOrder]);
    onAddAuditLog('ORDER_CREATED_BY_STAFF', 'Order', orderId, null, newOrder);
    done(orderCode, totalAmount);
  };

  // Equipment rental (FR-5.3): the catalog price, one item; shoes by size.
  const handleRentalRentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProductId) {
      notify('กรุณาเลือกชนิดอุปกรณ์กีฬา');
      return;
    }
    const prodObj = products.find(p => p.id === selectedProductId);
    if (!prodObj || prodObj.stock <= 0) {
      notify('ของเช่าชิ้นนี้หมดชั่วคราว กรุณาติดต่อฝั่งสนาม');
      return;
    }
    const variant = prodObj.variants?.find(v => v.id === rentalVariantId);
    if (prodObj.variants?.length && !variant) {
      notify('กรุณาเลือกเบอร์รองเท้า');
      return;
    }
    if (variant && variant.stock <= 0) {
      notify(`ขออภัยค่ะ! รองเท้า${variant.gender === 'F' ? 'หญิง' : 'ชาย'} เบอร์ ${variant.label} ถูกยืมหมดแล้ว`);
      return;
    }
    if (!(await confirmCashWithoutShift())) return; // rentals are paid in cash
    const sizeNote = variant ? ` (รองเท้า${variant.gender === 'F' ? 'หญิง' : 'ชาย'} เบอร์ ${variant.label})` : '';
    // Fee and deposit as recorded (the server's, in API mode).
    const done = (orderCode: string, fee = prodObj.price, dep = roundBaht(prodObj.deposit ?? 0)) => {
      setRentalCourtId('');
      setRentalCustomerPhone('');
      setRentalMember(null);
      setRentalVariantId('');
      onRefreshAll();
      notify(`ปล่อยเช่าสำเร็จ! รหัสทำรายการเช่า ${orderCode}${sizeNote}${dep > 0 ? `\nเก็บเงินสด ${formatBaht(fee + dep)} บาท (ค่าเช่า ${formatBaht(fee)} + มัดจำ ${formatBaht(dep)} คืนตอนคืนของ)` : ''}`);
    };

    if (api.USE_BACKEND) {
      rentalActionId.current ||= api.newActionId();
      return api.checkout({
        type: OrderType.EQUIPMENT_RENT, paymentMethod: PaymentMethod.CASH, customerName: '', // the server uses the member's name, or "walk-in"
        customerPhone: rentalCustomerPhone, courtId: rentalCourtId || undefined,
        items: [{ productId: prodObj.id, variantId: variant?.id, qty: 1 }],
        idempotencyKey: rentalActionId.current
      })
        .then(r => {
          rentalActionId.current = '';
          onAddAuditLog('RENTAL_CREATED_BY_STAFF', 'Order', r.order.id, null, { orderCode: r.order.orderCode });
          done(r.order.orderCode, r.order.totalAmount, r.order.depositAmount ?? 0);
        })
        .catch(err => { notify(`ปล่อยเช่าไม่สำเร็จ: ${err.message}`); onRefreshAll(); });
    }

    const orderId = 'o-rental-' + Date.now();
    const orderCode = `OD-RENT-${getTodayDateStr().replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;
    const customer = rentalCustomerPhone.trim()
      ? users.find(u => u.role === UserRole.CUSTOMER && normalizePhone(u.phone) === normalizePhone(rentalCustomerPhone))
      : undefined;
    const newOrder: Order = {
      id: orderId,
      orderCode,
      userId: customer?.id,
      customerName: customer?.name ?? 'ลูกค้าทั่วไป (Walk-in)',
      courtId: rentalCourtId || undefined,
      type: OrderType.EQUIPMENT_RENT,
      status: OrderStatus.PREPARING, // out on rent until returned
      totalAmount: prodObj.price,
      paidAmount: prodObj.price,
      depositAmount: prodObj.deposit ?? 0,
      paymentMethod: PaymentMethod.CASH,
      createdAt: new Date().toISOString(),
      createdBy: 'u-staff-1',
      items: [{
        id: 'oi-rent-' + Math.random().toString(36).substring(7),
        orderId,
        productId: prodObj.id,
        variantId: variant?.id,
        qty: 1,
        unitPrice: prodObj.price,
        shoeSize: variant?.label,
        shoeGender: variant?.gender === 'U' ? undefined : variant?.gender
      }]
    };
    StorageService.set('products', StorageService.get<Product[]>('products', []).map(p => p.id !== prodObj.id ? p : {
      ...p,
      stock: p.stock - 1,
      variants: p.variants?.map(v => v.id === variant?.id ? { ...v, stock: v.stock - 1 } : v)
    }));
    StorageService.set('orders', [...StorageService.get<Order[]>('orders', []), newOrder]);
    onAddAuditLog('RENTAL_CREATED_BY_STAFF', 'Order', orderId, null, newOrder);
    done(orderCode);
  };

  // A rented item is back: restock it (its size, for shoes); the rental
  // closes once every item is back.
  // The last item back settles the deposit: given back, or partly/fully
  // kept for damage or loss (with a reason).
  const handleReturnItem = async (orderId: string, itemId: string) => {
    const ord = api.USE_BACKEND ? activeRentalOrders.find(o => o.id === orderId)
      : StorageService.get<Order[]>('orders', []).find(o => o.id === orderId);
    const deposit = ord?.depositAmount ?? 0;
    const settles = !!ord && deposit > 0 && !ord.depositSettledAt && ord.items.every(it => it.id === itemId || it.returnedAt);
    let keep = 0, note = '';
    if (settles) {
      const raw = await askText(`คืนมัดจำ ${formatBaht(deposit)} บาท ให้ลูกค้า\nถ้าของเสียหาย/สูญหาย ใส่ยอดที่หักไว้ (0 = คืนเต็ม)`,
        { title: 'คืนมัดจำ', defaultValue: '0', required: true, okLabel: 'ต่อไป' });
      if (raw === null) return;
      keep = Number(raw.trim());
      if (!Number.isFinite(keep) || keep < 0 || keep > deposit) {
        notify(`ยอดที่หักต้องอยู่ระหว่าง 0 - ${formatBaht(deposit)} บาท`);
        return;
      }
      if (keep > 0) {
        const r = await askText(`เหตุผลที่หักมัดจำ ${formatBaht(keep)} บาท (จำเป็น):`, { title: 'หักมัดจำ', required: true, okLabel: 'บันทึก' });
        if (!r?.trim()) return;
        note = r.trim();
      }
    }
    const back = roundBaht(deposit - keep);
    if (settles && back > 0 && !(await confirmCashWithoutShift())) return; // the deposit comes out of the drawer
    const doneMsg = settles
      ? `บันทึกคืนอุปกรณ์แล้ว — คืนมัดจำ ${formatBaht(back)} บาท${keep > 0 ? ` (หักไว้ ${formatBaht(keep)} บาท: ${note})` : ''}`
      : 'บันทึกการส่งคืนอุปกรณ์เข้าคลังเรียบร้อย';
    if (api.USE_BACKEND) {
      return api.returnRentalItem(itemId, keep, note)
        .then(o => {
          onAddAuditLog('RENTAL_RETURNED_BY_STAFF', 'Order', o.id, null, { item: itemId, status: o.status, depositReturned: o.depositReturned, depositKept: o.depositKept });
          onRefreshAll();
          // What the server recorded - another counter may have returned
          // the other items, so this return can settle the deposit even
          // when this screen didn't expect it.
          const settledNow = !!o.depositAmount && !!o.depositSettledAt && !ord?.depositSettledAt;
          notify(settledNow
            ? `บันทึกคืนอุปกรณ์แล้ว — คืนมัดจำ ${formatBaht(o.depositReturned ?? 0)} บาทให้ลูกค้า${o.depositKept ? ` (หักไว้ ${formatBaht(o.depositKept)} บาท${o.depositNote ? `: ${o.depositNote}` : ''})` : ''}`
            : doneMsg);
        })
        .catch(err => { notify(`บันทึกคืนไม่สำเร็จ: ${err.message}`); onRefreshAll(); });
    }
    const rawOrders = StorageService.get<Order[]>('orders', []);
    const orderObj = rawOrders.find(o => o.id === orderId);
    const itemRef = orderObj?.items.find(it => it.id === itemId);
    if (!orderObj || !itemRef || itemRef.returnedAt) return;
    const now = new Date().toISOString();
    StorageService.set('orders', rawOrders.map(o => {
      if (o.id !== orderId) return o;
      const items = o.items.map(it => it.id === itemId ? { ...it, returnedAt: now } : it);
      return { ...o, items, status: items.every(it => it.returnedAt) ? OrderStatus.DELIVERED : o.status,
        ...(settles ? { depositReturned: back, depositKept: keep, depositNote: note || undefined, depositSettledAt: now } : {}) };
    }));
    StorageService.set('products', StorageService.get<Product[]>('products', []).map(p => p.id !== itemRef.productId ? p : {
      ...p,
      stock: p.stock + itemRef.qty,
      variants: p.variants?.map(v => v.id === itemRef.variantId ? { ...v, stock: v.stock + itemRef.qty } : v)
    }));
    onAddAuditLog('RENTAL_RETURNED_BY_STAFF', 'Order', orderId, { item: itemId, returned: false }, { item: itemId, returned: true, depositReturned: back, depositKept: keep });
    onRefreshAll();
    notify(doneMsg);
  };

  // Calculate Ledger parameters (Module 3 Specification). Booking money is
  // counted when it was received: in API mode from the server's day summary
  // (payments approved today by method, refunds recorded today); in
  // browser-only mode from localStorage. Completed and no-show hours count
  // as paid like confirmed ones.
  // Open the drawer shift with the counted float (FR-6.1).
  const handleOpenShift = () => {
    const float = Number(shiftFloatInput);
    if (shiftFloatInput.trim() === '' || !(float >= 0)) {
      notify('กรุณากรอกเงินทอนตั้งต้นในลิ้นชัก (บาท)');
      return;
    }
    setClosedShift(null);
    if (api.USE_BACKEND) {
      return api.openShift(float).then(() => { setShiftFloatInput(''); onRefreshAll(); }).catch(err => notify(`เปิดกะไม่สำเร็จ: ${err.message}`));
    }
    const list = StorageService.get<Shift[]>('shifts', []);
    if (list.some(sh => !sh.closedAt)) { notify('มีกะที่เปิดอยู่แล้ว ปิดกะก่อน'); return; }
    const sh: Shift = { id: 'shf-' + Date.now(), staffId: 'u-staff-1', staffName: 'คุณ กิตติ (เดโม)', openedAt: new Date().toISOString(), openingFloat: roundBaht(float) };
    StorageService.set('shifts', [...list, sh]);
    onAddAuditLog('SHIFT_OPENED', 'Shift', sh.id, null, { openingFloat: sh.openingFloat });
    setShiftFloatInput('');
    onRefreshAll();
  };

  // Close it with the counted cash: expected vs counted = over/short (FR-6.2).
  const handleCloseShift = async () => {
    if (!shift) return;
    const counted = Number(shiftCountInput);
    if (shiftCountInput.trim() === '' || !(counted >= 0)) {
      notify('กรุณากรอกยอดเงินสดที่นับได้จริง');
      return;
    }
    if (blindCount) {
      // The count is committed before the expected amount is known; a
      // difference then needs a note, but the count stays as counted.
      if (!countLocked && !(await ask(`ยืนยันยอดเงินสดที่นับได้ ${formatBaht(counted)} บาท?\nหลังยืนยันจะแก้ยอดนับไม่ได้`, { title: 'ปิดกะ', okLabel: 'ยืนยันยอดนับ' }))) return;
      setCountLocked(true);
      return closeShiftWith(counted, shiftNote.trim());
    }
    // Managers see the expected amount. The one from the last load may be
    // stale (another counter took cash since) - confirm against the current one.
    let current = shift;
    if (api.USE_BACKEND) {
      try {
        const fresh = await api.currentShift();
        if (!fresh) { notify('กะนี้ถูกปิดไปแล้ว'); onRefreshAll(); return; }
        current = fresh;
        setShift(fresh);
      } catch (err) {
        notify(`โหลดยอดกะล่าสุดไม่สำเร็จ: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }
    const variance = roundBaht(counted - current.expected);
    if (variance !== 0 && !shiftNote.trim()) {
      notify(`ยอดนับ${variance > 0 ? 'เกิน' : 'ขาด'} ${formatBaht(Math.abs(variance))} บาท กรุณาใส่หมายเหตุอธิบาย`);
      return;
    }
    if (!(await ask(`ปิดกะ: คาดว่ามีเงินสด ${formatBaht(current.expected)} บาท นับได้ ${formatBaht(counted)} บาท (${variance === 0 ? 'ตรง' : variance > 0 ? `เกิน ${formatBaht(variance)}` : `ขาด ${formatBaht(-variance)}`})`, { okLabel: 'ปิดกะ' }))) return;
    return closeShiftWith(counted, shiftNote.trim());
  };

  // Closes with this count; a count that is off without a note asks for
  // the note (showing the difference) and tries again with the same count.
  const closeShiftWith = async (counted: number, note: string): Promise<void> => {
    if (!shift) return;
    const askNote = async (message: string) => {
      const n = await askText(`${message}\n(ยอดนับ ${formatBaht(counted)} บาท แก้ไม่ได้แล้ว)`, { title: 'ยอดนับไม่ตรง', okLabel: 'บันทึกและปิดกะ' });
      return n ? closeShiftWith(counted, n) : undefined;
    };
    const done = (closed: api.ShiftView) => {
      setClosedShift(closed);
      setShiftCountInput('');
      setShiftNote('');
      setCountLocked(false);
      onRefreshAll();
    };
    if (api.USE_BACKEND) {
      try {
        done(await api.closeShift(counted, note));
      } catch (err) {
        if (err instanceof api.ApiError && /the count is .* off/i.test(err.serverMessage)) return askNote(err.message);
        notify(`ปิดกะไม่สำเร็จ: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }
    const variance = roundBaht(counted - shift.expected);
    if (variance !== 0 && !note) {
      return askNote(`ยอดนับ${variance > 0 ? 'เกิน' : 'ขาด'} ${formatBaht(Math.abs(variance))} บาท กรุณาใส่หมายเหตุอธิบาย`);
    }
    const closedAt = new Date().toISOString();
    const closed: Shift = { ...shift, closedAt, countedCash: roundBaht(counted), expectedCash: shift.expected, varianceCash: variance, notes: note || undefined, closedByName: 'คุณ กิตติ (เดโม)' };
    StorageService.set('shifts', StorageService.get<Shift[]>('shifts', []).map(sh => sh.id === shift.id ? closed : sh));
    onAddAuditLog('SHIFT_CLOSED', 'Shift', shift.id, null, { expected: shift.expected, counted, variance });
    done({ ...shift, ...closed });
  };

  // Manager: void today's counter sale - stock and points back, out of the
  // drawer. Reason required.
  const handleVoidOrder = async (order: Order) => {
    const reason = await askText(`เหตุผลการยกเลิกบิล ${order.orderCode} (${formatBaht(order.totalAmount)} บาท)\nคืนเงินลูกค้าแล้วค่อยยืนยัน`, { title: '✖ ยกเลิกบิล', okLabel: 'ยกเลิกบิล' });
    if (!reason) return;
    if (api.USE_BACKEND) {
      return api.voidOrder(order.id, reason)
        .then(r => {
          onRefreshAll();
          notify(`ยกเลิกบิล ${order.orderCode} แล้ว (คืนสต๊อกและแต้ม)${r.cancelledVouchers.length ? `\nยกเลิกคูปองของรางวัลที่แลกด้วยแต้มจากบิลนี้: ${r.cancelledVouchers.join(', ')}` : ''}`);
        })
        .catch(err => notify(`ยกเลิกบิลไม่สำเร็จ: ${err.message}`));
    }
    if (localDateOf(order.createdAt) !== getTodayDateStr()) { notify('ยกเลิกได้เฉพาะบิลของวันนี้'); return; }
    // A cash sale counted in an already-closed shift can't leave that count.
    if (order.paymentMethod === PaymentMethod.CASH && StorageService.get<Shift[]>('shifts', []).some(sh =>
      sh.closedAt && order.createdAt >= sh.openedAt && order.createdAt <= sh.closedAt)) {
      notify('บิลเงินสดนี้อยู่ในกะที่ปิดไปแล้ว ยกเลิกไม่ได้');
      return;
    }
    const pts = Math.floor(order.totalAmount / 100);
    const cancelledCodes: string[] = [];
    if (order.userId && pts > 0) {
      // Points already spent: cancel unused rewards (newest first) to cover
      // them, as on the server; a reward already handed over blocks the void.
      const balance = StorageService.get<User[]>('users', []).find(u => u.id === order.userId)?.points ?? 0;
      let short = pts - balance;
      if (short > 0) {
        const vouchers = StorageService.get<LocalVoucher[]>('redemptions', []);
        const usable = vouchers.filter(v => v.userId === order.userId && (v.status || 'ACTIVE') === 'ACTIVE').reverse();
        const cancelIds = new Set<string>();
        for (const v of usable) {
          if (short <= 0) break;
          cancelIds.add(v.id);
          cancelledCodes.push(v.claimCode);
          short -= v.pointsSpent || 0;
        }
        if (short > 0) {
          notify('ลูกค้านำแต้มจากบิลนี้ไปแลกของรางวัลและรับของไปแล้ว — ยกเลิกบิลไม่ได้');
          return;
        }
        StorageService.set('redemptions', vouchers.map(v => cancelIds.has(v.id) ? { ...v, status: 'CANCELLED' } : v));
        for (const v of usable.filter(x => cancelIds.has(x.id))) {
          StorageService.addLedgerEntry(order.userId, LedgerEntryType.VOUCHER_CANCELLED, v.pointsSpent || 0, 'manager', { refType: 'Voucher', refId: v.id, note: `Voucher ${v.claimCode} cancelled: sale ${order.orderCode} voided` });
        }
      }
      StorageService.addLedgerEntry(order.userId, LedgerEntryType.REVERSE_PURCHASE, -pts, 'manager', { note: `Sale ${order.orderCode} voided: ${reason}` });
    }
    StorageService.set('products', StorageService.get<Product[]>('products', []).map(p => {
      const lines = order.items.filter(it => it.productId === p.id && !it.returnedAt);
      if (!lines.length) return p;
      return {
        ...p,
        stock: p.stock + lines.reduce((n, it) => n + it.qty, 0),
        variants: p.variants?.map(v => ({ ...v, stock: v.stock + lines.filter(it => it.variantId === v.id).reduce((n, it) => n + it.qty, 0) }))
      };
    }));
    StorageService.set('orders', StorageService.get<Order[]>('orders', []).map(o => o.id === order.id
      ? { ...o, status: OrderStatus.CANCELLED, voidedAt: new Date().toISOString(), voidReason: reason,
          // A voided rental gives its deposit back (as the server does).
          ...(o.depositAmount && !o.depositSettledAt
            ? { depositReturned: o.depositAmount, depositSettledAt: new Date().toISOString(), depositNote: 'voided' } : {}) } : o));
    onAddAuditLog('ORDER_VOIDED', 'Order', order.id, { status: order.status }, { status: OrderStatus.CANCELLED, reason });
    onRefreshAll();
    notify(`ยกเลิกบิล ${order.orderCode} แล้ว (คืนสต๊อกและแต้ม)${cancelledCodes.length ? `\nยกเลิกคูปองของรางวัลที่แลกด้วยแต้มจากบิลนี้: ${cancelledCodes.join(', ')}` : ''}`);
  };

  // Today's (Bangkok) non-cancelled counter orders. API mode loads only
  // today's; stored times are UTC, so compare by local calendar date.
  const todaysOrders = () => orders.filter(o => o.status !== OrderStatus.CANCELLED &&
    (api.USE_BACKEND || localDateOf(o.createdAt) === getTodayDateStr()));

  const todayBookingList = api.USE_BACKEND ? todayBookingsApi : bookings.filter(b => b.date === getTodayDateStr());

  // The open receipt: a booking's whole group (one receipt per payment),
  // how it was paid, and whether it is paid at all - an unpaid booking
  // gets no receipt.
  // Local mode stores a user id (older rows a name) as who took the money.
  const nameOfUser = (idOrName?: string) => idOrName ? StorageService.get<User[]>('users', []).find(u => u.id === idOrName)?.name ?? idOrName : undefined;
  const shop = businessInfo();
  const receipt = (() => {
    const b = selectedReceiptBooking;
    if (b) {
      const pool = bookingPool();
      const group = bookingGroupOf(b, pool).filter(x => x.status !== BookingStatus.CANCELLED);
      const rows = (group.length ? group : [b]).sort((x, y) => (x.startTime + x.courtId).localeCompare(y.startTime + y.courtId));
      const paidRows = rows.filter(isPaidBooking);
      const ids = new Set(bookingGroupOf(b, pool).map(x => x.id));
      const pay = api.USE_BACKEND ? undefined : payments.find(p => ids.has(p.bookingId) && p.verifiedAt);
      const method = api.USE_BACKEND ? b.paymentMethod : (pay ?? payments.find(p => ids.has(p.bookingId)))?.method;
      const cashier = api.USE_BACKEND ? b.paymentVerifiedByName : nameOfUser(pay?.verifiedBy);
      const paidAt = api.USE_BACKEND ? b.paymentVerifiedAt : pay?.verifiedAt;
      return { code: b.bookingCode, rows: paidRows.length ? paidRows : rows, total: roundBaht(paidRows.reduce((n, x) => n + x.totalAmount, 0)), method, paid: paidRows.length > 0, cashier, paidAt };
    }
    const o = selectedReceiptOrder;
    if (o) return { code: o.orderCode, rows: [] as Booking[], total: o.totalAmount, method: o.paymentMethod, paid: o.status !== OrderStatus.CANCELLED,
      cashier: (o as api.OrderWithNames).createdByName || nameOfUser(o.createdBy), paidAt: o.createdAt };
    return null;
  })();
  const METHOD_LABEL: Partial<Record<PaymentMethod, string>> = {
    [PaymentMethod.CASH]: 'เงินสด (CASH)',
    [PaymentMethod.PROMPTPAY]: 'โอนผ่านพร้อมเพย์ (PROMPTPAY)',
    [PaymentMethod.VOUCHER]: 'คูปองชั่วโมงฟรี (VOUCHER)'
  };
  const calculateLedger = () => {
    const todayStr = getTodayDateStr();
    const paidBookings = todayBookingList.filter(isPaidBooking);

    // Day's counter orders: from the server's summary in API mode.
    const dayOrders = todaysOrders();
    const sumOf = (list: Order[]) => list.reduce((sum, o) => sum + Number(o.totalAmount), 0);
    const fbIncome = roundBaht(api.USE_BACKEND ? (daySummary?.fbSales ?? 0) + (daySummary?.equipmentSales ?? 0)
      : sumOf(dayOrders.filter(o => o.type !== OrderType.EQUIPMENT_RENT)));
    const rentalIncome = roundBaht(api.USE_BACKEND ? daySummary?.rentalIncome ?? 0 : sumOf(dayOrders.filter(o => o.type === OrderType.EQUIPMENT_RENT)));
    const cashSumFromOrders = api.USE_BACKEND ? daySummary?.ordersCash ?? 0 : sumOf(dayOrders.filter(o => o.paymentMethod === PaymentMethod.CASH));
    const qrSumFromOrders = api.USE_BACKEND ? daySummary?.ordersPromptpay ?? 0 : sumOf(dayOrders.filter(o => o.paymentMethod === PaymentMethod.PROMPTPAY));

    let cashFromBookings = 0, qrFromBookings = 0, refundedCash = 0, refundedQr = 0, refundedNotReceived = 0;
    if (api.USE_BACKEND) {
      cashFromBookings = daySummary?.cashReceived ?? 0;
      qrFromBookings = daySummary?.promptpayVerified ?? 0;
      refundedCash = daySummary?.refundedCash ?? 0;
      refundedQr = daySummary?.refundedPromptpay ?? 0;
      refundedNotReceived = daySummary?.refundedNotReceived ?? 0;
    } else {
      // Money received today, whatever day it was for - as the server
      // counts it: payments approved today (refunded ones too, their refund
      // is counted separately).
      for (const p of payments) {
        if (!p.verifiedAt || localDateOf(p.verifiedAt) !== todayStr) continue;
        if (p.status !== PaymentStatus.VERIFIED && p.status !== PaymentStatus.REFUNDED) continue;
        if (p.method === PaymentMethod.CASH) cashFromBookings += p.amount;
        else if (p.method === PaymentMethod.PROMPTPAY) qrFromBookings += p.amount;
      }
      // Each refund on its own day (older data has only the running total),
      // split like the server: by method, and money never approved apart.
      for (const p of payments) {
        const today = p.refunds
          ? p.refunds.filter(r => localDateOf(r.at) === todayStr).reduce((n, r) => n + r.amount, 0)
          : (p.refundedAt && localDateOf(p.refundedAt) === todayStr ? p.refundAmount || 0 : 0);
        if (!p.verifiedAt) refundedNotReceived += today;
        else if (p.method === PaymentMethod.CASH) refundedCash += today;
        else refundedQr += today;
      }
    }
    const bookingIncome = roundBaht(cashFromBookings + qrFromBookings);

    return {
      bookingCount: api.USE_BACKEND ? daySummary?.paidBookings ?? paidBookings.length : paidBookings.length,
      walkinCount: paidBookings.filter(b => b.createdBy !== 'customer' && b.createdBy !== b.userId).length,
      bookingIncome,
      fbIncome,
      rentalIncome,
      cashExpected: roundBaht(cashFromBookings + cashSumFromOrders),
      qrExpected: roundBaht(qrFromBookings + qrSumFromOrders),
      refunded: roundBaht(refundedCash + refundedQr),
      refundedCash: roundBaht(refundedCash),
      refundedQr: roundBaht(refundedQr),
      refundedNotReceived: roundBaht(refundedNotReceived),
      totalExpected: roundBaht(bookingIncome + fbIncome + rentalIncome)
    };
  };

  // Slips verification target list
  const pendingSlipPayments = api.USE_BACKEND
    ? reviewQueue.map(r => r.payment)
    : payments.filter(p => p.status === PaymentStatus.SLIP_UPLOADED);
  // Bookings the slip queue can resolve payments against.
  const slipQueueBookings = api.USE_BACKEND ? reviewQueue.flatMap(r => r.bookings) : bookings;

  // API mode: everything on this panel acts as a staff member - sign in
  // with an account whose role may use the counter (one shared login).
  const signedInElsewhere = api.USE_BACKEND && !staffUser ? api.getSession('staff')?.user : null;
  return {
    currentUserRole,
    onAddAuditLog,
    triggerRefresh,
    onRefreshAll,
    courts,
    setCourts,
    bookings,
    setBookings,
    payments,
    setPayments,
    products,
    setProducts,
    orders,
    setOrders,
    daysOff,
    setDaysOff,
    users,
    setUsers,
    activePosTab,
    setActivePosTab,
    posGridSportType,
    setPosGridSportType,
    walkinCourtId,
    setWalkinCourtId,
    walkinDate,
    setWalkinDate,
    loadedDate,
    setLoadedDate,
    gridReady,
    walkinSlot,
    setWalkinSlot,
    walkinName,
    setWalkinName,
    walkinPhone,
    setWalkinPhone,
    cartActionId,
    rentalActionId,
    walkinMember,
    setWalkinMember,
    cartMember,
    setCartMember,
    rentalMember,
    setRentalMember,
    memberPhoneHandlers,
    walkinPayMethod,
    setWalkinPayMethod,
    walkinVoucherCode,
    setWalkinVoucherCode,
    walkinSuccessAlert,
    setWalkinSuccessAlert,
    pendingWalkin,
    setPendingWalkin,
    selectedReceiptBooking,
    setSelectedReceiptBooking,
    selectedReceiptOrder,
    setSelectedReceiptOrder,
    cartItems,
    setCartItems,
    cartCustomerName,
    setCartCustomerName,
    cartCourtId,
    setCartCourtId,
    cartPayMethod,
    setCartPayMethod,
    cartSuccessAlert,
    setCartSuccessAlert,
    cartCustomerPhone,
    setCartCustomerPhone,
    rentalCourtId,
    setRentalCourtId,
    selectedProductId,
    setSelectedProductId,
    rentalCustomerPhone,
    setRentalCustomerPhone,
    rentalShoeGender,
    setRentalShoeGender,
    rentalVariantId,
    setRentalVariantId,
    cartSig,
    activeRentalOrders,
    setActiveRentalOrders,
    shift,
    setShift,
    shiftHistory,
    setShiftHistory,
    shiftFloatInput,
    setShiftFloatInput,
    shiftCountInput,
    setShiftCountInput,
    shiftNote,
    setShiftNote,
    closedShift,
    setClosedShift,
    rejectId,
    setRejectId,
    rejectReason,
    setRejectReason,
    staffUser,
    setStaffUser,
    staffIdentity,
    setStaffIdentity,
    staffPassword,
    setStaffPassword,
    staffApiError,
    setStaffApiError,
    gridError,
    setGridError,
    reviewQueue,
    setReviewQueue,
    seenSlip,
    setSeenSlip,
    slipVersionShown,
    daySummary,
    setDaySummary,
    todayBookingsApi,
    setTodayBookingsApi,
    voucherCode,
    setVoucherCode,
    voucherFound,
    setVoucherFound,
    voucherError,
    setVoucherError,
    staffUserId,
    staffRole,
    liveTick,
    lastSyncAt,
    setLastSyncAt,
    handleStaffLogin,
    staffLoginWith,
    handleStaffLogout,
    pendingSeen,
    pushLineMessage,
    resetVoucherCheck,
    handleWalkinBookingSubmit,
    handleVerifySlip,
    handleRejectSlip,
    actingUser,
    canManageBookings,
    TAB_PERMISSIONS,
    tabAllowed,
    firstAllowedTab,
    blindCount,
    countLocked,
    setCountLocked,
    closeBookingDetail,
    goOpenShift,
    confirmCashWithoutShift,
    busyRef,
    busy,
    setBusy,
    guarded,
    bookingPool,
    handleCancelBooking,
    handleMarkPaidInCash,
    handleMarkNoShow,
    handleUndoNoShow,
    handleRefundPayment,
    handleLookupVoucher,
    handleUseFreeHourVoucher,
    handleDispenseVoucher,
    confirmPendingWalkin,
    cancelPendingWalkin,
    handleAddToCart,
    handleUpdateCartQty,
    handleCartCheckout,
    handleRentalRentSubmit,
    handleReturnItem,
    handleOpenShift,
    handleCloseShift,
    closeShiftWith,
    handleVoidOrder,
    todaysOrders,
    todayBookingList,
    nameOfUser,
    shop,
    receipt,
    METHOD_LABEL,
    calculateLedger,
    pendingSlipPayments,
    slipQueueBookings,
    signedInElsewhere
  };
}

export type StaffPOSState = ReturnType<typeof useStaffPOS>;
export const StaffPOSContext = createContext<StaffPOSState | null>(null);
export function useStaffPOSContext(): StaffPOSState {
  const value = useContext(StaffPOSContext);
  if (!value) throw new Error('useStaffPOSContext outside StaffPOS');
  return value;
}
