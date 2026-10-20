import React, { useState, useEffect } from 'react';
import { 
  Court, CourtType, PriceType, Booking, BookingStatus, 
  Payment, PaymentStatus, PaymentMethod, MemberType, LineMessage, DayType, DayOff,
  User, UserRole
} from '../types';
import { StorageService, calculatePrice, generatePromptPayPayload, getDayType, getTodayDateStr, isHourOffPeak, isCourtSlotAvailable, findConflictingBooking } from '../mockData';
import * as api from '../api';
import DemoLogins, { DEMO_CUSTOMERS } from './DemoLogins';
import { QRCodeSVG } from 'qrcode.react';

// How long an online booking waits for its slip before the backend cancels
// it (service.PaymentHoldDuration in the Go backend).
const PAYMENT_HOLD_MINUTES = 30;
import { Calendar, Clock, CreditCard, CheckCircle, AlertTriangle, MessageSquare, ToggleRight, Trash2, Shield, Phone, FileImage, Sparkles, UserCheck } from 'lucide-react';

interface CustomerPanelProps {
  onAddAuditLog: (action: string, targetType: string, targetId: string, before?: any, after?: any) => void;
  triggerRefresh: number;
  onRefreshAll: () => void;
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
  userId: string;
  userName: string;
  rewardId: string;
  rewardName: string;
  pointsSpent: number;
  claimCode: string;
  redeemedAt: string;
}

const LOYALTY_REWARDS: Reward[] = [
  { id: 'water', name: "น้ำแร่ภูเขาแช่เย็น (Free Mineral Water)", cost: 5, description: "น้ำดื่มสุขภาพเย็นฉ่ำขวดใหญ่ ดับกระหายลุยศึกซูเปอร์แมตช์", emoji: "🥤" },
  { id: 'sponsor', name: "เกลือแร่สปอนเซอร์ (Free Energy Drink)", cost: 8, description: "เพิ่มประจุพลังงานฟิตเต็มร้อยพร้อมเสิร์ฟตบคีย์สปีดสปอร์ต", emoji: "⚡" },
  { id: 'towel', name: "ผ้าขนหนูเช่าซักสะอาดยกชุด (Free Towel Rental)", cost: 10, description: "สิทธิ์ผ้าเช็ดตัวไมโครไฟเบอร์ นิ่มเนียน สะอาดแห้งอบโอโซน", emoji: "🧼" },
  { id: 'court', name: "เช่าสนามฟรี 1 สล็อต Off-Peak (Free 1-Hr Court)", cost: 25, description: "ยกเว้นค่าธรรมเนียมสนามในช่วงเวลา Off-Peak 1 ชั่วโมงเต็ม", emoji: "🏸" }
];

