// Client for the Go backend (golang-backend/). The app runs in one of two
// data modes, picked at build time:
//
//   VITE_DATA_SOURCE=local (default) - everything lives in localStorage via
//     StorageService in mockData.ts; no backend needed.
//   VITE_DATA_SOURCE=api - customer login/registration, court availability,
//     bookings, slip upload, staff walk-in bookings and the staff
//     slip-review queue go through the Go API + Postgres. Features the
//     backend doesn't cover yet (POS, admin settings, rewards, ...) still
//     use localStorage.
//
// VITE_API_BASE_URL defaults to "/api/v1", which Vite's dev server proxies
// to the backend on :8080 (see vite.config.ts).
import {
  Booking, BookingStatus, Court, CourtType, MemberType, Payment, PaymentMethod,
  PaymentStatus, PriceType, User, UserRole
} from './types';

export const USE_BACKEND = import.meta.env.VITE_DATA_SOURCE === 'api';
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL || '/api/v1';

// The role switcher lets one browser act as a customer and as staff, so
// each side keeps its own login instead of sharing one token.
export type SessionKind = 'customer' | 'staff';

interface StoredSession {
  token: string;
  user: User;
}

const sessionKey = (kind: SessionKind) => `sports_complex_api_session_${kind}`;

export function getSession(kind: SessionKind): StoredSession | null {
  try {
    const raw = localStorage.getItem(sessionKey(kind));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(kind: SessionKind, session: StoredSession | null) {
  try {
    if (session) localStorage.setItem(sessionKey(kind), JSON.stringify(session));
    else localStorage.removeItem(sessionKey(kind));
  } catch (e) {
    console.error(e);
  }
}

export function logout(kind: SessionKind) {
  saveSession(kind, null);
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; form?: FormData; session?: SessionKind } = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = opts.session ? getSession(opts.session)?.token : undefined;
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { method: opts.method || 'GET', headers, body });
  } catch {
    throw new ApiError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (is the Go backend running on :8080?)', 0);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    // An expired/invalid token: drop it so the UI falls back to logged-out.
    if (res.status === 401 && opts.session && token) saveSession(opts.session, null);
    throw new ApiError(json.error || `Request failed (${res.status})`, res.status);
  }
  return json.data as T;
}

// Resolves a server-relative path like "/uploads/slips/x.png" against the
// API's origin, so slip images load whether or not the Vite proxy is used.
export function assetUrl(path?: string): string | undefined {
  if (!path || /^https?:/.test(path)) return path;
  try {
    return new URL(path, new URL(API_BASE_URL, window.location.href)).toString();
  } catch {
    return path;
  }
}

// ---- wire types (snake_case, as the Go structs serialize) and mappers ----

interface ApiUser {
  id: string; name: string; email?: string; phone: string; role: string;
  member_type: string; org_name?: string; is_active: boolean; points: number; created_at: string;
}
interface ApiCourt {
  id: string; name: string; type: string; mutex_group_id?: string; share_of_group: number;
  off_peak_only: boolean; is_active: boolean; created_at: string;
}
interface ApiBooking {
  id: string; booking_code: string; court_id: string; user_id: string; date: string;
  customer_name?: string; customer_phone?: string;
  start_time: string; end_time: string; is_half_court: boolean; price_type: string;
  total_amount: number; status: string; is_event_block: boolean; event_name?: string;
  notes?: string; created_by: string; cancellation_reason?: string; created_at: string;
}
interface ApiPayment {
  id: string; booking_id: string; amount: number; method: string; status: string;
  slip_url?: string; slip_uploaded_at?: string; verified_at?: string; verified_by?: string;
  refunded_at?: string; refunded_by?: string; refund_reason?: string; qr_payload?: string; created_at: string;
}

const toUser = (u: ApiUser): User => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role as UserRole,
  memberType: u.member_type as MemberType,
  orgName: u.org_name,
  isActive: u.is_active,
  points: u.points,
  createdAt: u.created_at
});

const toCourt = (c: ApiCourt): Court => ({
  id: c.id,
  name: c.name,
  type: c.type as CourtType,
  mutexGroupId: c.mutex_group_id,
  shareOfGroup: c.share_of_group,
  offPeakOnly: c.off_peak_only,
  isActive: c.is_active,
  createdAt: c.created_at
});

