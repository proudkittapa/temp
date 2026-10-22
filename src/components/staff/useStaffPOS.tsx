import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import {
  Court, CourtType, Booking, Payment, PaymentStatus,
  PaymentMethod, Product, Order, OrderStatus, OrderType, DayOff, User, Shift, LineMessage
} from '../../types';
import { StorageService, getTodayDateStr, normalizePhone } from '../../mockData';
import * as api from '../../api';
import { useLiveLoad, useLiveTick } from '../../useLiveTick';
import { can, canUseCounter, Permission } from '../../permissions';
import { useStaffSession } from './sessionActions';
import { useShiftActions } from './shiftActions';
import { useSlipActions } from './slipActions';
import { useBookingActions } from './bookingActions';
import { useVoucherActions } from './voucherActions';
import { useWalkinActions } from './walkinActions';
import { useShopActions } from './shopActions';
import { useRentalActions } from './rentalActions';
import { useDayReport } from './dayReport';
import { StaffPOSProps, localShiftView } from './shared';
export * from './shared';

// Shared state, effects and data loading of the panel. The handlers are in
// one hook per area: sessionActions, shiftActions, slipActions, bookingActions, voucherActions, walkinActions, shopActions, rentalActions, dayReport.
function useStaffPOSCore({ currentUserRole, onAddAuditLog, triggerRefresh, onRefreshAll }: StaffPOSProps) {
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
    pendingSeen,
    pushLineMessage,
    actingUser,
    canManageBookings,
    TAB_PERMISSIONS,
    tabAllowed,
    firstAllowedTab,
    blindCount,
    countLocked,
    setCountLocked,
    closeBookingDetail,
    busyRef,
    busy,
    setBusy,
    guarded,
    bookingPool,
    pendingSlipPayments,
    slipQueueBookings,
    signedInElsewhere
  };
}

export type StaffPOSCore = ReturnType<typeof useStaffPOSCore>;

// Everything the panel and its tabs use (read through the context below):
// the core plus each area's handlers, in dependency order.
export function useStaffPOS(props: StaffPOSProps) {
  const core = useStaffPOSCore(props);
  const session = useStaffSession(core);
  const shiftActions = useShiftActions(core);
  const slipActions = useSlipActions(core);
  const bookingActions = useBookingActions({ ...core, ...shiftActions });
  const voucherActions = useVoucherActions(core);
  const walkinActions = useWalkinActions({ ...core, ...shiftActions, ...voucherActions, ...slipActions });
  const shopActions = useShopActions({ ...core, ...shiftActions });
  const rentalActions = useRentalActions({ ...core, ...shiftActions });
  const dayReport = useDayReport(core);
  return { ...core, ...session, ...shiftActions, ...slipActions, ...bookingActions, ...voucherActions, ...walkinActions, ...shopActions, ...rentalActions, ...dayReport };
}

export type StaffPOSState = ReturnType<typeof useStaffPOS>;
export const StaffPOSContext = createContext<StaffPOSState | null>(null);
export function useStaffPOSContext(): StaffPOSState {
  const value = useContext(StaffPOSContext);
  if (!value) throw new Error('useStaffPOSContext outside StaffPOS');
  return value;
}
