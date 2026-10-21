import React, { useState, useEffect } from 'react';
import { 
  Court, CourtType, Booking, BookingStatus, Payment, PaymentStatus,
  PaymentMethod, Product, ProductCat, Order, OrderStatus, OrderType, UserRole, PriceType, DayOff, User, MemberType, LedgerEntryType, Shift
} from '../types';
import { StorageService, findClosure, getTodayDateStr, calculatePrice, isHourOffPeak, FREE_HOUR_REWARD_IDS, isCourtSlotAvailable, findConflictingBooking, bookingGroupOf, normalizePhone, slotTiming, generatePromptPayPayload, LOCAL_PROMPTPAY_ID, openSlotHours, formatBaht, roundBaht, isPaidBooking, localDateOf, formatDate, formatDateTime, businessInfo, formatTaxId } from '../mockData';
import { QRCodeSVG } from 'qrcode.react';
import * as api from '../api';
import { notify, ask, askText, dialog } from './Dialog';
import DemoLogins, { DEMO_STAFF } from './DemoLogins';
import { Check, X, ShoppingCart, Activity, AlertTriangle, ShieldCheck, Receipt, Plus, Minus, CheckCircle2, AlertOctagon } from 'lucide-react';

interface StaffPOSProps {
  currentUserRole: UserRole;
  onAddAuditLog: (action: string, targetType: string, targetId: string, before?: any, after?: any) => void;
  triggerRefresh: number;
  onRefreshAll: () => void;
}

// Browser-only mode: a shift's cash taken (same rule as the server: cash
// payments approved and non-voided cash orders while the shift was open).
function localShiftView(sh: Shift, payments: Payment[], orders: Order[]): api.ShiftView {
  const from = sh.openedAt, to = sh.closedAt || '9999';
  const cashBookings = roundBaht(payments.filter(p => p.method === PaymentMethod.CASH && p.verifiedAt && p.verifiedAt >= from && p.verifiedAt < to &&
    (p.status === PaymentStatus.VERIFIED || p.status === PaymentStatus.REFUNDED)).reduce((n, p) => n + p.amount, 0));
  const cashOrders = roundBaht(orders.filter(o => o.paymentMethod === PaymentMethod.CASH && o.status !== OrderStatus.CANCELLED &&
    o.createdAt >= from && o.createdAt < to).reduce((n, o) => n + o.totalAmount, 0));
  return { ...sh, cashBookings, cashOrders, expected: sh.expectedCash ?? roundBaht(sh.openingFloat + cashBookings + cashOrders) };
}

// Browser-only mode keeps reward vouchers in localStorage ("redemptions").
interface LocalVoucher { id: string; claimCode: string; rewardId: string; rewardName: string; userId: string; userName: string; pointsSpent?: number; status?: string; bookingId?: string; dispensedAt?: string }