export default function CustomerPanel({ onAddAuditLog, triggerRefresh, onRefreshAll }: CustomerPanelProps) {
  // Load data
  const [courts, setCourts] = useState<Court[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [lineMessages, setLineMessages] = useState<LineMessage[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  
  // Interaction Form state
  const [selectedType, setSelectedType] = useState<CourtType>(CourtType.BADMINTON);
  const [selectedCourtId, setSelectedCourtId] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedSlots, setSelectedSlots] = useState<{ courtId: string; startTime: string }[]>([]);
  
  const [memberName, setMemberName] = useState<string>('');
  const [memberPhone, setMemberPhone] = useState<string>('');
  const [memberType, setMemberType] = useState<MemberType>(MemberType.NORMAL);
  const [orgName, setOrgName] = useState<string>('');

  // Customer Authed account state
  const [loggedInUser, setLoggedInUser] = useState<User | null>(null);
  const [authTab, setAuthTab] = useState<'login' | 'register' | 'forgot'>('login');
  const [authEmail, setAuthEmail] = useState<string>('');
  const [authPassword, setAuthPassword] = useState<string>('');
  const [authName, setAuthName] = useState<string>('');
  const [authPhone, setAuthPhone] = useState<string>('');
  const [authMemberType, setAuthMemberType] = useState<MemberType>(MemberType.NORMAL);
  const [authOrgName, setAuthOrgName] = useState<string>('');
  const [forgotResult, setForgotResult] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // UI state
  const [activeStep, setActiveStep] = useState<number>(1); // 1: Select Slot, 2: Info & Checkout, 3: QR Payment & Upload Slip
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
  const [slipFile, setSlipFile] = useState<string>(''); // simulation base64/url
  const [showLineSimulator, setShowLineSimulator] = useState<boolean>(false);
  const [bookingSuccessAlert, setBookingSuccessAlert] = useState<string | null>(null);
  const [daysOff, setDaysOff] = useState<DayOff[]>([]);

  // Load everything
  useEffect(() => {
    const rawCourts = StorageService.get<Court[]>('courts', []);
    const rawBookings = StorageService.get<Booking[]>('bookings', []);
    const rawPayments = StorageService.get<Payment[]>('payments', []);
    const rawLine = StorageService.get<LineMessage[]>('line_messages', []);
    const rawDaysOff = StorageService.get<DayOff[]>('days_off', []);
    const rawRedemptions = StorageService.get<Redemption[]>('redemptions', []);
    
    // Load current logged in customer (API mode keeps it in the API session)
    const currentCust = api.USE_BACKEND
      ? api.getSession('customer')?.user ?? null
      : StorageService.get<User | null>('current_logged_in_customer', null);
    if (currentCust) {
      setLoggedInUser(currentCust);
      setMemberName(currentCust.name);
      setMemberPhone(currentCust.phone || '');
      setMemberType(currentCust.memberType || MemberType.NORMAL);
      setOrgName(currentCust.orgName || '');
    } else {
      setLoggedInUser(null);
      setMemberName('');
      setMemberPhone('');
      setMemberType(MemberType.NORMAL);
      setOrgName('');
    }

    // In API mode courts/bookings/payments are fetched by the effect below.
    if (!api.USE_BACKEND) {
      setCourts(rawCourts.filter(c => c.isActive));
      setBookings(rawBookings);
      setPayments(rawPayments);
    }
    setLineMessages(rawLine);
    if (!api.USE_BACKEND) setDaysOff(rawDaysOff);
    setRedemptions(rawRedemptions);

    // Initial Date selection to today
    const today = new Date();
    const offset = today.getTimezoneOffset();
    const adjusted = new Date(today.getTime() - (offset * 60 * 1000));
    const todayStr = adjusted.toISOString().split('T')[0];
    setSelectedDate(todayStr);
  }, [triggerRefresh]);

  // API mode: load courts, the selected date's bookings (for availability)
  // and the customer's own bookings+payments (for history) from the backend.
  const [apiError, setApiError] = useState<string | null>(null);
  const loggedInUserId = loggedInUser?.id;
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
          setAuthError('⏰ เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
          return; // loggedInUserId changes, so this effect re-runs logged out
        }
        if (me) setLoggedInUser(me);

        // syncPricingCache refreshes the pricing the price preview reads, so
        // it shows what the server will actually charge.
        const [apiCourts, dayBookings, mine, closures] = await Promise.all([
          api.listCourts(),
          api.listBookingsByDate(selectedDate),
          me ? api.listMyBookings() : Promise.resolve({ bookings: [], payments: [] }),
          api.listDaysOff(selectedDate, selectedDate),
          api.syncPricingCache()
        ]);
        if (cancelled) return;
        setDaysOff(closures);
        // The customer's own rows carry their details; prefer them over the
        // copies in the by-date list.
        const mineById = new Map(mine.bookings.map(b => [b.id, b]));
        setCourts(apiCourts);
        setBookings([...dayBookings.filter(b => !mineById.has(b.id)), ...mine.bookings]);
        setPayments(mine.payments);
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
    loginWith(authEmail, authPassword);
  };

  // Shared by the login form and the dev-only demo account buttons.
  const loginWith = (identity: string, password: string) => {
    setAuthError(null);
    setForgotResult(null);

    if (api.USE_BACKEND) {
      api.login('customer', identity, password)
        .then(user => {
          if (user.role !== UserRole.CUSTOMER) {
            api.logout('customer');
            setAuthError('❌ บัญชีนี้เป็นบัญชีพนักงาน กรุณาเข้าสู่ระบบที่หน้า Staff POS');
            return;
          }
          setLoggedInUser(user);
          onAddAuditLog('CUSTOMER_LOGIN_SUCCESS', 'User', user.id, null, { name: user.name, role: user.role });
          setAuthEmail('');
          setAuthPassword('');
          onRefreshAll();
        })
        .catch(err => setAuthError(`❌ ${err.message}`));
      return;
    }

    const allUsers = StorageService.get<User[]>('users', []);
    const foundUser = allUsers.find(
      u => (u.email?.toLowerCase() === identity.toLowerCase() || u.phone === identity) && u.role === UserRole.CUSTOMER
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

    if (!authName || !authPhone || !authEmail || !authPassword) {
      setAuthError('❌ กรุณากรอกข้อมูลสำคัญให้ครบถ้วนทุกช่องเพื่อความปลอดภัย');
      return;
    }

    if (api.USE_BACKEND) {
      api.register({ name: authName, email: authEmail, phone: authPhone, password: authPassword })
        .then(user => {
          setLoggedInUser(user);
          setAuthEmail('');
          setAuthPassword('');
          setAuthName('');
          setAuthPhone('');
          onRefreshAll();
          alert('🎉 สมัครสมาชิกและเข้าสู่ระบบสำเร็จ! ระดับบัญชีของคุณเริ่มต้นที่ "ลูกค้าทั่วไป" 🌟');
        })
        .catch(err => setAuthError(`❌ ${err.message}`));
      return;
    }

    const allUsers = StorageService.get<User[]>('users', []);
    const emailExists = allUsers.some(u => u.email?.toLowerCase() === authEmail.toLowerCase());
    const phoneExists = allUsers.some(u => u.phone === authPhone);

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
      createdAt: new Date().toISOString().split('T')[0],
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
    setAuthMemberType(MemberType.NORMAL);
    setAuthOrgName('');
    
    onRefreshAll();
    alert('🎉 สมัครสมาชิกก๊วนและเข้าสู่ระบบสำเร็จ! ระดับบัญชีของคุณเริ่มต้นที่ "ลูกค้าทั่วไป" (สามารถติดต่อเจ้าหน้าที่สตาฟ ณ ร้านเพื่อยืนยันหลักฐานรับสิทธิ์ส่วนลดพิเศษได้ภายหลังค่ะ) 🌟');
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

  const handleLogout = () => {
    onAddAuditLog('CUSTOMER_LOGOUT', 'User', loggedInUser?.id || '', null, null);
    localStorage.removeItem('sports_complex_current_logged_in_customer');
    api.logout('customer');
    setLoggedInUser(null);
    setActiveStep(1);
    onRefreshAll();
  };

  const handleDeleteAccount = () => {
    if (!loggedInUser) return;
    if (api.USE_BACKEND) {
      alert('การลบบัญชีผ่านระบบยังไม่เปิดให้บริการ กรุณาติดต่อเจ้าหน้าที่ค่ะ');
      return;
    }
    const confirm1 = window.confirm(`⚠️ คำเตือนความปลอดภัยสูงสุด: \nคุณแน่ใจหรือไม่ว่าต้องการ "ลบบัญชีผู้ใช้" ของคุณออกจากสยามคอมเพล็กซ์อย่างถาวร? \n\n* ข้อมูลสิทธิ์ส่วนลดและประวัติประวัติส่วนตัวทั้งหมดของคุณจะถูกทำลายทิ้งทันที!`);
    if (!confirm1) return;

    const confirm2 = window.confirm(`🔥 ยืนยันครั้งสุดท้าย (Action Irreversible): \nกดตกลงเพื่อยืนยันลบชื่อ "${loggedInUser.name}" ออกจากสารบัญหลักอย่างถาวร`);
    if (!confirm2) return;

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
    alert('🗑️ ดำเนินการลบบัญชีของคุณออกจากเซิร์ฟเวอร์เรียบร้อยแล้วค่ะ หวังว่าจะมีโอกาสได้กลับมาบริการท่านอีกครั้งนะคะ ขอบคุณค่ะ');
  };

  // Set default court when court type changes
  useEffect(() => {
    const matchedCourts = courts.filter(c => c.type === selectedType);
    if (matchedCourts.length > 0) {
      setSelectedCourtId(matchedCourts[0].id);
    } else {
      setSelectedCourtId('');
    }
    setSelectedSlots([]);
  }, [selectedType, courts]);

  const handleCourtTypeChange = (type: CourtType) => {
    setSelectedType(type);
    setSelectedSlots([]);
  };

  // Generate operating hours slots (e.g. 07:00 to 23:00)
  const getAvailableSlots = () => {
    const hours = [];
    for (let h = 7; h < 23; h++) {
      const start = h.toString().padStart(2, '0') + ':00';
      const end = (h + 1).toString().padStart(2, '0') + ':00';
      hours.push({ start, end, hourNum: h });
    }
    return hours;
  };

  // Check slot status
  const getSlotStatus = (courtId: string, slotTime: string) => {
    if (!selectedDate) return 'disabled';
    
    // Check if there is an existing booking for this court, date and slot time
    const found = bookings.find(
      b => b.courtId === courtId && 
           b.date === selectedDate && 
           b.startTime === slotTime && 
           b.status !== BookingStatus.CANCELLED
    );

    if (found) {
      return found.isEventBlock ? 'blocked' : 'booked';
    }

    // Peak hours check
    const isWeekend = getDayType(selectedDate) === DayType.WEEKEND;
    const hour = parseInt(slotTime.split(':')[0], 10);
    const isPeak = isWeekend 
      ? (hour >= 9 && hour < 22) 
      : (hour >= 17 && hour < 22);

    return isPeak ? 'peak' : 'normal';
  };

  // Helper to get Price Information inside layout
  const currentPriceDetails = () => {
    if (!selectedDate || selectedSlots.length === 0) return { total: 0, original: 0, priceType: PriceType.NORMAL };
    let total = 0;
    let original = 0;
    const currentEffectiveMemberType = loggedInUser ? (loggedInUser.memberType || MemberType.NORMAL) : MemberType.NORMAL;
    selectedSlots.forEach(s => {
      const detail = calculatePrice(selectedType, selectedDate, s.startTime, currentEffectiveMemberType, false, s.courtId);
      total += detail.total;
      original += detail.original;
    });
    return {
      total,
      original,
      priceType: PriceType.NORMAL
    };
  };

  const handleToggleSlot = (startTime: string) => {
    if (!loggedInUser) {
      alert('🔒 ขออภัยค่ะ! กรุณาลงชื่อเข้าใช้ระบบ (Login) หรือสมัครสมาชิกใหม่ด้านบนก่อน จึงจะสามารถเลือกสนามและช่วงเวลาสำหรับจองเล่นกีฬาได้ค่ะ 🌟');
      const consoleElem = document.getElementById('customer-auth-console');
      if (consoleElem) {
        consoleElem.scrollIntoView({ behavior: 'smooth' });
      }
      return;
    }
    const existsIdx = selectedSlots.findIndex(s => s.courtId === selectedCourtId && s.startTime === startTime);
    if (existsIdx > -1) {
      setSelectedSlots(selectedSlots.filter((_, i) => i !== existsIdx));
    } else {
      // Constraint 1: max 3 hours total per booking
      if (selectedSlots.length >= 3) {
        alert('คุณสามารถจองได้สูงสุดไม่เกิน 3 ชั่วโมง (3 สล็อต) ต่อการจอง 1 ครั้งค่ะ');
        return;
      }
      
      // Constraint 2: max 3 unique courts per booking
      const currentCourts = selectedSlots.map(s => s.courtId);
      const uniqueCourts = new Set([...currentCourts, selectedCourtId]);
      if (uniqueCourts.size > 3) {
        alert('คุณสามารถเลือกสนามได้ไม่เกิน 3 สนาม ต่อการจอง 1 ครั้งค่ะ');
        return;
      }

      // Check slot double booking
      const isSlotOccupied = bookings.some(
        b => b.courtId === selectedCourtId &&
             b.date === selectedDate &&
             b.startTime === startTime &&
             b.status !== BookingStatus.CANCELLED
      );

      if (isSlotOccupied) {
        alert('ขออภัยค่ะ! ช่วงเวลานี้ถูกผู้อื่นจองไปแล้ว กรุณาเลือกเวลาอื่น');
        return;
      }

      // Check Special DayOff block
      const hourNum = parseInt(startTime.split(':')[0], 10);
      const blockedItem = daysOff.find(
        d => d.date === selectedDate && 
             (d.courtId === 'all' || d.courtId === selectedCourtId) &&
             (d.isFullDay || d.isFullDay === undefined || (d.startHour !== undefined && d.endHour !== undefined && hourNum >= d.startHour && hourNum < d.endHour))
      );

      if (blockedItem) {
        alert(`ขออภัยค่ะ! สนามบินปิดระงับบริการในช่วงเวลานี้ชั่วคราว \nสาเหตุ: "${blockedItem.reason}"\nกรุณาเลือกรอบเวลาอื่นหรือสนามกีฬาอื่นค่ะ`);
        return;
      }

      setSelectedSlots([...selectedSlots, { courtId: selectedCourtId, startTime }]);
    }
  };

  const handleToggleSlotInGrid = (courtId: string, startTime: string) => {
    if (!loggedInUser) {
      alert('🔒 ขออภัยค่ะ! กรุณาลงชื่อเข้าใช้ระบบ (Login) หรือสมัครสมาชิกใหม่ด้านบนก่อน จึงจะสามารถเลือกสนามและช่วงเวลาสำหรับจองเล่นกีฬาได้ค่ะ 🌟');
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
        alert('คุณสามารถจองได้สูงสุดไม่เกิน 3 ชั่วโมง (3 สล็อต) ต่อการจอง 1 ครั้งค่ะ');
        return;
      }
      
      // Constraint 2: max 3 unique courts per booking
      const currentCourts = selectedSlots.map(s => s.courtId);
      const uniqueCourts = new Set([...currentCourts, courtId]);
      if (uniqueCourts.size > 3) {
        alert('คุณสามารถเลือกสนามได้ไม่เกิน 3 สนาม ต่อการจอง 1 ครั้งค่ะ');
        return;
      }

      // Check slot double booking. Uses the shared mutex-group check (FR-1.2)
      // instead of a plain per-court lookup, so e.g. booking half-court B is
      // correctly blocked when the full court is already booked, and vice
      // versa - a same-court-id-only check would miss that conflict.
      if (!isCourtSlotAvailable(courtId, selectedDate, startTime, bookings, courts)) {
        alert('ขออภัยค่ะ! ช่วงเวลานี้ถูกผู้อื่นจองไปแล้ว กรุณาเลือกเวลาอื่น');
        return;
      }

      // Check peak constraint for half-court resources (FR-1.2)
      const targetCourt = courts.find(c => c.id === courtId);
      if (targetCourt?.offPeakOnly && !isHourOffPeak(targetCourt.type, selectedDate, parseInt(startTime.split(':')[0], 10))) {
        alert('⚠️ ขออภัยค่ะ สนามครึ่งสนาม (B / C) เปิดให้บริการจองเฉพาะช่วง Off-Peak เท่านั้นค่ะ');
        return;
      }

      // Outside opening hours (no pricing rule covers it) - the server refuses these
      if (targetCourt && !calculatePrice(targetCourt.type, selectedDate, startTime, MemberType.NORMAL, false, courtId).isOpen) {
        alert('ขออภัยค่ะ ช่วงเวลานี้อยู่นอกเวลาเปิดให้บริการ');
        return;
      }

      // Check Special DayOff block
      const hourNum = parseInt(startTime.split(':')[0], 10);
      const blockedItem = daysOff.find(
        d => d.date === selectedDate && 
             (d.courtId === 'all' || d.courtId === courtId) &&
             (d.isFullDay || d.isFullDay === undefined || (d.startHour !== undefined && d.endHour !== undefined && hourNum >= d.startHour && hourNum < d.endHour))
      );

      if (blockedItem) {
        alert(`ขออภัยค่ะ! สนามบินปิดระงับบริการในช่วงเวลานี้ชั่วคราว \nสาเหตุ: "${blockedItem.reason}"\nกรุณาเลือกรอบเวลาอื่นหรือสนามกีฬาอื่นค่ะ`);
        return;
      }

      setSelectedSlots([...selectedSlots, { courtId, startTime }]);
    }
  };

  const handleRedeemReward = (reward: Reward) => {
    if (!loggedInUser) {
      alert('กรุณาเข้าสู่ระบบก่อนทำการแลกรางวัลค่ะ!');
      return;
    }
    // Points live in the backend's ledger in API mode; redeeming here would
    // only change a local copy. Needs a redemption endpoint first.
    if (api.USE_BACKEND) {
      alert('การแลกรางวัลออนไลน์ยังไม่เปิดให้บริการ กรุณาแลกที่เคาน์เตอร์ค่ะ');
      return;
    }

    const currentPoints = loggedInUser.points || 0;
    if (currentPoints < reward.cost) {
      alert(`ขออภัยค่ะ! แต้มสะสมของคุณไม่เพียงพอสำหรับการแลก ${reward.name} (ต้องการ ${reward.cost} แต้ม แต่คุณมี ${currentPoints} แต้ม)`);
      return;
    }

    const confirmRedeem = window.confirm(`🎁 ยืนยันสิทธิ์แลกแต้มสะสม:\n\nต้องการใช้แต้มสะสมจำนวน ${reward.cost} แต้ม เพื่อแลกรับรางวัล "${reward.emoji} ${reward.name}" ใช่หรือไม่?`);
    if (!confirmRedeem) return;

    // Deduct points
    const newPoints = currentPoints - reward.cost;

    // Update inside stored users list
    const users = StorageService.get<User[]>('users', []);
    const updatedUsers = users.map(user => {
      if (user.id === loggedInUser.id) {
        return { ...user, points: newPoints };
      }
      return user;
    });
    StorageService.set('users', updatedUsers);

    // Update loggedInUser and customer storage profile
    const updatedUser = { ...loggedInUser, points: newPoints };
    setLoggedInUser(updatedUser);
    StorageService.set('current_logged_in_customer', updatedUser);

    // Create redemption voucher
    const claimCode = `RW-${String(Math.floor(100000 + Math.random() * 900000))}`;
    const newVoucher: Redemption = {
      id: 'voucher-' + Date.now(),
      userId: loggedInUser.id,
      userName: loggedInUser.name,
      rewardId: reward.id,
      rewardName: reward.name,
      pointsSpent: reward.cost,
      claimCode,
      redeemedAt: new Date().toLocaleDateString('th-TH', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }) + ' น.'
    };

    const currentVouchers = StorageService.get<Redemption[]>('redemptions', []);
    const updatedVouchers = [newVoucher, ...currentVouchers];
    StorageService.set('redemptions', updatedVouchers);
    setRedemptions(updatedVouchers);

    // Add Audit Log
    onAddAuditLog('LOYALTY_POINT_REDEEMED', 'User', loggedInUser.id, { pointsBefore: currentPoints }, { pointsAfter: newPoints, gift: reward.name, voucherCode: claimCode });

    // Send Line simulated notification
    const cleanPhone = (loggedInUser.phone || '').replace(/[^0-9]/g, '');
    const lpMsg = `🎁 แลกรับสิทธิ์ของรางวัลสำเร็จ!\n🏆 คุณได้ใช้แต้มสะสมจำนวน -${reward.cost} แต้ม เพื่อแลกรับรางวัล "${reward.emoji} ${reward.name}"\n🔑 รหัสเคลมของรางวัล (Claim Code): ${claimCode}\n\n*โปรดแสดงรหัสสิทธิ์นี้ให้สตาฟเห็นเพื่อรับของรางวัลทันทีที่เคาน์เตอร์ขอบสนามค่ะ! 🎉`;
    
    // Call the pushMessage simulator
    const currentLine = StorageService.get<LineMessage[]>('line_messages', []);
    const newMsg: LineMessage = {
      id: 'msg-' + Date.now(),
      recipientPhone: cleanPhone,
      recipientName: loggedInUser.name,
      text: lpMsg,
      timestamp: new Date().toLocaleTimeString('th-TH'),
      type: 'CONFIRMED'
    };
    StorageService.set('line_messages', [newMsg, ...currentLine]);
    setLineMessages([newMsg, ...currentLine]);

    alert(`🎉 แลกรางวัล "${reward.name}" สำเร็จ!\nระบบได้หักคะแนนคงเหลือของคุณ -${reward.cost} แต้ม\n\nรหัสคูปองสำหรับเคลมของคุณคือ: ${claimCode}\n(รายละเอียดและรหัสเคลมระบุไว้ในประวัติแลกด้านล่าง และส่งแจ้งเตือนเข้าทางช่องแชท LINE เรียบร้อยแล้วค่ะ!)`);
    
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
      alert('🔒 ขออภัยค่ะ! กรุณาลงชื่อเข้าใช้ (Login) หรือสมัครสมาชิกใหม่ด้านบนก่อน เพื่อทำรายการจองและแสตมป์ยอดส่วนลดประจำตัวผู้เล่นค่ะ 🌟');
      return;
    }
    if (selectedSlots.length === 0) {
      alert('กรุณาเลือกสนาม และช่วงเวลาต้องการจองอย่างน้อย 1 ชั่วโมง!');
      return;
    }
    // Verify slot double-booking for all selected
    const occupied = selectedSlots.find(s => 
      bookings.some(b => 
        b.courtId === s.courtId &&
        b.date === selectedDate &&
        b.startTime === s.startTime &&
        b.status !== BookingStatus.CANCELLED
      )
    );

    if (occupied) {
      const cName = courts.find(c => c.id === occupied.courtId)?.name || 'สนาม';
      alert(`ขออภัยค่ะ! ช่วงเวลา ${occupied.startTime} น. ของ ${cName} ถูกผู้อื่นจองไปแล้วระหว่างทำรายการ กรุณาเลือกสล็อตอื่น`);
      return;
    }

    setActiveStep(2);
  };

  const handleBookingSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!loggedInUser) {
      alert('🔒 กรุณาลงชื่อเข้าใช้ระบบก่อนค่ะ!');
      return;
    }
    if (selectedSlots.length === 0) {
      alert('กรุณาเลือกวันเวลาที่จอง!');
      return;
    }

    if (api.USE_BACKEND) {
      // The server prices every slot itself (member discount, half-court
      // rate) and books them all-or-nothing, so the shown total is only a
      // preview - the response's amounts are what get stored and paid.
      api.createBookings(selectedDate, selectedSlots)
        .then(group => {
          setCurrentBooking(group.bookings[0]);
          setCurrentPayment(group.payment);
          setQrCodePayload(group.promptPayPayload);
          setActiveStep(3);
          const breakdown = group.bookings.map(b => {
            const cName = courts.find(c => c.id === b.courtId)?.name || 'สนาม';
            return `- ${cName} เวลา ${b.startTime}-${b.endTime} (${b.totalAmount} บาท)`;
          }).join('\n');
          triggerLineNotification(
            `✅ รับคำขอจองแล้ว (${group.bookings.length} รายการ)\n📋 รหัสจองกลุ่ม: ${group.bookingCode}\n📅 วันที่: ${selectedDate}\nรายละเอียด:\n${breakdown}\n💰 ยอดที่ต้องชำระทั้งหมด: ${group.totalAmount} บาท\n\nกรุณาชำระและอัปโหลด slip ภายใน 30 นาที หากไม่ชำระระบบจะยกเลิกออโต้`,
            (loggedInUser.phone || '').replace(/[^0-9]/g, ''), memberName, "CREATED"
          );
          setBookingSuccessAlert(`สร้างรายการจองรวม ${group.bookings.length} รายการสำเร็จ รหัสกลุ่มคือ ${group.bookingCode} แล้ว! กรุณาชำระเงินและอัพโหลดสลิป`);
          onRefreshAll();
        })
        .catch(err => {
          alert(`ขออภัยค่ะ จองไม่สำเร็จ: ${err.message}`);
          onRefreshAll(); // reload availability - someone may have taken the slot
        });
      return;
    }

    const priceInfo = currentPriceDetails();
    const cleanPhone = (loggedInUser.phone || '').replace(/[^0-9]/g, '');
    const mainBookingId = 'bk-' + Date.now();
    const bkCode = `BK${selectedDate.replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

    const newBookings: Booking[] = selectedSlots.map((slotItem, index) => {
      const singlePrice = calculatePrice(selectedType, selectedDate, slotItem.startTime, loggedInUser.memberType || MemberType.NORMAL, false, slotItem.courtId);
      // Half-court status comes from the court itself (B/C are half-shares),
      // as on the server.
      const bookedCourt = courts.find(c => c.id === slotItem.courtId);
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
    const qrPayload = generatePromptPayPayload('0105561008012', priceInfo.total);

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
      return `- ${cName} เวลา ${b.startTime}-${b.endTime} (${b.totalAmount} บาท)`;
    }).join('\n');

    const textMessage = `✅ รับคำขอจองแล้ว (${newBookings.length} รายการ)\n📋 รหัสจองกลุ่ม: ${bkCode}\n📅 วันที่: ${selectedDate}\nรายละเอียด:\n${breakdown}\n💰 ยอดที่ต้องชำระทั้งหมด: ${priceInfo.total} บาท\n\nกรุณาชำระและอัปโหลด slip ภายใน 30 นาที หากไม่ชำระระบบจะยกเลิกออโต้`;
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
    setSlipFile('');
    setActiveStep(3);
    setNowTick(Date.now());
    setTimeout(() => document.getElementById('promptpay-qr-display')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };

  const handleSlipUploadSimulation = (mockImgUrl: string, realFile?: File) => {
    if (!currentBooking) return;

    if (api.USE_BACKEND) {
      // Upload the chosen file; for the sample buttons, fetch the sample
      // image so the backend still receives a real file.
      const getFile: Promise<Blob> = realFile
        ? Promise.resolve(realFile)
        : fetch(mockImgUrl).then(r => {
            if (!r.ok) throw new Error('could not load sample slip image');
            return r.blob();
          });
      getFile
        .then(file => api.uploadSlip(currentBooking.id, file, realFile?.name || 'sample-slip.jpg'))
        .then(() => {
          setSlipFile(realFile ? URL.createObjectURL(realFile) : mockImgUrl);
          setBookingSuccessAlert("อัพโหลดสลิปเรียบร้อยแล้ว! สตาฟกำลังทำการตรวจสอบสลิปภายใน 5 นาที");
          setActiveStep(1);
          setSelectedSlots([]);
          onRefreshAll();
        })
        .catch(err => alert(`อัพโหลดสลิปไม่สำเร็จ: ${err.message}`));
      return;
    }

    setSlipFile(mockImgUrl);

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

    setBookingSuccessAlert("อัพโหลดสลิปเรียบร้อยแล้ว! ระบบ LINE OA และสตาฟกำลังทำการตรวจสอบสลิปภายใน 5 นาที");
    setActiveStep(1); // Return to booking screen
    setSelectedSlots([]);
    onRefreshAll();
  };

  // Standard static slip samples
  const SLIP_SAMPLES = [
    { name: 'สลิปยอดถูกต้อง (KTB Bank)', url: 'https://images.unsplash.com/photo-1554415707-6e8cfc93fe23?w=300&q=80' },
    { name: 'สลิปยอดฝากเงิน (SCB Bank)', url: 'https://images.unsplash.com/photo-1628157582853-a796fa650a6a?w=300&q=80' },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pb-20">
      {apiError && (
        <div className="lg:col-span-12 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>โหลดข้อมูลจากเซิร์ฟเวอร์ไม่สำเร็จ: {apiError}</span>
        </div>
      )}
      
      {/* Dynamic Line Notification Simulator Button */}
      <button 
        id="btn-line-sim-toggle"
        onClick={() => setShowLineSimulator(!showLineSimulator)}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-3 rounded-full shadow-2xl transition duration-200"
      >
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-slate-100 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-3 w-3 bg-white"></span>
        </span>
        <MessageSquare className="h-5 w-5" />
        <span className="font-sans font-medium text-sm">LINE OA ลูกค้า ({lineMessages.length})</span>
      </button>

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
                      <span className="px-2.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 text-[10px] font-bold uppercase tracking-wider">
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
                    className="bg-rose-950/40 hover:bg-rose-900 border border-rose-900/40 text-rose-300 text-[10px] font-bold py-1.5 px-3 rounded-lg transition"
                  >
                    🗑️ ขอลบข้อมูลบัญชีของฉัน (Delete Account)
                  </button>
                </div>
              </div>

              {/* Profile Details segment */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-xs bg-slate-950/50 p-4 rounded-xl border border-slate-800">
                <div className="space-y-1 font-sans">
                  <span className="text-[10px] text-slate-400 font-bold block">เบอร์โทรศัพท์ผู้ติดต่อหลัก:</span>
                  <span className="font-mono text-slate-200 font-bold text-xs">{loggedInUser.phone || 'ไม่ระบุ'}</span>
                </div>
                <div className="space-y-1 font-sans">
                  <span className="text-[10px] text-slate-400 font-bold block">ระดับสิทธิ์แสตมป์ส่วนลดประจำตัว:</span>
                  <span className="text-emerald-400 font-bold flex items-center gap-1 text-[11px] leading-tight">
                    🌟 {loggedInUser.memberType === MemberType.NORMAL && 'ลูกค้าทั่วไป (ไม่มีส่วนลด)'}
                    🌟 {loggedInUser.memberType === MemberType.MEMBER && 'สมาชิกร้านสากล (ส่วนลด 10%)'}
                    🌟 {loggedInUser.memberType === MemberType.STUDENT && 'สิทธิ์นักเรียนนักศึกษา (ส่วนลด 20%)'}
                    🌟 {loggedInUser.memberType === MemberType.CORPORATE && `สิทธิ์องค์กรแคมปัส [${loggedInUser.orgName || 'ไม่ระบุ'}] (ส่วนลด 15%)`}
                  </span>
                </div>
                <div className="space-y-1 font-sans">
                  <span className="text-[10px] text-slate-400 font-bold block">วันที่เริ่มจัดทะเบียนร่วมก๊วน:</span>
                  <span className="font-mono text-slate-300 text-xs">{loggedInUser.createdAt || 'ไม่ระบุ'}</span>
                </div>
                <div className="space-y-1 font-sans bg-amber-950/20 border border-amber-900/40 p-2 rounded-lg">
                  <span className="text-[10px] text-amber-400 font-bold block">🏆 แต้มสะสมปัจจุบัน (Reward Points):</span>
                  <span className="text-amber-300 font-black text-sm flex items-center gap-1 font-mono">
                    {loggedInUser.points || 0} แต้ม
                  </span>
                  <span className="text-[9px] text-slate-400 block leading-tight">(1 แต้ม / ชม.จอง หรือ 100 บ. ซื้อของ)</span>
                </div>
              </div>

              {/* 🌟 USER LOYALTY POINTS & REWARD CLUBS */}
              <div className="mt-5 border-t border-slate-800 pt-5 space-y-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-amber-400" />
                  <h4 className="text-[11px] font-black uppercase text-amber-450 tracking-wider">
                    คะแนนและการแลกรับรางวัล (Customer Loyalty & Vouchers Club)
                  </h4>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Left Column: List of Redeemable Rewards */}
                  <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-800 space-y-3">
                    <div className="flex justify-between items-center border-b border-slate-800 pb-2">
                      <span className="text-[11px] font-bold text-slate-300 flex items-center gap-1.5">
                        🎁 เลือกของรางวัลพรีเมียม
                      </span>
                      <span className="text-[10px] text-amber-400 font-bold bg-amber-950/40 px-2 py-0.5 rounded border border-amber-900/60 font-mono">
                        คงเหลือ: {loggedInUser?.points || 0} แต้ม
                      </span>
                    </div>

                    <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                      {LOYALTY_REWARDS.map(reward => {
                        const canRedeem = (loggedInUser?.points || 0) >= reward.cost;
                        return (
                          <div key={reward.id} className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800 flex justify-between items-center gap-3 hover:border-slate-750 transition">
                            <div className="space-y-0.5 max-w-[70%]">
                              <span className="text-[11px] font-bold text-slate-100 flex items-center gap-1">
                                <span className="text-sm leading-none">{reward.emoji}</span>
                                {reward.name}
                              </span>
                              <p className="text-[9.5px] text-slate-400 leading-snug">
                                {reward.description}
                              </p>
                            </div>
                            <div className="flex flex-col items-end shrink-0 gap-1.5">
                              <span className="text-[10px] font-black text-amber-300 bg-amber-950/20 px-2 py-0.5 rounded font-mono">
                                {reward.cost} แต้ม
                              </span>
                              <button
                                type="button"
                                onClick={() => handleRedeemReward(reward)}
                                className={`text-[10px] font-bold py-1 px-3.5 rounded-md transition duration-200 shadow-sm ${
                                  canRedeem 
                                    ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-slate-950 font-extrabold hover:shadow-md hover:brightness-110 active:scale-95 cursor-pointer' 
                                    : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-755'
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
                              <span className="text-[10.5px] font-bold text-emerald-300">
                                {voucher.rewardName}
                              </span>
                              <span className="text-[9px] text-slate-500 font-mono shrink-0">
                                {voucher.redeemedAt}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/60">
                              <span className="text-[9.5px] text-slate-400">
                                รหัสสำหรับยืนยันกับสตาฟ:
                              </span>
                              <span className="font-mono text-xs font-black text-amber-300 bg-amber-950/80 px-2 py-0.5 rounded border border-amber-800/40 tracking-wider">
                                {voucher.claimCode}
                              </span>
                            </div>
                          </div>
                        ))}

                        {redemptions.filter(v => v.userId === loggedInUser?.id).length === 0 && (
                          <div className="text-center py-8 text-slate-500 text-[10px] font-medium leading-relaxed">
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
                        const userConfirmedBookings = bookings.filter(b => b.userId === loggedInUser?.id && b.status === BookingStatus.CONFIRMED);
                        return (
                          <div className="space-y-1.5 font-sans">
                            <div className="flex justify-between items-center text-[10px]">
                              <span className="text-slate-400 mb-1">ชั่วโมงสนามได้รับก๊วนที่จองสำเร็จ:</span>
                              <span className="font-bold text-emerald-450 font-mono">{userConfirmedBookings.length} ชม. ({userConfirmedBookings.length} แต้ม)</span>
                            </div>
                            
                            <div className="max-h-[80px] overflow-y-auto space-y-1 text-[9.5px]">
                              {userConfirmedBookings.map(kb => (
                                <div key={kb.id} className="flex justify-between text-slate-400 border-b border-slate-900/60 pb-0.5">
                                  <span>📅 วันเล่น {kb.date} ({kb.startTime})</span>
                                  <span className="text-amber-400 font-bold">+1 แต้ม</span>
                                </div>
                              ))}
                              {userConfirmedBookings.length === 0 && (
                                <div className="text-[9px] text-slate-400">
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
              </div>
            </div>
          ) : (
            /* Anonymous Authed Screen */
            <div className="p-5 md:p-6">
              <div className="flex items-center gap-2 border-b border-slate-850 pb-3 mb-4">
                <Shield className="h-5 w-5 text-emerald-500 shrink-0" />
                <div>
                  <h3 className="text-xs font-black text-slate-100 uppercase tracking-widest leading-none">ก๊วนผู้เล่น & ส่วนลดอัตโนมัติ (Customer Account Center)</h3>
                  <p className="text-[10px] text-slate-400 mt-1 leading-normal">
                    ตามหลักมาตรฐานความมั่นคงใหม่ ลูกค้าสยามสปอร์ตคอมเพล็กซ์จะต้องล็อคอินเข้าสู่ระบบก่อน เพื่อระบุสิทธิ์ส่วนลดที่ติดกับบัญชีจริงของคุณ!
                  </p>
                </div>
              </div>

              {/* Tabs Switcher */}
              <div className="flex bg-slate-950/60 p-1 rounded-xl w-full border border-slate-850 md:max-w-md mb-4 text-xs">
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
                  📝 สมัครสัญญาสมาชิกใหม่
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
                <div className="bg-rose-950/30 border border-rose-900/40 text-rose-300 p-3 rounded-xl text-xs font-sans mb-4">
                  {authError}
                </div>
              )}

              {forgotResult && (
                <div className="bg-emerald-950/50 border border-emerald-800 text-emerald-350 p-3 rounded-xl text-xs font-sans whitespace-pre-line mb-4 leading-normal">
                  {forgotResult}
                </div>
              )}

              {/* Tab Form rendering */}
              <form onSubmit={authTab === 'login' ? handleLogin : authTab === 'register' ? handleRegister : handleForgotPassword} className="space-y-3 font-sans text-xs">
                {authTab === 'register' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 mb-1">ระบุชื่อเล่นก๊วน / ชื่อจริงผู้ประสานงาน:</label>
                      <input
                        type="text"
                        required
                        placeholder="เช่น พี่เหน่ง ก๊วนทุบดิน, สมศักดิ์"
                        value={authName}
                        onChange={(e) => setAuthName(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-white placeholder-slate-650 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-650"
                      />
                    </div>
                    <div className="bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/80 flex flex-col justify-center">
                      <span className="text-[10px] font-bold text-emerald-400 block">🌟 สิทธิ์เริ่มต้นบัญชีของคุณ:</span>
                      <span className="text-[10px] text-slate-300 font-medium">ลูกค้าทั่วไป (Normal) - ลด 0%</span>
                      <p className="text-[9px] text-slate-500 mt-1 leading-normal">* คุณจะได้รับสิทธิ์ทั่วไปโดยทันที เพื่อเปิดสิทธิ์ส่วนลดอื่นๆ (เช่น นักศึกษา/บริษัท MOU/สมาชิก) กรุณาแจ้งให้เจ้าหน้าที่ Admin ตรวจสอบหลักฐานและตั้งค่าให้หลังบ้านค่ะ</p>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 mb-1">
                      {authTab === 'forgot' ? 'ระบุเบอร์โทร หรือ อีเมลที่กู้คืน:' : 'ระบุ อีเมล / เบอร์โทรศัพท์ก๊วน:'}
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="เช่น user@mail.com หรือ 0845678901"
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-white focus:outline-none focus:border-emerald-600"
                    />
                  </div>

                  {authTab !== 'forgot' && (
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 mb-1">กำหนดรหัสผ่านเข้าใช้ (Password):</label>
                      <input
                        type="password"
                        required
                        placeholder="••••••"
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-white focus:outline-none focus:border-emerald-600"
                      />
                    </div>
                  )}

                  {authTab === 'register' && (
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 mb-1">ระบุเบอร์ติดต่อหลัก (Phone):</label>
                      <input
                        type="tel"
                        required
                        placeholder="เช่น 08XXXXXXXX"
                        value={authPhone}
                        onChange={(e) => setAuthPhone(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-white"
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
        <div id="booking-steps-indicator" className="bg-white p-5 rounded-2xl border border-slate-100 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-3">
            <div className={`h-8 w-8 rounded-full flex items-center justify-center font-bold text-sm ${activeStep >= 1 ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-400'}`}>1</div>
            <div>
              <p className="text-xs font-semibold text-slate-800">ขั้นตอนที่ 1</p>
              <p className="text-[10px] text-slate-500">เลือกสนามและเช็กตาราง</p>
            </div>
          </div>
          <div className="h-px bg-slate-200 flex-1 mx-4 max-w-[80px]" />
          <div className="flex items-center gap-3">
            <div className={`h-8 w-8 rounded-full flex items-center justify-center font-bold text-sm ${activeStep >= 2 ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-400'}`}>2</div>
            <div>
              <p className="text-xs font-semibold text-slate-800">ขั้นตอนที่ 2</p>
              <p className="text-[10px] text-slate-500">กรอกเบอร์โทร & เช็คราคา</p>
            </div>
          </div>
          <div className="h-px bg-slate-200 flex-1 mx-4 max-w-[80px]" />
          <div className="flex items-center gap-3">
            <div className={`h-8 w-8 rounded-full flex items-center justify-center font-bold text-sm ${activeStep >= 3 ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-400'}`}>3</div>
            <div>
              <p className="text-xs font-semibold text-slate-800">ขั้นตอนที่ 3</p>
              <p className="text-[10px] text-slate-500">ชำระ QR & อัพโหลดสลิป</p>
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
                {Object.values(CourtType).map(type => (
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
                    {type === CourtType.BADMINTON && 'Badminton (12) 🏸'}
                    {type === CourtType.BASKETBALL && 'Basketball (1) 🏀'}
                    {type === CourtType.PICKLEBALL && 'Pickleball (3) 🏓'}
                    {type === CourtType.MEETING_ROOM && 'ห้องประชุม (1) 👥'}
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
                  onChange={(e) => {
                    setSelectedDate(e.target.value);
                    setSelectedSlots([]);
                  }}
                  className="w-full bg-white border border-slate-205 rounded-lg py-2 px-3 text-xs text-slate-800 font-bold focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 focus:outline-none"
                />
              </div>
            </div>

            {/* COMPREHENSIVE CUSTOMER COURT BOOKING VISUALIZER MATRIX */}
            {selectedDate && (
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                  <div>
                    <h3 className="text-xs font-bold text-slate-800 uppercase tracking-widest flex items-center gap-1.5 font-sans">
                      🎾 ตารางจองสนามและมอนิเตอร์ดีมานด์ภาพรวม (Comprehensive Court Occupancy Grid)
                    </h3>
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      ตรวจสอบช่วงเวลาสนามว่าง/เต็มทุกชั่วโมง คลิกที่ช่อง "🟢 ว่าง" เพื่อนับจองสล็อตเวลาได้ทันทีสลับช่องได้อิสระ
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-[10px] font-sans">
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-rose-500 rounded" /> 🔴 จองแล้ว / เต็ม</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-rose-200 rounded" /> ⚠️ ปิดสนาม</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-amber-100 rounded" /> 🟡 ว่าง (Peak)</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-slate-100 rounded" /> 🟢 ว่าง (ปกติ)</span>
                    <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-emerald-600 rounded" /> ⭐ เลือกแล้ว</span>
                  </div>
                </div>

                {/* Overlay lock notice if not logged in */}
                <div className="relative">
                  {!loggedInUser && (
                    <div className="absolute inset-0 bg-white/75 backdrop-blur-[2px] z-10 flex flex-col items-center justify-center p-4 text-center rounded-2xl">
                      <div className="bg-slate-900 border border-slate-800 text-white p-5 rounded-2xl shadow-xl max-w-sm space-y-3">
                        <Shield className="h-6 w-6 text-amber-500 mx-auto animate-pulse" />
                        <h3 className="text-xs font-black text-slate-100 uppercase tracking-widest">🔒 ต้องเข้าสู่ระบบก่อนจึงจะเลือกจองได้</h3>
                        <p className="text-[10px] text-slate-350 leading-relaxed">
                          คุณลูกค้าจะต้องลงชื่อเข้าใช้ระบบ (Login) หรือลงทะเบียนสมาชิกด้านบนก่อน จึงจะสามารถคลิกเลือกจองสนามกีฬาในตารางด้านล่างได้ค่ะ
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            const consoleElem = document.getElementById('customer-auth-console');
                            if (consoleElem) {
                              consoleElem.scrollIntoView({ behavior: 'smooth' });
                            }
                          }}
                          className="bg-emerald-600 hover:bg-emerald-500 text-white font-black text-[9px] px-3.5 py-1.5 rounded-lg transition-all"
                        >
                          👉 เลื่อนไปด้านบนเพื่อเข้าสู่ระบบ
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Grid-based occupancy matrix */}
                  <div className="overflow-x-auto border border-slate-200 rounded-xl bg-slate-50/50">
                    <table className="w-full text-left border-collapse min-w-[1100px]">
                      <thead>
                        <tr className="bg-slate-100 text-[10px] uppercase font-black text-slate-500 border-b border-slate-200">
                          <th className="p-3 bg-slate-100 sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] w-36">สนาม (Court Name)</th>
                          {getAvailableSlots().map((slot) => (
                            <th key={slot.start} className="p-2 text-center text-[9px] min-w-[75px] border-l border-slate-200">
                              {slot.start} น.
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 bg-white text-[10px]">
                        {courts.filter(c => c.type === selectedType).map((court) => (
                          <tr key={court.id} className="hover:bg-slate-50/55 transition-colors">
                            {/* Court Title Left sticky column */}
                            <td className="p-3 font-bold text-[#0f172a] bg-slate-50 sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] border-r border-slate-200">
                              <div className="flex flex-col">
                                <span className="text-[11px] font-black">{court.name}</span>
                                {court.offPeakOnly && (
                                  <span className="text-[8px] text-emerald-800 font-bold bg-emerald-50 px-1 py-0.2 rounded w-max mt-0.5">Off-Peak เท่านั้น</span>
                                )}
                              </div>
                            </td>

                            {/* Hourly timeline slot cells */}
                            {getAvailableSlots().map((slot) => {
                              const time = slot.start;
                              const hourNum = slot.hourNum;

                              // 1. Is it blocked by a reservation on this court OR a
                              // mutex-group sibling (FR-1.2, e.g. the full court)?
                              const matchedBooking = findConflictingBooking(court.id, selectedDate, time, bookings, courts);

                              // 2. Is it blocked by admin closure / operational days off?
                              const matchedClosure = daysOff.find(
                                d => d.date === selectedDate &&
                                     (d.courtId === 'all' || d.courtId === court.id) &&
                                     (d.isFullDay || d.isFullDay === undefined || (d.startHour !== undefined && d.endHour !== undefined && hourNum >= d.startHour && hourNum < d.endHour))
                              );

                              // 3. Peak/Offpeak check, read from the same PricingRule
                              // config the price itself uses (instead of a separately
                              // hardcoded peak window that could drift from it).
                              const isPeak = !isHourOffPeak(court.type, selectedDate, hourNum);

                              // 4. Half-court offpeak-only constraint (FR-1.2)
                              const isRestrictedPeakBasketball = !!court.offPeakOnly && isPeak;

                              // 5. Currently selected by this user in checkout drawer
                              const isSelectedBySelf = selectedSlots.some(s => s.courtId === court.id && s.startTime === time);

                              // Render slot cells conditionally
                              if (matchedBooking) {
                                const isPending = matchedBooking.status === BookingStatus.PENDING_PAYMENT;
                                const isSelfBooking = loggedInUser && matchedBooking.userId === loggedInUser.id;
                                return (
                                  <td 
                                    key={time} 
                                    className="p-1 border-l border-slate-200 text-center bg-rose-500/10 text-rose-700 min-h-[44px] cursor-not-allowed select-none border-l-rose-250 font-bold"
                                    title={`จองแล้วโดย${isSelfBooking ? 'ตัวคุณเอง' : 'ลูกค้าท่านอื่น'}`}
                                  >
                                    <span className="block text-[8.5px] font-black uppercase text-rose-600">🔴 จองแล้ว</span>
                                    <span className="text-[8px] opacity-75 font-mono">
                                      {isPending ? '⏳ รอนุมัติ' : '✓ โอนแล้ว'}
                                    </span>
                                  </td>
                                );
                              }

                              if (matchedClosure) {
                                return (
                                  <td 
                                    key={time} 
                                    className="p-1 border-l border-slate-200 bg-rose-100 text-rose-800 text-center cursor-not-allowed select-none min-h-[44px] border-l-rose-200 font-bold"
                                    title={`ซ่อมบำรุง/ปิดสนาม: ${matchedClosure.reason}`}
                                  >
                                    <span className="block text-[8px] font-black text-rose-700">⚠️ ปิดสนาม</span>
                                    <span className="text-[7.5px] block leading-tight truncate max-w-[70px] text-slate-500">
                                      {matchedClosure.reason}
                                    </span>
                                  </td>
                                );
                              }

                              if (isRestrictedPeakBasketball) {
                                return (
                                  <td 
                                    key={time} 
                                    className="p-1 border-l border-slate-200 bg-slate-100 text-slate-400 text-center cursor-not-allowed select-none min-h-[44px]"
                                    title="สนามครึ่งสนามจะเปิดให้บริการเฉพาะเวลา Off-Peak"
                                  >
                                    <span className="block text-[8px] font-black text-slate-500">🚫 ปิดช่วง Peak</span>
                                    <span className="text-[7px] block leading-tight text-slate-400">เฉพาะ Offpeak</span>
                                  </td>
                                );
                              }

                              // Calculate single hour price
                              const priceResult = calculatePrice(
                                selectedType, 
                                selectedDate, 
                                time, 
                                loggedInUser ? (loggedInUser.memberType || MemberType.NORMAL) : MemberType.NORMAL,
                                court.shareOfGroup < 1,
                                court.id
                              );

                              // No pricing rule covers this hour: the server treats it
                              // as outside opening hours and refuses the booking.
                              if (!priceResult.isOpen) {
                                return (
                                  <td 
                                    key={time} 
                                    className="p-1 border-l border-slate-200 bg-slate-100 text-slate-400 text-center cursor-not-allowed select-none min-h-[44px]"
                                    title="นอกเวลาเปิดให้บริการ"
                                  >
                                    <span className="block text-[8px] font-black text-slate-500">🚫 ปิดบริการ</span>
                                    <span className="text-[7px] block leading-tight text-slate-400">นอกเวลาทำการ</span>
                                  </td>
                                );
                              }

                              if (isSelectedBySelf) {
                                return (
                                  <td 
                                    key={time} 
                                    onClick={() => handleToggleSlotInGrid(court.id, time)}
                                    className="p-1 border-l border-slate-200 bg-emerald-600 text-white text-center font-bold relative group cursor-pointer animate-pulse border-l-emerald-700"
                                  >
                                    <span className="block text-[9px] font-black uppercase">⭐ เลือกแล้ว</span>
                                    <span className="text-[8.5px] font-mono block">{priceResult.total}฿</span>
                                  </td>
                                );
                              }

                              // Vacant cell styles depending on peak
                              return (
                                <td 
                                  key={time} 
                                  onClick={() => handleToggleSlotInGrid(court.id, time)}
                                  className={`p-1 border-l border-slate-200 text-center cursor-pointer transition min-h-[44px] ${
                                    isPeak 
                                      ? 'bg-amber-50 hover:bg-amber-100 text-amber-900 hover:text-amber-950 border-l-amber-200' 
                                      : 'bg-emerald-50/15 hover:bg-emerald-500/10 text-slate-800 hover:text-emerald-900'
                                  }`}
                                >
                                  <span className="block text-[8.5px] font-semibold text-slate-500 leading-none">🟢 ว่าง</span>
                                  <span className="text-[9.5px] font-mono font-black block mt-0.5 text-slate-800">{priceResult.total}฿</span>
                                  <span className="text-[7.5px] text-slate-400 font-mono scale-[0.85] inline-block">
                                    {isPeak ? '⚡ Peak' : 'Off-Peak'}
                                  </span>
                                </td>
                              );
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
                </div>

                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center text-[10px] text-slate-500 bg-slate-50 p-3 rounded-xl border border-slate-200 gap-2 font-mono">
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
                            <p className="text-[10px] text-slate-500">เวลา {s.startTime} น.</p>
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
                    <span className="text-[10px] text-slate-400 block font-medium">คำนวณราคาเฉลี่ยสมาชิกรวม:</span>
                    <span className="text-sm font-extrabold text-emerald-800 font-mono">{currentPriceDetails().total} บาท</span>
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

            <form onSubmit={handleBookingSubmit} className="space-y-6">
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
                      {loggedInUser?.memberType === MemberType.NORMAL && 'ลูกค้าทั่วไป (ส่วนลด 0%)'}
                      {loggedInUser?.memberType === MemberType.MEMBER && 'สัญญาสมาชิกร้านสากล (ส่วนลด 10%)'}
                      {loggedInUser?.memberType === MemberType.STUDENT && 'สิทธิ์นักเรียนนักศึกษา (ส่วนลด 20%)'}
                      {loggedInUser?.memberType === MemberType.CORPORATE && `สิทธิ์องค์กรแคมปัส MOU [${loggedInUser.orgName || 'ไม่ระบุ'}] (ส่วนลด 15%)`}
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-2 leading-normal">
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
                  <p className="text-[10px] text-amber-700">เลือกสนาม B หรือ C ในตารางเพื่อเช่าครึ่งสนาม ราคาครึ่งหนึ่งของเต็มสนาม เปิดจองเฉพาะช่วง Off-Peak</p>
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
                      const detail = calculatePrice(selectedType, selectedDate, s.startTime, memberType, false, s.courtId);
                      return (
                        <div key={idx} className="flex justify-between text-slate-600 border-b border-slate-100 pb-1.5 last:border-0 last:pb-0 font-medium font-sans">
                          <span>{idx + 1}. {cName} - เวลา {s.startTime} น.</span>
                          <span className="font-bold text-slate-800">{detail.total} บาท <span className="text-[10px] text-slate-400 font-normal line-through">({detail.original}.-)</span></span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex justify-between">
                    <span className="text-slate-500">รวมค่าบริการราคาดิบ:</span>
                    <span className="font-bold text-slate-700">{currentPriceDetails().original} บาท</span>
                  </div>

                  <div className="h-px bg-slate-200 my-2" />
                  
                  <div className="flex justify-between text-sm">
                    <span className="font-bold text-slate-800">ยอดรวมทั้งสิ้นที่ต้องชำระ (100% Upfront):</span>
                    <span className="font-extrabold text-emerald-700 text-base">{currentPriceDetails().total} บาท</span>
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
                  className="bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold py-2.5 px-6 rounded-lg shadow-sm transition"
                >
                  ยืนยันการจอง และสลับรับ QR Code &rarr;
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Step 3: PromptPay QR payment panel */}
        {activeStep === 3 && currentBooking && (
          <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm space-y-6">
            <div className="text-center space-y-2">
              <span className="inline-flex text-[10px] items-center gap-1 font-bold text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1 rounded-full">
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
                    <span className="text-[7.5px] tracking-widest text-[#579FFF]">PROMPT PAY</span>
                    <span className="text-[10px] select-none -mt-1 leading-none font-sans">พร้อมเพย์</span>
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
                  {qrCodePayload ? (
                    <QRCodeSVG value={qrCodePayload} size={176} level="M" />
                  ) : (
                    <div className="h-44 w-44 flex items-center justify-center text-[10px] text-slate-400">ไม่พบ QR</div>
                  )}
                </div>

                <div className="text-center space-y-1">
                  <p className="text-xs font-semibold text-slate-500">สแกนชำระบัญชีสปอร์ตคอมเพล็กซ์</p>
                  <p className="text-sm font-black text-slate-800">รหัสจอง {currentBooking.bookingCode}</p>
                  <p className="text-xs text-sky-900 font-bold select-all bg-sky-50 px-2 py-0.5 rounded">บจก. กีฬาแฮปปี้ พาร์คคอมเพล็กซ์</p>
                  <p className="text-xs font-extrabold text-slate-800 text-lg mt-1">ยอดโอน: {currentPayment?.amount ?? currentBooking.totalAmount} บาท</p>
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
                </div>
              </div>

              {/* Upload Slip Selector Simulator */}
              <div className="space-y-4">
                <div className="bg-slate-50 p-4 rounded-xl border border-dashed border-slate-200">
                  <span className="block text-xs font-semibold text-slate-700 mb-2">อัพโหลดรูปภาพสลิปธนาคาร (Simulation Upload):</span>
                  
                  <div className="space-y-2">
                    {/* Stock-photo "slips" are a demo shortcut - never offer them to real customers. */}
                    {import.meta.env.DEV && SLIP_SAMPLES.map((sample, sIdx) => (
                      <button
                        key={sIdx}
                        type="button"
                        onClick={() => handleSlipUploadSimulation(sample.url)}
                        className="w-full flex items-center gap-3 bg-white p-3 rounded-lg border border-slate-200 hover:border-emerald-600 transition hover:bg-slate-50 text-left text-xs"
                      >
                        <FileImage className="h-7 w-7 text-emerald-700" />
                        <div>
                          <p className="font-bold text-slate-800">{sample.name}</p>
                          <p className="text-[10px] text-slate-500">จำลองอัพโหลดภาพถ่ายสลิปเพื่อส่งให้แอดมิน</p>
                        </div>
                      </button>
                    ))}
                  </div>

                  <div className="mt-4 text-center">
                    <p className="text-[10px] text-slate-400">--- หรือ ---</p>
                    <label className="inline-flex cursor-pointer mt-2 text-[10px] bg-slate-100 hover:bg-slate-200 px-4 py-2 rounded-lg font-bold text-slate-700 transition">
                      <FileImage className="h-3 w-3 mr-1" /> เลือกไฟล์จริงจากเครื่อง
                      <input 
                        type="file" 
                        accept="image/*" 
                        onChange={(e) => {
                          if (e.target.files && e.target.files[0]) {
                            // localStorage mode can't keep a real file, so it
                            // records a placeholder image; API mode uploads
                            // the actual file.
                            handleSlipUploadSimulation("https://images.unsplash.com/photo-1554415707-6e8cfc93fe23?w=300&q=80", e.target.files[0]);
                          }
                        }}
                        className="hidden" 
                      />
                    </label>
                  </div>
                </div>

                <div className="p-4 bg-amber-50 rounded-lg text-xs space-y-1 p-3.5 border border-amber-200 text-amber-800">
                  <p className="font-bold">เงื่อนไขสำคัญหลังจากอัพโหลด:</p>
                  <p>1. คอร์ทสำรองสิทธิ์การจองให้คุณ 30 นาที</p>
                  <p>2. สต๊าฟจะตรวจสอบความแม่นยำของสลิปและกสีกรณ์</p>
                  <p>3. คุณจะได้รับแจ้งเตือนใบรับจอง ยืนยันสำเร็จ (CONFIRMED) ผ่านไลน์ LINE OA</p>
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
                className="bg-slate-550 hover:bg-slate-100 text-xs font-bold text-slate-600 py-2 px-4 rounded text-center transition"
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
              <p className="text-[10px] text-slate-400">จารึกสถานะและสลิปการจองของร้านอาหารสปอร์ตคอมเพล็กซ์แห่งประเทศไทย</p>
            </div>
            <span className="text-[10px] bg-slate-800 text-slate-300 font-bold px-2.5 py-1 rounded-full">เรียงใหม่</span>
          </div>

          <div className="space-y-3 max-h-[250px] overflow-y-auto pr-1">
            {(() => {
              const now = new Date();
              const todayStr = getTodayDateStr();
              const currentTimeStr = now.toTimeString().split(' ')[0].substring(0, 5);

              if (!loggedInUser) {
                return (
                  <p className="text-xs text-slate-400 text-center py-4">
                    🔒 กรุณาลงชื่อเข้าใช้ระบบข้างต้นเสียก่อนเพื่อตรวจสอบประวัติตารางจองของท่านเอง
                  </p>
                );
              }

              const userFilteredFutureBookings = bookings.filter(booking => {
                const isMine = booking.userId === loggedInUser.id;
                if (!isMine) return false;
                
                // Show only future bookings
                const isFuture = booking.date > todayStr || (booking.date === todayStr && booking.startTime > currentTimeStr);
                return isFuture;
              });

              if (userFilteredFutureBookings.length === 0) {
                return (
                  <p className="text-xs text-slate-500 text-center py-6 leading-relaxed">
                    🌟 ไม่พบประวัติการจองล่วงหน้าสำหรับบัญชีคุณในขณะนี้ <br/>
                    <span className="text-[10px] text-slate-400">(ระบบจะแสดงเฉพาะรอบจองที่ยังไม่ถึงเวลาเล่นของท่านเท่านั้น รอบที่เคยผ่านไปแล้วจะไม่แสดงเพื่อความรวดเร็วและเป็นส่วนตัวค่ะ)</span>
                  </p>
                );
              }

              const groupsWithButton = new Set<string>();
              return userFilteredFutureBookings.map((booking) => {
                const courtName = courts.find(c => c.id === booking.courtId)?.name || 'สนามกีฬาทั่วไป';
                // The payment hangs off the group's first row; every row of
                // the group (same code) shares it.
                const matchedPayment = payments.find(p => p.bookingId === booking.id) ||
                  payments.find(p => bookings.some(b => b.id === p.bookingId && b.bookingCode === booking.bookingCode && b.userId === booking.userId));
                const awaitingSlip = booking.status === BookingStatus.PENDING_PAYMENT && !!matchedPayment &&
                  (matchedPayment.status === PaymentStatus.PENDING || matchedPayment.status === PaymentStatus.SLIP_UPLOADED);
                // One upload button per booking group, not one per hour.
                const showUploadButton = awaitingSlip && !groupsWithButton.has(booking.bookingCode);
                if (showUploadButton) groupsWithButton.add(booking.bookingCode);

                let statusBadge = '';
                if (booking.status === BookingStatus.CONFIRMED) statusBadge = 'bg-emerald-600 text-white';
                else if (booking.status === BookingStatus.PENDING_PAYMENT) statusBadge = 'bg-amber-500 text-white';
                else if (booking.status === BookingStatus.CANCELLED) statusBadge = 'bg-slate-600 text-slate-300';
                else statusBadge = 'bg-red-500 text-white';

                return (
                  <div key={booking.id} className="bg-slate-800/80 hover:bg-slate-800 rounded-xl p-4 border border-slate-700/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs transition">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-slate-200">{booking.bookingCode}</span>
                        <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${statusBadge}`}>
                          {booking.status === BookingStatus.CONFIRMED && 'อนุมัติเรียบร้อย'}
                          {booking.status === BookingStatus.PENDING_PAYMENT && (matchedPayment?.status === PaymentStatus.SLIP_UPLOADED ? 'รอสต๊าฟเช็คสลิป' : 'รอชำระเงิน / รอสลิป')}
                          {booking.status === BookingStatus.CANCELLED && 'ยกเลิกรายการ'}
                        </span>
                      </div>
                      <p className="font-bold text-slate-100">{courtName}</p>
                      <p className="text-[10px] text-slate-400">
                        วันที่จอง: {booking.date} | เวลา: {booking.startTime} - {booking.endTime} น.
                      </p>
                      <p className="text-[10px] text-slate-400">
                        ผู้ติดต่อ: {booking.userName} | โทร: {booking.userPhone}
                      </p>
                    </div>

                    <div className="flex flex-col items-start sm:items-end justify-between gap-1">
                      <p className="font-bold text-emerald-400 text-sm">{booking.totalAmount} บาท</p>
                      <span className="text-[9.5px] text-slate-400">
                        หลักฐานสลิป: {matchedPayment?.slipUrl ? (
                          <a href={matchedPayment.slipUrl} target="_blank" rel="noreferrer" className="text-sky-400 underline font-bold hover:text-sky-300">กดดูรูปสลิป</a>
                        ) : 'ไม่มีการอัพโหลด'}
                      </span>
                      {showUploadButton && matchedPayment && (
                        <button
                          type="button"
                          onClick={() => {
                            const root = bookings.find(b => b.id === matchedPayment.bookingId) || booking;
                            handleReopenPayment(root, matchedPayment);
                          }}
                          className="mt-1 text-[10px] font-bold bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg transition"
                        >
                          {matchedPayment.status === PaymentStatus.SLIP_UPLOADED ? '🔁 ส่งสลิปใหม่' : '📤 ชำระเงิน / อัปโหลดสลิป'}
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
      {showLineSimulator && (
        <div id="line-phone-simulator" className="col-span-1 lg:col-span-4 transition-all duration-300 ease-in-out">
          <div className="sticky top-6 bg-slate-950 text-white rounded-[32px] border-8 border-slate-800 overflow-hidden shadow-2xl h-[650px] flex flex-col">
            
            {/* Phone Ear Speaker & Cam */}
            <div className="h-6 bg-slate-800 w-full flex justify-center items-center relative">
              <div className="h-3 w-20 bg-slate-950 rounded-b-xl absolute top-0" />
              <div className="flex justify-between w-full px-5 text-[9px] text-slate-400 select-none">
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
                  <p className="text-[9px] text-emerald-400 flex items-center gap-0.5">● แอดมินและระบบ AI พร้อมตอบ</p>
                </div>
              </div>
              <button onClick={() => setShowLineSimulator(false)} className="text-slate-400 hover:text-white text-xs px-2 py-1">ย่อ</button>
            </div>

            {/* Simulated chat container */}
            <div className="flex-1 p-3 overflow-y-auto space-y-4 bg-slate-900 scrollbar-none font-sans">
              
              {/* Automated welcome message */}
              <div className="flex items-start gap-2 max-w-[85%]">
                <div className="h-6 w-6 rounded-full bg-emerald-500 flex items-center justify-center text-[8px] font-bold text-white shrink-0">SP</div>
                <div className="bg-[#293646] p-2.5 rounded-xl text-[11px] text-slate-200">
                  สวัสดีค่ะ ยินดีต้อนรับสู่ LINE OA ของสปอร์ตคอมเพล็กซ์ 🏸🏀 <br />ระบบจะส่งข้อมูลยืนยันการจอง และแจ้งเตือนล่วงหน้าให้ท่านที่นี่โดยอัติโนมัติค่ะ
                </div>
              </div>

              {/* Loop client side LINE alerts */}
              {lineMessages.map((msg) => (
                <div key={msg.id} className="flex flex-col items-start gap-1 max-w-[85%]">
                  <span className="text-[8px] text-slate-400 pl-8 font-mono">{msg.timestamp.split('T')[1].slice(0, 5)} น.</span>
                  <div className="flex items-start gap-2">
                    <div className="h-6 w-6 rounded-full bg-emerald-500 flex items-center justify-center text-[8px] font-bold text-white shrink-0">SP</div>
                    <div className="bg-emerald-950 border border-emerald-900/60 p-3 rounded-2xl text-[11px] text-emerald-100 whitespace-pre-wrap font-sans">
                      {msg.text}
                    </div>
                  </div>
                </div>
              ))}

              {lineMessages.length === 0 && (
                <p className="text-[10px] text-slate-500 text-center pt-10">ไม่มีแจ้งเตือนในขณะนี้ ยืนยันการจองเพื่อเริ่มรับ Push message ทาง LINE</p>
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
