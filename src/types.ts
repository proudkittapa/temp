export enum CourtType {
  BASKETBALL = 'BASKETBALL',
  BADMINTON = 'BADMINTON',
  PICKLEBALL = 'PICKLEBALL',
  MEETING_ROOM = 'MEETING_ROOM'
}

export enum DayType {
  WEEKDAY = 'WEEKDAY',
  WEEKEND = 'WEEKEND'
}

export enum PriceType {
  NORMAL = 'NORMAL',
  PEAK = 'PEAK',
  OFFPEAK = 'OFFPEAK',
  STUDENT = 'STUDENT',
  MEMBER = 'MEMBER',
  CORPORATE = 'CORPORATE'
}

export enum UserRole {
  ADMIN = 'ADMIN',
  MANAGER = 'MANAGER',
  STAFF = 'STAFF',
  CUSTOMER = 'CUSTOMER'
}

export enum MemberType {
  NORMAL = 'NORMAL',
  STUDENT = 'STUDENT',
  MEMBER = 'MEMBER',
  CORPORATE = 'CORPORATE'
}

export enum BookingStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
  NO_SHOW = 'NO_SHOW'
}

export enum PaymentMethod {
  PROMPTPAY = 'PROMPTPAY',
  CASH = 'CASH'
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  SLIP_UPLOADED = 'SLIP_UPLOADED',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
  REFUNDED = 'REFUNDED'
}

export enum OrderType {
  FB = 'FB',
  EQUIPMENT_RENT = 'EQUIPMENT_RENT',
  EQUIPMENT_SALE = 'EQUIPMENT_SALE'
}

export enum OrderStatus {
  PENDING = 'PENDING',
  PREPARING = 'PREPARING',
  READY = 'READY',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED'
}

export enum ProductCat {
  FB = 'FB',
  EQUIPMENT = 'EQUIPMENT'
}

export interface Court {
  id: string;
  name: string;
  type: CourtType;
  allowHalf: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface PricingRule {
  id: string;
  courtType: CourtType;
  dayType: DayType;
  startHour: number; // 0-23
  endHour: number; // 0-23
  pricePerHour: number;
  priceType: PriceType;
  label: string;
  isActive: boolean;
}

export interface OperatingHours {
  id: string;
  dayOfWeek: number; // 0-6 (Sun-Sat), 7 for all days override
  openTime: string; // "07:00"
  closeTime: string; // "23:00"
  isClosed: boolean;
}

export interface User {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  lineUserId?: string;
  role: UserRole;
  memberType?: MemberType;
  orgName?: string;
  isActive: boolean;
  createdAt: string;
  password?: string;
  points?: number;
}

export interface Booking {
  id: string;
  bookingCode: string;
  courtId: string;
  userId: string;
  userName: string; // custom helper
  userPhone: string; // custom helper
  date: string; // YYYY-MM-DD
  startTime: string; // "09:00"
  endTime: string; // "10:00"
  isHalfCourt: boolean;
  priceType: PriceType;
  totalAmount: number;
  status: BookingStatus;
  isEventBlock: boolean;
  eventName?: string;
  notes?: string;
  createdAt: string;
  createdBy: string; // userId or 'customer'
  cancellationReason?: string;
}

export interface Payment {
  id: string;
  bookingId: string;
  amount: number;
  method: PaymentMethod;
  status: PaymentStatus;
  slipUrl?: string; // local simulation path or string value
  slipUploadedAt?: string;
  verifiedAt?: string;
  verifiedBy?: string; // name or userId
  refundedAt?: string;
  refundedBy?: string;
  refundReason?: string;
  qrPayload?: string;
  createdAt: string;
}

export interface Product {
  id: string;
  name: string;
  category: ProductCat;
  subCategory?: string; // "drink", "snack", "food", "racket", "shoes"
  price: number;
  isRental: boolean;
  stock: number;
  isActive: boolean;
}

export interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  qty: number;
  unitPrice: number;
  returnedAt?: string; // for rental
  shoeSize?: string;    // shoe size control (e.g., "38")
  shoeGender?: 'M' | 'F'; // 'M' for Male, 'F' for Female
}

export interface Order {
  id: string;
  orderCode: string;
  userId?: string;
  customerName: string; // walkin or customer name
  courtId?: string; // reference to court
  type: OrderType;
  status: OrderStatus;
  totalAmount: number;
  paidAmount: number;
  paymentMethod?: PaymentMethod;
  createdAt: string;
  createdBy: string; // staff or manager id
  items: OrderItem[];
}

export interface AuditLog {
  id: string;
  userId: string;
  userName: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: any;
  after?: any;
  createdAt: string;
}

// Simulated LINE API Msg
export interface LineMessage {
  id: string;
  timestamp: string;
  recipientPhone: string;
  recipientName: string;
  text: string;
  type: "CREATED" | "CONFIRMED" | "REMINDER" | "CANCELLED";
}

export interface DayOff {
  id: string;
  date: string; // YYYY-MM-DD
  courtId: string; // "all" or courtId
  reason: string;
  isFullDay?: boolean; // if true or undefined, closed all day
  startHour?: number;   // closed starting this hour (e.g., 9)
  endHour?: number;     // closed ending this hour (e.g., 12)
}

export interface MemberDiscountRule {
  id: MemberType;
  name: string;
  discountPercent: number;
  isActive: boolean;
}


