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
  CASH = 'CASH',
  // A free off-peak hour paid with a loyalty reward voucher (0 THB).
  VOUCHER = 'VOUCHER'
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  SLIP_UPLOADED = 'SLIP_UPLOADED',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
  REFUNDED = 'REFUNDED',
  // No slip within the payment hold: the booking was cancelled, but a slip
  // can still be sent if the customer did pay (late payment).
  EXPIRED = 'EXPIRED'
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
  // Courts that share a mutexGroupId are mutually exclusive: an active booking
  // on any court in the group blocks every other court in that group for the
  // overlapping time range (e.g. one physical basketball court exposed as a
  // full-court booking option plus two half-court sides). Leave undefined for
  // a standalone court with no shared-resource siblings.
  mutexGroupId?: string;
  // Fraction of the mutex group's physical resource this court represents.
  // 1 = the whole resource (or a standalone court). Less than 1 marks a
  // sub-allocation (e.g. 0.5 for a half-court side) and is what the pricing
  // engine checks to apply PricingConfig.halfCourtRatePercent - it does NOT
  // by itself imply a 50% price cut, since the business's half-court rate is
  // an independently configurable percentage.
  shareOfGroup: number;
  // True if this court may only be booked during off-peak hours (FR-1.2).
  offPeakOnly?: boolean;
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

// Single source of truth for business coefficients that used to be duplicated
// as magic numbers across mockData.ts and the Go backend plan (and had drifted
// out of sync between them). Anything here should be read, never re-literaled.
export interface PricingConfig {
  id: 'global';
  // Half-court rate as a percent of the full-court rate, applied BEFORE
  // membership discounts (FR-2.4). Independent of Court.shareOfGroup, which
  // only describes physical proportion for mutex/display purposes.
  halfCourtRatePercent: number;
  // How many days ahead customers may book online (staff aren't limited).
  maxAdvanceDays?: number;
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
  // Cached running balance for fast reads. This is a derived total of the
  // user's PointsLedgerEntry rows, not an independently-editable value -
  // every mutation must go through StorageService.addLedgerEntry so the
  // balance and the ledger never disagree.
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
  // Snapshot of (court.shareOfGroup < 1) at booking time, kept on the record
  // for historical/receipt display even if the court's configuration later
  // changes. Availability and pricing must read the live Court, never this.
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
  // Money returned so far; REFUNDED once it covers `amount`.
  refundAmount?: number;
  // Set when the payment hold ran out; still set after a late slip arrives.
  expiredAt?: string;
  qrPayload?: string;
  createdAt: string;
}

// A sellable/rentable unit tracked separately from its parent Product, e.g.
// one shoe size+gender combination. Needed because stock for rental gear must
// be checked and decremented per variant, not against one aggregate counter -
// otherwise two customers can both be told "in stock" for the last size-42
// pair while a size-38 pair sits unused.
export interface ProductVariant {
  id: string;
  productId: string;
  label: string; // e.g. shoe size "42", or "Standard" for a one-size item
  gender?: 'M' | 'F' | 'U';
  stock: number;
}

export interface Product {
  id: string;
  name: string;
  category: ProductCat;
  subCategory?: string; // "drink", "snack", "food", "racket", "shoes"
  price: number;
  isRental: boolean;
  // Authoritative stock count ONLY when `variants` is absent. When variants
  // are present (e.g. sized rentals), this is a cached sum of their stock for
  // quick display - the variants are what checkout must actually decrement.
  stock: number;
  variants?: ProductVariant[];
  isActive: boolean;
}

export interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  variantId?: string; // set when productId resolves to a Product with `variants`
  qty: number;
  unitPrice: number;
  returnedAt?: string; // for rental
  shoeSize?: string;    // display copy of the variant label at time of sale
  shoeGender?: 'M' | 'F'; // display copy of the variant gender at time of sale
  productName?: string;   // display copy from the server (the product may be inactive now)
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
  targetType: 'Booking' | 'Payment' | 'Order' | 'Court' | 'PricingRule' | 'PricingConfig' | 'User' | 'Product' | 'DayOff' | 'Shift' | 'Report';
  targetId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  // Required by FR-6.3/FR-7.3 for cancellations, refunds, manual point
  // adjustments and price/schedule overrides - the caller must supply it for
  // those actions rather than leaving the justification implicit in `after`.
  reason?: string;
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

export enum LedgerEntryType {
  EARN_BOOKING = 'EARN_BOOKING',
  EARN_PURCHASE = 'EARN_PURCHASE',
  REDEEM = 'REDEEM',
  ADJUST_MANUAL = 'ADJUST_MANUAL',
  REVERSE_BOOKING = 'REVERSE_BOOKING'
}

// Append-only loyalty history (FR-4.1/FR-4.3, AC-6/AC-7). User.points is a
// cached sum of these entries; the ledger is what makes accrual/redemption
// auditable and lets a manual point adjustment be traced back to an actor.
export interface PointsLedgerEntry {
  id: string;
  userId: string;
  type: LedgerEntryType;
  points: number; // signed: positive for earn, negative for redeem/adjustment
  refType?: 'Booking' | 'Order' | 'Voucher';
  refId?: string;
  note?: string;
  createdAt: string;
  createdBy: string; // userId of actor ('system' for automatic accrual)
}

// Rewards catalog (FR-4.2) - kept separate from Voucher so the catalog can be
// edited without touching redemption history.
export interface RewardCatalogItem {
  id: string;
  name: string;
  emoji: string;
  pointsCost: number;
  isActive: boolean;
}

export enum VoucherStatus {
  ACTIVE = 'ACTIVE',
  REDEEMED = 'REDEEMED',
  EXPIRED = 'EXPIRED'
}

// A claimed reward (FR-4.3): created when a customer redeems points, then
// looked up by `code` at the counter and marked REDEEMED on dispense.
export interface Voucher {
  id: string;
  code: string; // "RW-XXXXXX"
  userId: string;
  rewardId: string;
  pointsSpent: number;
  status: VoucherStatus;
  createdAt: string;
  dispensedAt?: string;
  dispensedBy?: string; // staff userId
}

// Front-desk cash drawer session (FR-6). Cash totals are computed from
// Bookings/Orders paid by CASH within [openedAt, closedAt), not re-entered by
// staff, so the variance calculation has a single source of truth.
export interface Shift {
  id: string;
  staffId: string;
  staffName: string;
  openedAt: string;
  openingFloat: number;
  closedAt?: string;
  countedCash?: number;
  expectedCash?: number; // openingFloat + cash bookings + cash retail in-period
  varianceCash?: number; // countedCash - expectedCash
  notes?: string;
}