// Other customers' bookings arrive anonymized (no id/code/user) - enough to
// mark the slot taken. They get a synthetic id so lists can still key them.
const toBooking = (b: ApiBooking, user?: { name: string; phone: string }): Booking => ({
  id: b.id || `taken-${b.court_id}-${b.date.slice(0, 10)}-${b.start_time}`,
  bookingCode: b.booking_code,
  courtId: b.court_id,
  userId: b.user_id,
  userName: user?.name || b.customer_name || '',
  userPhone: user?.phone || b.customer_phone || '',
  date: b.date.slice(0, 10),
  startTime: b.start_time,
  endTime: b.end_time,
  isHalfCourt: b.is_half_court,
  priceType: b.price_type as PriceType,
  totalAmount: b.total_amount,
  status: b.status as BookingStatus,
  isEventBlock: b.is_event_block,
  eventName: b.event_name,
  notes: b.notes,
  createdAt: b.created_at,
  createdBy: b.created_by,
  cancellationReason: b.cancellation_reason
});

const toPayment = (p: ApiPayment): Payment => ({
  id: p.id,
  bookingId: p.booking_id,
  amount: p.amount,
  method: p.method as PaymentMethod,
  status: p.status as PaymentStatus,
  slipUrl: assetUrl(p.slip_url),
  slipUploadedAt: p.slip_uploaded_at,
  verifiedAt: p.verified_at,
  verifiedBy: p.verified_by,
  refundedAt: p.refunded_at,
  refundedBy: p.refunded_by,
  refundReason: p.refund_reason,
  qrPayload: p.qr_payload,
  createdAt: p.created_at
});

// ---- auth ----

export async function login(kind: SessionKind, identity: string, password: string): Promise<User> {
  const data = await request<{ token: string; user: ApiUser }>('/auth/login', {
    method: 'POST',
    body: { identity, password }
  });
  const user = toUser(data.user);
  saveSession(kind, { token: data.token, user });
  return user;
}

export async function register(input: { name: string; email: string; phone: string; password: string }): Promise<User> {
  const data = await request<{ token: string; user: ApiUser }>('/auth/register', { method: 'POST', body: input });
  const user = toUser(data.user);
  saveSession('customer', { token: data.token, user });
  return user;
}

// Re-reads the logged-in user (e.g. for a fresh points balance) and updates
// the stored session. Returns null if not logged in, or if the session is
// no longer valid (expired, suspended, or - for staff - no longer a staff
// role); request() has already dropped the stored session in that case.
export async function refreshMe(kind: SessionKind): Promise<User | null> {
  const session = getSession(kind);
  if (!session) return null;
  try {
    const user = toUser(await request<ApiUser>('/auth/me', { session: kind }));
    saveSession(kind, { ...session, user });
    return user;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    return session.user; // backend unreachable: keep showing the cached user
  }
}

// ---- courts & bookings ----