export default function StaffPOS({ currentUserRole, onAddAuditLog, triggerRefresh, onRefreshAll }: StaffPOSProps) {
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
  const [walkinSlot, setWalkinSlot] = useState<string>('');
  const [walkinName, setWalkinName] = useState<string>('');
  const [walkinPhone, setWalkinPhone] = useState<string>('');
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
  // A registered customer's phone: the sale earns them points (1 per 100 THB).
  const [cartCustomerPhone, setCartCustomerPhone] = useState<string>('');

  // Rental items list
  const [rentalRenterName, setRentalRenterName] = useState<string>('');
  const [rentalCourtId, setRentalCourtId] = useState<string>('');
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [rentalCustomerPhone, setRentalCustomerPhone] = useState<string>('');
  // Shoes are rented by size: gender filter + the chosen size variant (FR-5.3).
  const [rentalShoeGender, setRentalShoeGender] = useState<'M' | 'F'>('M');
  const [rentalVariantId, setRentalVariantId] = useState<string>('');
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
  const [staffUser, setStaffUser] = useState<User | null>(() => api.USE_BACKEND ? api.getSession('staff')?.user ?? null : null);
  const [staffIdentity, setStaffIdentity] = useState<string>('');
  const [staffPassword, setStaffPassword] = useState<string>('');
  const [staffApiError, setStaffApiError] = useState<string | null>(null);
  const [reviewQueue, setReviewQueue] = useState<api.PaymentForReview[]>([]);
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
  useEffect(() => {
    if (!api.USE_BACKEND || !staffUserId) return;
    let cancelled = false;
    const isManager = staffRole === UserRole.MANAGER || staffRole === UserRole.ADMIN;
    Promise.all([api.listPaymentsForReview(), api.daySummary(getTodayDateStr()), api.listProducts(), api.listOrders(getTodayDateStr()), api.activeRentals(),
      api.currentShift(), isManager ? api.listShifts() : Promise.resolve([] as api.ShiftView[]), api.listBookingsByDate(getTodayDateStr(), 'staff')])
      .then(([queue, summary, prods, dayOrders, rentals, openShift, history, todays]) => {
        if (cancelled) return;
        setTodayBookingsApi(todays);
        setShift(openShift);
        setShiftHistory(history);
        setReviewQueue(queue);
        setDaySummary(summary);
        setProducts(prods);
        setOrders(dayOrders);
        setActiveRentalOrders(rentals);
        setStaffApiError(null);
      })
      .catch(err => {
        if (cancelled) return;
        if (err instanceof api.ApiError && err.status === 401) setStaffUser(null);
        setStaffApiError(err.message);
      });
    return () => { cancelled = true; };
  }, [triggerRefresh, staffUserId, staffRole]);

  // API mode: the walk-in grid shows the backend's bookings for the chosen
  // date (online + walk-in), so the counter can't sell a slot that was
  // already booked online. Also re-validates the staff session.
  useEffect(() => {
    if (!api.USE_BACKEND || !staffUserId || !walkinDate) return;
    let cancelled = false;
    (async () => {
      try {
        const me = await api.refreshMe('staff');
        if (cancelled) return;
        if (!me || me.role === UserRole.CUSTOMER) {
          api.logout('staff');
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
          api.syncPricingCache() // walk-in price previews read it
        ]);
        if (cancelled) return;
        setCourts(apiCourts);
        setBookings(dayBookings);
        setDaysOff(closures);
      } catch (err) {
        if (!cancelled) setStaffApiError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [triggerRefresh, staffUserId, walkinDate]);

  const handleStaffLogin = (e: React.FormEvent) => {
    e.preventDefault();
    staffLoginWith(staffIdentity, staffPassword);
  };

  const staffLoginWith = (identity: string, password: string) => {
    setStaffApiError(null);
    api.login('staff', identity, password)
      .then(user => {
        if (user.role === UserRole.CUSTOMER) {
          api.logout('staff');
          setStaffApiError('บัญชีลูกค้าไม่มีสิทธิ์ตรวจสลิป');
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

  }, [triggerRefresh]);

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
    const rawLine = StorageService.get<any[]>('line_messages', []);
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
    const amount = useVoucher ? 0 : priceDetail.total;

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

    const qrPayload = settledNow ? undefined : generatePromptPayPayload(LOCAL_PROMPTPAY_ID, priceDetail.total);
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
        amount: priceDetail.total,
        qrPayload: qrPayload || '',
        label: `${courtObj?.name || ''} ${walkinDate} ${walkinSlot}-${newBooking.endTime} (${walkinName})`
      });
    }
    
    // reset
    setWalkinSlot('');
    setWalkinName('');
    setWalkinPhone('');
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
      return api.verifyPayment(paymentId, entry?.payment.slipUploadedAt)
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
      return api.rejectPayment(paymentId, reason, entry?.payment.slipUploadedAt)
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
  const effectiveRole = api.USE_BACKEND ? staffUser?.role : currentUserRole;
  const canManageBookings = effectiveRole === UserRole.MANAGER || effectiveRole === UserRole.ADMIN;
  // Blind cash count (owner decision 2026-10-21): counter staff count the
  // drawer without seeing what it should hold; managers/admins see it. In
  // API mode the server withholds the figures (shift.blind).
  const blindCount = api.USE_BACKEND ? !!shift?.blind : effectiveRole === UserRole.STAFF;
  // Once a blind count is confirmed it can't be changed (only explained).
  const [countLocked, setCountLocked] = useState(false);

  const closeBookingDetail = () => {
    setSelectedReceiptBooking(null);
    setSelectedReceiptOrder(null);
  };

  // Cash only with a drawer shift open (owner decision 2026-10-21): cash
  // taken outside a shift is in no shift's count, so the drawer never adds
  // up. The server refuses it too. Offers to go and open the shift.
  const confirmCashWithoutShift = async (): Promise<boolean> => {
    if (shift) return true;
    if (await ask('ต้องเปิดกะลิ้นชักก่อนรับเงินสด\nนับเงินทอนในลิ้นชัก แล้วกด "เปิดกะ" ที่แท็บ "ยอดลิ้นชักวันนี้"',
      { title: '⚠️ ยังไม่ได้เปิดกะ', okLabel: 'ไปเปิดกะ', cancelLabel: 'ปิด' })) {
      setActivePosTab('todays_total');
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
          notify(`ยกเลิก ${res.cancelled} ชั่วโมงแล้ว${res.refundAmount ? ` · บันทึกคืนเงิน ${formatBaht(res.refundAmount)} บาท` : ''}${res.pointsReversed ? ` · หักแต้มคืน ${res.pointsReversed}` : ''}`);
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
    if (!(await ask(`บันทึกว่าลูกค้าไม่มาใช้สนาม ${booking.startTime}-${booking.endTime} (${booking.bookingCode})?`, { okLabel: 'บันทึกไม่มา' }))) return;
    const done = () => {
      onAddAuditLog('BOOKING_NO_SHOW', 'Booking', booking.id, { status: booking.status }, { status: BookingStatus.NO_SHOW });
      closeBookingDetail();
      onRefreshAll();
    };
    if (api.USE_BACKEND) {
      return api.markNoShow(booking.id).then(done).catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }
    StorageService.set('bookings', StorageService.get<Booking[]>('bookings', []).map(b => b.id === booking.id ? { ...b, status: BookingStatus.NO_SHOW } : b));
    if (booking.totalAmount > 0) { // a free (voucher) hour earned no point to take back
      StorageService.addLedgerEntry(booking.userId, LedgerEntryType.REVERSE_BOOKING, -1, 'staff', { note: `No-show ${booking.date} ${booking.startTime}` });
    }
    done();
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
    const done = (orderCode: string, total: number, pts: number) => {
      setCartItems([]);
      setCartCustomerName('');
      setCartCourtId('');
      setCartCustomerPhone('');
      setCartSuccessAlert(`ใบเสร็จ ${orderCode} ตัดสต๊อกเรียบร้อย! ชำระผ่าน ${cartPayMethod === PaymentMethod.CASH ? 'เงินสด' : 'โอน/พร้อมเพย์'} ยอดเงิน ${formatBaht(total)} บาท ${pts > 0 ? `(🎁 ลูกค้าสะสมแต้ม +${pts} แต้ม!)` : ''}`);
      onRefreshAll();
    };

    if (api.USE_BACKEND) {
      // The server prices the items, checks and takes the stock, and
      // credits the customer with this phone.
      return api.checkout({
        type, paymentMethod: cartPayMethod, customerName: cartCustomerName, customerPhone: cartCustomerPhone,
        courtId: cartCourtId || undefined, items: cartItems.map(i => ({ productId: i.product.id, qty: i.qty }))
      })
        .then(r => {
          onAddAuditLog('ORDER_CREATED_BY_STAFF', 'Order', r.order.id, null, { orderCode: r.order.orderCode, total: r.order.totalAmount });
          done(r.order.orderCode, r.order.totalAmount, r.pointsEarned);
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
    const ptsAdded = customer ? StorageService.addPoints(customer.id, totalAmount) : 0;
    onAddAuditLog('ORDER_CREATED_BY_STAFF', 'Order', orderId, null, newOrder);
    done(orderCode, totalAmount, ptsAdded);
  };

  // Equipment rental (FR-5.3): the catalog price, one item; shoes by size.
  const handleRentalRentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rentalRenterName || !selectedProductId) {
      notify('กรุณากรอกชื่อผู้ขอเช่าเล่น และ เลือกชนิดอุปกรณ์กีฬา!');
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
    const done = (orderCode: string, pts: number) => {
      setRentalRenterName('');
      setRentalCourtId('');
      setRentalCustomerPhone('');
      setRentalVariantId('');
      onRefreshAll();
      notify(`ปล่อยเช่าสำเร็จ! รหัสทำรายการเช่า ${orderCode}${sizeNote} ${pts > 0 ? `(🎁 ลูกค้าสะสมแต้ม +${pts} แต้ม!)` : ''}`);
    };

    if (api.USE_BACKEND) {
      return api.checkout({
        type: OrderType.EQUIPMENT_RENT, paymentMethod: PaymentMethod.CASH, customerName: `${rentalRenterName} (เช่าอุปกรณ์)`,
        customerPhone: rentalCustomerPhone, courtId: rentalCourtId || undefined,
        items: [{ productId: prodObj.id, variantId: variant?.id, qty: 1 }]
      })
        .then(r => {
          onAddAuditLog('RENTAL_CREATED_BY_STAFF', 'Order', r.order.id, null, { orderCode: r.order.orderCode });
          done(r.order.orderCode, r.pointsEarned);
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
      customerName: `${rentalRenterName} (เช่าอุปกรณ์)`,
      courtId: rentalCourtId || undefined,
      type: OrderType.EQUIPMENT_RENT,
      status: OrderStatus.PREPARING, // out on rent until returned
      totalAmount: prodObj.price,
      paidAmount: prodObj.price,
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
    const ptsAdded = customer ? StorageService.addPoints(customer.id, prodObj.price) : 0;
    onAddAuditLog('RENTAL_CREATED_BY_STAFF', 'Order', orderId, null, newOrder);
    done(orderCode, ptsAdded);
  };

  // A rented item is back: restock it (its size, for shoes); the rental
  // closes once every item is back.
  const handleReturnItem = (orderId: string, itemId: string) => {
    if (api.USE_BACKEND) {
      return api.returnRentalItem(itemId)
        .then(o => {
          onAddAuditLog('RENTAL_RETURNED_BY_STAFF', 'Order', o.id, null, { item: itemId, status: o.status });
          onRefreshAll();
          notify('บันทึกการส่งคืนอุปกรณ์เข้าคลังเรียบร้อย');
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
      return { ...o, items, status: items.every(it => it.returnedAt) ? OrderStatus.DELIVERED : o.status };
    }));
    StorageService.set('products', StorageService.get<Product[]>('products', []).map(p => p.id !== itemRef.productId ? p : {
      ...p,
      stock: p.stock + itemRef.qty,
      variants: p.variants?.map(v => v.id === itemRef.variantId ? { ...v, stock: v.stock + itemRef.qty } : v)
    }));
    onAddAuditLog('RENTAL_RETURNED_BY_STAFF', 'Order', orderId, { item: itemId, returned: false }, { item: itemId, returned: true });
    onRefreshAll();
    notify('บันทึกการส่งคืนอุปกรณ์เข้าคลังเรียบร้อย');
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
      ? { ...o, status: OrderStatus.CANCELLED, voidedAt: new Date().toISOString(), voidReason: reason } : o));
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

    let cashFromBookings = 0, qrFromBookings = 0, refunded = 0;
    if (api.USE_BACKEND) {
      cashFromBookings = daySummary?.cashReceived ?? 0;
      qrFromBookings = daySummary?.promptpayVerified ?? 0;
      refunded = daySummary?.refunded ?? 0;
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
      // Each refund on its own day (older data has only the running total).
      refunded = payments.reduce((sum, p) => sum + (p.refunds
        ? p.refunds.filter(r => localDateOf(r.at) === todayStr).reduce((n, r) => n + r.amount, 0)
        : (p.refundedAt && localDateOf(p.refundedAt) === todayStr ? p.refundAmount || 0 : 0)), 0);
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
      refunded: roundBaht(refunded),
      totalExpected: roundBaht(bookingIncome + fbIncome + rentalIncome)
    };
  };

  // Slips verification target list
  const pendingSlipPayments = api.USE_BACKEND
    ? reviewQueue.map(r => r.payment)
    : payments.filter(p => p.status === PaymentStatus.SLIP_UPLOADED);
  // Bookings the slip queue can resolve payments against.
  const slipQueueBookings = api.USE_BACKEND ? reviewQueue.flatMap(r => r.bookings) : bookings;

  // API mode: everything on this panel acts as a staff member, so sign in
  // first (separately from any customer login in the same browser).
  if (api.USE_BACKEND && !staffUser) {
    return (
      <div className="max-w-sm mx-auto my-10 bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <form onSubmit={handleStaffLogin} className="space-y-3 text-xs">
          <p className="text-sm font-bold text-slate-800">เข้าสู่ระบบพนักงาน (Staff POS)</p>
          {staffApiError && (
            <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">⚠️ {staffApiError}</p>
          )}
          <input value={staffIdentity} onChange={e => setStaffIdentity(e.target.value)} placeholder="เบอร์โทร หรือ อีเมลพนักงาน" className="w-full border border-slate-300 rounded-lg px-3 py-2" required />
          <input type="password" value={staffPassword} onChange={e => setStaffPassword(e.target.value)} placeholder="รหัสผ่าน" className="w-full border border-slate-300 rounded-lg px-3 py-2" required />
          <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg py-2">เข้าสู่ระบบ</button>
          <DemoLogins accounts={DEMO_STAFF} onPick={staffLoginWith} />
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* A failed load leaves the previous data on screen - say so on every
          tab, not only on the slips tab. */}
      {api.USE_BACKEND && staffApiError && (
        <p id="staff-load-error" role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-2">
          ⚠️ โหลดข้อมูลล่าสุดไม่สำเร็จ ข้อมูลที่เห็นอาจไม่เป็นปัจจุบัน: {staffApiError}{' '}
          <button type="button" onClick={onRefreshAll} className="underline font-bold">ลองใหม่</button>
        </p>
      )}

      {!shift && (
        <button type="button" id="no-shift-banner" onClick={() => setActivePosTab('todays_total')}
          className="w-full text-left text-xs bg-amber-50 border border-amber-300 text-amber-900 rounded-xl px-4 py-2 font-bold">
          ⚠️ ยังไม่ได้เปิดกะลิ้นชัก — รับเงินสดไม่ได้จนกว่าจะเปิดกะ (กดที่นี่เพื่อเปิดกะ)
        </button>
      )}

      {/* Staff Workspace Alert banner */}
      <div className="bg-slate-800 text-white p-4 rounded-2xl flex flex-wrap items-center justify-between gap-4 border border-slate-700 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 bg-emerald-950 text-emerald-400 rounded-xl flex items-center justify-center font-bold font-mono">POS</div>
          <div>
            <p className="text-xs font-bold">แผงทำงานพนักงานสปอร์ตคอมเพล็กซ์ (Staff Panel)</p>
            <p className="text-[10px] text-slate-400">ผู้ใช้งาน: {staffUser ? staffUser.name : 'คุณ กิตติ (เดโม)'} | สิทธิ์ของคุณ: <span className="text-emerald-400 font-extrabold">{effectiveRole}</span></p>
          </div>
        </div>

        {/* Quick notification queue tracker */}
        <div className="flex gap-4">
          <span className="text-xs bg-amber-500/20 text-amber-300 font-bold px-3 py-1.5 rounded-xl border border-amber-500/30 flex items-center gap-1">
            <AlertOctagon className="h-4 w-4 shrink-0 shrink-0" />
            คิวอนุมัติสลิปโอน: {pendingSlipPayments.length} รายการ
          </span>
        </div>
      </div>

      {/* POS Sub Tabs controller */}
      <div id="staff-pos-tabs" className="flex flex-wrap border-b border-slate-200 gap-1">
        <button
          onClick={() => setActivePosTab('walkin')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'walkin' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          🏸 บันทึก Walk-in ด่วน
        </button>
        <button
          onClick={() => setActivePosTab('slips')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition relative ${activePosTab === 'slips' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          📝 อนุมัติ Slip โอน ({pendingSlipPayments.length})
          {pendingSlipPayments.length > 0 && (
            <span className="absolute top-1 right-1 h-2.5 w-2.5 rounded-full bg-rose-600 animate-ping" />
          )}
        </button>
        <button
          onClick={() => setActivePosTab('fb')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'fb' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          ☕️ POS ขายอาหาร F&B / ลูกแบด
        </button>
        <button
          onClick={() => setActivePosTab('rentals')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'rentals' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          🏸 ยืม/เช่าแร็กเกต & รองเท้า
        </button>
        <button
          onClick={() => setActivePosTab('vouchers')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'vouchers' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          🎁 รับของรางวัล
        </button>
        <button
          onClick={() => setActivePosTab('todays_total')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'todays_total' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          📊 ยอดลิ้นชักวันนี้ (Read-Only)
        </button>
      </div>

      {/* POS Contents Rendering */}
      <div id="pos-content-sections" className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm min-h-[400px]">
        
        {/* Tab 1: Walkin Booking */}
        {activePosTab === 'walkin' && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">รับจองคอร์ทหน้างาน (Walk-in Booking)</h3>
                <p className="text-xs text-slate-500">สำหรับลูกค้ายืนต่อแถวหน้าสนาม ไม่ต้องเช็คสลิปเนื่องจากพนักงานรับเงินสดหรือสแกนตรงนั้นทันที</p>
              </div>

              {walkinSuccessAlert && (
                <div className="bg-emerald-50 text-emerald-800 text-xs p-3.5 rounded-xl border border-emerald-200">
                  {walkinSuccessAlert}
                </div>
              )}

              <form onSubmit={e => { e.preventDefault(); void guarded(handleWalkinBookingSubmit)(e); }} className="space-y-4 text-xs">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1.5">1. เลือกสนามกีฬาที่ใช้</label>
                  <select 
                    value={walkinCourtId} 
                    onChange={(e) => setWalkinCourtId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 py-2.5 px-3 rounded-lg text-slate-800 font-medium text-xs"
                  >
                    {courts.map(c => (
                      <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">2. เลือกวันที่เล่น</label>
                    <input 
                      type="date" 
                      value={walkinDate} 
                      onChange={(e) => setWalkinDate(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-slate-800 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">3. ระบุคาบเวลา (1 ชม.)</label>
                    <select 
                      value={walkinSlot} 
                      onChange={(e) => setWalkinSlot(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 py-2.5 px-3 rounded-lg text-[11px]"
                    >
                      <option value="">--เลือกช่วงเวลา--</option>
                      {openSlotHours().map(h => (
                        <option key={h} value={h}>{h} น. เป็นต้นไป</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">4. ชื่อย่อลูกค้าสำหรับออกบัตร</label>
                    <input 
                      type="text" 
                      required
                      placeholder="เช่น สมศักดิ์, พี่แบงค์" 
                      value={walkinName} 
                      onChange={(e) => setWalkinName(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">5. เบอร์มือถือรับ LINE แทงสถานะ</label>
                    <input 
                      type="tel" 
                      required
                      placeholder="เช่น 089xxxxxxx" 
                      value={walkinPhone} 
                      onChange={(e) => setWalkinPhone(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-xs"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1.5">6. เลือกช่องทางรับชำระ</label>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      id="walkin-pay-cash"
                      type="button"
                      onClick={() => setWalkinPayMethod(PaymentMethod.CASH)}
                      className={`p-2.5 rounded-lg border text-xs font-bold text-center transition ${walkinPayMethod === PaymentMethod.CASH ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}
                    >
                      💵 รับเงินสด
                    </button>
                    <button
                      id="walkin-pay-promptpay"
                      type="button"
                      onClick={() => setWalkinPayMethod(PaymentMethod.PROMPTPAY)}
                      className={`p-2.5 rounded-lg border text-xs font-bold text-center transition ${walkinPayMethod === PaymentMethod.PROMPTPAY ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}
                    >
                      📲 โอนผ่านธนาคาร / QR PromptPay
                    </button>
                    <button
                      id="walkin-pay-voucher"
                      type="button"
                      onClick={() => setWalkinPayMethod(PaymentMethod.VOUCHER)}
                      className={`p-2.5 rounded-lg border text-xs font-bold text-center transition ${walkinPayMethod === PaymentMethod.VOUCHER ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}
                    >
                      🎟️ คูปองชั่วโมงฟรี
                    </button>
                  </div>
                  {walkinPayMethod === PaymentMethod.VOUCHER && (
                    <input
                      id="walkin-voucher-code"
                      value={walkinVoucherCode}
                      onChange={e => setWalkinVoucherCode(e.target.value)}
                      placeholder="รหัสคูปอง RW-123456"
                      className="w-full mt-2 bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-xs font-mono uppercase"
                    />
                  )}
                  <p className="text-[10px] text-slate-500 mt-1.5">
                    {walkinPayMethod === PaymentMethod.CASH
                      ? 'เงินสด: รับเงินก่อนกดยืนยัน ระบบยืนยันการจองทันทีและนับเข้าลิ้นชักเงินสด'
                      : walkinPayMethod === PaymentMethod.VOUCHER
                        ? 'คูปอง: ฟรี 1 ชั่วโมงช่วง Off-Peak ใช้ได้ครั้งเดียว จองในชื่อเจ้าของคูปอง ไม่ได้แต้มสะสม'
                        : 'โอน: ระบบแสดง QR และยอดเงิน แล้วกดยืนยันเมื่อเห็นเงินเข้า'}
                  </p>
                </div>

                <button 
                  type="submit" 
                  disabled={busy}
                  className="w-full bg-[#1e293b] hover:bg-[#334155] disabled:opacity-50 text-white py-3 rounded-lg font-bold text-xs shadow-sm transition"
                >
                  {walkinPayMethod === PaymentMethod.CASH ? 'รับเงินสดแล้ว ออกตั๋วคอร์ท' : walkinPayMethod === PaymentMethod.VOUCHER ? 'ใช้คูปองและออกตั๋วคอร์ท' : 'สร้างรายการจองและแสดง QR รับชำระ'} &rarr;
                </button>
              </form>

              {/* PromptPay walk-in awaiting the transfer: the amount is the
                  server's price (member discount included), and the booking
                  is only confirmed - and points awarded - once staff see
                  the money arrive. */}
              {pendingWalkin && (
                <div id="walkin-pending-payment" className="mt-4 p-4 rounded-xl border-2 border-amber-300 bg-amber-50 space-y-3 text-xs">
                  <p className="font-black text-amber-900">⏳ รอลูกค้าโอนเงิน · {pendingWalkin.bookingCode}</p>
                  <p className="text-amber-800">{pendingWalkin.label}</p>
                  <div className="flex items-center gap-4">
                    {pendingWalkin.qrPayload && (
                      <div className="bg-white p-2 rounded-lg border border-amber-200">
                        <QRCodeSVG value={pendingWalkin.qrPayload} size={132} />
                      </div>
                    )}
                    <div>
                      <p className="text-slate-500">ยอดที่ต้องชำระ</p>
                      <p id="walkin-pending-amount" className="text-2xl font-black text-slate-900">{formatBaht(pendingWalkin.amount)} บาท</p>
                      <p className="text-[10px] text-slate-500 mt-1">ให้ลูกค้าสแกน QR แล้วตรวจยอดเงินเข้าก่อนกดยืนยัน</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" disabled={busy} onClick={guarded(confirmPendingWalkin)} className="disabled:opacity-50 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-lg">
                      ✅ ได้รับเงินแล้ว ยืนยันการจอง
                    </button>
                    <button type="button" disabled={busy} onClick={guarded(cancelPendingWalkin)} className="disabled:opacity-50 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold py-2 rounded-lg">
                      ยกเลิกรายการ
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Interactive booked monitor table */}
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex flex-col justify-between">
              <div className="space-y-4">
                <span className="text-xs font-bold text-slate-700 flex items-center gap-1">
                  <Activity className="h-4 w-4 text-emerald-600 animate-pulse" />
                  การจองของวันที่ {formatDate(`${walkinDate}T12:00:00+07:00`)}
                </span>
                <span className="block text-[10px] text-slate-400">ทุกการจองของวันที่เลือกในฟอร์ม (รวมที่รอชำระ)</span>

                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                  {bookings.filter(b => b.date === walkinDate && b.status !== BookingStatus.CANCELLED).map((b) => (
                    <div key={b.id} className="bg-white p-3 rounded-xl border border-slate-200/60 text-xs flex justify-between items-center bg-slate-50/20 hover:bg-slate-50 transition">
                      <div>
                        <p className="font-bold text-slate-800">{courts.find(c => c.id === b.courtId)?.name}</p>
                        <p className="text-[10px] text-slate-500">ผู้จอง: {b.userName} | เวลา: <span className="font-bold text-slate-700">{b.startTime} - {b.endTime} น.</span></p>
                        <p className="text-[9px] text-slate-400">รหัสจอง: <span className="font-mono">{b.bookingCode}</span> | ยอด: {formatBaht(b.totalAmount)} บ.</p>
                      </div>
                      <div className="flex flex-col gap-1 items-end">
                        {b.status === BookingStatus.PENDING_PAYMENT ? (
                          <span className="text-[9px] bg-amber-100 text-amber-800 font-extrabold px-1.5 py-0.5 rounded-md">รอชำระเงิน</span>
                        ) : (
                          <span className="text-[9px] bg-emerald-100 text-emerald-800 font-extrabold px-1.5 py-0.5 rounded-md">ยืนยันแล้ว</span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedReceiptBooking(b);
                            setSelectedReceiptOrder(null);
                          }}
                          className="text-[9px] bg-slate-800 hover:bg-slate-700 text-white font-bold py-1 px-2 rounded-md flex items-center gap-1 transition-all mt-1"
                        >
                          <Receipt className="h-3 w-3" /> ออกใบเสร็จ
                        </button>
                      </div>
                    </div>
                  ))}
                  {bookings.filter(b => b.date === walkinDate && b.status !== BookingStatus.CANCELLED).length === 0 && (
                    <p className="text-[10px] text-slate-400 text-center py-10">ยังไม่มีผู้จองสนามในวันนี้ สามารถเปิดรับตึกวอล์กอินได้ตลอดเวลา</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* DYNAMIC COURT OCCUPANCY MONITOR MATRIX FOR COUNTER STAFF */}
          <div className="mt-8 border-t border-slate-200 pt-6 space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 bg-slate-50 p-4 rounded-xl border border-slate-200">
              <div>
                <h3 className="text-sm font-black text-[#0f172a] uppercase tracking-wider flex items-center gap-1.5 font-sans">
                  🎾 แดชบอร์ดตรวจสอบมอนิเตอร์ดีมานด์ภาพรวม & จองสนามด่วน (Occupancy Grid Matrix & Pos Shortcut)
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  เลือกดูสถานะว่าง/จัดงาน/ซ่อมบำรุง ทุกสนามพร้อมกันของวันที่ <span className="font-bold underline text-slate-800">{walkinDate}</span>. 
                  (คลิกที่สล็อตช่วงเวลาว่าง เพื่อตั้งค่าและเลือกรับลงทะเบียนจองในแบบฟอร์มด้านบนได้ทันที!)
                </p>
              </div>

              {/* Sport Type Filters for Grid */}
              <div className="flex flex-wrap gap-1 bg-[#f1f5f9] p-1 rounded-lg">
                {[CourtType.BADMINTON, CourtType.BASKETBALL, CourtType.PICKLEBALL, CourtType.MEETING_ROOM].map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setPosGridSportType(type)}
                    className={`px-3 py-1.5 rounded-md text-[10px] font-bold transition-all ${
                      posGridSportType === type
                        ? 'bg-[#1e293b] text-white shadow'
                        : 'text-slate-600 hover:bg-slate-200/50'
                    }`}
                  >
                    {type === CourtType.BADMINTON ? '🏸 แบดมินตัน' : 
                     type === CourtType.BASKETBALL ? '🏀 บาสเกตบอล' : 
                     type === CourtType.PICKLEBALL ? '🏓 พิคเคิลบอล' : '🏢 ห้องประชุม'}
                  </button>
                ))}
              </div>
            </div>

            {/* Grid display table */}
            <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white shadow-inner">
              <table className="w-full text-left border-collapse min-w-[1100px]">
                <thead>
                  <tr className="bg-[#f8fafc] text-[10px] uppercase font-black text-slate-500 border-b border-slate-200">
                    <th className="p-3 bg-[#f8fafc] sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] w-36 border-r border-slate-200">สนาม</th>
                    {openSlotHours().map((time) => (
                      <th key={time} className="p-2 text-center text-[9px] min-w-[75px] border-l border-slate-200">
                        {time} น.
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white text-[10px]" id="staff-pos-grid">
                  {courts.filter(c => c.type === posGridSportType).map((court) => (
                    <tr key={court.id} className="hover:bg-slate-50/50 transition-colors">
                      {/* Sticky Court Left Header */}
                      <td className="p-2.5 font-bold text-slate-800 bg-[#f8fafc]/95 sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] border-r border-slate-200">
                        <span className="block text-[11px] font-black">{court.name}</span>
                        {court.offPeakOnly && (
                          <span className="text-[8px] text-[#0f5132] font-semibold bg-[#d1e7dd] px-1 py-0.2 rounded w-max mt-0.5 inline-block">Off-Peak เท่านั้น</span>
                        )}
                      </td>

                      {/* Hourly slots */}
                      {openSlotHours().map((time) => {
                        const hourNum = parseInt(time.split(':')[0], 10);

                        // 1. Is there a booking on this court OR a mutex-group
                        // sibling (FR-1.2, e.g. the full court)?
                        const bItem = findConflictingBooking(court.id, walkinDate, time, bookings, courts);

                        // 2. Is there a closure/maintenance?
                        const closureItem = findClosure(daysOff, walkinDate, court.id, hourNum, courts);

                        // 3. Peak/Offpeak, read from the same PricingRule config
                        // the price itself uses.
                        const isPeak = !isHourOffPeak(court.type, walkinDate, hourNum);

                        // 4. Half-court offpeak-only rule (FR-1.2)
                        const isBasketballHalfCourt = !!court.offPeakOnly;
                        const isRestrictedPeakBasketball = isBasketballHalfCourt && isPeak;

                        // 5. Is it the currently selected slot on the POS left panel?
                        const isActiveSelection = walkinCourtId === court.id && walkinSlot === time;

                        if (bItem) {
                          const isPending = bItem.status === BookingStatus.PENDING_PAYMENT;
                          return (
                            <td 
                              key={time} 
                              onClick={() => {
                                setSelectedReceiptBooking(bItem);
                                setSelectedReceiptOrder(null);
                              }}
                              className="p-1 border-l border-slate-200 text-center bg-rose-50 hover:bg-rose-100 text-rose-800 font-bold min-h-[44px] cursor-pointer"
                              title="คลิกเพื่อออกใบเสร็จภาษี"
                            >
                              <span className="block text-[8px] font-black text-rose-600">🔴 จองแล้ว</span>
                              <span className="block text-[9px] text-[#0f172a] whitespace-nowrap overflow-hidden text-ellipsis max-w-[70px] mx-auto font-black" title={bItem.userName}>
                                {bItem.userName}
                              </span>
                              <span className="text-[7.5px] text-slate-500 font-mono scale-[0.9]">
                                {isPending ? '⏳ ค้างVerify'
                                  : bItem.status === BookingStatus.COMPLETED ? '🏁 เล่นแล้ว'
                                  : bItem.status === BookingStatus.NO_SHOW ? '🚫 ไม่มา'
                                  : '✓ ชำระแล้ว'}
                              </span>
                            </td>
                          );
                        }

                        if (closureItem) {
                          return (
                            <td 
                              key={time} 
                              className="p-1 border-l border-slate-200 bg-rose-100/70 text-rose-800 text-center min-h-[44px] cursor-not-allowed select-none font-medium"
                              title={`ปิดให้บริการ: ${closureItem.reason}`}
                            >
                              <span className="block text-[8px] font-black text-rose-700">⚠️ ปิดสนาม</span>
                              <span className="text-[7px] text-rose-900 block max-w-[65px] truncate mx-auto">
                                {closureItem.reason}
                              </span>
                            </td>
                          );
                        }

                        // Over: nobody can book it (an hour in progress still can be,
                        // at the counter).
                        if (slotTiming(walkinDate, time).ended) {
                          return (
                            <td 
                              key={time} 
                              className="p-1 border-l border-slate-200 bg-slate-100 text-slate-400 text-center min-h-[44px] cursor-not-allowed select-none"
                              title="ช่วงเวลานี้ผ่านไปแล้ว"
                            >
                              <span className="block text-[8px] font-semibold text-slate-500">⌛ ผ่านไปแล้ว</span>
                            </td>
                          );
                        }

                        if (isRestrictedPeakBasketball) {
                          return (
                            <td 
                              key={time} 
                              className="p-1 border-l border-slate-200 bg-slate-100 text-slate-400 text-center min-h-[44px] cursor-not-allowed select-none"
                              title="เฉพาะช่วงนิกาเพื่อสุขภาพ (Off-peak) เท่านั้น"
                            >
                              <span className="block text-[8px] font-semibold text-slate-500">🚫 ปิดช่วง Peak</span>
                              <span className="text-[7px] text-slate-400 block">บาสเกตบอลครึ่งสนาม</span>
                            </td>
                          );
                        }

                        const priceBase = calculatePrice(
                          posGridSportType, 
                          walkinDate, 
                          time, 
                          MemberType.NORMAL, 
                          court
                        );

                        // No pricing rule covers this hour: the server treats it
                        // as outside opening hours and refuses the booking.
                        if (!priceBase.isOpen) {
                          return (
                            <td 
                              key={time} 
                              className="p-1 border-l border-slate-200 bg-slate-100 text-slate-400 text-center min-h-[44px] cursor-not-allowed select-none"
                              title="นอกเวลาเปิดให้บริการ"
                            >
                              <span className="block text-[8px] font-semibold text-slate-500">🚫 ปิดบริการ</span>
                              <span className="text-[7px] text-slate-400 block">นอกเวลาทำการ</span>
                            </td>
                          );
                        }

                        if (isActiveSelection) {
                          return (
                            <td 
                              key={time} 
                              className="p-1 border-l border-slate-200 bg-[#3b82f6] text-white text-center font-bold relative cursor-pointer ring-2 ring-[#93c5fd] animate-pulse"
                              title="เลือกช่องสนามและชั่วโมงเวลานี้อยู่!"
                            >
                              <span className="block text-[8.5px] font-black uppercase text-white">⭐ จะจองคิว</span>
                              <span className="block text-[9px] font-mono leading-none">{priceBase.total}฿</span>
                            </td>
                          );
                        }

                        // Vacant cell clickable
                        return (
                          <td 
                            key={time} 
                            onClick={() => {
                              setWalkinCourtId(court.id);
                              setWalkinSlot(time);
                            }}
                            className={`p-1 border-l border-slate-200 text-center cursor-pointer transition min-h-[44px] ${
                              isPeak 
                                ? 'bg-amber-100/50 hover:bg-amber-100 text-amber-900' 
                                : 'bg-emerald-50/15 hover:bg-[#34d399]/20 text-slate-700'
                            }`}
                          >
                            <span className="block text-[8px] font-bold text-slate-500">🟢 ว่าง</span>
                            <span className="block text-[9.5px] font-mono font-black text-[#1e293b]">{priceBase.total}฿</span>
                            <span className="text-[7.5px] text-slate-400 italic block font-mono">
                              {isPeak ? '⚡ Peak' : 'Off-Peak'}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {courts.filter(c => c.type === posGridSportType).length === 0 && (
                    <tr>
                      <td colSpan={17} className="text-center text-slate-400 py-12 font-bold bg-slate-50">
                        ไม่มีข้อมูลประเภทกีฬา {posGridSportType} เพื่อตรวจสอบกริดระบบนี้
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-[10.5px] bg-[#f8fafc] px-3 py-2.5 rounded-lg border border-slate-200 font-mono text-slate-600">
              <span className="font-bold text-slate-700">📌 ทิปเคาน์เตอร์:</span>
              <span>1. คลิกช่อง "🟢 ว่าง" เพื่อเลือกรหัสสนามและเวลาลงฟอร์มออกตั๋วทันที</span>
              <span>2. คลิกช่อง "🔴 จองแล้ว" เพื่อดูรายละเอียดสลิป และพ่นพิมพ์ใบเสร็จ (ภาษีมูลค่าเพิ่ม 7%) ย้อนหลังได้</span>
            </div>
          </div>
          </>
        )}

        {/* Tab 2: Approve Slips */}
        {activePosTab === 'slips' && (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
                <ShieldCheck className="h-5 w-5 text-emerald-600" />
                คิวตรวจสอบสลิปโอนเงินลูกค้าออนไลน์ (Line Slip Verify Stage)
              </h3>
              <p className="text-xs text-slate-500">กรุณากดตรวจเช็กรายละเอียด รูปสลิปผู้เข้าใช้บริการก่อนการยืนยันจอง ป้องกันความคลาดเคลื่อนและสลิปปลอมแปลง</p>
            </div>



            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {api.USE_BACKEND && staffUser && (
                <p className="md:col-span-2 text-[11px] text-slate-500">
                  ตรวจสลิปในนาม <span className="font-bold text-slate-700">{staffUser.name}</span>
                  <button type="button" onClick={handleStaffLogout} className="ml-2 underline text-slate-500 hover:text-slate-700">ออกจากระบบ</button>
                </p>
              )}

              {/* Slip list queue */}
              <div className="space-y-3">
                <span className="text-xs font-bold text-slate-700 block">สลิปที่รอสต๊าฟเวอริฟายเดลิเวอร์รี ({pendingSlipPayments.length} รายการ):</span>
                
                <div className="space-y-3 max-h-[400px] overflow-y-auto pr-1">
                  {pendingSlipPayments.map((pay) => {
                    const bookingObj = slipQueueBookings.find(b => b.id === pay.bookingId);
                    if (!bookingObj) return null;
                    const groupHours = slipQueueBookings.filter(b => b.bookingCode === bookingObj.bookingCode).length;
                    const courtName = courts.find(c => c.id === bookingObj.courtId)?.name || 'สนาม';

                    return (
                      <div key={pay.id} className="bg-slate-50 hover:bg-slate-100 p-4 rounded-xl border border-slate-200 text-xs space-y-2 relative transition">
                        <div className="flex justify-between items-start">
                          <div>
                            <span className="text-[10px] bg-[#1e293b] text-white px-2 py-0.5 rounded font-mono font-bold">{bookingObj.bookingCode}</span>
                            <p className="font-black text-slate-800 mt-1.5">{courtName}</p>
                            <p className="text-[10px] text-slate-500">ผู้จอง: <span className="text-slate-800 font-semibold">{bookingObj.userName}</span> | โทร: {bookingObj.userPhone}</p>
                            <p className="text-[10px] text-slate-500">จองเล่นวันที่: {bookingObj.date} | เวลา: {bookingObj.startTime} - {bookingObj.endTime} น.{groupHours > 1 ? ` (+${groupHours - 1} ชั่วโมงในกลุ่มเดียวกัน)` : ''}</p>
                          </div>
                          
                          <div className="text-right">
                            {pay.expiredAt && (
                              <p className="text-[9.5px] font-black text-rose-700 bg-rose-50 border border-rose-200 rounded px-1.5 py-0.5 mb-1">⚠️ ส่งสลิปหลังหมดเวลา</p>
                            )}
                            <p className="font-extrabold text-emerald-700 text-sm">{formatBaht(pay.amount)} บาท</p>
                            <p className="text-[9px] text-slate-400">อัพโหลดเมื่อ: {pay.slipUploadedAt ? formatDateTime(pay.slipUploadedAt) : 'ไม่ระบุ'}</p>
                          </div>
                        </div>

                        {/* Interactive check actions */}
                        <div className="flex items-center gap-2 pt-2 border-t border-slate-200">
                          {/* The slip itself, so it is checked before approving
                              (tap to open it full size). */}
                          {pay.slipUrl && (
                            <a 
                              href={pay.slipUrl} 
                              target="_blank" 
                              rel="noreferrer" 
                              title="เปิดสลิปขนาดเต็ม"
                              className="mr-auto flex items-center gap-2 text-xs text-sky-800 font-bold"
                            >
                              <img src={pay.slipUrl} alt="สลิปโอนเงิน" className="h-20 w-16 object-cover rounded border border-slate-300 bg-white" />
                              <span className="underline">ดูสลิปเต็ม</span>
                            </a>
                          )}
                          
                          {canManageBookings && (
                            <button
                              type="button"
                              disabled={busy} onClick={guarded(() => handleRefundPayment(pay))}
                              title="ลูกค้าโอนแล้วแต่ยืนยันการจองไม่ได้ (เช่น ส่งสลิปช้าและมีผู้อื่นจองไปแล้ว) - บันทึกการคืนเงิน"
                              className="bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-200 py-1.5 px-3 rounded text-[11px] font-bold transition"
                            >
                              💸 คืนเงิน
                            </button>
                          )}

                          <button
                            onClick={() => {
                              setRejectId(pay.id);
                              setRejectReason('');
                            }}
                            className="bg-slate-200 hover:bg-slate-300 text-slate-700 py-1.5 px-3 rounded text-[11px] font-bold transition"
                          >
                            ❌ ปฏิเสธ
                          </button>
                          
                          <button
                            type="button"
                            disabled={busy} onClick={guarded(() => handleVerifySlip(pay.id))}
                            className="bg-emerald-600 hover:bg-emerald-500 text-white py-1.5 px-4 rounded text-[11px] font-bold flex items-center gap-1 shadow-sm transition"
                          >
                            <Check className="h-3.5 w-3.5" /> อนุมัติสล็อตจอง
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  {pendingSlipPayments.length === 0 && (
                    <div className="text-center py-16 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                      <p className="text-xs text-slate-500 font-bold">ไม่มีรายการสลิปรอการยืนยันในตู้ทำงานขณะนี้ 🎉</p>
                      <p className="text-[10px] text-slate-400 mt-1">คิวเป็นระเบียบเรียบร้อยทั้งหมด</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Reject / Slip Reject dialogue drawer simulation */}
              <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200 flex flex-col justify-between">
                {rejectId ? (
                  <div className="space-y-4 text-xs">
                    <p className="font-bold text-slate-800 flex items-center gap-1 text-rose-700">
                      <AlertTriangle className="h-4 w-4" /> ปฏิเสธหลักฐานรูปสลิปลูกค้า
                    </p>
                    <p className="text-slate-500 text-[10px]">ระบบจะยิงแจ้งเตือนยกเลิกการสลักเวลา และยิง Push message คัดสิทธิ์ คืนเงิน ผ่านทางพอร์ท LINE OA ลูกค้าทันที</p>
                    
                    <div>
                      <label className="block text-slate-700 font-semibold mb-1.5">ระบุเหตุผลการปฏิเสธยอดสลิป:</label>
                      <textarea
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="เช่น มียอดเบี่ยงเบนเล็กน้อย, สลิปซ้ำซ้อนรอบบ่าย, ตรวจสอบเงินไม่เข้าธนาคารกสิกร"
                        className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs focus:outline-none"
                        rows={3}
                      />
                    </div>

                    <div className="flex gap-2">
                      <button
                        disabled={busy} onClick={guarded(() => handleRejectSlip(rejectId))}
                        className="bg-rose-600 hover:bg-rose-500 text-white font-bold py-2 px-4 rounded"
                      >
                        ยืนยันการปฎิเสธ (Cancel Booking)
                      </button>
                      <button
                        onClick={() => setRejectId(null)}
                        className="bg-slate-200 hover:bg-slate-300 text-slate-700 py-2 px-4 rounded"
                      >
                        ยกเลิก
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-20 text-slate-400 font-sans space-y-2">
                    <CheckCircle2 className="h-10 w-10 text-slate-300 mx-auto" />
                    <p className="text-xs font-bold">ยังไม่ได้เลือกรายการที่จะปฏิเสธ</p>
                    <p className="text-[9.5px] text-slate-400">เลือกกด 'ปฏิเสธ (Reject)' เพื่อเปิดแผงสาเหตุที่นี่</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {activePosTab === 'fb' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            
            {/* Products Selector Grid (Left-Side) */}
            <div className="col-span-1 lg:col-span-7 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700 block">อาหาร เครื่องดื่ม และอุปกรณ์ (ขายขาด):</span>
                <span className="text-[10px] text-slate-400 font-medium">กดเลือกอาหาร/เครื่องดื่มเพื่อเพิ่มลงในตะกร้า</span>
              </div>

              {cartSuccessAlert && (
                <div className="bg-emerald-50 text-emerald-800 text-xs p-3.5 rounded-xl border border-emerald-200 flex justify-between">
                  <span>{cartSuccessAlert}</span>
                  <button onClick={() => setCartSuccessAlert(null)} className="font-bold underline text-[10px]">ตกลง</button>
                </div>
              )}

              <div id="products-pos-grid" className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {products.filter(p => p.isActive && !p.isRental).map((prod) => (
                  <div 
                    key={prod.id} 
                    onClick={() => handleAddToCart(prod)}
                    className="bg-slate-50 border border-slate-200 hover:border-slate-300 hover:bg-slate-100/50 p-3.5 rounded-xl text-left flex flex-col justify-between cursor-pointer transition select-none h-32"
                  >
                    <div className="space-y-1">
                      <span className={`inline-block text-[8px] font-bold px-1.5 py-0.5 rounded ${prod.category === ProductCat.EQUIPMENT ? 'bg-sky-100 text-sky-800' : 'bg-amber-100 text-amber-800'}`}>
                        {prod.category === ProductCat.EQUIPMENT ? 'อุปกรณ์กีฬา' : 'อาหารและเครื่องดื่ม'}
                      </span>
                      <p className="font-bold text-slate-800 text-xs line-clamp-2 leading-snug">{prod.name}</p>
                    </div>

                    <div className="flex justify-between items-center border-t border-slate-200/50 pt-2">
                      <p className="font-extrabold text-slate-900 text-xs">{formatBaht(prod.price)} บาท</p>
                      <p className={`text-[9.5px] font-semibold ${prod.stock > 10 ? 'text-slate-500' : 'text-rose-600 font-bold'}`}>
                        คลัง: {prod.stock}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Billing Cart Receipt Workspace Sidebar */}
            <div className="col-span-1 lg:col-span-5 bg-slate-900 text-white rounded-2xl p-5 flex flex-col justify-between border border-slate-800 shadow-md">
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <span className="text-xs font-bold flex items-center gap-1"><ShoppingCart className="h-4 w-4 text-emerald-400" /> ตะกร้าใบเสร็จรับเงิน F&B</span>
                  <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full">วันที่: {formatDate(Date.now())}</span>
                </div>

                {/* Cart Loop */}
                <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                  {cartItems.map((item) => (
                    <div key={item.product.id} className="bg-slate-800/80 p-3 rounded-lg flex items-center justify-between text-xs border border-slate-700/50">
                      <div>
                        <p className="font-bold text-slate-100">{item.product.name}</p>
                        <p className="text-[9.5px] text-slate-400">{formatBaht(item.product.price)} บาท / หน่วย</p>
                      </div>

                      {/* Qty edit actions */}
                      <div className="flex items-center gap-3">
                        <button 
                          onClick={() => handleUpdateCartQty(item.product.id, -1)}
                          className="h-5 w-5 rounded bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <span className="font-bold font-mono w-4 text-center text-slate-200">{item.qty}</span>
                        <button 
                          onClick={() => handleUpdateCartQty(item.product.id, 1)}
                          className="h-5 w-5 rounded bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}

                  {cartItems.length === 0 && (
                    <p className="text-xs text-slate-500 text-center py-10 font-medium">ตะกร้าว่างเปล่า กดเลือกสินค้าเพื่อเปิดบิลคีย์!</p>
                  )}
                </div>

                {/* Bill client credentials */}
                {cartItems.length > 0 && (
                  <div className="space-y-3 pt-3 border-t border-slate-800 text-xs">
                    <div>
                      <label className="block text-[10px] text-amber-400 font-bold mb-1">🎁 เบอร์โทรสมาชิก (สะสมแต้ม 1 แต้ม / 100 บาท, เว้นได้):</label>
                      <input
                        type="tel"
                        value={cartCustomerPhone}
                        onChange={(e) => setCartCustomerPhone(e.target.value)}
                        placeholder="เช่น 0812345678"
                        className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-xs text-white"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">ระบุชื่อลูกค้า (สำหรับอ้างอิงส่งออเดอร์):</label>
                      <input 
                        type="text" 
                        value={cartCustomerName}
                        onChange={(e) => setCartCustomerName(e.target.value)}
                        placeholder="เช่น โต๊ะแบดสนาม 3, พี่แดงซอย 5"
                        className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-xs text-white"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">อ้างอิงเลขสนามที่มาซื้อ (เว้นได้):</label>
                      <select 
                        value={cartCourtId} 
                        onChange={(e) => setCartCourtId(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-xs text-white"
                      >
                        <option value="">-- ไม่เชื่อมสนาม --</option>
                        {courts.map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1.5">เลือกรูปแบบการชำระเงิน F&B:</label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setCartPayMethod(PaymentMethod.CASH)}
                          className={`p-2 rounded text-[11px] font-bold text-center transition ${
                            cartPayMethod === PaymentMethod.CASH 
                              ? 'bg-emerald-600 text-white' 
                              : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          💵 เงินสด
                        </button>
                        <button
                          type="button"
                          onClick={() => setCartPayMethod(PaymentMethod.PROMPTPAY)}
                          className={`p-2 rounded text-[11px] font-bold text-center transition ${
                            cartPayMethod === PaymentMethod.PROMPTPAY 
                              ? 'bg-emerald-600 text-white' 
                              : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          📲 โอน/พร้อมเพย์
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Submit Checkout button */}
              {cartItems.length > 0 && (
                <div className="pt-4 border-t border-slate-800 mt-4 space-y-3">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-400 font-medium">รวมราคาสุทธิใบเสร็จ:</span>
                    <span className="font-extrabold text-emerald-400 text-lg">
                      {formatBaht(cartItems.reduce((acc, c) => acc + (c.product.price * c.qty), 0))} บาท
                    </span>
                  </div>

                  <button
                    disabled={busy} onClick={guarded(handleCartCheckout)}
                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded text-xs transition"
                  >
                    ยืนยันการรับเงินสด/โอน และตัดตู้สต๊อกคลัง
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 4: Equipment Rental */}
        {activePosTab === 'rentals' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              
              {/* Rent Equipment form */}
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-bold text-slate-900">บันทึกจ่ายปล่อยเช่าแร็กเก็ตและอุปกรณ์กีฬา</h3>
                  <p className="text-xs text-slate-500">กรุณากรอกชื่อผู้ประกันแร็กเก็ต สต๊าฟจะเก็บค่าค้ำหรือค่าบริการล่วงหน้าและบันทึกสต๊อก</p>
                </div>

                <form onSubmit={e => { e.preventDefault(); void guarded(handleRentalRentSubmit)(e); }} className="space-y-4 text-xs">
                  <div>
                    <label className="block text-amber-600 font-bold mb-1.5">🎁 เบอร์โทรสมาชิก (สะสมแต้ม, เว้นได้):</label>
                    <input
                      type="tel"
                      value={rentalCustomerPhone}
                      onChange={(e) => setRentalCustomerPhone(e.target.value)}
                      placeholder="เช่น 0812345678"
                      className="w-full bg-slate-50 border border-slate-200 py-2.5 px-3 rounded-lg text-xs"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">1. คืน/คีย์ชื่อก๊วน หรือ ชื่อผู้ติดต่อค้ำประกัน:</label>
                    <input 
                      type="text" 
                      required
                      placeholder="เช่น คุณเอก แบดกบฏ เช่า 2 ไม้"
                      value={rentalRenterName}
                      onChange={(e) => setRentalRenterName(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 py-2.5 px-3 rounded-lg text-slate-800"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-700 font-semibold mb-1.5">2. เลือกแร็กเกต/อุปกรณ์เช่า:</label>
                      <select
                        value={selectedProductId}
                        onChange={(e) => { setSelectedProductId(e.target.value); setRentalVariantId(''); }}
                        className="w-full bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-xs"
                      >
                        {products.filter(p => p.isRental).map(p => (
                          <option key={p.id} value={p.id}>{p.name} (เหลือ {p.stock})</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-slate-700 font-semibold mb-1.5">3. ค่าบริการเช่า (บาท):</label>
                      <p className="w-full bg-slate-100 border border-slate-200 py-1.5 px-3 rounded-lg font-bold text-xs">
                        {formatBaht(products.find(p => p.id === selectedProductId)?.price ?? 0)} บาท
                        <span className="font-normal text-slate-500"> (ราคาตั้งในหน้า Admin)</span>
                      </p>
                    </div>
                  </div>

                  {/* Shoes: pick gender and size; each size has its own stock (FR-5.3) */}
                  {!!products.find(p => p.id === selectedProductId)?.variants?.length && (
                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 space-y-3">
                      <p className="font-bold text-indigo-900 text-[11px] flex items-center gap-1">
                        👟 เลือกเบอร์รองเท้า (เพศ ชาย/หญิง):
                      </p>
                      <div className="grid grid-cols-2 gap-3 text-[11px]">
                        <div>
                          <label className="block text-slate-500 mb-1">เพศ:</label>
                          <div className="flex gap-1">
                            {(['M', 'F'] as const).map(g => (
                              <button
                                key={g}
                                type="button"
                                onClick={() => { setRentalShoeGender(g); setRentalVariantId(''); }}
                                className={`flex-1 py-1 px-2 rounded text-[10px] font-bold transition border ${rentalShoeGender === g ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-slate-200 text-slate-700'}`}
                              >
                                {g === 'M' ? 'ชาย (M)' : 'หญิง (F)'}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <label className="block text-slate-500 mb-1">เบอร์ (EU):</label>
                          <select
                            id="rental-shoe-size"
                            value={rentalVariantId}
                            onChange={(e) => setRentalVariantId(e.target.value)}
                            className="w-full bg-white border border-slate-200 rounded py-1 px-1.5 text-[11px] text-slate-800 focus:outline-none"
                          >
                            <option value="">-- เลือกเบอร์ --</option>
                            {(products.find(p => p.id === selectedProductId)?.variants || [])
                              .filter(v => v.gender === rentalShoeGender || v.gender === 'U')
                              .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
                              .map(v => (
                                <option key={v.id} value={v.id} disabled={v.stock <= 0}>เบอร์ {v.label} (เหลือ {v.stock} คู่)</option>
                              ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">4. จองคอร์ทที่ใช้อ้างอิงเช่า (ระบุได้):</label>
                    <select
                      value={rentalCourtId}
                      onChange={(e) => setRentalCourtId(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-xs"
                    >
                      <option value="">-- ไม่ระบุคอร์ท --</option>
                      {courts.map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>

                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-bold py-2.5 rounded text-xs transition"
                  >
                    บันทึกปล่อยเช่าอุปกรณ์กีฬา & ถอนคลังสำรอง
                  </button>
                </form>
              </div>

              {/* Active Rental items tracking ledger with Return buttons */}
              <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200 space-y-4">
                <div>
                  <span className="text-xs font-bold text-slate-700 block mb-1">รายการอุปกรณ์เล่นรอนำส่งคืนสต๊อก ({activeRentalOrders.reduce((n, o) => n + o.items.filter(it => !it.returnedAt).length, 0)} ชิ้น):</span>
                  <span className="text-[10px] text-slate-400 block mb-3">เมื่อผู้เล่นคืนอุปกรณ์ กด "บันทึกคืน" เพื่อนำของกลับเข้าคลัง</span>
                </div>

                <div id="active-rentals" className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
                  {activeRentalOrders.flatMap(order => order.items.filter(it => !it.returnedAt).map(item => (
                    <div key={item.id} className="bg-white p-3.5 rounded-xl border border-slate-300 flex justify-between items-center text-xs">
                      <div>
                        <span className="text-[9px] bg-sky-100 text-sky-800 font-bold px-1.5 rounded uppercase font-mono">{order.orderCode}</span>
                        <p className="font-bold text-slate-800 mt-1">{order.customerName}</p>
                        <p className="text-[10px] text-slate-400">
                          อุปกรณ์: {item.productName || products.find(p => p.id === item.productId)?.name || 'อุปกรณ์เช่า'}
                          {item.shoeSize && ` (เบอร์ ${item.shoeSize} ${item.shoeGender === 'F' ? 'หญิง' : 'ชาย'})`}
                          {` · ตั้งแต่ ${formatDateTime(order.createdAt)}`}
                        </p>
                      </div>

                      <button
                        disabled={busy} onClick={guarded(() => handleReturnItem(order.id, item.id))}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1.5 px-3 rounded text-[10px] shadow-sm transition"
                      >
                        📬 บันทึกคืน
                      </button>
                    </div>
                  )))}

                  {activeRentalOrders.length === 0 && (
                    <p className="text-[10px] text-slate-400 text-center py-10">ยังไม่มีผู้เช่าไม้แร็กเก็ตหรือรองเท้ากีฬาออกไปเล่น ณ ขณะนี้</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Reward vouchers: staff check an RW-XXXXXX claim code and hand the
            reward over (FR-4.3). */}
        {activePosTab === 'vouchers' && (
          <div className="max-w-lg space-y-4">
            <div>
              <h3 className="text-base font-bold text-slate-900">🎁 ตรวจรหัสแลกของรางวัล</h3>
              <p className="text-xs text-slate-500">ลูกค้าแสดงรหัส RW-XXXXXX จากหน้าแลกแต้ม ตรวจแล้วกดมอบของรางวัล (ใช้ได้ครั้งเดียว)</p>
            </div>
            <form onSubmit={e => { e.preventDefault(); handleLookupVoucher(); }} className="flex gap-2">
              <input id="voucher-code-input" value={voucherCode} onChange={e => setVoucherCode(e.target.value)} placeholder="RW-123456"
                className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono uppercase" />
              <button type="submit" className="bg-slate-900 text-white font-bold px-4 rounded-lg text-xs">ตรวจรหัส</button>
            </form>
            {voucherError && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">⚠️ {voucherError}</p>}
            {voucherFound && (
              <div id="voucher-result" className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2 text-xs">
                <p className="font-mono font-black text-sm">{voucherFound.code}</p>
                <p><span className="text-slate-500">ของรางวัล:</span> <span className="font-bold">{voucherFound.reward}</span></p>
                <p><span className="text-slate-500">ลูกค้า:</span> {voucherFound.customer}</p>
                <p><span className="text-slate-500">สถานะ:</span> <span className="font-bold">{voucherFound.status === 'ACTIVE' ? '✅ ใช้ได้' : voucherFound.status === 'REDEEMED' ? (voucherFound.freeHour ? '⛔ ใช้จองไปแล้ว' : '⛔ รับไปแล้ว') : '⌛ หมดอายุ'}</span>
                  {voucherFound.expires && voucherFound.status === 'ACTIVE' ? ` (ถึง ${voucherFound.expires})` : ''}</p>
                {voucherFound.status === 'ACTIVE' && voucherFound.freeHour && (
                  <>
                    <button id="voucher-use-free-hour" type="button" onClick={handleUseFreeHourVoucher} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-lg">🏸 ใช้จองชั่วโมงฟรี</button>
                    <p className="text-[10px] text-slate-500">เปิดฟอร์ม Walk-in พร้อมรหัสนี้ เลือกสนามและเวลา Off-Peak 1 ชั่วโมง แล้วกดยืนยัน (คูปองถูกใช้เมื่อจองสำเร็จ)</p>
                  </>
                )}
                {voucherFound.status === 'ACTIVE' && !voucherFound.freeHour && (
                  <button type="button" disabled={busy} onClick={guarded(handleDispenseVoucher)} className="disabled:opacity-50 w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-lg">มอบของรางวัลแล้ว</button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tab 5: Today's consolidate accounting summary (Read only block for staff) */}
        {activePosTab === 'todays_total' && (
          <div className="space-y-6">
            {/* Cash drawer shift (FR-6.1/6.2) */}
            <div id="shift-panel" className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 shadow-sm text-xs">
              <h4 className="text-sm font-bold text-slate-800">💰 กะลิ้นชักเงินสด</h4>
              {!shift ? (
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <label className="block text-slate-600 mb-1">เงินทอนตั้งต้นในลิ้นชัก (บาท)</label>
                    <input id="shift-float" type="number" min={0} value={shiftFloatInput} onChange={e => setShiftFloatInput(e.target.value)}
                      className="w-40 border border-slate-300 rounded-lg px-3 py-2" placeholder="เช่น 2000" />
                  </div>
                  <button type="button" disabled={busy} onClick={guarded(handleOpenShift)} className="disabled:opacity-50 bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-4 py-2 rounded-lg">เปิดกะ</button>
                  <p className="text-slate-500 w-full">นับเงินทอนในลิ้นชักก่อนเริ่มขาย แล้วกดเปิดกะ ระบบจะรวมเงินสดที่รับระหว่างกะให้อัตโนมัติ</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-slate-600">เปิดกะโดย <b>{shift.staffName}</b> เมื่อ {formatDateTime(shift.openedAt)}</p>
                  {blindCount ? (
                    <p id="shift-blind-note" className="bg-slate-50 rounded-lg p-2 text-slate-600">
                      เงินทอนตั้งต้น <b>{formatBaht(shift.openingFloat)}</b> บาท · นับเงินสดทั้งหมดในลิ้นชักแล้วกรอกยอด
                      (ระบบไม่แสดงยอดที่ควรมีจนกว่าจะยืนยันยอดนับ)
                    </p>
                  ) : (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div className="bg-slate-50 rounded-lg p-2"><span className="text-slate-500 block">เงินทอนตั้งต้น</span><b>{formatBaht(shift.openingFloat)}</b></div>
                    <div className="bg-slate-50 rounded-lg p-2"><span className="text-slate-500 block">+ เงินสดค่าสนาม</span><b>{formatBaht(shift.cashBookings)}</b></div>
                    <div className="bg-slate-50 rounded-lg p-2"><span className="text-slate-500 block">+ เงินสดขายของ/เช่า</span><b>{formatBaht(shift.cashOrders)}</b></div>
                    <div className="bg-emerald-50 rounded-lg p-2"><span className="text-emerald-700 block">= ควรมีในลิ้นชัก</span><b id="shift-expected">{formatBaht(shift.expected)}</b></div>
                  </div>
                  )}
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <label className="block text-slate-600 mb-1">เงินสดที่นับได้จริง (บาท)</label>
                      <input id="shift-count" type="number" min={0} value={shiftCountInput} readOnly={countLocked} onChange={e => setShiftCountInput(e.target.value)} className="w-40 border border-slate-300 rounded-lg px-3 py-2 read-only:bg-slate-100" />
                    </div>
                    <div className="flex-1 min-w-[180px]">
                      <label className="block text-slate-600 mb-1">{blindCount ? 'หมายเหตุ (ถ้ามี)' : 'หมายเหตุ (จำเป็นถ้ายอดไม่ตรง)'}</label>
                      <input id="shift-note" value={shiftNote} onChange={e => setShiftNote(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2" />
                    </div>
                    <button type="button" disabled={busy} onClick={guarded(handleCloseShift)} className="disabled:opacity-50 bg-slate-900 hover:bg-slate-800 text-white font-bold px-4 py-2 rounded-lg">นับเงินและปิดกะ</button>
                  </div>
                  <p className="text-[10px] text-slate-500">การคืนเงินลูกค้าเป็นการโอน ไม่ได้จ่ายจากลิ้นชัก จึงไม่ถูกหักจากยอดนี้</p>
                </div>
              )}
              {closedShift && (
                <p id="shift-result" className={`rounded-lg px-3 py-2 font-bold ${closedShift.varianceCash === 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>
                  ปิดกะแล้ว: ควรมี {formatBaht(closedShift.expectedCash ?? 0)} นับได้ {formatBaht(closedShift.countedCash ?? 0)} →{' '}
                  {closedShift.varianceCash === 0 ? 'ตรง ✔' : (closedShift.varianceCash ?? 0) > 0 ? `เกิน ${formatBaht(closedShift.varianceCash ?? 0)} บาท` : `ขาด ${formatBaht(-(closedShift.varianceCash ?? 0))} บาท`}
                </p>
              )}
              {canManageBookings && shiftHistory.filter(sh => sh.closedAt).length > 0 && (
                <div>
                  <p className="font-bold text-slate-700 mb-1">กะที่ปิดแล้ว (ผู้จัดการ)</p>
                  <table className="w-full text-[11px]">
                    <thead><tr className="text-left text-slate-500"><th>เปิด</th><th>พนักงาน</th><th className="text-right">ควรมี</th><th className="text-right">นับได้</th><th className="text-right">เกิน/ขาด</th><th>หมายเหตุ</th></tr></thead>
                    <tbody>
                      {shiftHistory.filter(sh => sh.closedAt).slice(0, 15).map(sh => (
                        <tr key={sh.id} className="border-t border-slate-100">
                          <td>{formatDateTime(sh.openedAt)}</td>
                          <td>{sh.staffName}{sh.closedByName && sh.closedByName !== sh.staffName ? ` → ${sh.closedByName}` : ''}</td>
                          <td className="text-right">{formatBaht(sh.expectedCash ?? sh.expected)}</td>
                          <td className="text-right">{formatBaht(sh.countedCash ?? 0)}</td>
                          <td className={`text-right font-bold ${(sh.varianceCash ?? 0) === 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{formatBaht(sh.varianceCash ?? 0)}</td>
                          <td>{sh.notes || ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">สรุปบัญชีเงินสด และ ยอดจราจรวันนี้ (Cash Reconciliation)</h3>
              <p className="text-xs text-slate-500">รายงานข้อมูลเรียลไทม์ ยอดในหมวดหมู่คอร์ท การจราจร F&B เพื่อกระทบยอดปิดกะพนักงานประจำวันวันนี้ ({getTodayDateStr()})</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                <span className="text-[10px] font-semibold text-slate-500 block uppercase">ชั่วโมงสนามที่เล่นวันนี้ (ชำระแล้ว)</span>
                <span className="font-extrabold text-slate-800 text-3xl mt-1 block">{calculateLedger().bookingCount} ชม.</span>
                <p className="text-[10px] text-slate-400 mt-2">ในนี้เป็น Walk-in: {calculateLedger().walkinCount}</p>
              </div>

              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                <span className="text-[10px] font-semibold text-slate-500 block uppercase">เงินที่รับวันนี้ทั้งหมด</span>
                <span className="font-extrabold text-emerald-700 text-3xl mt-1 block">{blindCount ? '—' : `${formatBaht(calculateLedger().totalExpected)} บาท`}</span>
                {blindCount
                  ? <p id="day-report-blind" className="text-[10px] text-slate-400 mt-2">ยอดเงินแสดงให้ผู้จัดการเท่านั้น (นับลิ้นชักแบบไม่เห็นยอด)</p>
                  : <p className="text-[10px] text-slate-400 mt-2">ค่าสนาม: {formatBaht(calculateLedger().bookingIncome)} (รวมเงินจองล่วงหน้าของวันอื่น) | ขายของ: {formatBaht(calculateLedger().fbIncome)} | ค่าเช่า: {formatBaht(calculateLedger().rentalIncome)}</p>}
                {calculateLedger().refunded > 0 && (
                  <p className="text-[10px] text-sky-700 font-bold mt-1">💸 คืนเงินวันนี้: {formatBaht(calculateLedger().refunded)} บาท</p>
                )}
              </div>

              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                <span className="text-[10px] font-semibold text-slate-500 block uppercase">แยกตามช่องทางรับเงิน (วันนี้)</span>
                <div className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-500">💵 เงินสดที่รับวันนี้:</span>
                    <span id="ledger-cash" className="font-bold text-slate-800">{blindCount ? '—' : `${formatBaht(calculateLedger().cashExpected)} บาท`}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">📲 โอน / พร้อมเพย์:</span>
                    <span id="ledger-qr" className="font-bold text-slate-800 text-slate-800">{formatBaht(calculateLedger().qrExpected)} บาท</span>
                  </div>
                </div>
              </div>
            </div>

            {/* List of Recent POS Receipts orders & Walk-in Bookings */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4 shadow-sm">
              <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                🧾 ระบบพิมพ์ใบเสร็จรับเงินด่วน (Recent Invoices & Receipts)
              </h4>
              <p className="text-[10px] text-slate-500">
                รายชื่อสล็อตและ F&B ทั้งหมดที่ได้รับการโอนชำระเสร็จในวันนี้ กดเพื่อเปิดหน้าต่างพิมพ์ใบสำคัญรับเงินได้ทันที
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Bookings with confirmed status */}
                <div className="space-y-2.5">
                  <span className="text-[10.5px] font-bold text-slate-700 block">🥇 การจองที่เล่นวันนี้ (ชำระแล้ว):</span>
                  <div className="space-y-2 max-h-[250px] overflow-y-auto border border-slate-100 rounded-lg p-2.5 bg-slate-50/30">
                    {todayBookingList.filter(isPaidBooking).map(b => (
                      <div key={b.id} className="bg-white p-2.5 rounded-lg border border-slate-200 text-[10.5px] flex items-center justify-between hover:bg-slate-50 transition">
                        <div>
                          <p className="font-bold text-slate-800">{courts.find(c => c.id === b.courtId)?.name || 'สนามกีฬาทั่วไป'}</p>
                          <p className="text-[9.5px] text-slate-500">ผู้จอง: {b.userName} | ยอด: {formatBaht(b.totalAmount)} บ.</p>
                          <p className="text-[9px] text-[#475569]">เวลา: {b.startTime} น. | รหัส {b.bookingCode}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedReceiptBooking(b);
                            setSelectedReceiptOrder(null);
                          }}
                          className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1 px-2.5 rounded text-[9.5px] shadow-xs flex items-center gap-1 shrink-0"
                        >
                          <Receipt className="h-3 w-3" /> ใบเสร็จ
                        </button>
                      </div>
                    ))}
                    {todayBookingList.filter(isPaidBooking).length === 0 && (
                      <p className="text-[9.5px] text-slate-400 text-center py-6">ไม่มีรายการจองสนามเวลานี้</p>
                    )}
                  </div>
                </div>

                {/* Orders (F&B and Rentals) */}
                <div className="space-y-2.5">
                  <span className="text-[10.5px] font-bold text-slate-700 block">🥤 สินค้าขาย F&B & เช่าไม้นอกตู้อัตโนมัติ:</span>
                  <div className="space-y-2 max-h-[250px] overflow-y-auto border border-slate-100 rounded-lg p-2.5 bg-slate-50/30">
                    {todaysOrders().map(o => (
                      <div key={o.id} className="bg-white p-2.5 rounded-lg border border-slate-200 text-[10.5px] flex items-center justify-between hover:bg-slate-50 transition">
                        <div>
                          <p className="font-bold text-slate-800">
                            {o.type === OrderType.FB ? '🥤 ออเดอร์ F&B' : o.type === OrderType.EQUIPMENT_SALE ? '🏸 ขายอุปกรณ์กีฬา' : '👟 เช่ารองเท้า/ไม้เล่น'}
                          </p>
                          <p className="text-[9.5px] text-slate-500">ลูกค้า: {o.customerName} | ยอด: {formatBaht(o.totalAmount)} บ.</p>
                          <p className="text-[9.5px] text-[#475569]">รหัสธุรกรรม (Order): {o.orderCode}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedReceiptOrder(o);
                            setSelectedReceiptBooking(null);
                          }}
                          className="bg-sky-600 hover:bg-sky-500 text-white font-bold py-1 px-2.5 rounded text-[9.5px] shadow-xs flex items-center gap-1 shrink-0"
                        >
                          <Receipt className="h-3 w-3" /> ใบเสร็จ
                        </button>
                        {canManageBookings && (
                          <button
                            type="button"
                            disabled={busy} onClick={guarded(() => handleVoidOrder(o))}
                            className="bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-bold py-1 px-2 rounded text-[9.5px] shrink-0 ml-1"
                          >
                            ✖ ยกเลิกบิล
                          </button>
                        )}
                      </div>
                    ))}
                    {todaysOrders().length === 0 && (
                      <p className="text-[9.5px] text-slate-400 text-center py-6">ยังไม่มีผลงานออเดอร์ F&B วันนี้</p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4 bg-amber-50 rounded-xl text-xs flex gap-2 border border-amber-200 text-amber-800">
              <AlertTriangle className="h-5 w-5 text-amber-700 shrink-0" />
              <div>
                <p className="font-bold">นโยบายห้ามแก้ไขรายการเงินสำมะคัญ (Anti-Price Tampering):</p>
                <p className="text-[10px] leading-relaxed mt-1">
                  ทุกรายการแก้ไขยอดเงิน สล็อตที่ถูกกด หรือสินค้าตัดสต๊อกจะถูกสลักชื่อแอดมิน คุณกิตติ ลงในแผงบิล Audit Log ถาวร 
                  การลบหรือสลับยกเลิก (Cancel) สล็อตและจ่ายคืนเคลม (Refund) จะต้องยื่นให้สิทธิ์ ผู้จัดการ (Manager) หรือ ผู้บริหารระบบ (Admin) ดำเนิการผ่านรหัสล็อคเกอร์พาสเท่านั้น
                </p>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Printable Receipt Overlay Modal (ออกใบเสร็จรับเงินอย่างเป็นทางการ) */}
      {(selectedReceiptBooking || selectedReceiptOrder) && (
        <div className="fixed inset-0 bg-slate-900/65 flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-white rounded-2xl max-w-sm w-full p-5 shadow-2xl border border-slate-300 relative space-y-4">
            
            {/* Close button */}
            <button
              onClick={() => {
                setSelectedReceiptBooking(null);
                setSelectedReceiptOrder(null);
              }}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 transition"
              type="button"
            >
              <X className="h-4 w-4" />
            </button>

            {/* Printable Frame Area */}
            <div id="invoice-receipt-print" className="p-4 bg-slate-50 rounded-xl border border-dashed border-slate-300 font-sans text-[11px] text-slate-800 space-y-3.5 shadow-inner">
              
              {/* Receipt Header logo */}
              <div className="text-center space-y-1 pb-3 border-b border-slate-200">
                {shop.name
                  ? <h2 id="receipt-shop-name" className="text-xs font-black tracking-tight text-slate-900 uppercase">{shop.name}</h2>
                  : <h2 id="receipt-shop-name" className="text-xs font-bold text-rose-600">ยังไม่ได้ตั้งชื่อร้าน (ผู้ดูแลตั้งได้ที่แท็บราคา)</h2>}
                {shop.address && <p className="text-[8.5px] text-slate-500">{shop.address}</p>}
                {shop.phone && <p className="text-[8.5px] text-slate-500 font-mono">โทร {shop.phone}</p>}
                {shop.vatRegistered && shop.taxId && <p className="text-[8.5px] text-slate-500">เลขประจำตัวผู้เสียภาษี (TAX ID): <span className="font-mono">{formatTaxId(shop.taxId)}</span></p>}
                <p id="receipt-title" className="text-[10px] font-bold text-slate-800 underline uppercase mt-2">{shop.vatRegistered ? 'ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ' : 'ใบเสร็จรับเงิน'}</p>
                <p className="text-[9px] font-semibold text-slate-600 bg-slate-200/60 inline-block px-1.5 py-0.5 rounded mt-0.5 font-mono">{shop.vatRegistered ? 'RECEIPT / TAX INVOICE (ABB.)' : 'RECEIPT'}</p>
              </div>

              {/* Receipt metadata info */}
              <div className="space-y-1 text-[9.5px] text-slate-600 bg-white p-2 rounded border border-slate-100">
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-500">เลขที่ใบเสร็จ (No.):</span>
                  <span className="font-mono font-bold text-slate-800">
                    {selectedReceiptBooking ? `REC-${selectedReceiptBooking.bookingCode}` : `REC-${selectedReceiptOrder?.orderCode}`}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-500">วันที่ออก (Date):</span>
                  <span className="font-mono">
                    {formatDateTime(Date.now())} น.
                  </span>
                </div>
                {receipt?.paid && receipt.paidAt && (
                  <div className="flex justify-between">
                    <span className="font-semibold text-slate-500">วันที่รับเงิน (Paid):</span>
                    <span id="receipt-paid-at" className="font-mono">{formatDateTime(receipt.paidAt)} น.</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-500">ชื่อผู้ซื้อ (Customer):</span>
                  <span className="font-bold text-slate-800">
                    {selectedReceiptBooking ? selectedReceiptBooking.userName : selectedReceiptOrder?.customerName}
                  </span>
                </div>
                {selectedReceiptBooking?.userPhone && (
                  <div className="flex justify-between">
                    <span className="font-semibold text-slate-500">เบอร์โทรศัพท์:</span>
                    <span className="font-mono">{selectedReceiptBooking.userPhone}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-500">ผู้รับชำระ (Cashier):</span>
                  <span id="receipt-cashier" className="italic">{receipt?.cashier || '-'}</span>
                </div>
              </div>

              {/* Items detail list */}
              <div className="border-t border-b border-slate-200 py-2">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[8.5px] font-black text-slate-500 uppercase tracking-wide border-b border-slate-200 pb-1">
                      <th className="pb-1">รายการ (Item)</th>
                      <th className="pb-1 text-center">จํานวน</th>
                      <th className="pb-1 text-right">สุทธิ (บ.)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-[10px]">
                    {selectedReceiptBooking && receipt?.rows.map(row => (
                      <tr key={row.id}>
                        <td className="py-1">
                          <span className="font-medium text-slate-800">{courts.find(c => c.id === row.courtId)?.name || 'สนามหลักคอมเพล็กซ์'}</span>
                          <div className="text-[8.5px] text-slate-400 font-mono">
                            วันที่เล่น {row.date} ({row.startTime} - {row.endTime} น.)
                          </div>
                        </td>
                        <td className="py-1 text-center font-mono">1 ชม.</td>
                        <td className="py-1 text-right font-mono font-bold text-slate-800">{formatBaht(row.totalAmount)}</td>
                      </tr>
                    ))}

                    {selectedReceiptOrder && selectedReceiptOrder.items.map((it, idx) => {
                      const prodName = it.productName || products.find(p => p.id === it.productId)?.name || 'สินค้า F&B / อุปกรณ์กีฬา';
                      return (
                        <tr key={idx}>
                          <td className="py-1">
                            <span className="font-medium text-slate-800">{prodName}</span>
                            {it.shoeSize && (
                              <span className="text-[8px] text-indigo-700 bg-indigo-50 border border-indigo-100 px-1 rounded ml-1">
                                Size {it.shoeSize} ({it.shoeGender === 'M' ? 'ชาย' : 'หญิง'})
                              </span>
                            )}
                          </td>
                          <td className="py-1 text-center font-mono">{it.qty}</td>
                          <td className="py-1 text-right font-mono font-bold text-slate-800">{formatBaht(it.unitPrice * it.qty)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Financial Calculation footer */}
              <div className="space-y-0.5 text-[9.5px] text-slate-700">
                {shop.vatRegistered && (() => {
                  const total = receipt?.total || 0;
                  const vat = Math.round(total * 7 / 107 * 100) / 100;
                  return (<>
                    <div className="flex justify-between">
                      <span>ฐานภาษี (VATAble Base):</span>
                      <span className="font-mono">{(total - vat).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>ภาษีมูลค่าเพิ่ม (VAT 7%):</span>
                      <span id="receipt-vat" className="font-mono mr-1">{vat.toFixed(2)}</span>
                    </div>
                  </>);
                })()}
                <div className="flex justify-between font-black text-slate-900 border-t border-slate-200 pt-1.5 text-[11px]">
                  <span>ยอดชำระสุทธิ (Grand Total):</span>
                  <span className="font-mono text-emerald-700 text-[11.5px]">
                    {formatBaht(receipt?.total || 0)} บาท
                  </span>
                </div>
              </div>

              {/* Signature stamp */}
              <div className="pt-2.5 text-center border-t border-slate-200 space-y-0.5 text-[8.5px] text-slate-400">
                {receipt?.paid
                  ? <p>💸 รับชำระแล้วโดย: <span id="receipt-method" className="font-bold text-slate-700 uppercase">{(receipt.method && METHOD_LABEL[receipt.method]) || receipt.method || '-'}</span></p>
                  : <p id="receipt-unpaid" className="font-bold text-rose-600">ยังไม่ได้รับชำระเงิน / ยกเลิกแล้ว — ไม่ออกใบเสร็จ</p>}
                <p className="italic">"ขอบพระคุณลูกค้าที่วางใจคอมเพล็กซ์ของเราค่ะ"</p>
              </div>
            </div>

            {/* Booking actions: cancel/refund and cash for managers, no-show
                for any staff. */}
            {selectedReceiptBooking && (() => {
              const b = selectedReceiptBooking;
              const timing = slotTiming(b.date, b.startTime);
              const canNoShow = (b.status === BookingStatus.CONFIRMED || b.status === BookingStatus.COMPLETED) && timing.started;
              const canCancel = canManageBookings && (b.status === BookingStatus.CONFIRMED || b.status === BookingStatus.PENDING_PAYMENT);
              // Not while a slip waits for review (approve/reject it instead).
              const ids = new Set(bookingGroupOf(b, bookingPool()).map(x => x.id));
              const payStatus = api.USE_BACKEND ? b.paymentStatus : payments.find(p => ids.has(p.bookingId))?.status;
              const canCash = canManageBookings && b.status === BookingStatus.PENDING_PAYMENT && payStatus !== PaymentStatus.SLIP_UPLOADED;
              if (!canNoShow && !canCancel && !canCash) return null;
              return (
                <div id="booking-actions" className="flex flex-wrap gap-2 text-[11px]">
                  {canCash && (
                    <button type="button" disabled={busy} onClick={guarded(() => handleMarkPaidInCash(b))} className="disabled:opacity-50 flex-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 font-bold py-1.5 rounded-lg">💵 รับเงินสดแล้ว</button>
                  )}
                  {canNoShow && (
                    <button type="button" disabled={busy} onClick={guarded(() => handleMarkNoShow(b))} className="disabled:opacity-50 flex-1 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 font-bold py-1.5 rounded-lg">🚫 ไม่มาใช้สนาม</button>
                  )}
                  {canCancel && (
                    <button type="button" disabled={busy} onClick={guarded(() => handleCancelBooking(b))} className="disabled:opacity-50 flex-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-bold py-1.5 rounded-lg">✖ ยกเลิก / คืนเงิน</button>
                  )}
                </div>
              );
            })()}

            {/* Print action buttons */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                onClick={() => {
                  setSelectedReceiptBooking(null);
                  setSelectedReceiptOrder(null);
                }}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 py-2 rounded-xl font-bold text-center transition"
              >
                ปิดย้อนกลับ
              </button>
              
              <button
                type="button"
                id="receipt-print"
                disabled={!receipt?.paid}
                onClick={() => {
                  window.print();
                  onAddAuditLog('RECEIPT_PRINTED_BY_STAFF', 'Report', selectedReceiptBooking ? selectedReceiptBooking.id : (selectedReceiptOrder?.id || ''), null, null);
                }}
                className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-2 rounded-xl text-center transition flex justify-center items-center gap-1 shadow-sm font-sans"
              >
                <Receipt className="h-3.5 w-3.5" /> พิมพ์บิล/บันทึก PDF
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
