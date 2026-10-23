import {
  Court,
  CourtType,
  PricingRule,
  PricingConfig,
  DayType,
  PriceType,
  User,
  UserRole,
  MemberType,
  Booking,
  BookingStatus,
  Payment,
  PaymentMethod,
  PaymentStatus,
  Product,
  ProductCat,
  Order,
  OrderStatus,
  OrderType,
  AuditLog,
  LineMessage,
  MemberDiscountRule,
  PointsLedgerEntry,
  LedgerEntryType,
  Shift,
  DayOff
} from './types';

// Default initial seeds

// How many courts of each type the browser-only seed creates. Set with
// BASKETBALL_COURT_COUNT, BADMINTON_COURT_COUNT, PICKLEBALL_COURT_COUNT and
// MEETING_ROOM_COUNT in the root .env (vite.config.ts passes them in as
// __COURT_COUNTS__); same names, defaults and limits as the Go backend's
// golang-backend/seed_courts.go. In API mode courts come from the backend,
// so only golang-backend/.env matters there.
interface CourtCounts { basketball: number; badminton: number; pickleball: number; meetingRoom: number }

export const DEFAULT_COURT_COUNTS: CourtCounts = { basketball: 3, badminton: 12, pickleball: 3, meetingRoom: 1 };

// Out-of-range or non-numeric values fall back to the default, as on the server.
export function parseCourtCounts(raw: Partial<Record<keyof CourtCounts, string>>): CourtCounts {
  const read = (key: keyof CourtCounts, max: number): number => {
    const v = (raw[key] ?? '').trim();
    if (!/^\d+$/.test(v) || Number(v) > max) return DEFAULT_COURT_COUNTS[key];
    return Number(v);
  };
  return { basketball: read('basketball', 26), badminton: read('badminton', 50), pickleball: read('pickleball', 50), meetingRoom: read('meetingRoom', 50) };
}

// Basketball court n (1 = A): full court + left half + right half, one
// mutex group. Court A keeps its original ids (its halves were once
// misnamed "B"/"C"), so old bookings stay valid. Same as the server's
// basketballCourtIDs.
function basketballCourtIds(n: number): { full: string; left: string; right: string; group: string } {
  const group = `bball-court-${n}`;
  if (n === 1) return { full: 'b_full_a', left: 'b_half_b', right: 'b_half_c', group };
  const l = String.fromCharCode(96 + n);
  return { full: `bb-${l}-full`, left: `bb-${l}-left`, right: `bb-${l}-right`, group };
}