// Sorted by id with numeric awareness (bad-2 before bad-10), matching the
// order of the local seed data rather than the backend's name order.
export async function listCourts(): Promise<Court[]> {
  return (await request<ApiCourt[]>('/courts'))
    .map(c => toCourt(c))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

// Every active booking on a date. For customers, other people's bookings
// come back anonymized; staff (kind 'staff') see everything incl. names.
export async function listBookingsByDate(date: string, kind: SessionKind = 'customer'): Promise<Booking[]> {
  return (await request<ApiBooking[]>(`/bookings?date=${encodeURIComponent(date)}`, { session: kind })).map(b => toBooking(b));
}

export async function listMyBookings(): Promise<{ bookings: Booking[]; payments: Payment[] }> {
  const me = getSession('customer')?.user;
  const rows = await request<(ApiBooking & { payment?: ApiPayment })[]>('/me/bookings', { session: 'customer' });
  return {
    bookings: rows.map(r => toBooking(r, me ? { name: me.name, phone: me.phone || '' } : undefined)),
    payments: rows.filter(r => r.payment).map(r => toPayment(r.payment!))
  };
}

export interface CreatedBookingGroup {
  bookingCode: string;
  totalAmount: number;
  promptPayPayload: string;
  bookings: Booking[];
  payment: Payment;
}

// Books all slots as one group with one payment; the server prices them
// (member discount, half-court rate) and rejects the whole request if any
// slot is taken.
export async function createBookings(date: string, slots: { courtId: string; startTime: string }[]): Promise<CreatedBookingGroup> {
  const me = getSession('customer')?.user;
  const data = await request<{
    booking_code: string; total_amount: number; promptpay_payload: string; bookings: ApiBooking[]; payment: ApiPayment;
  }>('/bookings', {
    method: 'POST',
    session: 'customer',
    body: { date, slots: slots.map(s => ({ court_id: s.courtId, start_time: s.startTime })) }
  });
  return {
    bookingCode: data.booking_code,
    totalAmount: data.total_amount,
    promptPayPayload: data.promptpay_payload,
    bookings: data.bookings.map(b => toBooking(b, me ? { name: me.name, phone: me.phone || '' } : undefined)),
    payment: toPayment(data.payment)
  };
}

export async function uploadSlip(bookingId: string, file: Blob, filename = 'slip.jpg'): Promise<void> {
  const form = new FormData();
  form.append('slip', file, filename);
  await request(`/bookings/${encodeURIComponent(bookingId)}/upload-slip`, { method: 'POST', form, session: 'customer' });
}

// ---- staff walk-ins ----

export interface WalkInInput {
  date: string;
  slots: { courtId: string; startTime: string }[];
  customerName: string;
  customerPhone: string;
  paymentMethod: PaymentMethod;
  // Staff confirmed booking through a day-off/maintenance block.
  overrideClosure?: boolean;
}

// Books a counter walk-in, paid on the spot (confirmed immediately). Goes
// through the same availability checks as online bookings, and is credited
// to the registered customer with that phone, if any.
export async function createWalkInBooking(input: WalkInInput): Promise<CreatedBookingGroup & { pointsAwarded: number }> {
  const data = await request<{
    booking_code: string; total_amount: number; promptpay_payload: string; points_awarded: number;
    bookings: ApiBooking[]; payment: ApiPayment;
  }>('/staff/bookings', {
    method: 'POST',
    session: 'staff',
    body: {
      date: input.date,
      slots: input.slots.map(s => ({ court_id: s.courtId, start_time: s.startTime })),
      customer_name: input.customerName,
      customer_phone: input.customerPhone,
      payment_method: input.paymentMethod,
      override_closure: !!input.overrideClosure
    }
  });
  return {
    bookingCode: data.booking_code,
    totalAmount: data.total_amount,
    promptPayPayload: data.promptpay_payload,
    pointsAwarded: data.points_awarded,
    bookings: data.bookings.map(b => toBooking(b)),
    payment: toPayment(data.payment)
  };
}

// ---- staff slip review (FR-3.3) ----

export interface PaymentForReview {
  payment: Payment;
  bookings: Booking[];
}

export async function listPaymentsForReview(status: PaymentStatus = PaymentStatus.SLIP_UPLOADED): Promise<PaymentForReview[]> {
  const rows = await request<{ payment: ApiPayment; bookings: ApiBooking[]; user_name: string; user_phone: string }[]>(
    `/staff/payments?status=${status}`,
    { session: 'staff' }
  );
  return rows.map(r => ({
    payment: toPayment(r.payment),
    bookings: r.bookings.map(b => toBooking(b, { name: r.user_name, phone: r.user_phone }))
  }));
}

export interface ReviewResult {
  bookingCode: string;
  bookingsCount: number;
  pointsAwarded: number;
}

export async function verifyPayment(paymentId: string): Promise<ReviewResult> {
  const r = await request<{ booking_code: string; bookings_count: number; points_awarded: number }>(
    `/staff/payments/${encodeURIComponent(paymentId)}/verify`,
    { method: 'POST', session: 'staff' }
  );
  return { bookingCode: r.booking_code, bookingsCount: r.bookings_count, pointsAwarded: r.points_awarded };
}

export async function rejectPayment(paymentId: string, reason: string): Promise<ReviewResult> {
  const r = await request<{ booking_code: string; bookings_count: number; points_awarded: number }>(
    `/staff/payments/${encodeURIComponent(paymentId)}/reject`,
    { method: 'POST', session: 'staff', body: { reason } }
  );
  return { bookingCode: r.booking_code, bookingsCount: r.bookings_count, pointsAwarded: r.points_awarded };
}
