import React, { useState, useEffect, useMemo } from 'react';
import { 
  Court, CourtType, PriceType, Booking, BookingStatus, 
  Payment, PaymentStatus, PaymentMethod, MemberType, LineMessage, DayOff,
  User, UserRole, LedgerEntryType
} from '../types';
import { StorageService, findClosure, calculatePrice, generatePromptPayPayload, LOCAL_PROMPTPAY_ID, slotTiming, memberTierLabel, normalizePhone, openSlotHours, formatBaht, roundBaht, lastBookableDate, isPaidBooking, getTodayDateStr, isHourOffPeak, isCourtSlotAvailable, findConflictingBooking, FREE_HOUR_REWARD_IDS, formatDate, formatDateTime, businessInfo } from '../mockData';
import { prepareSlipImage, SlipImageError } from '../slipImage';
import * as api from '../api';
import { canUseCounter, canUseSettings } from '../permissions';
import { notify, ask } from './Dialog';
import DemoLogins, { DEMO_CUSTOMERS } from './DemoLogins';
import { QRCodeSVG } from 'qrcode.react';

// How long an online booking waits for its slip before the backend cancels
// it (service.PaymentHoldDuration in the Go backend).
const PAYMENT_HOLD_MINUTES = 30;
import { Calendar, CheckCircle, AlertTriangle, MessageSquare, ToggleRight, Shield, FileImage, Sparkles, UserCheck } from 'lucide-react';

interface CustomerPanelProps {
  onAddAuditLog: (action: string, targetType: string, targetId: string, before?: any, after?: any) => void;
  triggerRefresh: number;
  onRefreshAll: () => void;
  // One login for everyone: a staff/admin account signed in here is handed
  // to App, which opens the screen its role may use.
  onStaffSignIn?: (user: User) => void;
}

interface Reward {
  id: string;
  name: string;
  cost: number;
  description: string;
  emoji: string;
}