// Every seeded court for these counts. Basketball: each court is one mutex
// group, so availability/conflict checks stay generic (see
// isCourtSlotAvailable): the full court blocks both halves, a half blocks
// the full court, the two halves don't block each other. Half courts are
// off-peak only per FR-1.2. Same ids and names as the Go backend's seed.
export function buildDefaultCourts(counts: CourtCounts): Court[] {
  const base = { shareOfGroup: 1, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' };
  const courts: Court[] = [];
  for (let n = 1; n <= counts.basketball; n++) {
    const ids = basketballCourtIds(n);
    const letter = String.fromCharCode(64 + n);
    courts.push(
      { ...base, id: ids.full, name: `สนามบาสเกตบอล ${letter} (เต็มสนาม)`, type: CourtType.BASKETBALL, mutexGroupId: ids.group },
      { ...base, id: ids.left, name: `สนามบาสเกตบอล ${letter} (ครึ่งซ้าย)`, type: CourtType.BASKETBALL, mutexGroupId: ids.group, shareOfGroup: 0.5, offPeakOnly: true },
      { ...base, id: ids.right, name: `สนามบาสเกตบอล ${letter} (ครึ่งขวา)`, type: CourtType.BASKETBALL, mutexGroupId: ids.group, shareOfGroup: 0.5, offPeakOnly: true }
    );
  }
  for (let i = 1; i <= counts.badminton; i++) courts.push({ ...base, id: `bad-${i}`, name: `สนามแบดมินตัน ${i}`, type: CourtType.BADMINTON });
  for (let i = 1; i <= counts.pickleball; i++) courts.push({ ...base, id: `pick-${i}`, name: `สนามพิคเคิลบอล ${i}`, type: CourtType.PICKLEBALL });
  for (let i = 1; i <= counts.meetingRoom; i++) courts.push({ ...base, id: `meet-${i}`, name: `ห้องประชุมเอนกประสงค์ ${i}`, type: CourtType.MEETING_ROOM });
  return courts;
}

const DEFAULT_COURTS: Court[] = buildDefaultCourts(parseCourtCounts(typeof __COURT_COUNTS__ !== 'undefined' ? __COURT_COUNTS__ : {}));

// Names earlier versions seeded for court A's halves, renamed on upgrade only
// if still unchanged (see initializeState).
const OLD_BASKETBALL_NAMES: Record<string, string> = {
  b_half_b: 'สนามบาสเกตบอล B (ครึ่งสนาม: ซ้าย)',
  b_half_c: 'สนามบาสเกตบอล C (ครึ่งสนาม: ขวา)'
};

const DEFAULT_PRICING_RULES: PricingRule[] = [
  // Badminton
  { id: 'p-bad-wd-op', courtType: CourtType.BADMINTON, dayType: DayType.WEEKDAY, startHour: 7, endHour: 17, pricePerHour: 180, priceType: PriceType.OFFPEAK, label: 'แบดมินตัน วันธรรมดาช่วง Off-Peak', isActive: true },
  { id: 'p-bad-wd-p', courtType: CourtType.BADMINTON, dayType: DayType.WEEKDAY, startHour: 17, endHour: 22, pricePerHour: 280, priceType: PriceType.PEAK, label: 'แบดมินตัน วันธรรมดาช่วง Peak', isActive: true },
  { id: 'p-bad-wd-op2', courtType: CourtType.BADMINTON, dayType: DayType.WEEKDAY, startHour: 22, endHour: 23, pricePerHour: 200, priceType: PriceType.OFFPEAK, label: 'แบดมินตัน วันธรรมดาช่วงดึก', isActive: true },
  { id: 'p-bad-we-p', courtType: CourtType.BADMINTON, dayType: DayType.WEEKEND, startHour: 9, endHour: 22, pricePerHour: 300, priceType: PriceType.PEAK, label: 'แบดมินตัน วันหยุดช่วง Peak', isActive: true },
  { id: 'p-bad-we-op', courtType: CourtType.BADMINTON, dayType: DayType.WEEKEND, startHour: 7, endHour: 9, pricePerHour: 220, priceType: PriceType.OFFPEAK, label: 'แบดมินตัน วันหยุดช่วงเช้า Off-Peak', isActive: true },
  { id: 'p-bad-we-op2', courtType: CourtType.BADMINTON, dayType: DayType.WEEKEND, startHour: 22, endHour: 23, pricePerHour: 220, priceType: PriceType.OFFPEAK, label: 'แบดมินตัน วันหยุดช่วงดึก Off-Peak', isActive: true },

  // Basketball
  { id: 'p-bas-wd-op', courtType: CourtType.BASKETBALL, dayType: DayType.WEEKDAY, startHour: 7, endHour: 17, pricePerHour: 500, priceType: PriceType.OFFPEAK, label: 'บาสเกตบอล วันธรรมดา Off-Peak', isActive: true },
  { id: 'p-bas-wd-p', courtType: CourtType.BASKETBALL, dayType: DayType.WEEKDAY, startHour: 17, endHour: 22, pricePerHour: 800, priceType: PriceType.PEAK, label: 'บาสเกตบอล วันธรรมดา Peak', isActive: true },
  { id: 'p-bas-wd-op2', courtType: CourtType.BASKETBALL, dayType: DayType.WEEKDAY, startHour: 22, endHour: 23, pricePerHour: 600, priceType: PriceType.OFFPEAK, label: 'บาสเกตบอล วันธรรมดาช่วงดึก', isActive: true },
  { id: 'p-bas-we-p', courtType: CourtType.BASKETBALL, dayType: DayType.WEEKEND, startHour: 9, endHour: 22, pricePerHour: 900, priceType: PriceType.PEAK, label: 'บาสเกตบอล วันหยุด Peak', isActive: true },
  { id: 'p-bas-we-op', courtType: CourtType.BASKETBALL, dayType: DayType.WEEKEND, startHour: 7, endHour: 9, pricePerHour: 600, priceType: PriceType.OFFPEAK, label: 'บาสเกตบอล วันหยุด Off-Peak', isActive: true },
  { id: 'p-bas-we-op2', courtType: CourtType.BASKETBALL, dayType: DayType.WEEKEND, startHour: 22, endHour: 23, pricePerHour: 600, priceType: PriceType.OFFPEAK, label: 'บาสเกตบอล วันหยุดช่วงดึก', isActive: true },

  // Pickleball
  { id: 'p-pic-wd-op', courtType: CourtType.PICKLEBALL, dayType: DayType.WEEKDAY, startHour: 7, endHour: 17, pricePerHour: 220, priceType: PriceType.OFFPEAK, label: 'พิคเคิลบอล วันธรรมดา Off-Peak', isActive: true },
  { id: 'p-pic-wd-p', courtType: CourtType.PICKLEBALL, dayType: DayType.WEEKDAY, startHour: 17, endHour: 22, pricePerHour: 350, priceType: PriceType.PEAK, label: 'พิคเคิลบอล วันธรรมดา Peak', isActive: true },
  { id: 'p-pic-wd-op2', courtType: CourtType.PICKLEBALL, dayType: DayType.WEEKDAY, startHour: 22, endHour: 23, pricePerHour: 250, priceType: PriceType.OFFPEAK, label: 'พิคเคิลบอล วันธรรมดาช่วงดึก', isActive: true },
  { id: 'p-pic-we-p', courtType: CourtType.PICKLEBALL, dayType: DayType.WEEKEND, startHour: 9, endHour: 22, pricePerHour: 380, priceType: PriceType.PEAK, label: 'พิคเคิลบอล วันหยุด Peak', isActive: true },
  { id: 'p-pic-we-op', courtType: CourtType.PICKLEBALL, dayType: DayType.WEEKEND, startHour: 7, endHour: 9, pricePerHour: 250, priceType: PriceType.OFFPEAK, label: 'พิคเคิลบอล วันหยุด Off-Peak', isActive: true },
  { id: 'p-pic-we-op2', courtType: CourtType.PICKLEBALL, dayType: DayType.WEEKEND, startHour: 22, endHour: 23, pricePerHour: 250, priceType: PriceType.OFFPEAK, label: 'พิคเคิลบอล วันหยุดช่วงดึก', isActive: true },

  // Meeting Room
  { id: 'p-meet-all', courtType: CourtType.MEETING_ROOM, dayType: DayType.WEEKDAY, startHour: 7, endHour: 23, pricePerHour: 400, priceType: PriceType.NORMAL, label: 'ห้องประชุม ราคาคงที่วันธรรมดา', isActive: true },
  { id: 'p-meet-all-we', courtType: CourtType.MEETING_ROOM, dayType: DayType.WEEKEND, startHour: 7, endHour: 23, pricePerHour: 500, priceType: PriceType.NORMAL, label: 'ห้องประชุม ราคาคงที่เสาร์-อาทิตย์', isActive: true }
];

const DEFAULT_PRODUCTS: Product[] = [
  { id: 'pd-1', name: 'น้ำดื่มเนสท์เล่ 600ml', category: ProductCat.FB, subCategory: 'drink', price: 15, isRental: false, stock: 120, isActive: true },
  { id: 'pd-2', name: 'เกลือแร่สปอนเซอร์ 250ml', category: ProductCat.FB, subCategory: 'drink', price: 20, isRental: false, stock: 85, isActive: true },
  { id: 'pd-3', name: 'น้ำอัดลมโค้กกระป๋อง 325ml', category: ProductCat.FB, subCategory: 'drink', price: 20, isRental: false, stock: 90, isActive: true },
  { id: 'pd-4', name: 'เลย์ มันฝรั่งอบกรอบ 50g', category: ProductCat.FB, subCategory: 'snack', price: 30, isRental: false, stock: 50, isActive: true },
  { id: 'pd-5', name: 'ลูกแบดมินตัน RSL Silver (หลอด 12 ลูก)', category: ProductCat.EQUIPMENT, subCategory: 'shuttle', price: 650, isRental: false, stock: 15, isActive: true },
  { id: 'pd-6', name: 'ลูกแบด RSL (แบ่งขาย/คนละลูก)', category: ProductCat.EQUIPMENT, subCategory: 'shuttle', price: 60, isRental: false, stock: 45, isActive: true },
  { id: 'pd-7', name: 'เช่าไม้แบดมินตัน Yonex (ต่อชั่วโมง)', category: ProductCat.EQUIPMENT, subCategory: 'racket', price: 50, isRental: true, stock: 20, isActive: true },
  { id: 'pd-8', name: 'เช่าไม้พิคเคิลบอล Franklin (ต่อชั่วโมง)', category: ProductCat.EQUIPMENT, subCategory: 'racket', price: 60, isRental: true, stock: 10, isActive: true },
  {
    id: 'pd-9', name: 'เช่ารองเท้ากีฬาคุณภาพ (ต่อครั้ง)', category: ProductCat.EQUIPMENT, subCategory: 'shoes', price: 80, isRental: true,
    // `stock` is a cached sum of the per-size/gender variants below (FR-5.3) -
    // checkout must decrement the matching variant, not this aggregate, or
    // two customers could both be told "in stock" for the same last pair.
    stock: 20, isActive: true,
    variants: ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'].flatMap((size) => (
      (['M', 'F'] as const).map((gender) => ({
        id: `pd-9-${size}-${gender}`,
        productId: 'pd-9',
        label: size,
        gender,
        stock: 1
      }))
    ))
  }
];

