import {
  Court,
  CourtType,
  PricingRule,
  DayType,
  PriceType,
  OperatingHours,
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
  OrderItem,
  MemberDiscountRule
} from './types';

// Default initial seeds
const DEFAULT_COURTS: Court[] = [
  // Basketball (3 courts)
  { id: 'b_full_a', name: 'สนามบาสเกตบอล A (เต็มสนาม)', type: CourtType.BASKETBALL, allowHalf: false, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'b_half_b', name: 'สนามบาสเกตบอล B (ครึ่งสนาม: ซ้าย)', type: CourtType.BASKETBALL, allowHalf: false, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'b_half_c', name: 'สนามบาสเกตบอล C (ครึ่งสนาม: ขวา)', type: CourtType.BASKETBALL, allowHalf: false, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
  // Badminton (12 courts)
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `bad-${i + 1}`,
    name: `สนามแบดมินตัน ${i + 1}`,
    type: CourtType.BADMINTON,
    allowHalf: false,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z'
  })),
  // Pickleball (3 courts)
  ...Array.from({ length: 3 }, (_, i) => ({
    id: `pick-${i + 1}`,
    name: `สนามพิคเคิลบอล ${i + 1}`,
    type: CourtType.PICKLEBALL,
    allowHalf: false,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z'
  })),
  // Meeting Room (1)
  { id: 'meet-1', name: 'ห้องประชุมเอนกประสงค์ 1', type: CourtType.MEETING_ROOM, allowHalf: false, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' }
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

const DEFAULT_OPERATING_HOURS: OperatingHours[] = [
  ...Array.from({ length: 7 }, (_, i) => ({
    id: `op-${i}`,
    dayOfWeek: i,
    openTime: '07:00',
    closeTime: '23:00',
    isClosed: false
  }))
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
  { id: 'pd-9', name: 'เช่ารองเท้ากีฬาคุณภาพ (ต่อครั้ง)', category: ProductCat.EQUIPMENT, subCategory: 'shoes', price: 80, isRental: true, stock: 8, isActive: true }
];

const DEFAULT_USERS: User[] = [
  { id: 'u-admin', name: 'สมชาย ผู้บริหาร', email: 'admin@sportscomplex.com', phone: '0812345678', role: UserRole.ADMIN, isActive: true, createdAt: '2026-01-01', password: '123456' },
  { id: 'u-mgr-1', name: 'วิชัย ผู้จัดการ', email: 'manager@sportscomplex.com', phone: '0823456789', role: UserRole.MANAGER, isActive: true, createdAt: '2026-01-02', password: '123456' },
  { id: 'u-staff-1', name: 'กิตติ สตาฟเวรเช้า', email: 'staff1@sportscomplex.com', phone: '0834567890', role: UserRole.STAFF, isActive: true, createdAt: '2026-01-03', password: '123456' },
  { id: 'u-cust-mbr', name: 'ประเสริฐ รักกีฬา (สมาชิกร้าน)', email: 'prasert@gmail.com', phone: '0845678901', role: UserRole.CUSTOMER, memberType: MemberType.MEMBER, isActive: true, createdAt: '2026-02-10', password: '123456' },
  { id: 'u-cust-std', name: 'น้องพีเดอร์ นักเรียน', email: 'student@school.ac.th', phone: '0856789012', role: UserRole.CUSTOMER, memberType: MemberType.STUDENT, isActive: true, createdAt: '2026-02-12', password: '123456' }
];

// Helper to format date with current timezone
export const getTodayDateStr = () => {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const adjusted = new Date(d.getTime() - (offset * 60 * 1000));
  return adjusted.toISOString().split('T')[0];
};

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

const DEFAULT_PAYMENTS = (): Payment[] => [
  {
    id: "pay-1",
    bookingId: "bk-1",
    amount: 300,
    method: PaymentMethod.PROMPTPAY,
    status: PaymentStatus.VERIFIED,
    slipUrl: "https://images.unsplash.com/photo-1628157582853-a796fa650a6a?w=150",
    slipUploadedAt: "2026-06-17T08:05:00.000Z",
    verifiedAt: "2026-06-17T08:10:00.000Z",
    verifiedBy: "u-staff-1",
    createdAt: "2026-06-17T08:00:00.000Z"
  },
  {
    id: "pay-2",
    bookingId: "bk-2",
    amount: 250,
    method: PaymentMethod.PROMPTPAY,
    status: PaymentStatus.PENDING,
    qrPayload: "00020101021130340016A000000677010111011300668123456785802TH5406250.006304ABCD",
    createdAt: "2026-06-17T08:15:00.000Z"
  }
];

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

export const DEFAULT_MEMBER_DISCOUNTS: MemberDiscountRule[] = [
  { id: MemberType.NORMAL, name: 'ลูกค้าทั่วไป', discountPercent: 0, isActive: true },
  { id: MemberType.MEMBER, name: 'สมาชิกร้านทั่วไป', discountPercent: 10, isActive: true },
  { id: MemberType.STUDENT, name: 'สิทธิ์นักเรียนนักศึกษาเยาวชน', discountPercent: 20, isActive: true },
  { id: MemberType.CORPORATE, name: 'องค์กรพันธมิตรร่วม MOU', discountPercent: 15, isActive: true },
];

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

  static addPoints(userId: string | undefined, amount: number): number {
    if (!userId) return 0;
    const pointsToAdd = Math.floor(amount / 100);
    if (pointsToAdd <= 0) return 0;

    const users = this.get<User[]>('users', []);
    let pointsAwarded = 0;
    const updatedUsers = users.map(user => {
      if (user.id === userId) {
        const currentPoints = user.points || 0;
        const newPoints = currentPoints + pointsToAdd;
        pointsAwarded = pointsToAdd;
        return { ...user, points: newPoints };
      }
      return user;
    });

    if (pointsAwarded > 0) {
      this.set('users', updatedUsers);
      
      const currentCust = this.get<User | null>('current_logged_in_customer', null);
      if (currentCust && currentCust.id === userId) {
        currentCust.points = (currentCust.points || 0) + pointsAwarded;
        this.set('current_logged_in_customer', currentCust);
      }
    }
    return pointsAwarded;
  }

  static addPointsHour(userId: string | undefined, hours: number): number {
    if (!userId || hours <= 0) return 0;
    const users = this.get<User[]>('users', []);
    let pointsAwarded = 0;
    const updatedUsers = users.map(user => {
      if (user.id === userId) {
        const currentPoints = user.points || 0;
        const newPoints = currentPoints + hours;
        pointsAwarded = hours;
        return { ...user, points: newPoints };
      }
      return user;
    });

    if (pointsAwarded > 0) {
      this.set('users', updatedUsers);
      
      const currentCust = this.get<User | null>('current_logged_in_customer', null);
      if (currentCust && currentCust.id === userId) {
        currentCust.points = (currentCust.points || 0) + pointsAwarded;
        this.set('current_logged_in_customer', currentCust);
      }
    }
    return pointsAwarded;
  }

  static clear(): void {
    localStorage.clear();
  }
}

