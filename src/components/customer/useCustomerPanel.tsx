import React, { useState, useEffect, useMemo } from 'react';
import {
  Court, CourtType, PriceType, Booking, BookingStatus,
  Payment, PaymentStatus, PaymentMethod, MemberType, LineMessage, DayOff,
  User, UserRole, LedgerEntryType, AddAuditLog
} from '../../types';
import { StorageService, findClosure, calculatePrice, generatePromptPayPayload, LOCAL_PROMPTPAY_ID, slotTiming, normalizePhone, openSlotHours, formatBaht, roundBaht, lastBookableDate, getTodayDateStr, isHourOffPeak, isCourtSlotAvailable, findConflictingBooking, formatDate, formatDateTime } from '../../mockData';
import { prepareSlipImage, SlipImageError } from '../../slipImage';
import { useLiveLoad, useLiveTick } from '../../useLiveTick';
import * as api from '../../api';
import { canUseCounter, canUseSettings } from '../../permissions';
import { notify, ask } from '../Dialog';
import { createContext, useContext } from 'react';

// How long an online booking waits for its slip before the backend cancels
// it (service.PaymentHoldDuration in the Go backend).
export const PAYMENT_HOLD_MINUTES = 30;

export interface CustomerPanelProps {
  onAddAuditLog: AddAuditLog;
  triggerRefresh: number;
  onRefreshAll: () => void;
  // One login for everyone: a staff/admin account signed in here is handed
  // to App, which opens the screen its role may use.
  onStaffSignIn?: (user: User) => void;
}

export interface Reward {
  id: string;
  name: string;
  cost: number;
  description: string;
  emoji: string;
}

export interface Redemption {
  id: string;
  status?: 'ACTIVE' | 'REDEEMED' | 'EXPIRED' | 'CANCELLED';
  userId: string;
  userName: string;
  rewardId: string;
  rewardName: string;
  pointsSpent: number;
  claimCode: string;
  redeemedAt: string;
}

// The LINE chat preview simulates notifications that aren't sent yet (see
// TODO.md item 2): demo and dev builds only, never a real customer site.
export const SHOW_LINE_SIM = !(import.meta.env.PROD && api.USE_BACKEND);

export const COURT_TYPE_LABEL: Record<CourtType, string> = {
  [CourtType.BADMINTON]: '🏸 แบดมินตัน',
  [CourtType.BASKETBALL]: '🏀 บาสเกตบอล',
  [CourtType.PICKLEBALL]: '🏓 พิกเคิลบอล',
  [CourtType.MEETING_ROOM]: '👥 ห้องประชุม'
};

// LINE message times: ISO timestamps, shown in Bangkok time. Older saved
// messages stored only a local time string ("13:56:02"); show those as-is.
export function lineMessageTime(ts: string): string {
  if (!ts) return '';
  return isNaN(new Date(ts).getTime()) ? ts : formatDateTime(ts);
}

export const LOYALTY_REWARDS: Reward[] = [
  { id: 'water', name: "น้ำแร่ภูเขาแช่เย็น (Free Mineral Water)", cost: 5, description: "น้ำดื่มสุขภาพเย็นฉ่ำขวดใหญ่ ดับกระหายลุยศึกซูเปอร์แมตช์", emoji: "🥤" },
  { id: 'sponsor', name: "เกลือแร่สปอนเซอร์ (Free Energy Drink)", cost: 8, description: "เพิ่มประจุพลังงานฟิตเต็มร้อยพร้อมเสิร์ฟตบคีย์สปีดสปอร์ต", emoji: "⚡" },
  { id: 'towel', name: "ผ้าขนหนูเช่าซักสะอาดยกชุด (Free Towel Rental)", cost: 10, description: "สิทธิ์ผ้าเช็ดตัวไมโครไฟเบอร์ นิ่มเนียน สะอาดแห้งอบโอโซน", emoji: "🧼" },
  { id: 'court', name: "เช่าสนามฟรี 1 สล็อต Off-Peak (Free 1-Hr Court)", cost: 25, description: "ยกเว้นค่าธรรมเนียมสนามในช่วงเวลา Off-Peak 1 ชั่วโมงเต็ม", emoji: "🏸" }
];