const DEFAULT_USERS: User[] = [
  { id: 'u-admin', name: 'สมชาย ผู้บริหาร', email: 'admin@sportscomplex.com', phone: '0812345678', role: UserRole.ADMIN, isActive: true, createdAt: '2026-01-01', password: '123456' },
  { id: 'u-mgr-1', name: 'วิชัย ผู้จัดการ', email: 'manager@sportscomplex.com', phone: '0823456789', role: UserRole.MANAGER, isActive: true, createdAt: '2026-01-02', password: '123456' },
  { id: 'u-staff-1', name: 'กิตติ สตาฟเวรเช้า', email: 'staff1@sportscomplex.com', phone: '0834567890', role: UserRole.STAFF, isActive: true, createdAt: '2026-01-03', password: '123456' },
  { id: 'u-cust-mbr', name: 'ประเสริฐ รักกีฬา (สมาชิกร้าน)', email: 'prasert@gmail.com', phone: '0845678901', role: UserRole.CUSTOMER, memberType: MemberType.MEMBER, isActive: true, createdAt: '2026-02-10', password: '123456' },
  { id: 'u-cust-std', name: 'น้องพีเดอร์ นักเรียน', email: 'student@school.ac.th', phone: '0856789012', role: UserRole.CUSTOMER, memberType: MemberType.STUDENT, isActive: true, createdAt: '2026-02-12', password: '123456' }
];

// The venue's calendar date (YYYY-MM-DD, Asia/Bangkok) of a timestamp -
// stored times are UTC, so slicing the string gives the wrong day before
// 07:00 Bangkok, and the browser's own time zone may not be Bangkok.
const BKK_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
export const localDateOf = (iso: string | number | Date) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : BKK_DATE.format(d);
};

export const getTodayDateStr = () => localDateOf(new Date());

// Dates are shown in the Gregorian calendar (2026, not พ.ศ. 2569) with
// Thai month names, in Bangkok time: "20 ต.ค. 2026" / "20 ต.ค. 2026 13:56".
const TH_GREGORIAN = 'th-TH-u-ca-gregory';
export const formatDate = (d: string | number | Date) =>
  new Date(d).toLocaleDateString(TH_GREGORIAN, { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric' });
export const formatDateTime = (d: string | number | Date, withSeconds = false) =>
  new Date(d).toLocaleString(TH_GREGORIAN, {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {})
  });

// "2026-10-20 13:56:02" in Bangkok time, for CSV files (sorts as text and
// spreadsheets read it as a date-time).
export const bangkokStamp = (d: string | number | Date) =>
  new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });

const DEFAULT_BOOKINGS = (): Booking[] => {
  const today = getTodayDateStr();
  return [
    {
      id: "bk-1",
      bookingCode: "BK20260617-0001",
      courtId: "bad-1",
      userId: "u-cust-mbr",
      userName: "ประเสริฐ รักกีฬา (สมาชิกร้าน)",
      userPhone: "0845678901",
      date: today,
      startTime: "09:00",
      endTime: "10:00",
      isHalfCourt: false,
      priceType: PriceType.PEAK,
      totalAmount: 300,
      status: BookingStatus.CONFIRMED,
      isEventBlock: false,
      createdAt: `${today}T08:00:00.000Z`,
      createdBy: "u-staff-1"
    },
    {
      id: "bk-2",
      bookingCode: "BK20260617-0002",
      courtId: "bad-2",
      userId: "u-cust-std",
      userName: "น้องพีเดอร์ นักเรียน",
      userPhone: "0856789012",
      date: today,
      startTime: "10:00",
      endTime: "11:00",
      isHalfCourt: false,
      priceType: PriceType.PEAK,
      totalAmount: 250, // student discount applied
      status: BookingStatus.PENDING_PAYMENT,
      isEventBlock: false,
      createdAt: `${today}T08:15:00.000Z`,
      createdBy: "u-cust-std"
    }
  ];
};

const DEFAULT_PAYMENTS = (): Payment[] => {
  const today = getTodayDateStr();
  return [
    {
      id: "pay-1",
      bookingId: "bk-1",
      amount: 300,
      method: PaymentMethod.PROMPTPAY,
      status: PaymentStatus.VERIFIED,
      slipUrl: "https://images.unsplash.com/photo-1628157582853-a796fa650a6a?w=150",
      slipUploadedAt: `${today}T08:05:00.000Z`,
      verifiedAt: `${today}T08:10:00.000Z`,
      verifiedBy: "u-staff-1",
      createdAt: `${today}T08:00:00.000Z`
    },
    {
      // Created "now" with a real QR, so the demo customer can still pay it
      // instead of it expiring the moment the data is seeded.
      id: "pay-2",
      bookingId: "bk-2",
      amount: 250,
      method: PaymentMethod.PROMPTPAY,
      status: PaymentStatus.PENDING,
      qrPayload: generatePromptPayPayload(LOCAL_PROMPTPAY_ID, 250),
      createdAt: new Date().toISOString()
    }
  ];
};

