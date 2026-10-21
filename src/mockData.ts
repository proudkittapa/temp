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
const DEFAULT_COURTS: Court[] = [
  // Basketball: one physical court exposed as a full-court booking option plus
  // two half-court sides. They share `mutexGroupId` so availability/conflict
  // checks are generic (see isCourtSlotAvailable) instead of hardcoding these
  // three IDs. Half-court sides are off-peak only per FR-1.2.
  { id: 'b_full_a', name: 'สนามบาสเกตบอล A (เต็มสนาม)', type: CourtType.BASKETBALL, mutexGroupId: 'bball-court-1', shareOfGroup: 1, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'b_half_b', name: 'สนามบาสเกตบอล B (ครึ่งสนาม: ซ้าย)', type: CourtType.BASKETBALL, mutexGroupId: 'bball-court-1', shareOfGroup: 0.5, offPeakOnly: true, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'b_half_c', name: 'สนามบาสเกตบอล C (ครึ่งสนาม: ขวา)', type: CourtType.BASKETBALL, mutexGroupId: 'bball-court-1', shareOfGroup: 0.5, offPeakOnly: true, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
  // Badminton (12 courts)
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `bad-${i + 1}`,
    name: `สนามแบดมินตัน ${i + 1}`,
    type: CourtType.BADMINTON,
    shareOfGroup: 1,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z'
  })),
  // Pickleball (3 courts)
  ...Array.from({ length: 3 }, (_, i) => ({
    id: `pick-${i + 1}`,
    name: `สนามพิคเคิลบอล ${i + 1}`,
    type: CourtType.PICKLEBALL,
    shareOfGroup: 1,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z'
  })),
  // Meeting Room (1)
  { id: 'meet-1', name: 'ห้องประชุมเอนกประสงค์ 1', type: CourtType.MEETING_ROOM, shareOfGroup: 1, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' }
];

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

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
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

  // FR-4.1: 1 point per 100 THB spent on POS retail/F&B.
  static addPoints(userId: string | undefined, amount: number): number {
    const pointsToAdd = Math.floor(amount / 100);
    if (pointsToAdd <= 0) return 0;
    return this.addLedgerEntry(userId, LedgerEntryType.EARN_PURCHASE, pointsToAdd, 'system', { note: `Purchase of ${amount} THB` });
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
  const court = courts.find(c => c.id === courtId);
  const activeAt = (b: Booking) => b.date === date && b.startTime === hour && b.status !== BookingStatus.CANCELLED;

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
export const PAID_BOOKING_STATUSES: BookingStatus[] = [BookingStatus.CONFIRMED, BookingStatus.COMPLETED, BookingStatus.NO_SHOW];
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
  return d;
}

// The current date and hour at the venue (Asia/Bangkok), whatever the
// browser's own time zone.
export function bangkokNow(): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: parseInt(get('hour'), 10) };
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

// Every booking row of root's group: one checkout's hours share its code,
// owner and date and are paid by one payment (attached to the first row).
// Same rule as the backend's bookingGroup, which also matches owner and date
// so a code collision can never pull in someone else's booking.
// The closure covering `courtId` at `hour` on `date`, if any: an
// all-courts or this-court closure, full day or that hour range. The same
// rule as the server's repository.ClosureFor; every screen uses this one.
export function findClosure(daysOff: DayOff[], date: string, courtId: string, hour: number): DayOff | undefined {
  return daysOff.find(d => d.date === date && (d.courtId === 'all' || d.courtId === courtId) &&
    (d.isFullDay || d.isFullDay === undefined || (d.startHour !== undefined && d.endHour !== undefined && hour >= d.startHour && hour < d.endHour)));
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
export function normalizePromptPayId(id: string): { subTag: string; value: string } {
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
    StorageService.set('users', DEFAULT_USERS);
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