export type SlotState =
| { kind: 'booked'; pending: boolean; mine: boolean }
| { kind: 'closed'; reason: string }
| { kind: 'started' }
| { kind: 'peakBlocked' }
| { kind: 'notOpen' }
| { kind: 'free' | 'selected'; price: number; isPeak: boolean; isOffPeak: boolean };

// State and handlers of CustomerPanel (moved here as they were). The panel
// and its tab components read them through CustomerPanelContext.
export function useCustomerPanel({ onAddAuditLog, triggerRefresh, onRefreshAll, onStaffSignIn }: CustomerPanelProps) {
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
  }, [triggerRefresh, selectedDate, loggedInUserId], liveTick);

  // The payment screen follows the server: the payment as last loaded
  // (approved, rejected, expired, refunded), not the copy from when it was
  // created.
  useEffect(() => {
    if (!currentPayment) return;
    const fresh = payments.find(p => p.id === currentPayment.id);
    if (fresh && (fresh.status !== currentPayment.status || fresh.slipUploadedAt !== currentPayment.slipUploadedAt)) setCurrentPayment(fresh);
  }, [payments]);

  // Customer Auth Function Handlers
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    return loginWith(authEmail, authPassword);
  };

  // Shared by the login form and the dev-only demo account buttons.
  const loginWith = (identity: string, password: string) => {
    setAuthError(null);
    setForgotResult(null);

    if (api.USE_BACKEND) {
      return api.login('customer', identity, password)
        .then(user => {
          setAuthEmail('');
          setAuthPassword('');
          if (onStaffSignIn && (canUseCounter(user) || canUseSettings(user))) {
            onStaffSignIn(user);
            return;
          }
          setLoggedInUser(user);
          onAddAuditLog('CUSTOMER_LOGIN_SUCCESS', 'User', user.id, null, { name: user.name, role: user.role });
          setAuthEmail('');
          setAuthPassword('');
          onRefreshAll();
        })
        .catch(err => setAuthError(`❌ ${err.message}`));
    }

    const allUsers = StorageService.get<User[]>('users', []);
    const foundUser = allUsers.find(
      u => (u.email?.toLowerCase() === identity.toLowerCase() || (!identity.includes('@') && normalizePhone(u.phone) === normalizePhone(identity))) && u.role === UserRole.CUSTOMER
    );

    if (!foundUser) {
      setAuthError('❌ ไม่พบบัญชีผู้ใช้งานที่ระบุ หรือรหัสผ่านไม่ถูกต้อง (กรุณาใช้เบอร์โทร หรือ อีเมลที่สมัครในระบบ)');
      return;
    }

    if (foundUser.password !== password) {
      setAuthError('❌ รหัสผ่านไม่ถูกต้อง กรุณากรอกใหม่อีกครั้ง');
      return;
    }

    if (!foundUser.isActive) {
      setAuthError('❌ บัญชีสิทธิ์นี้ถูกระงับติดต่อสตาฟร้านเพื่อเปิดใช้งานอีกครั้ง');
      return;
    }

    // Success login
    StorageService.set('current_logged_in_customer', foundUser);
    onAddAuditLog('CUSTOMER_LOGIN_SUCCESS', 'User', foundUser.id, null, { name: foundUser.name, role: foundUser.role });
    
    // reset form states
    setAuthEmail('');
    setAuthPassword('');
    setAuthError(null);
    onRefreshAll();
  };

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setForgotResult(null);

    if (!authName || !authPhone || !authPassword) {
      setAuthError('❌ กรุณาใส่ชื่อ เบอร์โทร และรหัสผ่าน');
      return;
    }
    if (authPassword.length < 6) {
      setAuthError('❌ รหัสผ่านต้องมีอย่างน้อย 6 ตัว');
      return;
    }

    if (api.USE_BACKEND) {
      return api.register({ name: authName, email: authEmail.trim(), phone: authPhone, password: authPassword })
        .then(user => {
          setLoggedInUser(user);
          setAuthEmail('');
          setAuthPassword('');
          setAuthName('');
          setAuthPhone('');
          onRefreshAll();
          notify('🎉 สมัครสมาชิกและเข้าสู่ระบบสำเร็จ! ระดับบัญชีของคุณเริ่มต้นที่ "ลูกค้าทั่วไป" 🌟');
        })
        .catch(err => setAuthError(`❌ ${err.message}`));
    }

    const allUsers = StorageService.get<User[]>('users', []);
    const emailExists = !!authEmail.trim() && allUsers.some(u => u.email?.toLowerCase() === authEmail.trim().toLowerCase());
    const phoneExists = allUsers.some(u => normalizePhone(u.phone) === normalizePhone(authPhone));

    if (emailExists) {
      setAuthError('❌ อีเมลนี้มีอยู่ในระบบแล้ว กรุณาเข้าสู่ระบบแทน');
      return;
    }
    if (phoneExists) {
      setAuthError('❌ เบอร์โทรศัพท์นี้ถูกลงทะเบียนไว้แล้ว กรุณาใช้เบอร์อื่นหรือกู้รหัสผ่าน');
      return;
    }

    // Create custom student/member metadata based on preference (Always default to NORMAL as requested, admin must promote/assign discount tier)
    const newId = 'u-cust-' + Date.now();
    const newUserObj: User = {
      id: newId,
      name: authName,
      email: authEmail,
      phone: authPhone,
      role: UserRole.CUSTOMER,
      memberType: MemberType.NORMAL,
      isActive: true,
      createdAt: getTodayDateStr(),
      password: authPassword
    };

    const updatedUsersList = [...allUsers, newUserObj];
    StorageService.set('users', updatedUsersList);
    StorageService.set('current_logged_in_customer', newUserObj);

    onAddAuditLog('CUSTOMER_REGISTER_SUCCESS', 'User', newId, null, { name: authName, memberType: MemberType.NORMAL });

    // reset forms
    setAuthEmail('');
    setAuthPassword('');
    setAuthName('');
    setAuthPhone('');
    
    onRefreshAll();
    notify('🎉 สมัครสมาชิกก๊วนและเข้าสู่ระบบสำเร็จ! ระดับบัญชีของคุณเริ่มต้นที่ "ลูกค้าทั่วไป" (สามารถติดต่อเจ้าหน้าที่สตาฟ ณ ร้านเพื่อยืนยันหลักฐานรับสิทธิ์ส่วนลดพิเศษได้ภายหลังค่ะ) 🌟');
  };

  const handleForgotPassword = (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setForgotResult(null);

    if (!authEmail) {
      setAuthError('❌ กรุณากรอกเบอร์โทรหรืออีเมลเพื่อยืนยันสิทธิ์ค้นหา');
      return;
    }

    // The backend only stores password hashes, so there is nothing to look
    // up - and revealing a password on screen was only ever a demo shortcut.
    if (api.USE_BACKEND) {
      setForgotResult('ℹ️ ระบบไม่สามารถแสดงรหัสผ่านเดิมได้ กรุณาติดต่อเจ้าหน้าที่ที่เคาน์เตอร์เพื่อรีเซ็ตรหัสผ่านค่ะ');
      return;
    }

    const allUsers = StorageService.get<User[]>('users', []);
    const foundUser = allUsers.find(
      u => (u.email?.toLowerCase() === authEmail.toLowerCase() || u.phone === authEmail) && u.role === UserRole.CUSTOMER
    );

    if (!foundUser) {
      setAuthError('❌ ไม่พบบัญชีผู้ใช้งานทีมีเบอร์โทรหรืออีเมลนี้ในสารบบของเราค่ะ');
      return;
    }

    // Output password successfully to bypass mock limits!
    setForgotResult(`✅ ค้นหาสำเร็จ! บัญชีของคุณ "${foundUser.name}" มีรหัสผ่านคือ "${foundUser.password}" และมีสิทธิ์ระดับ "${foundUser.memberType || 'ทั่วไป'}" \nกรุณาใช้รหัสนี้เข้าสู่ระบบได้ทันทีค่ะ`);
    onAddAuditLog('CUSTOMER_PASSWORD_RECOVERY_TRIGGERED', 'User', foundUser.id, null, null);
  };

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

  const handleLogout = () => {
    onAddAuditLog('CUSTOMER_LOGOUT', 'User', loggedInUser?.id || '', null, null);
    localStorage.removeItem('sports_complex_current_logged_in_customer');
    api.logout('customer');
    setLoggedInUser(null);
    clearCustomerScreen();
    onRefreshAll();
  };

  const handleDeleteAccount = async () => {
    if (!loggedInUser) return;
    if (api.USE_BACKEND) {
      notify('การลบบัญชีผ่านระบบยังไม่เปิดให้บริการ กรุณาติดต่อเจ้าหน้าที่ค่ะ');
      return;
    }
    if (!(await ask(`ลบบัญชี "${loggedInUser.name}" ถาวร?\nแต้ม สิทธิ์ส่วนลด และประวัติของคุณจะหายไป และกู้คืนไม่ได้`, { title: '⚠️ ลบบัญชี', okLabel: 'ลบบัญชีถาวร', cancelLabel: 'ไม่ลบ', danger: true }))) return;

    // Perform permanent removal
    const allUsers = StorageService.get<User[]>('users', []);
    const filteredUsers = allUsers.filter(u => u.id !== loggedInUser.id);
    StorageService.set('users', filteredUsers);
    
    // Add audit log for compliance
    onAddAuditLog('CUSTOMER_ACCOUNT_DELETED_BY_SELF', 'User', loggedInUser.id, loggedInUser, null);

    // Logout
    localStorage.removeItem('sports_complex_current_logged_in_customer');
    setLoggedInUser(null);
    setActiveStep(1);
    onRefreshAll();
    notify('🗑️ ดำเนินการลบบัญชีของคุณออกจากเซิร์ฟเวอร์เรียบร้อยแล้วค่ะ หวังว่าจะมีโอกาสได้กลับมาบริการท่านอีกครั้งนะคะ ขอบคุณค่ะ');
  };

  // Picked hours are dropped when the court list really changes (a court
  // added or closed). Keyed on the ids, not the array: every refresh
  // re-fetches the courts, and that must not wipe the customer's picks.
  const courtIdsKey = courts.map(c => c.id).join(',');
  useEffect(() => {
    setSelectedSlots([]);
  }, [selectedType, courtIdsKey]);

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

  const handleRedeemReward = async (reward: Reward) => {
    if (!loggedInUser) {
      notify('กรุณาเข้าสู่ระบบก่อนทำการแลกรางวัลค่ะ!');
      return;
    }
    // API mode: points live in the backend's ledger; the server deducts
    // them and issues the voucher in one transaction.
    if (api.USE_BACKEND) {
      if (!(await ask(`ใช้ ${reward.cost} แต้ม แลก "${reward.emoji} ${reward.name}"?`, { title: '🎁 แลกแต้ม', okLabel: 'แลกเลย' }))) return;
      if (!sessionStillMine()) return;
      return api.redeemReward(reward.id)
        .then(v => {
          onAddAuditLog('LOYALTY_POINT_REDEEMED', 'User', loggedInUser.id, null, { gift: v.rewardName, voucherCode: v.code });
          notify(`🎉 แลกรางวัลสำเร็จ!\nรหัสรับของรางวัล: ${v.code}\nแสดงรหัสนี้ที่เคาน์เตอร์ภายในวันที่ ${formatDate(v.expiresAt)}`);
          onRefreshAll();
        })
        .catch(err => notify(`แลกรางวัลไม่สำเร็จ: ${err.message}`));
    }

    // The stored balance, not the copy taken at sign-in.
    const currentPoints = StorageService.get<User[]>('users', []).find(u => u.id === loggedInUser.id)?.points ?? loggedInUser.points ?? 0;
    if (currentPoints < reward.cost) {
      notify(`ขออภัยค่ะ! แต้มสะสมของคุณไม่เพียงพอสำหรับการแลก ${reward.name} (ต้องการ ${reward.cost} แต้ม แต่คุณมี ${currentPoints} แต้ม)`);
      return;
    }

    if (!(await ask(`ใช้ ${reward.cost} แต้ม แลก "${reward.emoji} ${reward.name}"?`, { title: '🎁 แลกแต้ม', okLabel: 'แลกเลย' }))) return;
    // Re-read after the question: the balance may have changed meanwhile.
    const balanceNow = StorageService.get<User[]>('users', []).find(u => u.id === loggedInUser.id)?.points ?? 0;
    if (balanceNow < reward.cost) {
      notify(`แต้มไม่พอแล้ว (ต้องการ ${reward.cost} แต้ม มี ${balanceNow} แต้ม)`);
      onRefreshAll();
      return;
    }

    // Deduct through the points ledger, like every other points change.
    const claimCode = `RW-${String(Math.floor(100000 + Math.random() * 900000))}`;
    const voucherId = 'voucher-' + Date.now();
    StorageService.addLedgerEntry(loggedInUser.id, LedgerEntryType.REDEEM, -reward.cost, loggedInUser.id, { refType: 'Voucher', refId: voucherId, note: reward.name });
    const newPoints = balanceNow - reward.cost;
    const updatedUser = { ...loggedInUser, points: newPoints };
    setLoggedInUser(updatedUser);

    // Create redemption voucher
    const newVoucher: Redemption = {
      id: voucherId,
      userId: loggedInUser.id,
      userName: loggedInUser.name,
      rewardId: reward.id,
      rewardName: reward.name,
      pointsSpent: reward.cost,
      claimCode,
      redeemedAt: formatDateTime(Date.now()) + ' น.'
    };

    const currentVouchers = StorageService.get<Redemption[]>('redemptions', []);
    const updatedVouchers = [newVoucher, ...currentVouchers];
    StorageService.set('redemptions', updatedVouchers);
    setRedemptions(updatedVouchers);

    // Add Audit Log
    onAddAuditLog('LOYALTY_POINT_REDEEMED', 'User', loggedInUser.id, { pointsBefore: balanceNow }, { pointsAfter: newPoints, gift: reward.name, voucherCode: claimCode });

    // Send Line simulated notification
    const cleanPhone = normalizePhone(loggedInUser.phone || '');
    const lpMsg = `🎁 แลกรับสิทธิ์ของรางวัลสำเร็จ!\n🏆 คุณได้ใช้แต้มสะสมจำนวน -${reward.cost} แต้ม เพื่อแลกรับรางวัล "${reward.emoji} ${reward.name}"\n🔑 รหัสเคลมของรางวัล (Claim Code): ${claimCode}\n\n*โปรดแสดงรหัสสิทธิ์นี้ให้สตาฟเห็นเพื่อรับของรางวัลทันทีที่เคาน์เตอร์ขอบสนามค่ะ! 🎉`;
    
    // Call the pushMessage simulator
    const currentLine = StorageService.get<LineMessage[]>('line_messages', []);
    const newMsg: LineMessage = {
      id: 'msg-' + Date.now(),
      recipientPhone: cleanPhone,
      recipientName: loggedInUser.name,
      text: lpMsg,
      timestamp: new Date().toISOString(),
      type: 'CONFIRMED'
    };
    StorageService.set('line_messages', [newMsg, ...currentLine]);
    setLineMessages([newMsg, ...currentLine]);

    notify(`🎉 แลกรางวัล "${reward.name}" สำเร็จ!\nระบบได้หักคะแนนคงเหลือของคุณ -${reward.cost} แต้ม\n\nรหัสคูปองสำหรับเคลมของคุณคือ: ${claimCode}\n(รายละเอียดและรหัสเคลมระบุไว้ในประวัติแลกด้านล่าง และส่งแจ้งเตือนเข้าทางช่องแชท LINE เรียบร้อยแล้วค่ะ!)`);
    
    onRefreshAll();
  };

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
    handleLogin,
    loginWith,
    handleRegister,
    handleForgotPassword,
    clearCustomerScreen,
    handleLogout,
    handleDeleteAccount,
    courtIdsKey,
    handleCourtTypeChange,
    getAvailableSlots,
    currentPriceDetails,
    handleToggleSlotInGrid,
    handleRedeemReward,
    triggerLineNotification,
    handleProceedToCheckout,
    handleBookingSubmit,
    handleReopenPayment,
    handleSlipUploadSimulation,
    SLIP_SAMPLES,
    slotStatus,
    cellButton,
    SLOT_LABEL,
    renderCourtList,
    quickDates
  };
}

export type CustomerPanelState = ReturnType<typeof useCustomerPanel>;
export const CustomerPanelContext = createContext<CustomerPanelState | null>(null);
export function useCustomerPanelContext(): CustomerPanelState {
  const value = useContext(CustomerPanelContext);
  if (!value) throw new Error('useCustomerPanelContext outside CustomerPanel');
  return value;
}
