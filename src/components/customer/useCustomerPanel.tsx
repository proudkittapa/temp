import React, { useState, useEffect, useMemo, useRef, createContext, useContext } from 'react';
import {
  Court, CourtType, Booking, Payment, LineMessage, DayOff,
  User
} from '../../types';
import { StorageService, normalizePhone, getTodayDateStr, formatDate } from '../../mockData';
import { useLiveLoad, useLiveTick } from '../../useLiveTick';
import * as api from '../../api';
import { notify } from '../Dialog';
import { useAccountActions } from './accountActions';
import { useSlotPicker } from './slotPicker';
import { useBookingFlow } from './bookingFlow';
import { useRewardActions } from './rewardActions';
import { CustomerPanelProps, Reward, Redemption, LOYALTY_REWARDS } from './shared';
export * from './shared';

// Shared state, effects and data loading of the panel. The handlers are in
// one hook per area: accountActions, slotPicker, bookingFlow, rewardActions.
function useCustomerPanelCore({ onAddAuditLog, triggerRefresh, onRefreshAll, onStaffSignIn }: CustomerPanelProps) {
  // Load data
  const [courts, setCourts] = useState<Court[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [lineMessages, setLineMessages] = useState<LineMessage[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  // API mode: the rewards catalog comes from the backend (null until loaded).
  const [apiRewards, setApiRewards] = useState<Reward[] | null>(null);
  const rewardsCatalog = api.USE_BACKEND ? (apiRewards ?? []) : LOYALTY_REWARDS;
  
  // Interaction Form state
  const [selectedType, setSelectedType] = useState<CourtType>(CourtType.BADMINTON);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedSlots, setSelectedSlots] = useState<{ courtId: string; startTime: string }[]>([]);

  // Booking view: a wide grid on desktop, a list of courts with big hour
  // buttons on phones. 'auto' picks by screen width; the toggle overrides it
  // and is remembered on this device.
  const [isNarrow, setIsNarrow] = useState<boolean>(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const onChange = () => setIsNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const [viewPref, setViewPref] = useState<'auto' | 'grid' | 'list'>(() => {
    try { return (localStorage.getItem('sports_complex_booking_view') as 'grid' | 'list') || 'auto'; } catch { return 'auto'; }
  });
  const viewMode = viewPref === 'auto' ? (isNarrow ? 'list' : 'grid') : viewPref;
  const chooseView = (v: 'grid' | 'list') => {
    setViewPref(v);
    try { localStorage.setItem('sports_complex_booking_view', v); } catch { /* private mode: not remembered */ }
  };
  // The rewards club is long; on phones it starts folded so the booking
  // steps come first.
  const [showRewards, setShowRewards] = useState<boolean>(() => !(typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches));

  // Courts expanded in the list view.
  const [openCourts, setOpenCourts] = useState<Record<string, boolean>>({});
  
  const [memberName, setMemberName] = useState<string>('');

  // Customer Authed account state
  const [loggedInUser, setLoggedInUser] = useState<User | null>(null);
  const [authTab, setAuthTab] = useState<'login' | 'register' | 'forgot'>('login');
  const [authEmail, setAuthEmail] = useState<string>('');
  const [authPassword, setAuthPassword] = useState<string>('');
  const [authName, setAuthName] = useState<string>('');
  const [authPhone, setAuthPhone] = useState<string>('');
  const [forgotResult, setForgotResult] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // UI state
  const [activeStep, setActiveStep] = useState<number>(1); // 1: Select Slot, 2: Info & Checkout, 3: QR Payment & Upload Slip
  // Live data: availability and the customer's payments reload while the
  // page is visible - every 10 s on the payment screen (so "approved" or
  // "expired" shows up by itself), 30 s elsewhere - and on returning from
  // the banking app.
  const liveTick = useLiveTick(activeStep === 3 ? 10000 : 30000);

  // One action at a time (booking, slip upload, redeem): a double tap on a
  // slow phone must not send it twice. Wraps the button handlers; `busy`
  // greys the buttons.
  const busyRef = React.useRef(false);
  const [busy, setBusy] = useState(false);
  const guarded = <A extends unknown[]>(fn: (...args: A) => unknown) => async (...args: A) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await fn(...args); } finally { busyRef.current = false; setBusy(false); }
  };

  // Moving between steps scrolls the booking area into view - on a phone the
  // account box above it would otherwise hide the new step.
  const firstStepRender = React.useRef(true);
  useEffect(() => {
    if (firstStepRender.current) { firstStepRender.current = false; return; }
    document.getElementById('booking-steps-indicator')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [activeStep]);

  const [currentBooking, setCurrentBooking] = useState<Booking | null>(null);
  // The group's payment shown in step 3: its amount is the whole group's
  // total (currentBooking is only the first hour), and its createdAt drives
  // the payment-hold countdown.
  const [currentPayment, setCurrentPayment] = useState<Payment | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    if (activeStep !== 3) return;
    const t = setInterval(() => setNowTick(Date.now()), 15000);
    return () => clearInterval(t);
  }, [activeStep]);
  const [qrCodePayload, setQrCodePayload] = useState<string>('');
  const [showLineSimulator, setShowLineSimulator] = useState<boolean>(false);
  const [bookingSuccessAlert, setBookingSuccessAlert] = useState<string | null>(null);
  const [daysOff, setDaysOff] = useState<DayOff[]>([]);

  // Lookups for the booking history, built once per data change instead of
  // re-scanning every booking and payment for each row on every render.
  const bookingById = useMemo(() => new Map(bookings.map(b => [b.id, b])), [bookings]);
  const courtNameById = useMemo(() => new Map(courts.map(c => [c.id, c.name])), [courts]);
  const paymentForBooking = useMemo(() => {
    const groupKey = (b: Booking) => `${b.bookingCode}|${b.userId}|${b.date}`;
    const byBookingId = new Map(payments.map(p => [p.bookingId, p]));
    const byGroup = new Map<string, Payment>();
    for (const p of payments) {
      const root = bookingById.get(p.bookingId);
      if (root) byGroup.set(groupKey(root), p);
    }
    return (b: Booking) => byBookingId.get(b.id) || byGroup.get(groupKey(b));
  }, [payments, bookingById]);

  // Load everything
  useEffect(() => {
    const rawCourts = StorageService.get<Court[]>('courts', []);
    const rawBookings = StorageService.get<Booking[]>('bookings', []);
    const rawPayments = StorageService.get<Payment[]>('payments', []);
    const rawLine = StorageService.get<LineMessage[]>('line_messages', []);
    const rawDaysOff = StorageService.get<DayOff[]>('days_off', []);
    const rawRedemptions = StorageService.get<Redemption[]>('redemptions', []);
    
    // Load current logged in customer (API mode keeps it in the API session)
    let currentCust = api.USE_BACKEND
      ? api.getSession('customer')?.user ?? null
      : StorageService.get<User | null>('current_logged_in_customer', null);
    // Browser-only mode: the saved login is a copy taken at sign-in. Re-read
    // the account so points/tier changes show, and sign out a customer the
    // admin has since suspended or deleted.
    if (!api.USE_BACKEND && currentCust) {
      const fresh = StorageService.get<User[]>('users', []).find(u => u.id === currentCust!.id);
      if (!fresh || !fresh.isActive) {
        StorageService.set('current_logged_in_customer', null);
        currentCust = null;
      } else {
        currentCust = fresh;
        StorageService.set('current_logged_in_customer', fresh);
      }
    }
    if (currentCust) {
      setLoggedInUser(currentCust);
      setMemberName(currentCust.name);
    } else {
      setLoggedInUser(null);
      setMemberName('');
    }

    // In API mode courts/bookings/payments are fetched by the effect below.
    if (!api.USE_BACKEND) {
      setCourts(rawCourts.filter(c => c.isActive));
      setBookings(rawBookings);
      setPayments(rawPayments);
    }
    setLineMessages(rawLine);
    if (!api.USE_BACKEND) setDaysOff(rawDaysOff);
    if (!api.USE_BACKEND) setRedemptions(rawRedemptions);

    // Start on today (Bangkok); a refresh keeps the date the customer chose.
    setSelectedDate(prev => prev || getTodayDateStr());
  }, [triggerRefresh, liveTick]);

  // API mode: load courts, the selected date's bookings (for availability)
  // and the customer's own bookings+payments (for history) from the backend.
  const [apiError, setApiError] = useState<string | null>(null);
  // API mode: the date whose bookings are on screen. Until it matches the
  // chosen date the grid would show the previous date's bookings as free
  // hours, so it waits.
  const [loadedDate, setLoadedDate] = useState<string>('');
  const gridLoading = api.USE_BACKEND && loadedDate !== selectedDate;
  const loggedInUserId = loggedInUser?.id;
  // API calls use the stored session; another tab may have signed in as
  // someone else since this page loaded. Checked before booking or
  // spending, so nothing is done for the wrong account.
  const sessionStillMine = () => {
    if (!api.USE_BACKEND || !loggedInUser) return true;
    if (api.getSession('customer')?.user.id === loggedInUser.id) return true;
    notify('บัญชีที่เข้าสู่ระบบเปลี่ยนไปแล้ว (อาจเข้าสู่ระบบจากแท็บอื่น) — กำลังโหลดข้อมูลใหม่ กรุณาลองอีกครั้ง');
    onRefreshAll();
    return false;
  };
  // Only the signed-in customer's own messages (the store holds everyone's).
  const myLineMessages = loggedInUser
    ? lineMessages.filter(m => normalizePhone(m.recipientPhone) === normalizePhone(loggedInUser.phone || ''))
    : [];
  const paymentStep = activeStep === 3;
  useLiveLoad(async isCurrent => {
    if (!api.USE_BACKEND || !selectedDate) return;
    try {
      // Check the session first: if it lapsed, fall back to logged-out
      // and load the public views, instead of letting the logged-in-only
      // calls fail the whole load.
      const me = loggedInUserId ? await api.refreshMe('customer') : null;
      if (!isCurrent()) return;
      if (loggedInUserId && !me) {
        setLoggedInUser(null);
        clearCustomerScreen();
        setAuthError('⏰ เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
        return; // loggedInUserId changes, so this effect re-runs logged out
      }
      if (me) setLoggedInUser(me);

      // On the payment step (polled every 10 s) only the customer's own
      // bookings and payments change what is shown - not the grid, rewards
      // or pricing; going back to booking reloads everything.
      if (paymentStep && me) {
        const mine = await api.listMyBookings();
        if (!isCurrent()) return;
        const mineById = new Map(mine.bookings.map(b => [b.id, b]));
        setBookings(prev => [...prev.filter(b => !mineById.has(b.id)), ...mine.bookings]);
        setPayments(mine.payments);
        setApiError(null);
        return;
      }

      // What the grid needs must all arrive; the extras (rewards, vouchers,
      // the price preview's pricing cache) may fail on their own without
      // leaving the grid on the previous date's bookings.
      // syncPricingCache refreshes the pricing the price preview reads, so
      // it shows what the server will actually charge.
      const extras = Promise.allSettled([
        api.syncPricingCache(),
        api.listRewards(),
        me ? api.myVouchers() : Promise.resolve([] as api.VoucherInfo[])
      ]);
      const [apiCourts, dayBookings, mine, closures] = await Promise.all([
        api.listCourts(),
        api.listBookingsByDate(selectedDate),
        me ? api.listMyBookings() : Promise.resolve({ bookings: [], payments: [] }),
        api.listDaysOff(selectedDate, selectedDate)
      ]);
      const [, rewards, vouchers] = await extras;
      if (!isCurrent()) return;
      if (rewards.status === 'fulfilled') {
        setApiRewards(rewards.value.map(r => ({ id: r.id, name: r.name, cost: r.pointsCost, description: '', emoji: r.emoji })));
      }
      if (vouchers.status === 'fulfilled') {
        setRedemptions(vouchers.value.map(v => ({
          id: v.id, status: v.status, userId: me?.id || '', userName: me?.name || '', rewardId: v.rewardId,
          rewardName: `${v.rewardEmoji} ${v.rewardName}`, pointsSpent: v.pointsSpent, claimCode: v.code,
          redeemedAt: formatDate(v.createdAt)
        })));
      }
      setDaysOff(closures);
      // The customer's own rows carry their details; prefer them over the
      // copies in the by-date list.
      const mineById = new Map(mine.bookings.map(b => [b.id, b]));
      setCourts(apiCourts);
      setBookings([...dayBookings.filter(b => !mineById.has(b.id)), ...mine.bookings]);
      setPayments(mine.payments);
      setLoadedDate(selectedDate);
      setApiError(null);
    } catch (err) {
      if (isCurrent()) setApiError(err instanceof Error ? err.message : String(err));
    }
  }, [triggerRefresh, selectedDate, loggedInUserId, paymentStep], liveTick);

  // The payment screen follows the server: the payment as last loaded
  // (approved, rejected, expired, refunded), not the copy from when it was
  // created.
  useEffect(() => {
    if (!currentPayment) return;
    const fresh = payments.find(p => p.id === currentPayment.id);
    if (fresh && (fresh.status !== currentPayment.status || fresh.slipUploadedAt !== currentPayment.slipUploadedAt)) setCurrentPayment(fresh);
  }, [payments]);

  // Nothing of this customer's session (picks, booking code, QR) is left on
  // screen for the next person on a shared device.
  const clearCustomerScreen = () => {
    setActiveStep(1);
    setSelectedSlots([]);
    setCurrentBooking(null);
    setCurrentPayment(null);
    setQrCodePayload('');
    setBookingSuccessAlert(null);
    setBookings([]);
    setPayments([]);
    setRedemptions([]);
  };
  // Also when the account changes any other way - the nav bar's sign-out,
  // another tab signing in or out - not only the panel's own logout.
  const shownUserId = useRef(loggedInUserId);
  useEffect(() => {
    if (shownUserId.current && shownUserId.current !== loggedInUserId) clearCustomerScreen();
    shownUserId.current = loggedInUserId;
  }, [loggedInUserId]);

  // Picked hours are dropped when the court list really changes (a court
  // added or closed). Keyed on the ids, not the array: every refresh
  // re-fetches the courts, and that must not wipe the customer's picks.
  const courtIdsKey = courts.map(c => c.id).join(',');
  useEffect(() => {
    setSelectedSlots([]);
  }, [selectedType, courtIdsKey]);
  return {
    onAddAuditLog,
    triggerRefresh,
    onRefreshAll,
    onStaffSignIn,
    courts,
    setCourts,
    bookings,
    setBookings,
    payments,
    setPayments,
    lineMessages,
    setLineMessages,
    redemptions,
    setRedemptions,
    apiRewards,
    setApiRewards,
    rewardsCatalog,
    selectedType,
    setSelectedType,
    selectedDate,
    setSelectedDate,
    selectedSlots,
    setSelectedSlots,
    isNarrow,
    setIsNarrow,
    viewPref,
    setViewPref,
    viewMode,
    chooseView,
    showRewards,
    setShowRewards,
    openCourts,
    setOpenCourts,
    memberName,
    setMemberName,
    loggedInUser,
    setLoggedInUser,
    authTab,
    setAuthTab,
    authEmail,
    setAuthEmail,
    authPassword,
    setAuthPassword,
    authName,
    setAuthName,
    authPhone,
    setAuthPhone,
    forgotResult,
    setForgotResult,
    authError,
    setAuthError,
    activeStep,
    setActiveStep,
    liveTick,
    busyRef,
    busy,
    setBusy,
    guarded,
    firstStepRender,
    currentBooking,
    setCurrentBooking,
    currentPayment,
    setCurrentPayment,
    nowTick,
    setNowTick,
    qrCodePayload,
    setQrCodePayload,
    showLineSimulator,
    setShowLineSimulator,
    bookingSuccessAlert,
    setBookingSuccessAlert,
    daysOff,
    setDaysOff,
    bookingById,
    courtNameById,
    paymentForBooking,
    apiError,
    setApiError,
    loadedDate,
    setLoadedDate,
    gridLoading,
    loggedInUserId,
    sessionStillMine,
    myLineMessages,
    clearCustomerScreen,
    courtIdsKey
  };
}

export type CustomerPanelCore = ReturnType<typeof useCustomerPanelCore>;

// Everything the panel and its tabs use (read through the context below):
// the core plus each area's handlers, in dependency order.
export function useCustomerPanel(props: CustomerPanelProps) {
  const core = useCustomerPanelCore(props);
  const account = useAccountActions(core);
  const slotPicker = useSlotPicker(core);
  const bookingFlow = useBookingFlow({ ...core, ...slotPicker });
  const rewardActions = useRewardActions(core);
  return { ...core, ...account, ...slotPicker, ...bookingFlow, ...rewardActions };
}

export type CustomerPanelState = ReturnType<typeof useCustomerPanel>;
export const CustomerPanelContext = createContext<CustomerPanelState | null>(null);
export function useCustomerPanelContext(): CustomerPanelState {
  const value = useContext(CustomerPanelContext);
  if (!value) throw new Error('useCustomerPanelContext outside CustomerPanel');
  return value;
}