const DEFAULT_ORDERS = (): Order[] => {
  const today = getTodayDateStr();
  return [
    {
      id: "o-1",
      orderCode: "OD20260617-001",
      userId: "u-cust-mbr",
      customerName: "ประเสริฐ รักกีฬา",
      courtId: "bad-1",
      type: OrderType.FB,
      status: OrderStatus.DELIVERED,
      totalAmount: 50,
      paidAmount: 50,
      paymentMethod: PaymentMethod.CASH,
      createdAt: `${today}T09:15:00.000Z`,
      createdBy: "u-staff-1",
      items: [
        { id: "oi-1", orderId: "o-1", productId: "pd-1", qty: 2, unitPrice: 15 },
        { id: "oi-2", orderId: "o-1", productId: "pd-2", qty: 1, unitPrice: 20 }
      ]
    },
    {
      id: "o-2",
      orderCode: "OD20260617-002",
      customerName: "สมควร เดินเข้ามา (Walk-in)",
      type: OrderType.EQUIPMENT_RENT,
      status: OrderStatus.DELIVERED,
      totalAmount: 50,
      paidAmount: 50,
      paymentMethod: PaymentMethod.CASH,
      createdAt: `${today}T10:05:00.000Z`,
      createdBy: "u-staff-1",
      items: [
        { id: "oi-3", orderId: "o-2", productId: "pd-7", qty: 1, unitPrice: 50 }
      ]
    }
  ];
};

const DEFAULT_AUDIT_LOGS = (): AuditLog[] => {
  const today = getTodayDateStr();
  return [
    {
      id: "al-1",
      userId: "u-staff-1",
      userName: "กิตติ สตาฟเวรเช้า",
      action: "CONFIRMED_BOOKING",
      targetType: "Booking",
      targetId: "bk-1",
      before: { status: "PENDING_PAYMENT" },
      after: { status: "CONFIRMED" },
      createdAt: `${today}T08:10:00.000Z`
    },
    {
      id: "al-2",
      userId: "u-admin",
      userName: "สมชาย ผู้บริหาร",
      action: "PRICING_UPDATED",
      targetType: "PricingRule",
      targetId: "p-bad-wd-op",
      before: { pricePerHour: 180 },
      after: { pricePerHour: 180 },
      createdAt: `${today}T07:05:00.000Z`
    }
  ];
};

const DEFAULT_LINE_MESSAGES = (): LineMessage[] => {
  const today = getTodayDateStr();
  return [
    {
      id: "lm-1",
      timestamp: `${today}T08:00:10Z`,
      recipientPhone: "0845678901",
      recipientName: "ประเสริฐ รักกีฬา",
      type: "CREATED",
      text: `✅ รับคำขอจองแล้ว\n📋 รหัสจอง: BK20260617-0001\n🏟️ สนาม: สนามแบดมินตัน 1\n📅 ${today} เวลา 09:00–10:00\n💰 ยอดที่ต้องชำระ: 300 บาท\n\nกรุณาชำระและอัปโหลด slip ภายใน 30 นาที\nหากไม่ชำระ ระบบจะยกเลิกอัตโนมัติ`
    },
    {
      id: "lm-2",
      timestamp: `${today}T08:10:05Z`,
      recipientPhone: "0845678901",
      recipientName: "ประเสริฐ รักกีฬา",
      type: "CONFIRMED",
      text: `🎉 ยืนยันการจองแล้ว!\n📋 BK20260617-0001 | สนาม สนามแบดมินตัน 1\n📅 ${today} 09:00–10:00\nพบกันที่สนาม!`
    }
  ];
};

// Percentages match REQUIREMENTS.md FR-2.3 (the approved spec). Previously
// this table, mockData's calculatePrice(), and BACKEND_PLAN.md's pricing
// engine each hardcoded a different set of numbers; this is now the one
// place they're defined.
export const DEFAULT_MEMBER_DISCOUNTS: MemberDiscountRule[] = [
  { id: MemberType.NORMAL, name: 'ลูกค้าทั่วไป', discountPercent: 0, isActive: true },
  { id: MemberType.STUDENT, name: 'สิทธิ์นักเรียนนักศึกษาเยาวชน', discountPercent: 15, isActive: true },
  { id: MemberType.MEMBER, name: 'สมาชิกร้านทั่วไป', discountPercent: 10, isActive: true },
  { id: MemberType.CORPORATE, name: 'องค์กรพันธมิตรร่วม MOU', discountPercent: 20, isActive: true },
];

// FR-2.4: half-court rate as a percent of the full-court rate, applied before
// membership discounts. The only place this coefficient should live.
// The business details the admin set (Pricing tab). In API mode they come
// from the cached pricing config, so the receipt works offline too.
export const businessInfo = () => {
  const c = StorageService.get<Partial<PricingConfig>>('pricing_config', {});
  return { name: c.businessName ?? '', address: c.businessAddress ?? '', phone: c.businessPhone ?? '',
    taxId: c.businessTaxId ?? '', vatRegistered: !!c.vatRegistered };
};
// 0105559092490 -> 0-1055-59092-49-0 (the usual Thai layout).
export const formatTaxId = (id: string) =>
  /^\d{13}$/.test(id) ? `${id[0]}-${id.slice(1, 5)}-${id.slice(5, 10)}-${id.slice(10, 12)}-${id[12]}` : id;

const DEFAULT_PRICING_CONFIG: PricingConfig = {
  id: 'global',
  halfCourtRatePercent: 50,
  maxAdvanceDays: 30,
  openHour: 7,
  closeHour: 23
};

// State manager for localStorage
export class StorageService {
  static get<T>(key: string, defaultValue: T): T {
    try {
      const val = localStorage.getItem(`sports_complex_${key}`);
      return val ? JSON.parse(val) : defaultValue;
    } catch {
      return defaultValue;
    }
  }

  static set<T>(key: string, value: T): void {
    try {
      localStorage.setItem(`sports_complex_${key}`, JSON.stringify(value));
    } catch (e) {
      console.error(e);
    }
  }