interface Redemption {
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
const SHOW_LINE_SIM = !(import.meta.env.PROD && api.USE_BACKEND);

const COURT_TYPE_LABEL: Record<CourtType, string> = {
  [CourtType.BADMINTON]: '🏸 แบดมินตัน',
  [CourtType.BASKETBALL]: '🏀 บาสเกตบอล',
  [CourtType.PICKLEBALL]: '🏓 พิกเคิลบอล',
  [CourtType.MEETING_ROOM]: '👥 ห้องประชุม'
};

// LINE message times: ISO timestamps, shown in Bangkok time. Older saved
// messages stored only a local time string ("13:56:02"); show those as-is.
function lineMessageTime(ts: string): string {
  if (!ts) return '';
  return isNaN(new Date(ts).getTime()) ? ts : formatDateTime(ts);
}

const LOYALTY_REWARDS: Reward[] = [
  { id: 'water', name: "น้ำแร่ภูเขาแช่เย็น (Free Mineral Water)", cost: 5, description: "น้ำดื่มสุขภาพเย็นฉ่ำขวดใหญ่ ดับกระหายลุยศึกซูเปอร์แมตช์", emoji: "🥤" },
  { id: 'sponsor', name: "เกลือแร่สปอนเซอร์ (Free Energy Drink)", cost: 8, description: "เพิ่มประจุพลังงานฟิตเต็มร้อยพร้อมเสิร์ฟตบคีย์สปีดสปอร์ต", emoji: "⚡" },
  { id: 'towel', name: "ผ้าขนหนูเช่าซักสะอาดยกชุด (Free Towel Rental)", cost: 10, description: "สิทธิ์ผ้าเช็ดตัวไมโครไฟเบอร์ นิ่มเนียน สะอาดแห้งอบโอโซน", emoji: "🧼" },
  { id: 'court', name: "เช่าสนามฟรี 1 สล็อต Off-Peak (Free 1-Hr Court)", cost: 25, description: "ยกเว้นค่าธรรมเนียมสนามในช่วงเวลา Off-Peak 1 ชั่วโมงเต็ม", emoji: "🏸" }
];

export default function CustomerPanel({ onAddAuditLog, triggerRefresh, onRefreshAll, onStaffSignIn }: CustomerPanelProps) {
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
  }, [triggerRefresh]);

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
  useEffect(() => {
    if (!api.USE_BACKEND || !selectedDate) return;
    let cancelled = false;
    (async () => {
      try {
        // Check the session first: if it lapsed, fall back to logged-out
        // and load the public views, instead of letting the logged-in-only
        // calls fail the whole load.
        const me = loggedInUserId ? await api.refreshMe('customer') : null;
        if (cancelled) return;
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
        if (cancelled) return;
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
        if (!cancelled) setApiError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [triggerRefresh, selectedDate, loggedInUserId]);

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

  // What one court-hour shows on the booking screen - shared by the grid
  // and the phone list so they can never disagree. Order matters: a booking
  // beats a closure beats "already started" beats off-peak-only beats price.
  type SlotState =
    | { kind: 'booked'; pending: boolean; mine: boolean }
    | { kind: 'closed'; reason: string }
    | { kind: 'started' }
    | { kind: 'peakBlocked' }
    | { kind: 'notOpen' }
    | { kind: 'free' | 'selected'; price: number; isPeak: boolean; isOffPeak: boolean };
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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pb-28">
      {apiError && (
        <div className="lg:col-span-12 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>โหลดข้อมูลจากเซิร์ฟเวอร์ไม่สำเร็จ: {apiError}</span>
        </div>
      )}
      
      {/* Phones: the selection and the next step stay in reach at the bottom */}
      {isNarrow && activeStep === 1 && selectedSlots.length > 0 && (
        <div id="mobile-booking-bar" className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-200 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex items-center justify-between gap-3">
          <span>
            <span className="block text-sm font-bold text-slate-900">{selectedSlots.length} ชม. · {formatBaht(currentPriceDetails().total)} บาท</span>
            <button type="button" onClick={() => setSelectedSlots([])} className="text-xs text-rose-600 underline">ล้างที่เลือก</button>
          </span>
          <button type="button" onClick={handleProceedToCheckout} className="bg-emerald-700 text-white font-bold rounded-xl px-5 min-h-[48px] text-base">จองต่อ →</button>
        </div>
      )}

      {/* Dynamic Line Notification Simulator Button (demo). On phones: a
          small round button that never covers the booking bar or forms. */}
      {SHOW_LINE_SIM && (
      <button 
        id="btn-line-sim-toggle"
        aria-label="ข้อความ LINE (จำลอง)"
        aria-expanded={showLineSimulator}
        onClick={() => setShowLineSimulator(!showLineSimulator)}
        className={`fixed z-30 items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-full shadow-2xl transition duration-200 bottom-4 left-4 p-3 sm:bottom-6 sm:left-6 sm:px-5 sm:py-3 ${isNarrow && activeStep === 1 && selectedSlots.length > 0 ? 'hidden' : 'flex'}`}
      >
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-slate-100 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-3 w-3 bg-white"></span>
        </span>
        <MessageSquare className="h-5 w-5" />
        <span className="hidden sm:inline font-sans font-medium text-sm">LINE OA ลูกค้า ({myLineMessages.length})</span>
      </button>
      )}

      {/* Main Form Left Arena */}
      <div className={`col-span-1 lg:col-span-8 space-y-6 ${showLineSimulator ? 'lg:col-span-8' : 'lg:col-span-12'}`}>
        
        {bookingSuccessAlert && (
          <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 text-emerald-800 p-4 rounded-xl shadow-sm">
            <CheckCircle className="h-5 w-5 mt-0.5 text-emerald-600 shrink-0" />
            <div className="w-full">
              <p className="font-semibold text-sm">ทำรายการสำเร็จ!</p>
              <p className="text-xs text-emerald-600 mt-1">{bookingSuccessAlert}</p>
            </div>
            <button onClick={() => setBookingSuccessAlert(null)} className="text-emerald-500 hover:text-emerald-800 text-xs font-semibold px-2">ปิด</button>
          </div>
        )}

        {/* 🔐 CUSTOMER AUTHENTICATION & PROFILE CONSOLE */}
        <div id="customer-auth-console" className="bg-slate-900 text-white rounded-2xl border border-slate-800 overflow-hidden shadow-md">
          {loggedInUser ? (
            /* Logged In View */
            <div className="p-5 md:p-6 space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
                <div className="flex items-center gap-3">
                  <div className="h-12 w-12 rounded-full bg-emerald-600 flex items-center justify-center font-bold text-white text-lg shadow-sm border border-emerald-500 shrink-0">
                    {loggedInUser.name.substring(0, 2)}
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-slate-100 flex items-center gap-2">
                      สวัสดีคุณ {loggedInUser.name}
                      <span className="px-2.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 text-xs font-bold uppercase tracking-wider">
                        สยามก๊วนคลับ
                      </span>
                    </h3>
                    <p className="text-[11px] text-slate-400 font-medium">สิทธิ์บัญชีผู้เล่น: {loggedInUser.email || 'ไม่มีอีเมล'}</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={handleLogout}
                    className="bg-slate-800 hover:bg-slate-700 hover:text-white text-slate-300 text-[11px] font-bold py-1.5 px-3.5 rounded-lg border border-slate-700 transition"
                  >
                    🚪 ลงชื่อออกจากระบบ (Logout)
                  </button>
                  <button
                    onClick={handleDeleteAccount}
                    className="bg-rose-950/40 hover:bg-rose-900 border border-rose-900/40 text-rose-300 text-xs font-bold py-1.5 px-3 rounded-lg transition"
                  >
                    🗑️ ขอลบข้อมูลบัญชีของฉัน (Delete Account)
                  </button>
                </div>
              </div>

              {/* Profile Details segment */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-xs bg-slate-950/50 p-4 rounded-xl border border-slate-800">
                <div className="space-y-1 font-sans">
                  <span className="text-xs text-slate-400 font-bold block">เบอร์โทรศัพท์ผู้ติดต่อหลัก:</span>
                  <span className="font-mono text-slate-200 font-bold text-xs">{loggedInUser.phone || 'ไม่ระบุ'}</span>
                </div>
                <div className="space-y-1 font-sans">
                  <span className="text-xs text-slate-400 font-bold block">ระดับสิทธิ์แสตมป์ส่วนลดประจำตัว:</span>
                  <span className="text-emerald-400 font-bold flex items-center gap-1 text-[11px] leading-tight">
                    🌟 {memberTierLabel(loggedInUser.memberType)}
                    {loggedInUser.memberType === MemberType.CORPORATE && loggedInUser.orgName ? ` [${loggedInUser.orgName}]` : ''}
                  </span>
                </div>
                <div className="space-y-1 font-sans">
                  <span className="text-xs text-slate-400 font-bold block">วันที่เริ่มจัดทะเบียนร่วมก๊วน:</span>
                  <span className="font-mono text-slate-300 text-xs">{loggedInUser.createdAt ? formatDate(loggedInUser.createdAt) : 'ไม่ระบุ'}</span>
                </div>
                <div className="space-y-1 font-sans bg-amber-950/20 border border-amber-900/40 p-2 rounded-lg">
                  <span className="text-xs text-amber-400 font-bold block">🏆 แต้มสะสมปัจจุบัน (Reward Points):</span>
                  <span className="text-amber-300 font-black text-sm flex items-center gap-1 font-mono">
                    {loggedInUser.points || 0} แต้ม
                  </span>
                  <span className="text-xs text-slate-400 block leading-tight">(1 แต้ม / ชม.จอง หรือ 100 บ. ซื้อของ)</span>
                </div>
              </div>

              {/* 🌟 USER LOYALTY POINTS & REWARD CLUBS */}
              <div className="mt-5 border-t border-slate-800 pt-5 space-y-4">
                <button type="button" id="rewards-toggle" onClick={() => setShowRewards(v => !v)} className="w-full flex items-center justify-between gap-2 min-h-[40px] text-left">
                  <span className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-amber-400" />
                    <span className="text-sm font-black text-amber-400">แต้มสะสมและของรางวัล ({loggedInUser.points || 0} แต้ม)</span>
                  </span>
                  <span className="text-slate-400">{showRewards ? '▴' : '▾'}</span>
                </button>

                {showRewards && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Left Column: List of Redeemable Rewards */}
                  <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-800 space-y-3">
                    <div className="flex justify-between items-center border-b border-slate-800 pb-2">
                      <span className="text-[11px] font-bold text-slate-300 flex items-center gap-1.5">
                        🎁 เลือกของรางวัลพรีเมียม
                      </span>
                      <span className="text-xs text-amber-400 font-bold bg-amber-950/40 px-2 py-0.5 rounded border border-amber-900/60 font-mono">
                        คงเหลือ: {loggedInUser?.points || 0} แต้ม
                      </span>
                    </div>

                    <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                      {rewardsCatalog.map(reward => {
                        const canRedeem = (loggedInUser?.points || 0) >= reward.cost;
                        return (
                          <div key={reward.id} className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800 flex justify-between items-center gap-3 hover:border-slate-700 transition">
                            <div className="space-y-0.5 max-w-[70%]">
                              <span className="text-[11px] font-bold text-slate-100 flex items-center gap-1">
                                <span className="text-sm leading-none">{reward.emoji}</span>
                                {reward.name}
                              </span>
                              <p className="text-xs text-slate-400 leading-snug">
                                {reward.description}
                              </p>
                            </div>
                            <div className="flex flex-col items-end shrink-0 gap-1.5">
                              <span className="text-xs font-black text-amber-300 bg-amber-950/20 px-2 py-0.5 rounded font-mono">
                                {reward.cost} แต้ม
                              </span>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={guarded(() => handleRedeemReward(reward))}
                                className={`text-xs font-bold py-1 px-3.5 rounded-md transition duration-200 shadow-sm ${
                                  canRedeem 
                                    ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-slate-950 font-extrabold hover:shadow-md hover:brightness-110 active:scale-95 cursor-pointer' 
                                    : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-800'
                                }`}
                              >
                                {canRedeem ? 'แลกแต้ม' : 'แต้มไม่พอ'}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Right Column: Active Vouchers and Point Earnings Logs */}
                  <div className="space-y-4">
                    {/* Active Coupon Code list */}
                    <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-800 space-y-3">
                      <span className="text-[11px] font-bold text-slate-300 block border-b border-slate-800 pb-2">
                        🎟️ บัตรกำนัลสิทธิ์ของคุณ ({redemptions.filter(v => v.userId === loggedInUser?.id).length} ชิ้น)
                      </span>

                      <div className="space-y-2 max-h-[170px] overflow-y-auto pr-1">
                        {redemptions.filter(v => v.userId === loggedInUser?.id).map(voucher => (
                          <div key={voucher.id} className="bg-gradient-to-br from-emerald-950/30 to-slate-900 border border-emerald-900/40 p-2.5 rounded-lg space-y-1 relative overflow-hidden">
                            <span className="absolute -right-5 -bottom-5 text-4xl opacity-10 leading-none">🎖️</span>
                            <div className="flex justify-between items-start gap-1">
                              <span className="text-xs font-bold text-emerald-300">
                                {voucher.rewardName}
                              </span>
                              <span className="text-xs text-slate-500 font-mono shrink-0">
                                {voucher.redeemedAt}
                                {voucher.status && voucher.status !== 'ACTIVE' && (
                                  <span className="ml-1 font-bold text-slate-300">{voucher.status === 'REDEEMED' ? '· รับแล้ว' : voucher.status === 'CANCELLED' ? '· ยกเลิก (บิลที่ได้แต้มถูกยกเลิก)' : '· หมดอายุ'}</span>
                                )}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/60">
                              <span className="text-xs text-slate-400">
                                รหัสสำหรับยืนยันกับสตาฟ:
                              </span>
                              <span className="font-mono text-xs font-black text-amber-300 bg-amber-950/80 px-2 py-0.5 rounded border border-amber-800/40 tracking-wider">
                                {voucher.claimCode}
                              </span>
                            </div>
                            {FREE_HOUR_REWARD_IDS.includes(voucher.rewardId) && (voucher.status || 'ACTIVE') === 'ACTIVE' && (
                              <p className="text-xs text-emerald-300/80">🏸 แจ้งรหัสนี้ที่เคาน์เตอร์เพื่อจองสนามช่วง Off-Peak ฟรี 1 ชั่วโมง</p>
                            )}
                          </div>
                        ))}

                        {redemptions.filter(v => v.userId === loggedInUser?.id).length === 0 && (
                          <div className="text-center py-8 text-slate-500 text-xs font-medium leading-relaxed">
                            ยังไม่มีคูปองเวาเชอร์ที่แลกไว้ 🏷️ <br />
                            สะสมแต้มจากการจองแตะสล็อตเล่นเพื่อปลดล็อกได้ค่ะ!
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Earnings history simulation */}
                    <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-800 space-y-2">
                      <span className="text-[11px] font-bold text-slate-300 block border-b border-slate-800 pb-1">
                        📊 แหล่งแต้มสะสมชั่วโมงเล่น (1 Point per Hour)
                      </span>
                      {(() => {
                        const userConfirmedBookings = bookings.filter(b => b.userId === loggedInUser?.id && isPaidBooking(b));
                        return (
                          <div className="space-y-1.5 font-sans">
                            <div className="flex justify-between items-center text-xs">
                              <span className="text-slate-400 mb-1">ชั่วโมงสนามได้รับก๊วนที่จองสำเร็จ:</span>
                              <span className="font-bold text-emerald-400 font-mono">{userConfirmedBookings.length} ชม. ({userConfirmedBookings.length} แต้ม)</span>
                            </div>
                            
                            <div className="max-h-[80px] overflow-y-auto space-y-1 text-xs">
                              {userConfirmedBookings.map(kb => (
                                <div key={kb.id} className="flex justify-between text-slate-400 border-b border-slate-900/60 pb-0.5">
                                  <span>📅 วันเล่น {kb.date} ({kb.startTime})</span>
                                  <span className="text-amber-400 font-bold">+1 แต้ม</span>
                                </div>
                              ))}
                              {userConfirmedBookings.length === 0 && (
                                <div className="text-xs text-slate-400">
                                  (ยังไม่มีประวัติตารางจองจริงที่สตาฟตรวจสอบยืนยันสลิป แต้มเดิมของคุณถูกแอดโดยผู้จัดการระบบ)
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
                )}
              </div>
            </div>
          ) : (
            /* Anonymous Authed Screen */
            <div className="p-5 md:p-6">
              <div className="flex items-center gap-2 border-b border-slate-800 pb-3 mb-4">
                <Shield className="h-5 w-5 text-emerald-500 shrink-0" />
                <div>
                  <h3 className="text-xs font-black text-slate-100 uppercase tracking-widest leading-none">ก๊วนผู้เล่น & ส่วนลดอัตโนมัติ (Customer Account Center)</h3>
                  <p className="text-xs text-slate-400 mt-1 leading-normal">
                    ตามหลักมาตรฐานความมั่นคงใหม่ ลูกค้าสยามสปอร์ตคอมเพล็กซ์จะต้องล็อคอินเข้าสู่ระบบก่อน เพื่อระบุสิทธิ์ส่วนลดที่ติดกับบัญชีจริงของคุณ!
                  </p>
                </div>
              </div>

              {/* Tabs Switcher */}
              <div className="flex bg-slate-950/60 p-1 rounded-xl w-full border border-slate-800 md:max-w-md mb-4 text-xs">
                <button
                  onClick={() => { setAuthTab('login'); setAuthError(null); setForgotResult(null); }}
                  className={`flex-1 py-1.5 rounded-lg font-bold text-center transition ${authTab === 'login' ? 'bg-emerald-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'}`}
                >
                  🔑 เข้าสู่ระบบก๊วน
                </button>
                <button
                  onClick={() => { setAuthTab('register'); setAuthError(null); setForgotResult(null); }}
                  className={`flex-1 py-1.5 rounded-lg font-bold text-center transition ${authTab === 'register' ? 'bg-emerald-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'}`}
                >
                  📝 สมัครสมาชิกใหม่
                </button>
                <button
                  onClick={() => { setAuthTab('forgot'); setAuthError(null); setForgotResult(null); }}
                  className={`flex-1 py-1.5 rounded-lg font-bold text-center transition ${authTab === 'forgot' ? 'bg-emerald-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'}`}
                >
                  ❓ ลืมรหัสผ่าน
                </button>
              </div>

              {/* Success recover/Error alerts inside Auth UI */}
              {authError && (
                <div role="alert" className="bg-rose-950/30 border border-rose-900/40 text-rose-300 p-3 rounded-xl text-xs font-sans mb-4">
                  {authError}
                </div>
              )}

              {forgotResult && (
                <div className="bg-emerald-950/50 border border-emerald-800 text-emerald-300 p-3 rounded-xl text-xs font-sans whitespace-pre-line mb-4 leading-normal">
                  {forgotResult}
                </div>
              )}

              {/* Tab Form rendering */}
              <form onSubmit={e => { e.preventDefault(); void guarded(authTab === 'login' ? handleLogin : authTab === 'register' ? handleRegister : handleForgotPassword)(e); }} className="space-y-3 font-sans text-xs">
                {authTab === 'register' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="auth-name" className="block text-xs font-bold text-slate-400 mb-1">ชื่อ (ชื่อเล่น หรือชื่อก๊วน):</label>
                      <input
                        id="auth-name"
                        type="text"
                        required
                        placeholder="เช่น พี่เหน่ง ก๊วนทุบดิน, สมศักดิ์"
                        value={authName}
                        onChange={(e) => setAuthName(e.target.value)}
                        className="w-full text-base sm:text-xs bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-white focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
                      />
                    </div>
                    <div className="bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/80 flex flex-col justify-center">
                      <span className="text-xs font-bold text-emerald-400 block">🌟 สิทธิ์เริ่มต้นบัญชีของคุณ:</span>
                      <span className="text-xs text-slate-300 font-medium">ลูกค้าทั่วไป (Normal) - ลด 0%</span>
                      <p className="text-xs text-slate-500 mt-1 leading-normal">* คุณจะได้รับสิทธิ์ทั่วไปโดยทันที เพื่อเปิดสิทธิ์ส่วนลดอื่นๆ (เช่น นักศึกษา/บริษัท MOU/สมาชิก) กรุณาแจ้งให้เจ้าหน้าที่ Admin ตรวจสอบหลักฐานและตั้งค่าให้หลังบ้านค่ะ</p>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="auth-identity" className="block text-xs font-bold text-slate-400 mb-1">
                      {authTab === 'forgot' ? 'ระบุเบอร์โทร หรือ อีเมลที่กู้คืน:' : authTab === 'register' ? 'อีเมล (ไม่บังคับ):' : 'เบอร์โทรศัพท์ หรือ อีเมล:'}
                    </label>
                    <input
                      id="auth-identity"
                      type={authTab === 'register' ? 'email' : 'text'}
                      required={authTab !== 'register'}
                      placeholder={authTab === 'register' ? 'เช่น user@mail.com' : 'เช่น 0845678901 หรือ user@mail.com'}
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                      className="w-full text-base sm:text-xs bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-white focus:outline-none focus:border-emerald-600"
                    />
                  </div>

                  {authTab !== 'forgot' && (
                    <div>
                      <label htmlFor="auth-password" className="block text-xs font-bold text-slate-400 mb-1">{authTab === 'register' ? 'ตั้งรหัสผ่าน (อย่างน้อย 6 ตัว):' : 'รหัสผ่าน:'}</label>
                      <input
                        id="auth-password"
                        type="password"
                        required
                        placeholder="••••••"
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        className="w-full text-base sm:text-xs bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-white focus:outline-none focus:border-emerald-600"
                      />
                    </div>
                  )}

                  {authTab === 'register' && (
                    <div>
                      <label htmlFor="auth-phone" className="block text-xs font-bold text-slate-400 mb-1">เบอร์มือถือ (ใช้เข้าสู่ระบบ):</label>
                      <input
                        id="auth-phone"
                        type="tel"
                        required
                        placeholder="เช่น 08XXXXXXXX"
                        value={authPhone}
                        onChange={(e) => setAuthPhone(e.target.value)}
                        className="w-full text-base sm:text-xs bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-white"
                      />
                    </div>
                  )}
                </div>

                <div className="flex justify-end pt-1">
                  <button
                    type="submit"
                    className="bg-emerald-600 hover:bg-emerald-500 font-bold px-6 py-2 rounded-lg text-white font-sans transition"
                  >
                    {authTab === 'login' && '🔑 กดลงชื่อเข้าสู่ระบบ'}
                    {authTab === 'register' && '📝 ลงทะเบียนบันทึกและเข้าใช้งาน'}
                    {authTab === 'forgot' && '🔍 ดึงรหัสผ่านของฉันคืนชีพ'}
                  </button>
                </div>
                {authTab === 'login' && <DemoLogins accounts={DEMO_CUSTOMERS} onPick={loginWith} dark />}
              </form>
            </div>
          )}
        </div>

        {/* Step Indicator */}
        <div id="booking-steps-indicator" className="scroll-mt-32 sm:scroll-mt-24 bg-white p-3 sm:p-5 rounded-2xl border border-slate-100 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className={`h-8 w-8 shrink-0 rounded-full flex items-center justify-center font-bold text-sm ${activeStep >= 1 ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-400'}`}>1</div>
            <div>
              <p className="text-xs font-semibold text-slate-800"><span className="hidden sm:inline">ขั้นตอนที่ 1</span><span className="sm:hidden">เลือกเวลา</span></p>
              <p className="hidden sm:block text-xs text-slate-500">เลือกสนามและเช็กตาราง</p>
            </div>
          </div>
          <div className="h-px bg-slate-200 flex-1 mx-2 sm:mx-4 max-w-[80px]" />
          <div className="flex items-center gap-2 sm:gap-3">
            <div className={`h-8 w-8 shrink-0 rounded-full flex items-center justify-center font-bold text-sm ${activeStep >= 2 ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-400'}`}>2</div>
            <div>
              <p className="text-xs font-semibold text-slate-800"><span className="hidden sm:inline">ขั้นตอนที่ 2</span><span className="sm:hidden">ข้อมูล</span></p>
              <p className="hidden sm:block text-xs text-slate-500">กรอกเบอร์โทร & เช็คราคา</p>
            </div>
          </div>
          <div className="h-px bg-slate-200 flex-1 mx-2 sm:mx-4 max-w-[80px]" />
          <div className="flex items-center gap-2 sm:gap-3">
            <div className={`h-8 w-8 shrink-0 rounded-full flex items-center justify-center font-bold text-sm ${activeStep >= 3 ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-400'}`}>3</div>
            <div>
              <p className="text-xs font-semibold text-slate-800"><span className="hidden sm:inline">ขั้นตอนที่ 3</span><span className="sm:hidden">ชำระเงิน</span></p>
              <p className="hidden sm:block text-xs text-slate-500">ชำระ QR & อัพโหลดสลิป</p>
            </div>
          </div>
        </div>

        {/* Step 1: Arena Selector / Slot grid */}
        {activeStep === 1 && (
          <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-amber-500" />
                  จองสนามกีฬา & วันเวลาที่ท่านต้องการ
                </h2>
                <p className="text-xs text-slate-500">ค่าบริการจะแตกต่างกันไปตามประเภทกีฬาและช่วงเวลา Peak/Off-Peak</p>
              </div>

              {/* Court Types Switcher Tabs */}
              <div id="court-type-tabs" className="flex bg-slate-100 p-1 rounded-xl flex-wrap gap-1">
                {Object.values(CourtType).filter(type => type === selectedType || courts.some(c => c.type === type)).map(type => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => handleCourtTypeChange(type)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                      selectedType === type 
                        ? 'bg-white text-emerald-800 shadow-sm' 
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {/* Counted from the live court list: admins add and close courts. */}
                    {COURT_TYPE_LABEL[type]} ({courts.filter(c => c.type === type).length})
                  </button>
                ))}
              </div>
            </div>

            {/* Date Selection Picker - Put first */}
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
              <div className="max-w-md">
                <label className="block text-xs font-semibold text-slate-700 mb-2 flex items-center gap-1.5">
                  <Calendar className="h-4 w-4 text-emerald-600" />
                  ระบุวันที่ต้องการเล่น (กรุณาเลือกเพื่อดึงข้อมูลรอบว่าง):
                </label>
                <input
                  id="input-booking-date"
                  type="date"
                  value={selectedDate}
                  min={getTodayDateStr()}
                  max={lastBookableDate()}
                  onChange={(e) => {
                    setSelectedDate(e.target.value);
                    setSelectedSlots([]);
                  }}
                  className="w-full bg-white border border-slate-200 rounded-lg py-2.5 px-3 text-base sm:text-sm text-slate-800 font-bold focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 focus:outline-none"
                />
                <div id="quick-dates" className="flex gap-2 mt-2">
                  {quickDates.map(q => (
                    <button key={q.iso} type="button"
                      onClick={() => { setSelectedDate(q.iso); setSelectedSlots([]); }}
                      className={`flex-1 min-h-[40px] rounded-lg border text-sm font-bold ${selectedDate === q.iso ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white border-slate-200 text-slate-700'}`}>
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* COMPREHENSIVE CUSTOMER COURT BOOKING VISUALIZER MATRIX */}
            {selectedDate && (
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                  <div className="w-full sm:w-auto flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">🎾 เลือกสนามและเวลา</h3>
                      <p className="text-xs text-slate-500 mt-0.5">แตะช่อง "ว่าง" เพื่อเลือก (สูงสุด 3 ชั่วโมงต่อการจอง)</p>
                    </div>
                    {/* Grid / list toggle (remembered on this device) */}
                    <div id="view-toggle" className="flex bg-slate-100 p-1 rounded-lg shrink-0">
                      {(['grid', 'list'] as const).map(v => (
                        <button key={v} type="button" onClick={() => chooseView(v)}
                          className={`px-3 min-h-[36px] rounded-md text-sm font-bold ${viewMode === v ? 'bg-white text-emerald-800 shadow-sm' : 'text-slate-600'}`}>
                          {v === 'grid' ? 'ตาราง' : 'รายการ'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className={`${viewMode === 'grid' ? 'flex' : 'hidden'} flex-wrap items-center gap-2 text-xs font-sans`}>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-rose-500 rounded" /> 🔴 จองแล้ว / เต็ม</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-rose-200 rounded" /> ⚠️ ปิดสนาม</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-amber-100 rounded" /> 🟡 ว่าง (Peak)</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-slate-100 rounded" /> 🟢 ว่าง (Off-Peak / ราคาปกติ)</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-emerald-600 rounded" /> ⭐ เลือกแล้ว</span>
                  </div>
                </div>

                {/* Anyone can see what's free; picking a slot asks to log in
                    (handleToggleSlotInGrid). */}
                <div className="relative">
                  {!loggedInUser && (
                    <p id="guest-availability-hint" className="mb-2 text-xs bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg px-3 py-2">
                      👀 ดูช่วงเวลาว่างได้เลย — <button type="button" className="underline font-bold"
                        onClick={() => document.getElementById('customer-auth-console')?.scrollIntoView({ behavior: 'smooth' })}>เข้าสู่ระบบหรือสมัครสมาชิก</button> เพื่อจองและดูราคาสมาชิก
                    </p>
                  )}

                  {gridLoading && (
                    <p id="grid-loading" role="status" className="text-center text-slate-500 py-10 font-bold">
                      {apiError
                        ? <>โหลดตารางไม่สำเร็จ <button type="button" onClick={onRefreshAll} className="underline text-emerald-700">ลองใหม่</button></>
                        : 'กำลังโหลดตารางสนาม...'}
                    </p>
                  )}

                  {!gridLoading && viewMode === 'list' && renderCourtList()}

                  {/* Grid-based occupancy matrix */}
                  {!gridLoading && viewMode === 'grid' && (
                  <div className="overflow-x-auto border border-slate-200 rounded-xl bg-slate-50/50">
                    <table className="w-full text-left border-collapse min-w-[1100px]">
                      <thead>
                        <tr className="bg-slate-100 text-xs uppercase font-black text-slate-500 border-b border-slate-200">
                          <th className="p-3 bg-slate-100 sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] w-36">สนาม (Court Name)</th>
                          {getAvailableSlots().map((slot) => (
                            <th key={slot.start} className="p-2 text-center text-xs min-w-[75px] border-l border-slate-200">
                              {slot.start} น.
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 bg-white text-xs">
                        {courts.filter(c => c.type === selectedType).map((court) => (
                          <tr key={court.id} className="hover:bg-slate-50/55 transition-colors">
                            {/* Court Title Left sticky column */}
                            <td className="p-3 font-bold text-[#0f172a] bg-slate-50 sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] border-r border-slate-200">
                              <div className="flex flex-col">
                                <span className="text-[11px] font-black">{court.name}</span>
                                {court.offPeakOnly && (
                                  <span className="text-[11px] text-emerald-800 font-bold bg-emerald-50 px-1 py-0.2 rounded w-max mt-0.5">Off-Peak เท่านั้น</span>
                                )}
                              </div>
                            </td>

                            {/* Hourly timeline slot cells */}
                            {getAvailableSlots().map((slot) => {
                              const time = slot.start;
                              const st = slotStatus(court, time, slot.hourNum);
                              const blocked = 'cursor-not-allowed select-none p-1 border-l border-slate-200 text-center min-h-[44px]';
                              switch (st.kind) {
                                case 'booked':
                                  return (
                                    <td key={time} className={`${blocked} bg-rose-500/10 text-rose-700 font-bold`} title={`จองแล้วโดย${st.mine ? 'ตัวคุณเอง' : 'ลูกค้าท่านอื่น'}`}>
                                      <span className="block text-[11px] font-black text-rose-600">🔴 จองแล้ว</span>
                                      <span className="text-[11px] opacity-75">{st.pending ? '⏳ รออนุมัติ' : '✓ ชำระแล้ว'}</span>
                                    </td>
                                  );
                                case 'closed':
                                  return (
                                    <td key={time} className={`${blocked} bg-rose-100 text-rose-800 font-bold`} title={`ซ่อมบำรุง/ปิดสนาม: ${st.reason}`}>
                                      <span className="block text-[11px] font-black text-rose-700">⚠️ ปิดสนาม</span>
                                      <span className="text-[11px] block leading-tight truncate max-w-[70px] text-slate-500">{st.reason}</span>
                                    </td>
                                  );
                                case 'started':
                                case 'peakBlocked':
                                case 'notOpen':
                                  return (
                                    <td key={time} className={`${blocked} bg-slate-100 text-slate-500`}
                                      title={st.kind === 'started' ? 'เลยเวลาจองออนไลน์แล้ว ติดต่อเคาน์เตอร์ได้' : st.kind === 'peakBlocked' ? 'ครึ่งสนามเปิดเฉพาะเวลา Off-Peak' : 'นอกเวลาเปิดให้บริการ'}>
                                      <span className="block text-[11px] font-bold">{st.kind === 'started' ? '⌛' : '🚫'} {SLOT_LABEL[st.kind]}</span>
                                    </td>
                                  );
                                case 'selected':
                                  return (
                                    <td key={time} {...cellButton(court.id, time, true)}
                                      className="p-1 border-l border-slate-200 bg-emerald-600 text-white text-center font-bold cursor-pointer border-l-emerald-700">
                                      <span className="block text-[11px] font-black">⭐ เลือกแล้ว</span>
                                      <span className="text-xs block">{formatBaht(st.price)}฿</span>
                                    </td>
                                  );
                                default:
                                  return (
                                    <td key={time} {...cellButton(court.id, time, false)}
                                      className={`p-1 border-l border-slate-200 text-center cursor-pointer transition min-h-[44px] ${
                                        st.isPeak ? 'bg-amber-50 hover:bg-amber-100 text-amber-900' : 'bg-emerald-50/15 hover:bg-emerald-500/10 text-slate-800'
                                      }`}>
                                      <span className="block text-[11px] font-semibold text-slate-500 leading-none">🟢 ว่าง</span>
                                      <span className="text-xs font-black block mt-0.5 text-slate-800">{formatBaht(st.price)}฿</span>
                                      <span className="text-[11px] text-slate-500">{st.isPeak ? '⚡ Peak' : st.isOffPeak ? 'Off-Peak' : 'ราคาปกติ'}</span>
                                    </td>
                                  );
                              }
                            })}
                          </tr>
                        ))}

                        {courts.filter(c => c.type === selectedType).length === 0 && (
                          <tr>
                            <td colSpan={17} className="text-center text-slate-400 py-12 font-bold">
                              ไม่มีข้อมูลสนามของประเภทกีฬา {selectedType} ในระบบเวลานี้
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  )}
                </div>

                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center text-xs text-slate-500 bg-slate-50 p-3 rounded-xl border border-slate-200 gap-2">
                  <span className="font-semibold text-emerald-800 flex items-center gap-1">
                    💡 คำแนะนำผู้เล่น: เลือกสล็อตที่กล่องสีเขียว/เหลืองเพื่อจอง และสำหรับสนามบาสเกตบอลครึ่งสนาม (B, C) จะอนุญาตให้กดเลือกได้เฉพาะช่วง Off-Peak (เวลานอกช่วงเร่งด่วน) เท่านั้น
                  </span>
                </div>
              </div>
            )}

            {/* Selected Summary Info area */}
            {selectedSlots.length > 0 && (
              <div id="checkout-preview-card" className="flex flex-col p-4 bg-emerald-50 rounded-xl border border-emerald-100 gap-4">
                <div className="space-y-2">
                  <p className="text-xs font-bold text-slate-700 flex items-center gap-1">
                    <Calendar className="h-4 w-4 text-emerald-700" />
                    รายการสนามและเวลาที่คุณเลือกเล่น (วันที่ {selectedDate}):
                  </p>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {selectedSlots.map((s, idx) => {
                      const cName = courts.find(c => c.id === s.courtId)?.name || 'สนาม';
                      return (
                        <div key={idx} className="bg-white px-3 py-2 rounded-lg border border-emerald-100 flex items-center justify-between text-xs">
                          <div>
                            <p className="font-bold text-slate-800">{cName}</p>
                            <p className="text-xs text-slate-500">เวลา {s.startTime} น.</p>
                          </div>
                          <button 
                            onClick={() => {
                              setSelectedSlots(selectedSlots.filter((_, i) => i !== idx));
                            }}
                            className="text-rose-600 hover:text-rose-800 font-bold p-1 text-[11px]"
                          >
                            ลบ
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="flex justify-between items-center border-t border-emerald-100 pt-3">
                  <div>
                    <span className="text-xs text-slate-400 block font-medium">คำนวณราคาเฉลี่ยสมาชิกรวม:</span>
                    <span className="text-sm font-extrabold text-emerald-800 font-mono">{formatBaht(currentPriceDetails().total)} บาท</span>
                  </div>
                  <button
                    id="btn-customer-stage-1"
                    onClick={handleProceedToCheckout}
                    className="bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold py-2 px-4 rounded-lg shadow-sm transition"
                  >
                    ระบุข้อมูลผู้ติดต่อ & ถัดไป &rarr;
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Information & Checkout */}
        {activeStep === 2 && (
          <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900">กรอกข้อมูลผู้จองสนาม</h2>
                <p className="text-xs text-slate-500">กรุณาระบุข้อมูลตามความเป็นจริง เพื่อรับข้อความแจ้งเตือนสำคัญทาง LINE OA</p>
              </div>
              <button 
                onClick={() => setActiveStep(1)} 
                className="text-slate-500 hover:text-slate-800 text-xs font-semibold"
              >
                &larr; ย้อนกลับไปเลือกเวลาใหม่
              </button>
            </div>

            <form onSubmit={e => { e.preventDefault(); void guarded(handleBookingSubmit)(e); }} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-2">ชื่อผู้ติดต่อหลัก (ดึงข้อมูลอัตโนมัติ)</label>
                  <input
                    id="input-customer-name"
                    type="text"
                    disabled
                    value={loggedInUser ? loggedInUser.name : ''}
                    className="w-full bg-slate-100 border border-slate-200 rounded-lg py-2 px-3 text-xs text-slate-600 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-2">เบอร์โทรศัพท์ประจำตัวผู้เล่น</label>
                  <input
                    id="input-customer-phone"
                    type="tel"
                    disabled
                    value={loggedInUser ? loggedInUser.phone : ''}
                    className="w-full bg-slate-100 border border-slate-200 rounded-lg py-2 px-3 text-xs text-slate-600 focus:outline-none"
                  />
                </div>
              </div>

              {/* Read Only Member Type Display (Injected via LoggedInUser Profile) */}
              <div className="bg-emerald-50/50 p-4 rounded-xl border border-emerald-100 space-y-3">
                <p className="text-xs font-bold text-emerald-900 flex items-center gap-1.5">
                  <UserCheck className="h-4 w-4 text-emerald-700" />
                  สิทธิ์ผู้จอง & อัตราส่วนลดของคุณ (ล็อกสิทธิ์ผ่านระบบตรวจสอบบัญชีหลักเพื่อความปลอดภัย)
                </p>
                
                <div className="bg-white border border-emerald-200 rounded-lg p-3 text-xs space-y-1">
                  <div className="flex justify-between items-center font-bold">
                    <span className="text-slate-700">สิทธิ์ส่วนลดปัจจุบัน:</span>
                    <span className="text-emerald-700 text-sm">
                      {memberTierLabel(loggedInUser?.memberType)}
                      {loggedInUser?.memberType === MemberType.CORPORATE && loggedInUser.orgName ? ` [${loggedInUser.orgName}]` : ''}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-2 leading-normal">
                    * ลูกค้าไม่สามารถกดแก้ไขประเภทส่วนลดด้วยตนเองได้ในหน้านี้ เพื่อป้องกันการแอบอ้างสิทธิ์ของ พนง. ลูกค้าสามารถเปลี่ยนสลับบทบาทหรือติดต่อฝ่ายเคาน์เตอร์แคชเชียร์สตาฟเพื่ออัปเกรดสถานะบัตรของท่านได้ ตลอด 24 ชม.
                  </p>
                </div>
              </div>

              {/* Half-court is chosen by picking court B or C, not by a toggle:
                  the price follows the court, as on the server. */}
              {selectedType === CourtType.BASKETBALL && (
                <div className="bg-amber-50 p-4 rounded-xl border border-amber-100 space-y-1">
                  <p className="text-xs font-bold text-amber-900 flex items-center gap-1.5">
                    <ToggleRight className="h-5 w-5 text-amber-700" />
                    เช่าแบบครึ่งสนาม (สำหรับสตรีทบาสเกตบอล 3x3)
                  </p>
                  <p className="text-xs text-amber-700">เลือกสนาม B หรือ C ในตารางเพื่อเช่าครึ่งสนาม ราคาครึ่งหนึ่งของเต็มสนาม เปิดจองเฉพาะช่วง Off-Peak</p>
                </div>
              )}

              {/* Price Breakdown Calculation */}
              <div className="border-t border-slate-100 pt-5 space-y-3">
                <h3 className="text-xs font-bold text-slate-800">สรุปรายละเอียดและค่าบริการ (Server-Side Calculation):</h3>
                
                <div id="price-calculations" className="p-4 bg-slate-50 rounded-xl space-y-2 border border-slate-100 text-xs">
                  <div className="space-y-2 bg-white p-3.5 rounded-xl border border-slate-200/50 mb-3">
                    <p className="font-bold text-slate-800 text-[11px]">รายการสล็อตเวลาที่ทำจอง ({selectedSlots.length} สล็อต):</p>
                    {selectedSlots.map((s, idx) => {
                      const cName = courts.find(c => c.id === s.courtId)?.name || 'สนาม';
                      // The account's tier, as the server prices it (the
                      // memberType field is only the editable form copy).
                      const court = courts.find(c => c.id === s.courtId);
                      const detail = calculatePrice(selectedType, selectedDate, s.startTime, loggedInUser?.memberType || MemberType.NORMAL, court);
                      const before = calculatePrice(selectedType, selectedDate, s.startTime, MemberType.NORMAL, court).total;
                      return (
                        <div key={idx} className="flex justify-between text-slate-600 border-b border-slate-100 pb-1.5 last:border-0 last:pb-0 font-medium font-sans">
                          <span>{idx + 1}. {cName} - เวลา {s.startTime} น.</span>
                          <span className="font-bold text-slate-800">{formatBaht(detail.total)} บาท {before > detail.total && <span className="text-xs text-slate-400 font-normal line-through">({formatBaht(before)}.-)</span>}</span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex justify-between">
                    <span className="text-slate-500">ราคาก่อนส่วนลดสมาชิก:</span>
                    <span className="font-bold text-slate-700">{formatBaht(currentPriceDetails().original)} บาท</span>
                  </div>

                  <div className="h-px bg-slate-200 my-2" />
                  
                  <div className="flex justify-between text-sm">
                    <span className="font-bold text-slate-800">ยอดรวมทั้งสิ้นที่ต้องชำระ (100% Upfront):</span>
                    <span className="font-extrabold text-emerald-700 text-base">{formatBaht(currentPriceDetails().total)} บาท</span>
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setActiveStep(1)}
                  className="bg-slate-100 hover:bg-slate-200 text-xs font-semibold py-2.5 px-5 rounded-lg text-slate-700 transition"
                >
                  ย้อนกลับ
                </button>
                <button
                  id="btn-customer-booking-confirm"
                  type="submit"
                  disabled={busy}
                  className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-bold py-2.5 px-6 rounded-lg shadow-sm transition"
                >
                  {busy ? 'กำลังจอง...' : <>ยืนยันการจอง และสลับรับ QR Code &rarr;</>}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Step 3: PromptPay QR payment panel */}
        {activeStep === 3 && currentBooking && (
          <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm space-y-6">
            <div className="text-center space-y-2">
              <span className="inline-flex text-xs items-center gap-1 font-bold text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1 rounded-full">
                <AlertTriangle className="h-3 w-3" /> ชำระเงินล่วงหน้าเพื่อยืนยันสิทธิ์คอร์ท
              </span>
              <h2 className="text-lg font-bold text-slate-900">ชำระเงินค่านัดผ่าน QR Thai PromptPay</h2>
              <p className="text-xs text-slate-500">กรุณาสแกนรหัสคิวอาร์ และทำการโอนเงินยอดและแสกนด้วยแอพนาคารจากนั้นส่งหลักฐานสลิปด้านล่าง</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
              
              {/* Thai PromptPay QR Visual Simulation */}
              <div id="promptpay-qr-display" className="bg-slate-50 p-5 rounded-2xl border border-slate-100 flex flex-col items-center justify-center space-y-4 shadow-inner">
                {/* PromptPay Banner Header */}
                <div className="w-56 h-10 bg-sky-900 rounded flex items-center justify-between px-3">
                  <div className="text-white text-xs font-extrabold flex flex-col">
                    <span className="text-[11px] tracking-widest text-[#579FFF]">PROMPT PAY</span>
                    <span className="text-xs select-none -mt-1 leading-none font-sans">พร้อมเพย์</span>
                  </div>
                  {/* Visual logo simulation */}
                  <div className="flex gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse"></span>
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-300"></span>
                    <span className="h-1.5 w-1.5 rounded-full bg-[#18f3b2]"></span>
                  </div>
                </div>

                {/* The actual PromptPay (EMVCo) payload as a scannable QR code */}
                <div className="bg-white border border-slate-200 p-3 rounded">
                  {currentPayment?.status === PaymentStatus.EXPIRED ? (
                    // The hold ran out: don't invite a new payment - only a
                    // slip for money already sent (late payment).
                    <div id="expired-payment-notice" className="h-44 w-44 flex flex-col items-center justify-center text-center gap-1 text-xs text-rose-700 font-bold">
                      <span className="text-2xl">⌛</span>
                      หมดเวลาชำระแล้ว กรุณาอย่าโอนเงินเพิ่ม
                    </div>
                  ) : qrCodePayload ? (
                    <QRCodeSVG value={qrCodePayload} size={176} level="M" />
                  ) : (
                    <div className="h-44 w-44 flex items-center justify-center text-xs text-slate-400">ไม่พบ QR</div>
                  )}
                </div>

                <div className="text-center space-y-1">
                  <p className="text-xs font-semibold text-slate-500">สแกนด้วยแอปธนาคาร ยอดเงินจะขึ้นให้อัตโนมัติ</p>
                  <p className="text-sm font-black text-slate-800">รหัสจอง {currentBooking.bookingCode}</p>
                  {businessInfo().name
                    ? <p id="payee-name" className="text-xs text-slate-600">ชื่อบัญชีผู้รับ: <b className="text-slate-800">{businessInfo().name}</b> — ตรวจให้ตรงในแอปธนาคารก่อนกดโอน</p>
                    : <p className="text-xs text-slate-500">ตรวจชื่อผู้รับในแอปธนาคารก่อนกดโอน</p>}
                  <p className="text-xs font-extrabold text-slate-800 text-lg mt-1">ยอดโอน: {formatBaht(currentPayment?.amount ?? currentBooking.totalAmount)} บาท</p>
                  {currentPayment?.status === PaymentStatus.PENDING && (() => {
                    // Capped: server and browser clocks can differ slightly.
                    const minutesLeft = Math.min(PAYMENT_HOLD_MINUTES, Math.ceil((new Date(currentPayment.createdAt).getTime() + PAYMENT_HOLD_MINUTES * 60000 - nowTick) / 60000));
                    return minutesLeft > 0
                      ? <p className="text-[11px] font-bold text-amber-700">⏳ กรุณาชำระและส่งสลิปภายใน {minutesLeft} นาที</p>
                      : <p className="text-[11px] font-bold text-rose-700">⌛ หมดเวลาชำระแล้ว ระบบอาจยกเลิกการจองนี้</p>;
                  })()}
                  {currentPayment?.status === PaymentStatus.SLIP_UPLOADED && (
                    <p className="text-[11px] font-bold text-sky-700">📨 ส่งสลิปแล้ว รอพนักงานตรวจ — อัปโหลดใหม่ได้หากส่งผิดรูป</p>
                  )}
                  {currentPayment?.status === PaymentStatus.EXPIRED && (
                    <p className="text-[11px] font-bold text-rose-700 max-w-xs">
                      การจองนี้ถูกยกเลิกเพราะไม่ได้รับสลิปภายใน {PAYMENT_HOLD_MINUTES} นาที หากคุณโอนเงินไปแล้ว ส่งสลิปด้านล่าง —
                      พนักงานจะยืนยันการจองให้หากสนามยังว่าง หรือคืนเงินให้หากมีผู้อื่นจองไปแล้ว
                    </p>
                  )}
                </div>
              </div>

              {/* Upload Slip Selector Simulator */}
              <div className="space-y-4">
                <div className="bg-slate-50 p-4 rounded-xl border border-dashed border-slate-200">
                  <span className="block text-xs font-semibold text-slate-700 mb-2">โอนแล้ว ส่งรูปสลิปที่นี่:</span>
                  
                  <div className="space-y-2">
                    {/* Stock-photo "slips" are a demo shortcut - never offer them to real customers. */}
                    {import.meta.env.DEV && SLIP_SAMPLES.map((sample, sIdx) => (
                      <button
                        key={sIdx}
                        type="button"
                        onClick={guarded(() => handleSlipUploadSimulation(sample.url))}
                        className="w-full flex items-center gap-3 bg-white p-3 rounded-lg border border-slate-200 hover:border-emerald-600 transition hover:bg-slate-50 text-left text-xs"
                      >
                        <FileImage className="h-7 w-7 text-emerald-700" />
                        <div>
                          <p className="font-bold text-slate-800">{sample.name}</p>
                          <p className="text-xs text-slate-500">จำลองอัพโหลดภาพถ่ายสลิปเพื่อส่งให้แอดมิน</p>
                        </div>
                      </button>
                    ))}
                  </div>

                  <div className="mt-4 text-center">
                    {import.meta.env.DEV && <p className="text-xs text-slate-400">--- หรือ ---</p>}
                    <label className="inline-flex items-center cursor-pointer mt-2 text-sm bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 rounded-lg font-bold text-white transition">
                      <FileImage className="h-4 w-4 mr-1.5" /> เลือกรูปสลิปจากเครื่อง
                      <input 
                        type="file" 
                        accept="image/jpeg,image/png,image/webp,image/heic,image/*"
                        disabled={busy}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          // Cleared so choosing the same file again (after a
                          // failed upload) fires onChange again.
                          e.target.value = '';
                          if (file) {
                            // localStorage mode can't keep a real file, so it
                            // records a placeholder image; API mode uploads
                            // the actual file.
                            void guarded(handleSlipUploadSimulation)("https://images.unsplash.com/photo-1554415707-6e8cfc93fe23?w=300&q=80", file);
                          }
                        }}
                        className="hidden" 
                      />
                    </label>
                  </div>
                </div>

                <div className="p-4 bg-amber-50 rounded-lg text-xs space-y-1 p-3.5 border border-amber-200 text-amber-800">
                  <p className="font-bold">ขั้นตอนหลังจอง:</p>
                  <p>1. ระบบกันสนามไว้ให้ {PAYMENT_HOLD_MINUTES} นาที — โอนและส่งสลิปภายในเวลานี้</p>
                  <p>2. พนักงานตรวจสลิปแล้วยืนยันการจอง</p>
                  <p>3. ดูสถานะได้ที่ "ตรวจสอบสถานะการจอง" ด้านล่าง (ขึ้น "อนุมัติเรียบร้อย" เมื่อยืนยันแล้ว)</p>
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-4 border-t border-slate-50">
              <button
                type="button"
                onClick={() => {
                  setActiveStep(1);
                  setSelectedSlots([]);
                }}
                className="bg-slate-500 hover:bg-slate-100 text-xs font-bold text-slate-600 py-2 px-4 rounded text-center transition"
              >
                ชำระภายหลัง (กลับมาส่งสลิปได้จากรายการจองด้านล่าง ภายใน {PAYMENT_HOLD_MINUTES} นาที)
              </button>
            </div>
          </div>
        )}

        {/* Existing Bookings tracking for user in customer view */}
        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 text-white space-y-4 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div>
              <p className="text-sm font-bold tracking-tight">ตรวจสอบสถานะการจองล่าสุดทั้งหมด</p>
              <p className="text-xs text-slate-400">สถานะการจองและสลิปการชำระเงินของคุณ</p>
            </div>
            <span className="text-xs bg-slate-800 text-slate-300 font-bold px-2.5 py-1 rounded-full">เรียงใหม่</span>
          </div>

          <div className="space-y-3 max-h-[250px] overflow-y-auto pr-1">
            {(() => {
              if (!loggedInUser) {
                return (
                  <p className="text-xs text-slate-400 text-center py-4">
                    🔒 กรุณาลงชื่อเข้าใช้ระบบข้างต้นเสียก่อนเพื่อตรวจสอบประวัติตารางจองของท่านเอง
                  </p>
                );
              }

              // Upcoming and in-progress bookings only, judged in Bangkok time
              // (the browser's own clock/time zone used to decide this).
              const userFilteredFutureBookings = bookings.filter(booking =>
                booking.userId === loggedInUser.id && !slotTiming(booking.date, booking.startTime).ended
              );

              if (userFilteredFutureBookings.length === 0) {
                return (
                  <p className="text-xs text-slate-500 text-center py-6 leading-relaxed">
                    🌟 ไม่พบประวัติการจองล่วงหน้าสำหรับบัญชีคุณในขณะนี้ <br/>
                    <span className="text-xs text-slate-400">(ระบบจะแสดงเฉพาะรอบจองที่ยังไม่ถึงเวลาเล่นของท่านเท่านั้น รอบที่เคยผ่านไปแล้วจะไม่แสดงเพื่อความรวดเร็วและเป็นส่วนตัวค่ะ)</span>
                  </p>
                );
              }

              const groupsWithButton = new Set<string>();
              return userFilteredFutureBookings.map((booking) => {
                const courtName = courtNameById.get(booking.courtId) || 'สนามกีฬาทั่วไป';
                // The payment hangs off the group's first row; every row of
                // the group shares it.
                const matchedPayment = paymentForBooking(booking);
                // A slip can be sent while the booking awaits payment, and also
                // after the hold expired (late payment: the customer paid but
                // the slip came too late).
                const lateSlip = !!matchedPayment && (matchedPayment.status === PaymentStatus.EXPIRED ||
                  (matchedPayment.status === PaymentStatus.SLIP_UPLOADED && !!matchedPayment.expiredAt));
                const awaitingSlip = !!matchedPayment && (lateSlip || (booking.status === BookingStatus.PENDING_PAYMENT &&
                  (matchedPayment.status === PaymentStatus.PENDING || matchedPayment.status === PaymentStatus.SLIP_UPLOADED)));
                // One upload button per booking group, not one per hour.
                const showUploadButton = awaitingSlip && !groupsWithButton.has(booking.bookingCode);
                if (showUploadButton) groupsWithButton.add(booking.bookingCode);

                let statusBadge = '';
                if (booking.status === BookingStatus.CONFIRMED || booking.status === BookingStatus.COMPLETED) statusBadge = 'bg-emerald-600 text-white';
                else if (booking.status === BookingStatus.PENDING_PAYMENT) statusBadge = 'bg-amber-500 text-white';
                else if (booking.status === BookingStatus.CANCELLED) statusBadge = 'bg-slate-600 text-slate-300';
                else statusBadge = 'bg-red-500 text-white';

                return (
                  <div key={booking.id} className="bg-slate-800/80 hover:bg-slate-800 rounded-xl p-4 border border-slate-700/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs transition">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-slate-200">{booking.bookingCode}</span>
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${statusBadge}`}>
                          {booking.status === BookingStatus.CONFIRMED && 'อนุมัติเรียบร้อย'}
                          {booking.status === BookingStatus.PENDING_PAYMENT && (matchedPayment?.status === PaymentStatus.SLIP_UPLOADED ? 'รอสต๊าฟเช็คสลิป' : 'รอชำระเงิน / รอสลิป')}
                          {booking.status === BookingStatus.CANCELLED && (
                            matchedPayment?.status === PaymentStatus.EXPIRED ? 'หมดเวลาชำระ'
                              : lateSlip ? 'ส่งสลิปล่าช้า รอพนักงานตรวจ'
                              : 'ยกเลิกรายการ')}
                          {booking.status === BookingStatus.COMPLETED && 'เล่นแล้ว'}
                          {booking.status === BookingStatus.NO_SHOW && 'ไม่มาใช้สนาม'}
                        </span>
                      </div>
                      <p className="font-bold text-slate-100">{courtName}</p>
                      <p className="text-xs text-slate-400">
                        วันที่จอง: {booking.date} | เวลา: {booking.startTime} - {booking.endTime} น.
                      </p>
                      <p className="text-xs text-slate-400">
                        ผู้ติดต่อ: {booking.userName} | โทร: {booking.userPhone}
                      </p>
                    </div>

                    <div className="flex flex-col items-start sm:items-end justify-between gap-1">
                      <p className="font-bold text-emerald-400 text-sm">{formatBaht(booking.totalAmount)} บาท</p>
                      <span className="text-xs text-slate-400">
                        หลักฐานสลิป: {matchedPayment?.slipUrl ? (
                          <a href={matchedPayment.slipUrl} target="_blank" rel="noreferrer" className="text-sky-400 underline font-bold hover:text-sky-300">กดดูรูปสลิป</a>
                        ) : 'ไม่มีการอัพโหลด'}
                      </span>
                      {!!matchedPayment?.refundAmount && (
                        <span className="text-xs font-bold text-sky-300">
                          💸 คืนเงินแล้ว {formatBaht(matchedPayment.refundAmount)} บาท{matchedPayment.refundReason ? ` (${matchedPayment.refundReason})` : ''}
                        </span>
                      )}
                      {booking.status === BookingStatus.CANCELLED && booking.cancellationReason && !lateSlip && matchedPayment?.status !== PaymentStatus.EXPIRED && (
                        <span className="text-xs text-slate-400">เหตุผล: {booking.cancellationReason}</span>
                      )}
                      {showUploadButton && matchedPayment && (
                        <button
                          type="button"
                          onClick={() => {
                            const root = bookingById.get(matchedPayment.bookingId) || booking;
                            handleReopenPayment(root, matchedPayment);
                          }}
                          className="mt-1 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg transition"
                        >
                          {matchedPayment.status === PaymentStatus.EXPIRED ? '📤 โอนแล้วแต่หมดเวลา? ส่งสลิป'
                            : matchedPayment.status === PaymentStatus.SLIP_UPLOADED ? '🔁 ส่งสลิปใหม่' : '📤 ชำระเงิน / อัปโหลดสลิป'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      </div>

      {/* LINE Notification Sidebar Phone Simulator (Module 5 Integration UI) */}
      {SHOW_LINE_SIM && showLineSimulator && (
        <div id="line-phone-simulator" className="col-span-1 lg:col-span-4 transition-all duration-300 ease-in-out">
          <div className="sticky top-6 bg-slate-950 text-white rounded-[32px] border-8 border-slate-800 overflow-hidden shadow-2xl h-[650px] flex flex-col">
            
            {/* Phone Ear Speaker & Cam */}
            <div className="h-6 bg-slate-800 w-full flex justify-center items-center relative">
              <div className="h-3 w-20 bg-slate-950 rounded-b-xl absolute top-0" />
              <div className="flex justify-between w-full px-5 text-xs text-slate-400 select-none">
                <span>05:30 น.</span>
                <span className="flex gap-1 items-center">📶 🛜 🔋 100%</span>
              </div>
            </div>

            {/* Line OA AppHeader */}
            <div className="bg-[#1e2a38] p-4 flex items-center justify-between border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="h-8 w-8 rounded-full bg-emerald-500 flex items-center justify-center font-bold text-white text-xs shadow-inner">SP</div>
                <div>
                  <p className="font-bold text-xs">สนามกีฬาคอมเพล็กซ์ LINE OA</p>
                  <p className="text-xs text-emerald-400 flex items-center gap-0.5">● แอดมินและระบบ AI พร้อมตอบ</p>
                </div>
              </div>
              <button onClick={() => setShowLineSimulator(false)} className="text-slate-400 hover:text-white text-xs px-2 py-1">ย่อ</button>
            </div>

            {/* Simulated chat container */}
            <div className="flex-1 p-3 overflow-y-auto space-y-4 bg-slate-900 scrollbar-none font-sans">
              
              {/* Automated welcome message */}
              <div className="flex items-start gap-2 max-w-[85%]">
                <div className="h-6 w-6 rounded-full bg-emerald-500 flex items-center justify-center text-[11px] font-bold text-white shrink-0">SP</div>
                <div className="bg-[#293646] p-2.5 rounded-xl text-[11px] text-slate-200">
                  สวัสดีค่ะ ยินดีต้อนรับสู่ LINE OA ของสปอร์ตคอมเพล็กซ์ 🏸🏀 <br />ระบบจะส่งข้อมูลยืนยันการจอง และแจ้งเตือนล่วงหน้าให้ท่านที่นี่โดยอัติโนมัติค่ะ
                </div>
              </div>

              {/* Loop client side LINE alerts */}
              {myLineMessages.map((msg) => (
                <div key={msg.id} className="flex flex-col items-start gap-1 max-w-[85%]">
                  <span className="text-[11px] text-slate-400 pl-8 font-mono">{lineMessageTime(msg.timestamp)}</span>
                  <div className="flex items-start gap-2">
                    <div className="h-6 w-6 rounded-full bg-emerald-500 flex items-center justify-center text-[11px] font-bold text-white shrink-0">SP</div>
                    <div className="bg-emerald-950 border border-emerald-900/60 p-3 rounded-2xl text-[11px] text-emerald-100 whitespace-pre-wrap font-sans">
                      {msg.text}
                    </div>
                  </div>
                </div>
              ))}

              {myLineMessages.length === 0 && (
                <p className="text-xs text-slate-500 text-center pt-10">ไม่มีแจ้งเตือนในขณะนี้ ยืนยันการจองเพื่อเริ่มรับ Push message ทาง LINE</p>
              )}
            </div>

            {/* Input simulation footer */}
            <div className="p-3 bg-[#18222d] border-t border-slate-800 flex items-center gap-2">
              <input
                type="text"
                disabled
                placeholder="ระบุข้อความโต้ตอบอัตโนมัติ..."
                className="w-full bg-[#243141] text-xs py-2 px-3 rounded-full text-slate-400 outline-none cursor-not-allowed"
              />
              <button disabled className="h-8 w-8 rounded-full bg-emerald-600 flex items-center justify-center text-white text-xs cursor-not-allowed">ส่ง</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