// Pricing Helper Calculation
export function getDayType(dateStr: string): DayType {
  const day = new Date(dateStr).getDay();
  return (day === 0 || day === 6) ? DayType.WEEKEND : DayType.WEEKDAY;
}

export function isHourOffPeak(courtType: CourtType, dateStr: string, hourNum: number): boolean {
  const pricingRules = StorageService.get<PricingRule[]>('pricing_rules', DEFAULT_PRICING_RULES);
  const dayType = getDayType(dateStr);
  const rule = pricingRules.find(
    r => r.courtType === courtType &&
         r.dayType === dayType &&
         hourNum >= r.startHour &&
         hourNum < r.endHour &&
         r.isActive
  );
  return rule ? rule.priceType === PriceType.OFFPEAK : true;
}

export function calculatePrice(
  courtType: CourtType,
  dateStr: string,
  startHourStr: string, // e.g., "09:00"
  memberType: MemberType = MemberType.NORMAL,
  isHalfCourt: boolean = false,
  courtId?: string
): { total: number; original: number; priceType: PriceType; discountMessage?: string } {
  const pricingRules = StorageService.get<PricingRule[]>('pricing_rules', DEFAULT_PRICING_RULES);
  const dayType = getDayType(dateStr);
  const hour = parseInt(startHourStr.split(':')[0], 10);

  // 1. Find matching time/day rule
  const rule = pricingRules.find(
    r => r.courtType === courtType &&
         r.dayType === dayType &&
         hour >= r.startHour &&
         hour < r.endHour &&
         r.isActive
  ) || pricingRules.find(r => r.courtType === courtType && r.isActive);

  let basePrice = rule ? rule.pricePerHour : 200;
  const original = basePrice;
  let priceType = rule ? rule.priceType : PriceType.NORMAL;

  // 2. Adjust for Half-Court (Basketball off-peak only, or court b_half_b/c/b1/b2/ครึ่งสนาม)
  const isReallyHalf = isHalfCourt || courtId === 'b_half_b' || courtId === 'b_half_c' || courtId === 'b2';
  if (courtType === CourtType.BASKETBALL && isReallyHalf) {
    basePrice = basePrice * 0.6; // 40% discount for half court (all times)
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

  return {
    total: Math.round(finalPrice),
    original,
    priceType,
    discountMessage
  };
}

// PromptPay QR simulation payload generator
export function generatePromptPayPayload(phoneOrTaxId: string, amount: number): string {
  // Simulate standard PromptPay format
  const amountStr = amount.toFixed(2);
  const lengthCode = amountStr.length.toString().padStart(2, '0');
  return `00020101021130340016A00000067701011101130066${phoneOrTaxId.replace(/[^0-9]/g, '').padStart(10, '0')}5802TH54${lengthCode}${amountStr}6304MOCK`;
}

// Master state initialization
export function initializeState() {
  if (!localStorage.getItem('sports_complex_init')) {
    StorageService.set('courts', DEFAULT_COURTS);
    StorageService.set('pricing_rules', DEFAULT_PRICING_RULES);
    StorageService.set('operating_hours', DEFAULT_OPERATING_HOURS);
    StorageService.set('products', DEFAULT_PRODUCTS);
    StorageService.set('users', DEFAULT_USERS);
    StorageService.set('bookings', DEFAULT_BOOKINGS());
    StorageService.set('payments', DEFAULT_PAYMENTS());
    StorageService.set('orders', DEFAULT_ORDERS());
    StorageService.set('audit_logs', DEFAULT_AUDIT_LOGS());
    StorageService.set('line_messages', DEFAULT_LINE_MESSAGES());
    StorageService.set('member_discounts', DEFAULT_MEMBER_DISCOUNTS);
    StorageService.set('init', 'true');
  } else {
    // Migration check for basketball courts (A, B, C)
    const courts = StorageService.get<Court[]>('courts', []);
    if (!courts.some(c => c.id === 'b_half_b')) {
      const filtered = courts.filter(c => c.type !== CourtType.BASKETBALL);
      filtered.push(
        { id: 'b_full_a', name: 'สนามบาสเกตบอล A (เต็มสนาม)', type: CourtType.BASKETBALL, allowHalf: false, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b_half_b', name: 'สนามบาสเกตบอล B (ครึ่งสนาม: ซ้าย)', type: CourtType.BASKETBALL, allowHalf: false, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b_half_c', name: 'สนามบาสเกตบอล C (ครึ่งสนาม: ขวา)', type: CourtType.BASKETBALL, allowHalf: false, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' }
      );
      StorageService.set('courts', filtered);
    }
    // Migration check for member_discounts
    if (!localStorage.getItem('sports_complex_member_discounts')) {
      StorageService.set('member_discounts', DEFAULT_MEMBER_DISCOUNTS);
    }
  }
}