  // Single write path for every points mutation (earn from booking hours,
  // earn from retail spend, redemption, manual admin adjustment). Appends an
  // auditable PointsLedgerEntry and keeps User.points as its cached sum, so
  // the two can never drift apart the way ad hoc increments used to allow.
  static addLedgerEntry(
    userId: string | undefined,
    type: LedgerEntryType,
    points: number,
    createdBy: string,
    opts?: { refType?: PointsLedgerEntry['refType']; refId?: string; note?: string }
  ): number {
    if (!userId || points === 0) return 0;

    const users = this.get<User[]>('users', []);
    let applied = 0;
    const updatedUsers = users.map(user => {
      if (user.id !== userId) return user;
      const currentPoints = user.points || 0;
      const newPoints = Math.max(0, currentPoints + points);
      applied = newPoints - currentPoints; // clamps a redemption that would go negative
      return { ...user, points: newPoints };
    });

    if (applied === 0) return 0;
    this.set('users', updatedUsers);

    const entry: PointsLedgerEntry = {
      id: `ledger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId,
      type,
      points: applied,
      refType: opts?.refType,
      refId: opts?.refId,
      note: opts?.note,
      createdAt: new Date().toISOString(),
      createdBy
    };
    const ledger = this.get<PointsLedgerEntry[]>('points_ledger', []);
    this.set('points_ledger', [...ledger, entry]);

    const currentCust = this.get<User | null>('current_logged_in_customer', null);
    if (currentCust && currentCust.id === userId) {
      currentCust.points = (currentCust.points || 0) + applied;
      this.set('current_logged_in_customer', currentCust);
    }
    return applied;
  }

  // FR-4.1: 1 point per 1 hour of confirmed court reservation.
  static addPointsHour(userId: string | undefined, hours: number): number {
    if (hours <= 0) return 0;
    return this.addLedgerEntry(userId, LedgerEntryType.EARN_BOOKING, hours, 'system', { note: `${hours}h confirmed booking` });
  }
}

// Pricing Helper Calculation
// dateStr is a calendar date ("YYYY-MM-DD"). It used to go through
// new Date(dateStr).getDay(): that parses as UTC midnight but reads the
// weekday in the browser's zone, so west of UTC every date was a day early
// (Saturday priced as a weekday, Monday as weekend).
export function getDayType(dateStr: string): DayType {
  const [y, m, d] = dateStr.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (day === 0 || day === 6) ? DayType.WEEKEND : DayType.WEEKDAY;
}

// The active pricing rule for a court type at an hour - the rules double as
// opening hours (no rule = closed), as on the server.
function findPricingRule(courtType: CourtType, dateStr: string, hour: number): PricingRule | undefined {
  const pricingRules = StorageService.get<PricingRule[]>('pricing_rules', DEFAULT_PRICING_RULES);
  const dayType = getDayType(dateStr);
  return pricingRules.find(r => r.courtType === courtType && r.dayType === dayType && hour >= r.startHour && hour < r.endHour && r.isActive);
}

// Off-peak by the hour's pricing rule. An hour no rule covers is closed, so
// it is not off-peak (it used to count as off-peak, unlike the server).
export function isHourOffPeak(courtType: CourtType, dateStr: string, hourNum: number): boolean {
  return findPricingRule(courtType, dateStr, hourNum)?.priceType === PriceType.OFFPEAK;
}

// A court is the "hub" of its mutex group when it represents the whole
// physical resource (e.g. the full court) rather than a sub-allocation.
export function isHubCourt(court: Court): boolean {
  return court.shareOfGroup >= 1;
}

// Determines whether two courts conflict for mutex-group purposes (FR-1.2).
// The rule is asymmetric, NOT all-vs-all: a group's hub (the full-court
// allocation) is exclusive with every sibling, but two non-hub
// sub-allocations (e.g. half-court sides B and C) must NOT block each other -
// an earlier version of this function treated every court sharing a
// mutexGroupId as mutually exclusive with every other, which would have
// incorrectly prevented B and C from being booked in parallel.
export function courtsConflict(a: Court, b: Court): boolean {
  if (a.id === b.id) return true;
  if (!a.mutexGroupId || a.mutexGroupId !== b.mutexGroupId) return false;
  return isHubCourt(a) || isHubCourt(b);
}

// Finds the booking (if any) that conflicts with courtId at this date/hour,
// checking every court in its mutex group (FR-1.2) via courtsConflict rather
// than just courtId itself. Replaces the old approach of hardcoding
// basketball court IDs in every component.
export function findConflictingBooking(
  courtId: string,
  date: string,
  hour: string, // "HH:00"
  bookings: Booking[],
  courts: Court[]
): Booking | undefined {
  // A no-show's hour is free again (re-sold at the resale price - see
  // findNoShow), like a cancelled one.
  return findBookingAt(courtId, date, hour, bookings, courts,
    b => b.status !== BookingStatus.CANCELLED && b.status !== BookingStatus.NO_SHOW);
}

// The no-show at this court (or its basketball group) and hour, if any: the
// hour is free and costs resalePrice() - same rule as the server.
export function findNoShow(courtId: string, date: string, hour: string, bookings: Booking[], courts: Court[]): Booking | undefined {
  return findBookingAt(courtId, date, hour, bookings, courts, b => b.status === BookingStatus.NO_SHOW);
}

// No-show rules (server settings, cached with the pricing config): marking
// is allowed from graceMinutes after the start; a freed hour costs the
// court's normal non-member price x resalePercent (see resalePrice).
export function noShowRules(): { graceMinutes: number; resalePercent: number } {
  const c = StorageService.get<Partial<PricingConfig>>('pricing_config', {});
  return { graceMinutes: c.noShowGraceMinutes ?? 15, resalePercent: c.noShowResalePercent ?? 50 };
}
// How many hours one booking may hold: the server's MAX_HOURS_PER_BOOKING
// (API mode, from /pricing); browser-only mode reads the same setting from
// the root .env (vite.config.ts), default 3.
export function maxHoursPerBooking(): number {
  const fromServer = StorageService.get<Partial<PricingConfig>>('pricing_config', {}).maxHoursPerBooking;
  if (fromServer) return fromServer;
  const local = parseInt(typeof __MAX_HOURS_PER_BOOKING__ !== 'undefined' ? __MAX_HOURS_PER_BOOKING__ : '', 10);
  return local >= 1 && local <= 24 ? local : 3;
}
// Whether staff may mark a no-show for the hour starting at startTime on
// date yet (graceMinutes after it starts, Bangkok time), and from when.
export function noShowOpenAt(date: string, startTime: string): Date {
  return new Date(new Date(`${date}T${startTime}:00+07:00`).getTime() + noShowRules().graceMinutes * 60000);
}
// How much of court (0..1) no-shows freed at this hour - same rule as the
// server (noShowFreedShare): all of it when the no-show held the same court
// or the full court over this half; for the full court, the share of the
// halves that were no-shows.
export function noShowFreedShare(court: Court, date: string, hour: string, bookings: Booking[], courts: Court[]): number {
  let share = 0;
  const counted = new Set<string>();
  for (const b of bookings) {
    if (b.status !== BookingStatus.NO_SHOW || b.date !== date || b.startTime !== hour || counted.has(b.courtId)) continue;
    const other = courts.find(c => c.id === b.courtId);
    if (!other || !courtsConflict(court, other)) continue;
    counted.add(other.id);
    if (other.id === court.id || isHubCourt(other)) return 1;
    share += other.shareOfGroup;
  }
  return Math.min(share, 1);
}
// The price of an hour that no-shows freed (some of), or undefined if none
// did - same rule as the server (planSlots): the freed share at the court's
// normal non-member price (half-court rate included) x resalePercent, the
// rest at `normal` (this customer's usual price), never above `normal`.
export function resalePrice(court: Court, date: string, hour: string, bookings: Booking[], courts: Court[], normal: number): number | undefined {
  const freed = noShowFreedShare(court, date, hour, bookings, courts);
  if (freed === 0) return undefined;
  const list = listPrice(court, date, hour);
  if (list === undefined) return undefined;
  return Math.min(normal, roundBaht(list * freed * noShowRules().resalePercent / 100 + normal * (1 - freed)));
}

// The slot's price before any member discount (not even a NORMAL-tier one):
// the rule's hourly price, at the half-court rate for a half court - the
// server's SlotQuoter.ListPrice.
export function listPrice(court: Court, date: string, hour: string): number | undefined {
  const rule = findPricingRule(court.type, date, parseInt(hour, 10));
  if (!rule) return undefined;
  const half = court.shareOfGroup < 1
    ? StorageService.get<PricingConfig>('pricing_config', DEFAULT_PRICING_CONFIG).halfCourtRatePercent / 100 : 1;
  return roundBaht(rule.pricePerHour * half);
}

function findBookingAt(courtId: string, date: string, hour: string, bookings: Booking[], courts: Court[], match: (b: Booking) => boolean): Booking | undefined {
  const court = courts.find(c => c.id === courtId);
  const activeAt = (b: Booking) => b.date === date && b.startTime === hour && match(b);

  if (!court) {
    return bookings.find(b => b.courtId === courtId && activeAt(b));
  }
  return bookings.find(b => {
    if (!activeAt(b)) return false;
    const bookedCourt = courts.find(c => c.id === b.courtId);
    if (!bookedCourt) return b.courtId === courtId;
    return courtsConflict(court, bookedCourt);
  });
}

export function isCourtSlotAvailable(
  courtId: string,
  date: string,
  hour: string, // "HH:00"
  bookings: Booking[],
  courts: Court[]
): boolean {
  return !findConflictingBooking(courtId, date, hour, bookings, courts);
}

// Rounds to 2 decimal places (satang), like the backend's RoundBaht.
export function roundBaht(x: number): number {
  return Math.round(x * 100) / 100;
}

// "180" for whole baht, "212.50" otherwise.
export function formatBaht(x: number): string {
  const r = roundBaht(x);
  return Number.isInteger(r) ? r.toLocaleString('en-US') : r.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Booking statuses whose money was received (or whose hour was played):
// what revenue, occupancy and cancellation care about. COMPLETED (the hour
// is over) and NO_SHOW (paid but didn't come) count like CONFIRMED.
const PAID_BOOKING_STATUSES: BookingStatus[] = [BookingStatus.CONFIRMED, BookingStatus.COMPLETED, BookingStatus.NO_SHOW];
export const isPaidBooking = (b: { status: BookingStatus }) => PAID_BOOKING_STATUSES.includes(b.status);

// The last date customers may book online: today + maxAdvanceDays
// (configurable, default 30), Bangkok calendar.
export function lastBookableDate(): string {
  const cfg = StorageService.get<PricingConfig>('pricing_config', DEFAULT_PRICING_CONFIG);
  const days = cfg.maxAdvanceDays ?? DEFAULT_PRICING_CONFIG.maxAdvanceDays ?? 30;
  const [y, m, d] = bangkokNow().date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Phone numbers in one canonical form: digits only, with the Thai country
// code (66 / 0066) rewritten as the domestic leading 0, so "081-234-5678"
// and "+66 81 234 5678" are the same number. Mirrors the backend's
// repository.NormalizePhone.
export function normalizePhone(phone: string | undefined): string {
  const d = (phone || '').replace(/[^0-9]/g, '');
  if ((d.length === 10 || d.length === 11) && d.startsWith('66')) return '0' + d.slice(2);
  if ((d.length === 12 || d.length === 13) && d.startsWith('0066')) return '0' + d.slice(4);
  // A mobile (06/08/09 + 8 digits) typed without its leading 0.
  if (d.length === 9 && /^[689]/.test(d)) return '0' + d;
  return d;
}

// The current date and hour at the venue (Asia/Bangkok), whatever the
// browser's own time zone.
const BKK_HOUR = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', hourCycle: 'h23' });
function bangkokNow(): { date: string; hour: number } {
  const now = new Date();
  return { date: BKK_DATE.format(now), hour: parseInt(BKK_HOUR.format(now), 10) };
}

// Whether the hour starting at `startTime` on `date` has already started
// (online bookings must start in the future) or ended (nobody can book it),
// in Bangkok time - the same rule as the backend's checkNotPast.
export function slotTiming(date: string, startTime: string): { started: boolean; ended: boolean } {
  const now = bangkokNow();
  const hour = parseInt(startTime.split(':')[0], 10);
  if (date !== now.date) {
    const past = date < now.date;
    return { started: past, ended: past };
  }
  return { started: hour <= now.hour, ended: hour + 1 <= now.hour };
}

// "สิทธิ์นักเรียน... (ส่วนลด 15%)" for a member tier, from the configured
// discounts rather than a hard-coded percentage.
export function memberTierLabel(memberType: MemberType | undefined): string {
  const tiers = StorageService.get<MemberDiscountRule[]>('member_discounts', DEFAULT_MEMBER_DISCOUNTS);
  const tier = tiers.find(t => t.id === (memberType || MemberType.NORMAL));
  if (!tier) return memberType || MemberType.NORMAL;
  return `${tier.name} (ส่วนลด ${tier.isActive ? tier.discountPercent : 0}%)`;
}

// The closure covering `courtId` at `hour` on `date`, if any: an all-courts
// closure, or one on this court or a court that conflicts with it
// (courtsConflict - closing a full court closes its halves, closing a half
// closes the full court but not the other half), for the full day or that
// hour range. `courts` must include the closed courts; without them only
// all-courts and same-court closures can match. The same rule as the
// server's repository.ClosureFor; every screen uses this one.
export function findClosure(daysOff: DayOff[], date: string, courtId: string, hour: number, courts: Court[] = []): DayOff | undefined {
  const target = courts.find(c => c.id === courtId);
  return daysOff.find(d => {
    if (d.date !== date) return false;
    if (d.courtId !== 'all' && d.courtId !== courtId) {
      const closed = courts.find(c => c.id === d.courtId);
      if (!target || !closed || !courtsConflict(closed, target)) return false;
    }
    return d.isFullDay || d.isFullDay === undefined ||
      (d.startHour !== undefined && d.endHour !== undefined && hour >= d.startHour && hour < d.endHour);
  });
}

// Every booking row of root's group: one checkout's hours share its code,
// owner and date and are paid by one payment (attached to the first row).
// Same rule as the backend's bookingGroup, which also matches owner and date
// so a code collision can never pull in someone else's booking.
// Browser-only mode's payment hold (the server's PaymentHoldDuration) and
// unpaid cap (MaxUnpaidGroupsPerUser).
export const LOCAL_PAYMENT_HOLD_MS = 30 * 60000;
export const LOCAL_MAX_UNPAID_GROUPS = 3;
const madeOnline = (b: Booking) => b.createdBy === 'customer' || b.createdBy === b.userId;

// The server's ExpireUnpaidBookings for browser-only mode, run when a
// screen loads: a booking still unpaid by transfer (no slip) after the hold
// - online or a counter walk-in - is cancelled and its payment EXPIRED, so
// the courts free up as the screen says.
export function expireUnpaidLocal(now = Date.now()): number {
  const payments = StorageService.get<Payment[]>('payments', []);
  const bookings = StorageService.get<Booking[]>('bookings', []);
  const byId = new Map(bookings.map(b => [b.id, b]));
  const stale = payments.filter(p => {
    const root = byId.get(p.bookingId);
    return p.status === PaymentStatus.PENDING && p.method === PaymentMethod.PROMPTPAY && !!root &&
      now - new Date(p.createdAt).getTime() > LOCAL_PAYMENT_HOLD_MS;
  });
  if (!stale.length) return 0;
  const at = new Date(now).toISOString();
  const cancelIds = new Set(stale.flatMap(p => bookingGroupOf(byId.get(p.bookingId)!, bookings)
    .filter(b => b.status === BookingStatus.PENDING_PAYMENT).map(b => b.id)));
  const staleIds = new Set(stale.map(p => p.id));
  StorageService.set('bookings', bookings.map(b => cancelIds.has(b.id)
    ? { ...b, status: BookingStatus.CANCELLED, cancellationReason: 'Expired: no payment slip within 30 minutes' } : b));
  StorageService.set('payments', payments.map(p => staleIds.has(p.id) ? { ...p, status: PaymentStatus.EXPIRED, expiredAt: at } : p));
  return stale.length;
}

// How many online booking groups the customer has awaiting payment or slip
// review (the server's countUnpaidGroups).
export function unpaidGroupsLocal(userId: string): number {
  const byId = new Map(StorageService.get<Booking[]>('bookings', []).map(b => [b.id, b]));
  return StorageService.get<Payment[]>('payments', []).filter(p => {
    const root = byId.get(p.bookingId);
    return (p.status === PaymentStatus.PENDING || p.status === PaymentStatus.SLIP_UPLOADED) && !!root && root.userId === userId && madeOnline(root);
  }).length;
}

export function bookingGroupOf(root: Booking, bookings: Booking[]): Booking[] {
  return bookings.filter(b => b.bookingCode === root.bookingCode && b.userId === root.userId && b.date === root.date);
}

export function calculatePrice(
  courtType: CourtType,
  dateStr: string,
  startHourStr: string, // e.g., "09:00"
  memberType: MemberType = MemberType.NORMAL,
  court?: Pick<Court, 'shareOfGroup'>
): { total: number; original: number; priceType: PriceType; discountMessage?: string; isOpen: boolean } {
  const hour = parseInt(startHourStr.split(':')[0], 10);
  const { open, close } = openingHours();
  if (!(hour >= open && hour < close)) {
    return { total: 0, original: 0, priceType: PriceType.NORMAL, discountMessage: '', isOpen: false };
  }

  // 1. Find matching time/day rule. The pricing rules double as opening
  // hours, exactly as on the server (SlotQuoter.Quote): an hour no active
  // rule covers is closed, not priced at some fallback rate the server
  // would refuse to book.
  const rule = findPricingRule(courtType, dateStr, hour);
  if (!rule) {
    return { total: 0, original: 0, priceType: PriceType.NORMAL, discountMessage: '', isOpen: false };
  }

  let basePrice = rule.pricePerHour;
  const original = basePrice;
  const priceType = rule.priceType;

  // 2. Adjust for half-court (FR-2.4). The court's own `shareOfGroup` is
  // the only source of truth for "is this a half-court", as on the server.
  // Callers pass the court they display (in API mode that's the server's
  // court list) rather than a flag or an id looked up in localStorage: a
  // separate flag once halved the full court's price, and an id lookup
  // missed courts that only exist on the server. The rate comes from the
  // configurable PricingConfig.
  const isReallyHalf = court ? court.shareOfGroup < 1 : false;
  if (isReallyHalf) {
    const pricingConfig = StorageService.get<PricingConfig>('pricing_config', DEFAULT_PRICING_CONFIG);
    basePrice = basePrice * (pricingConfig.halfCourtRatePercent / 100);
  }

  let finalPrice = basePrice;
  let discountMessage = '';

  // 3. Member discounts from StorageService
  const memberDiscounts = StorageService.get<MemberDiscountRule[]>('member_discounts', DEFAULT_MEMBER_DISCOUNTS);
  const matchedRule = memberDiscounts.find(rule => rule.id === memberType);

  if (matchedRule && matchedRule.isActive && matchedRule.discountPercent > 0) {
    finalPrice = basePrice * (1 - matchedRule.discountPercent / 100);
    discountMessage = `ส่วนลด${matchedRule.name} ${matchedRule.discountPercent}%`;
  }

  // To the satang (2 decimals, REQUIREMENTS.md NFR-4) - the backend's
  // RoundBaht gives the same result.
  return {
    total: roundBaht(finalPrice),
    original,
    priceType,
    discountMessage,
    isOpen: true
  };
}

// Opening hours (admin setting, PricingConfig.openHour/closeHour; default
// 07:00-23:00, REQUIREMENTS.md FR-2.2): the first slot starts at `open`, the
// last ends at `close`. In API mode the server's value is cached here.
export function openingHours(): { open: number; close: number } {
  const cfg = StorageService.get<PricingConfig>('pricing_config', DEFAULT_PRICING_CONFIG);
  const open = cfg.openHour ?? 7, close = cfg.closeHour ?? 23;
  return open >= 0 && close <= 24 && open < close ? { open, close } : { open: 7, close: 23 };
}

// "HH:00" labels of every slot start within the opening hours.
export function openSlotHours(): string[] {
  const { open, close } = openingHours();
  return Array.from({ length: close - open }, (_, i) => `${String(open + i).padStart(2, '0')}:00`);
}

// Rewards whose voucher pays for one free off-peak court hour (booked by
// staff at the counter) rather than an item handed over. Browser-only mode
// uses the "court" id; the backend catalog marks it with kind
// FREE_OFFPEAK_HOUR.
export const FREE_HOUR_REWARD_IDS = ['court', 'rw-hour'];

// The merchant PromptPay ID QR codes pay to in browser-only mode (the Go
// backend's DefaultPromptPayID).
export const LOCAL_PROMPTPAY_ID = '0105561008012';

// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), the checksum EMVCo QR
// codes end with. Mirrors golang-backend/internal/pkg/promptpay.
export function crc16(data: string): string {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// Classifies a PromptPay ID into its tag-29 sub-tag and encoded value:
// 01 = mobile (0066 + 9 digits), 02 = 13-digit tax/national ID, 03 =
// 15-digit e-wallet. Decided from the number as given, before the mobile
// number is rewritten as 0066XXXXXXXXX (which is also 13 characters).
function normalizePromptPayId(id: string): { subTag: string; value: string } {
  if (/[^0-9 +-]/.test(id)) throw new Error(`Invalid PromptPay ID: ${id}`);
  const d = id.replace(/[^0-9]/g, '');
  if (d.length === 10 && d.startsWith('0')) return { subTag: '01', value: '0066' + d.slice(1) };
  if (d.length === 11 && d.startsWith('66')) return { subTag: '01', value: '00' + d };
  if (d.length === 13 && d.startsWith('0066')) return { subTag: '01', value: d };
  if (d.length === 13) return { subTag: '02', value: d };
  if (d.length === 15) return { subTag: '03', value: d };
  throw new Error(`Invalid PromptPay ID: ${id}`);
}

const tlv = (tag: string, value: string) => tag + value.length.toString().padStart(2, '0') + value;

// PromptPay (Thai QR / EMVCo) payload paying `amount` THB to the given ID -
// the same string the Go backend produces, so a QR drawn in local mode is
// scannable too.
export function generatePromptPayPayload(phoneOrTaxId: string, amount: number): string {
  const { subTag, value } = normalizePromptPayId(phoneOrTaxId);
  const body =
    tlv('00', '01') +
    tlv('01', '12') +
    tlv('29', tlv('00', 'A000000677010111') + tlv(subTag, value)) +
    tlv('58', 'TH') +
    tlv('53', '764') +
    tlv('54', amount.toFixed(2)) +
    '6304';
  return body + crc16(body);
}

// Master state initialization
export function initializeState() {
  if (!localStorage.getItem('sports_complex_init')) {
    StorageService.set('courts', DEFAULT_COURTS);
    StorageService.set('pricing_rules', DEFAULT_PRICING_RULES);
    StorageService.set('pricing_config', DEFAULT_PRICING_CONFIG);
    StorageService.set('products', DEFAULT_PRODUCTS);
    // The demo accounts (with their passwords) exist only in browser-only
    // mode; in a VITE_DATA_SOURCE=api build this folds to [] and
    // DEFAULT_USERS is dropped from the bundle.
    StorageService.set('users', import.meta.env.VITE_DATA_SOURCE === 'api' ? [] : DEFAULT_USERS);
    StorageService.set('bookings', DEFAULT_BOOKINGS());
    StorageService.set('payments', DEFAULT_PAYMENTS());
    StorageService.set('orders', DEFAULT_ORDERS());
    StorageService.set('audit_logs', DEFAULT_AUDIT_LOGS());
    StorageService.set('line_messages', DEFAULT_LINE_MESSAGES());
    StorageService.set('member_discounts', DEFAULT_MEMBER_DISCOUNTS);
    StorageService.set('points_ledger', [] as PointsLedgerEntry[]);
    StorageService.set('shifts', [] as Shift[]);
    StorageService.set('init', 'true');
  } else {
    // Migration: courts now carry mutexGroupId/shareOfGroup instead of the
    // unused allowHalf flag, and the basketball trio needs the group wired up.
    const courts = StorageService.get<Court[]>('courts', []);
    if (!courts.some(c => c.mutexGroupId === 'bball-court-1')) {
      const filtered = courts.filter(c => c.type !== CourtType.BASKETBALL);
      filtered.push(...DEFAULT_COURTS.filter(c => c.type === CourtType.BASKETBALL));
      StorageService.set('courts', filtered.map(c => ({ ...c, shareOfGroup: c.shareOfGroup ?? 1 })));
    } else {
      // Add any seeded court that's missing (basketball became courts A-C;
      // a raised *_COURT_COUNT adds more), and rename A's halves if their
      // old "B"/"C" names are unchanged. Never removes a court: lowering a
      // count leaves existing courts for the admin to close.
      const seededById = new Map(DEFAULT_COURTS.map(c => [c.id, c]));
      const migrated = courts.map(c => {
        const seeded = seededById.get(c.id);
        return seeded && OLD_BASKETBALL_NAMES[c.id] === c.name ? { ...c, name: seeded.name } : c;
      });
      const have = new Set(migrated.map(c => c.id));
      const missing = DEFAULT_COURTS.filter(c => !have.has(c.id));
      if (missing.length > 0 || migrated.some((c, i) => c !== courts[i])) {
        StorageService.set('courts', [...migrated, ...missing]);
      }
    }
    // Migration check for member_discounts
    if (!localStorage.getItem('sports_complex_member_discounts')) {
      StorageService.set('member_discounts', DEFAULT_MEMBER_DISCOUNTS);
    }
    // Migrations for entities added by the loyalty ledger / vouchers / shifts / pricing config redesign
    if (!localStorage.getItem('sports_complex_pricing_config')) {
      StorageService.set('pricing_config', DEFAULT_PRICING_CONFIG);
    }
    if (!localStorage.getItem('sports_complex_points_ledger')) {
      StorageService.set('points_ledger', [] as PointsLedgerEntry[]);
    }
    if (!localStorage.getItem('sports_complex_shifts')) {
      StorageService.set('shifts', [] as Shift[]);
    }
  }
}
