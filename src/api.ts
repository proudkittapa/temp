// Client for the Go backend (golang-backend/). The app runs in one of two
// data modes, picked at build time:
//
//   VITE_DATA_SOURCE=local (default) - everything lives in localStorage via
//     StorageService in mockData.ts; no backend needed.
//   VITE_DATA_SOURCE=api - customer login/registration, court availability,
//     bookings, slip upload, staff walk-in bookings, the staff
//     slip-review queue, court closures (days off) and pricing (rules,
//     member discounts, half-court rate) go through the Go API + Postgres. Features the
//     backend doesn't cover yet (POS, admin settings, rewards, ...) still
//     use localStorage.
//
// VITE_API_BASE_URL defaults to "/api/v1", which Vite's dev server proxies
// to the backend on :8080 (see vite.config.ts).
import {
  Booking, BookingStatus, Court, CourtType, DayOff, DayType, MemberDiscountRule, MemberType, Payment,
  PaymentMethod, PaymentStatus, PriceType, PricingConfig, PricingRule, User, UserRole,
  AuditLog, Order, OrderItem, OrderStatus, OrderType, Product, ProductCat, ProductVariant, Shift
} from './types';
import { StorageService } from './mockData';
import { thaiErrorText } from './errorText';

export const USE_BACKEND = import.meta.env.VITE_DATA_SOURCE === 'api';
const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL || '/api/v1';

// One login per browser: customers, counter staff and admins all sign in
// the same way and share one stored session. SessionKind is kept as a label
// on calls (which screen makes them) but every kind reads the same session.
type SessionKind = 'customer' | 'staff' | 'admin';

interface StoredSession {
  token: string;
  user: User;
}

const SESSION_KEY = 'sports_complex_api_session';
// Before there was one login, each screen kept its own session under these
// keys. The first load after the upgrade keeps one of them (staff/admin over
// customer, so a manager isn't silently demoted) and drops the rest.
const LEGACY_SESSION_KEYS = ['admin', 'staff', 'customer'].map(k => `sports_complex_api_session_${k}`);

export function migrateLegacySessions(): void {
  try {
    if (!localStorage.getItem(SESSION_KEY)) {
      const kept = LEGACY_SESSION_KEYS.map(k => localStorage.getItem(k)).find(Boolean);
      if (kept) localStorage.setItem(SESSION_KEY, kept);
    }
    LEGACY_SESSION_KEYS.forEach(k => localStorage.removeItem(k));
  } catch {
    // storage unavailable: nothing to migrate
  }
}

export function getSession(_kind?: SessionKind): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(_kind: SessionKind, session: StoredSession | null) {
  // A retry key belongs to the user who started the action: forget them
  // when someone else signs in or out (not on a refresh of the same login).
  if (getSession()?.user?.id !== session?.user?.id) pendingWrites.clear();
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch (e) {
    console.error(e);
  }
}

// Signs out everywhere (there is one session).
export function logout(_kind?: SessionKind) {
  saveSession('customer', null);
}

// Calls back when another tab signs in, out, or as someone else (the token
// changes). Re-saving the same session - refreshMe does that on every load
// - doesn't count, or two open tabs would keep waking each other.
export function onSessionChangedElsewhere(cb: (kind: SessionKind) => void): () => void {
  const token = (raw: string | null) => {
    try { return raw ? (JSON.parse(raw) as StoredSession).token : null; } catch { return null; }
  };
  const handler = (e: StorageEvent) => {
    if (e.key === SESSION_KEY && token(e.oldValue) !== token(e.newValue)) cb('customer');
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

// message is in Thai for the screens (see errorText.ts); serverMessage keeps
// the backend's own English text.
export class ApiError extends Error {
  readonly serverMessage: string;
  constructor(message: string, readonly status: number) {
    super(thaiErrorText(message));
    this.serverMessage = message;
  }
}

// Retry safety: every write (not sign-in, not file uploads) carries an
// Idempotency-Key. The same action sent again - same endpoint, same body,
// e.g. staff pressing "confirm" again after a dropped connection - reuses
// its key, so the server answers from the first attempt instead of selling,
// booking or refunding twice. The key is dropped once the action succeeds,
// so an identical action later is a new one.
// An entry lives at most RETRY_WINDOW_MS: after that the same body is a new
// action (e.g. the next customer buying the same thing), not a retry.
const pendingWrites = new Map<string, { body: string; key: string; at: number }>();
const RETRY_WINDOW_MS = 2 * 60 * 1000;
const newIdempotencyKey = () => typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

const READ_TIMEOUT_MS = 20000;

async function request<T>(
  path: string,
  // withMeta: resolve to the whole body ({ data, has_more, ... }), not just data.
  opts: { method?: string; body?: unknown; form?: FormData; session?: SessionKind; withMeta?: boolean } = {}
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
  const method = opts.method || 'GET';
  const writeScope = method !== 'GET' && !opts.form && !path.startsWith('/auth') ? `${method} ${path}` : '';
  if (writeScope) {
    const sent = typeof body === 'string' ? body : '';
    let pending = pendingWrites.get(writeScope);
    if (!pending || pending.body !== sent || Date.now() - pending.at > RETRY_WINDOW_MS) {
      pending = { body: sent, key: newIdempotencyKey(), at: Date.now() };
      pendingWrites.set(writeScope, pending);
    }
    headers['Idempotency-Key'] = pending.key;
  }

  // Reads give up after READ_TIMEOUT_MS: the screens skip a refresh while
  // one is still running, so a request stuck on a dead connection (minutes
  // of TCP retries) would otherwise freeze them with no error shown.
  // Writes are left to finish - their outcome matters, and a retry reuses
  // the Idempotency-Key.
  const abort = method === 'GET' ? new AbortController() : undefined;
  const timer = abort ? setTimeout(() => abort.abort(), READ_TIMEOUT_MS) : undefined;
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { method, headers, body, signal: abort?.signal });
  } catch {
    if (abort?.signal.aborted) throw new ApiError('เซิร์ฟเวอร์ตอบช้าเกินไป กรุณาลองใหม่', 0);
    throw new ApiError(import.meta.env.DEV
      ? 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (is the Go backend running on :8080?)'
      : 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่', 0);
  }
  let json: { success?: boolean; error?: string; data?: unknown } | null = null;
  try { json = await res.json(); } catch { /* not JSON (or timed out) - handled below */ }
  clearTimeout(timer);
  if (abort?.signal.aborted && !json) throw new ApiError('เซิร์ฟเวอร์ตอบช้าเกินไป กรุณาลองใหม่', 0);
  if (!res.ok || !json || json.success === false) {
    // An expired/invalid token: drop it so the UI falls back to logged-out -
    // unless the stored session is already a newer one (signed in again,
    // maybe in another tab, while this request was out).
    if (res.status === 401 && opts.session && token && getSession(opts.session)?.token === token) saveSession(opts.session, null);
    // The server refused the key itself: don't send it again.
    if (writeScope && res.status === 422) pendingWrites.delete(writeScope);
    // No JSON at all (e.g. a proxy's HTML error page on a 200).
    throw new ApiError(json?.error || (json ? `Request failed (${res.status})` : 'เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง กรุณาลองใหม่'), res.status);
  }
  if (writeScope && pendingWrites.get(writeScope)?.key === headers['Idempotency-Key']) pendingWrites.delete(writeScope);
  return (opts.withMeta ? json : json.data) as T;
}

// Resolves a server-relative path like "/api/v1/slips/x.png?exp=..&sig=.."
// (a signed slip link) against the API's origin, so slip images load
// whether or not the Vite proxy is used.
function assetUrl(path?: string): string | undefined {
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
  permissions?: string[]; // /auth/me only
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
  notes?: string; created_by: string; cancellation_reason?: string; resale_of?: string; created_at: string;
  payment?: { method: string; status: string; verified_at?: string; verified_by_name?: string }; // staff date list: the group's payment
}
interface ApiPayment {
  id: string; booking_id: string; amount: number; method: string; status: string;
  slip_url?: string; slip_uploaded_at?: string; verified_at?: string; verified_by?: string;
  refunded_at?: string; refunded_by?: string; refund_reason?: string; qr_payload?: string; created_at: string;
  refund_amount?: number; expired_at?: string;
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
  createdAt: u.created_at,
  permissions: u.permissions
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
  cancellationReason: b.cancellation_reason, resaleOf: b.resale_of,
  paymentMethod: b.payment?.method as PaymentMethod | undefined,
  paymentStatus: b.payment?.status as PaymentStatus | undefined,
  paymentVerifiedAt: b.payment?.verified_at,
  paymentVerifiedByName: b.payment?.verified_by_name
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
  refundAmount: p.refund_amount,
  expiredAt: p.expired_at,
  qrPayload: p.qr_payload,
  createdAt: p.created_at
});

// ---- auth ----

export async function login(kind: SessionKind, identity: string, password: string): Promise<User> {
  const data = await request<{ token: string; user: ApiUser }>('/auth/login', {
    method: 'POST',
    body: { identity, password }
  });
  saveSession(kind, { token: data.token, user: toUser(data.user) });
  // The login response has no permissions; /auth/me does, and the screens
  // use them to decide what to show.
  return (await refreshMe(kind)) ?? toUser(data.user);
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
    // Signed out, or someone else signed in (another tab, the next staff
    // member at a shared counter), while this was in flight: writing the
    // old session back would undo that. The screens poll this every few
    // seconds, so the window is real.
    if (getSession(kind)?.token !== session.token) return getSession(kind)?.user ?? null;
    saveSession(kind, { ...session, user });
    return user;
  } catch (e) {
    // Checked first: a 401 for the old token says nothing about a newer
    // session stored meanwhile.
    if (getSession(kind)?.token !== session.token) return getSession(kind)?.user ?? null;
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

interface CreatedBookingGroup {
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

// ---- court closures / days off (FR-1.3) ----

interface ApiDayOff {
  id: string; date: string; court_id?: string | null; reason: string;
  is_full_day: boolean; start_hour?: number | null; end_hour?: number | null;
}

const toDayOff = (d: ApiDayOff): DayOff => ({
  id: d.id,
  date: d.date.slice(0, 10),
  courtId: d.court_id || 'all',
  reason: d.reason,
  isFullDay: d.is_full_day,
  startHour: d.start_hour ?? undefined,
  endHour: d.end_hour ?? undefined
});

// Closures with from <= date <= to (to optional). Public: booking grids use
// it to show closed slots; the server enforces them on every booking.
export async function listDaysOff(from: string, to?: string): Promise<DayOff[]> {
  const q = `from=${encodeURIComponent(from)}${to ? `&to=${encodeURIComponent(to)}` : ''}`;
  return (await request<ApiDayOff[]>(`/days-off?${q}`)).map(toDayOff);
}

// Manager/admin only. Resolves with the closure plus the existing bookings
// it overlaps - those still stand, so staff should contact the customers.
export async function createDayOff(d: Omit<DayOff, 'id'>): Promise<{ dayOff: DayOff; affectedBookings: Booking[] }> {
  const data = await request<{ day_off: ApiDayOff; affected_bookings: ApiBooking[] }>('/admin/days-off', {
    method: 'POST',
    session: 'admin',
    body: {
      date: d.date,
      court_id: d.courtId === 'all' ? null : d.courtId,
      reason: d.reason,
      is_full_day: d.isFullDay !== false,
      start_hour: d.isFullDay === false ? d.startHour : null,
      end_hour: d.isFullDay === false ? d.endHour : null
    }
  });
  return { dayOff: toDayOff(data.day_off), affectedBookings: data.affected_bookings.map(b => toBooking(b)) };
}

export async function deleteDayOff(id: string): Promise<void> {
  await request(`/admin/days-off/${encodeURIComponent(id)}`, { method: 'DELETE', session: 'admin' });
}

// ---- pricing (FR-2) ----

interface ApiPricingRule {
  id: string; court_type: string; day_type: string; start_hour: number; end_hour: number;
  price_per_hour: number; price_type: string; label: string; is_active: boolean;
}
interface ApiMemberDiscount { member_type: string; name: string; discount_percent: number; is_active: boolean }

const toRule = (r: ApiPricingRule): PricingRule => ({
  id: r.id,
  courtType: r.court_type as CourtType,
  dayType: r.day_type as DayType,
  startHour: r.start_hour,
  endHour: r.end_hour,
  pricePerHour: r.price_per_hour,
  priceType: r.price_type as PriceType,
  label: r.label,
  isActive: r.is_active
});

const toDiscount = (d: ApiMemberDiscount): MemberDiscountRule => ({
  id: d.member_type as MemberType,
  name: d.name,
  discountPercent: d.discount_percent,
  isActive: d.is_active
});

interface PricingSnapshot {
  rules: PricingRule[];
  config: PricingConfig;
  memberDiscounts: MemberDiscountRule[];
}

interface ApiPricingConfig {
  half_court_rate_percent: number; max_advance_days: number; open_hour?: number; close_hour?: number;
  business_name?: string; business_address?: string; business_phone?: string; business_tax_id?: string; vat_registered?: boolean;
}
const toPricingConfig = (c: ApiPricingConfig): PricingConfig => ({
  id: 'global', halfCourtRatePercent: c.half_court_rate_percent, maxAdvanceDays: c.max_advance_days,
  openHour: c.open_hour ?? 7, closeHour: c.close_hour ?? 23,
  businessName: c.business_name || '', businessAddress: c.business_address || '', businessPhone: c.business_phone || '',
  businessTaxId: c.business_tax_id || '', vatRegistered: !!c.vat_registered
});

// Admin: the business on receipts and the payment screen.
export async function updateBusiness(b: { name: string; address: string; phone: string; taxId: string; vatRegistered: boolean }): Promise<PricingConfig> {
  return toPricingConfig(await request<ApiPricingConfig>('/admin/business', {
    method: 'PUT', session: 'admin',
    body: { business_name: b.name, business_address: b.address, business_phone: b.phone, business_tax_id: b.taxId, vat_registered: b.vatRegistered }
  }));
}

async function getPricing(): Promise<PricingSnapshot> {
  const d = await request<{ rules: ApiPricingRule[]; config: ApiPricingConfig; member_discounts: ApiMemberDiscount[];
    no_show_grace_minutes?: number; no_show_resale_percent?: number; max_hours_per_booking?: number }>('/pricing');
  return {
    rules: d.rules.map(toRule),
    config: { ...toPricingConfig(d.config), noShowGraceMinutes: d.no_show_grace_minutes ?? 15, noShowResalePercent: d.no_show_resale_percent ?? 50,
      maxHoursPerBooking: d.max_hours_per_booking ?? 3 },
    memberDiscounts: d.member_discounts.map(toDiscount)
  };
}

// The UI's price previews (calculatePrice / isHourOffPeak in mockData.ts)
// read pricing from the localStorage keys below. In API mode the server
// is the source of truth and charges from its own tables, so this copies
// the server's pricing into those keys - otherwise an admin's price change
// would alter what customers pay but not what they're shown.
export async function syncPricingCache(): Promise<PricingSnapshot> {
  const snap = await getPricing();
  StorageService.set('pricing_rules', snap.rules);
  StorageService.set('pricing_config', snap.config);
  StorageService.set('member_discounts', snap.memberDiscounts);
  return snap;
}

const ruleBody = (r: Omit<PricingRule, 'id'>) => ({
  court_type: r.courtType, day_type: r.dayType, start_hour: r.startHour, end_hour: r.endHour,
  price_per_hour: r.pricePerHour, price_type: r.priceType, label: r.label, is_active: r.isActive
});

// Admin only. Creates the rule when id is empty, otherwise replaces it.
export async function savePricingRule(rule: PricingRule): Promise<PricingRule> {
  const path = rule.id ? `/admin/pricing-rules/${encodeURIComponent(rule.id)}` : '/admin/pricing-rules';
  return toRule(await request<ApiPricingRule>(path, { method: rule.id ? 'PUT' : 'POST', session: 'admin', body: ruleBody(rule) }));
}

export async function deletePricingRule(id: string): Promise<void> {
  await request(`/admin/pricing-rules/${encodeURIComponent(id)}`, { method: 'DELETE', session: 'admin' });
}

export async function updateMemberDiscount(d: MemberDiscountRule): Promise<void> {
  await request(`/admin/member-discounts/${encodeURIComponent(d.id)}`, {
    method: 'PUT',
    session: 'admin',
    body: { name: d.name, discount_percent: d.discountPercent, is_active: d.isActive }
  });
}

// ---- staff walk-ins ----

interface WalkInInput {
  date: string;
  slots: { courtId: string; startTime: string }[];
  customerName: string;
  customerPhone: string;
  paymentMethod: PaymentMethod;
  // Staff confirmed booking through a day-off/maintenance block.
  overrideClosure?: boolean;
  // With paymentMethod VOUCHER: the free-hour reward voucher paying for it.
  voucherCode?: string;
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
      override_closure: !!input.overrideClosure,
      voucher_code: input.voucherCode || undefined
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

export interface MemberMatch { id: string; name: string; phone: string; memberType: MemberType; points: number }

// Counter staff: customers A-Z, up to 20 - all when q is empty, otherwise
// those whose phone starts with q or whose name contains it.
export async function searchMembers(q: string): Promise<MemberMatch[]> {
  const rows = await request<{ id: string; name: string; phone: string; member_type: string; points: number }[]>(
    `/staff/members?q=${encodeURIComponent(q)}`, { session: 'staff' });
  return rows.map(r => ({ id: r.id, name: r.name, phone: r.phone, memberType: r.member_type as MemberType, points: r.points }));
}

export async function listPaymentsForReview(status: PaymentStatus | 'REFUND_CHECK' = PaymentStatus.SLIP_UPLOADED): Promise<PaymentForReview[]> {
  const rows = await request<{ payment: ApiPayment; bookings: ApiBooking[]; user_name: string; user_phone: string }[]>(
    `/staff/payments?status=${status}`,
    { session: 'staff' }
  );
  return rows.map(r => ({
    payment: toPayment(r.payment),
    bookings: r.bookings.map(b => toBooking(b, { name: r.user_name, phone: r.user_phone }))
  }));
}

// Managers: refunds asked for when cancelling but not recorded, because the
// slip was never approved - waiting for someone to check the bank account.
export async function listRefundChecks(): Promise<PaymentForReview[]> {
  return listPaymentsForReview('REFUND_CHECK');
}

// Managers: close a refund waiting for a bank check - no money from this
// customer arrived, so there is nothing to refund.
export async function dismissRefundCheck(paymentId: string, reason: string): Promise<Payment> {
  return toPayment(await request<ApiPayment>(`/admin/payments/${encodeURIComponent(paymentId)}/no-refund`, {
    method: 'POST', session: 'staff', body: { reason }
  }));
}

interface ReviewResult {
  bookingCode: string;
  bookingsCount: number;
  pointsAwarded: number;
  // The payment arrived after the hold expired and the slots were re-booked.
  late?: boolean;
}

// slipUploadedAt is the payment's slip_uploaded_at as the staff member saw
// it: the server refuses the decision if the customer has replaced the slip
// since (so nobody approves an image they never looked at).
export async function verifyPayment(paymentId: string, slipUploadedAt?: string): Promise<ReviewResult> {
  const r = await request<{ booking_code: string; bookings_count: number; points_awarded: number }>(
    `/staff/payments/${encodeURIComponent(paymentId)}/verify`,
    { method: 'POST', session: 'staff', body: { expected_slip_uploaded_at: slipUploadedAt ?? null } }
  );
  return { bookingCode: r.booking_code, bookingsCount: r.bookings_count, pointsAwarded: r.points_awarded, late: (r as { late?: boolean }).late };
}

export async function rejectPayment(paymentId: string, reason: string, slipUploadedAt?: string): Promise<ReviewResult> {
  const r = await request<{ booking_code: string; bookings_count: number; points_awarded: number }>(
    `/staff/payments/${encodeURIComponent(paymentId)}/reject`,
    { method: 'POST', session: 'staff', body: { reason, expected_slip_uploaded_at: slipUploadedAt ?? null } }
  );
  return { bookingCode: r.booking_code, bookingsCount: r.bookings_count, pointsAwarded: r.points_awarded };
}

// ---- users (Admin panel; manager/admin) ----

// One page of accounts, newest first (the server never sends the whole
// list); search matches part of the name, email or phone.
export async function listUsers(opts: { search?: string; limit?: number } = {}): Promise<{ users: User[]; hasMore: boolean }> {
  const q = new URLSearchParams();
  if (opts.search) q.set('search', opts.search);
  q.set('limit', String(opts.limit ?? 200));
  const r = await request<{ data: ApiUser[]; has_more?: boolean }>(`/admin/users?${q}`, { session: 'admin', withMeta: true });
  return { users: r.data.map(toUser), hasMore: !!r.has_more };
}

// Sets the membership tier the server prices this customer's bookings with.
export async function setMemberType(userId: string, memberType: MemberType): Promise<User> {
  return toUser(await request<ApiUser>(`/admin/users/${encodeURIComponent(userId)}/member-type`, {
    method: 'PUT',
    session: 'admin',
    body: { member_type: memberType }
  }));
}

// Admin only: change a user's role (e.g. make a customer counter staff).
export async function setUserRole(userId: string, role: UserRole): Promise<User> {
  return toUser(await request<ApiUser>(`/admin/users/${encodeURIComponent(userId)}/role`, {
    method: 'PUT', session: 'admin', body: { role }
  }));
}

// ---- roles (permission sets, admin) ----

export interface RoleView {
  id: string;
  name: string;
  permissions: string[];
  isBuiltin: boolean;
  userCount: number;
}

interface ApiRole { id: string; name: string; permissions: string[] | null; is_builtin: boolean; user_count?: number }
const toRole = (r: ApiRole): RoleView => ({ id: r.id, name: r.name, permissions: r.permissions || [], isBuiltin: r.is_builtin, userCount: r.user_count ?? 0 });

export async function listRoles(): Promise<RoleView[]> {
  const d = await request<{ roles: ApiRole[] }>('/admin/roles', { session: 'admin' });
  return d.roles.map(toRole);
}

// Creates the role when id is empty, otherwise renames / re-permissions it.
export async function saveRole(role: { id?: string; name: string; permissions: string[] }): Promise<RoleView> {
  const body = { name: role.name, permissions: role.permissions };
  return toRole(role.id
    ? await request<ApiRole>(`/admin/roles/${encodeURIComponent(role.id)}`, { method: 'PUT', session: 'admin', body })
    : await request<ApiRole>('/admin/roles', { method: 'POST', session: 'admin', body }));
}

export async function deleteRole(id: string): Promise<void> {
  await request(`/admin/roles/${encodeURIComponent(id)}`, { method: 'DELETE', session: 'admin' });
}

// Admin only: suspend or reactivate an account (accounts are never deleted
// through the API, so their booking and points history stays intact).
export async function setUserActive(userId: string, isActive: boolean): Promise<User> {
  return toUser(await request<ApiUser>(`/admin/users/${encodeURIComponent(userId)}/active`, {
    method: 'PUT', session: 'admin', body: { is_active: isActive }
  }));
}

// Manual loyalty points change; the reason is required and audit-logged.
export async function adjustPoints(userId: string, delta: number, reason: string): Promise<number> {
  const r = await request<{ new_balance: number }>(`/admin/users/${encodeURIComponent(userId)}/adjust-points`, {
    method: 'POST',
    session: 'admin',
    body: { points_delta: delta, reason }
  });
  return r.new_balance;
}

// ---- booking lifecycle: cancel / refund / cash / no-show (FR-6.3) ----

interface CancelResult {
  bookingCode: string;
  cancelled: number;
  refundAmount: number;
  pointsReversed: number;
  // A refund was asked for a slip nobody approved: none was recorded.
  refundNeedsCheck: boolean;
  cancelledVouchers: string[]; // rewards cancelled because their points came from these hours
  pointsShort: number; // points spent on a reward already handed over (not taken back)
  paymentStatus: PaymentStatus;
  remainingActive: number;
}

// Manager/admin. bookingId is any hour of the group; bookingIds limits the
// cancellation to those hours. refund records the paid hours as refunded.
// bankChecked: the manager confirmed the money is in the bank account -
// required to refund a slip that was never approved.
export async function cancelBooking(bookingId: string, reason: string, refund: boolean, bookingIds?: string[], session: SessionKind = 'staff', bankChecked = false): Promise<CancelResult> {
  const r = await request<{ booking_code: string; cancelled: number; refund_amount: number; points_reversed: number; payment_status: string; remaining_active: number;
    cancelled_vouchers?: string[]; points_short?: number; refund_needs_check?: boolean }>(
    `/admin/bookings/${encodeURIComponent(bookingId)}/cancel`,
    { method: 'POST', session, body: { reason, refund, booking_ids: bookingIds, bank_checked: bankChecked } }
  );
  return {
    bookingCode: r.booking_code, cancelled: r.cancelled, refundAmount: r.refund_amount,
    pointsReversed: r.points_reversed, paymentStatus: r.payment_status as PaymentStatus, remainingActive: r.remaining_active,
    cancelledVouchers: r.cancelled_vouchers ?? [], pointsShort: r.points_short ?? 0, refundNeedsCheck: !!r.refund_needs_check
  };
}

// Manager/admin: record a refund (e.g. a late payment whose slot was taken).
export async function refundPayment(paymentId: string, reason: string, amount?: number, bankChecked = false): Promise<Payment> {
  return toPayment(await request<ApiPayment>(`/admin/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST', session: 'staff', body: { reason, amount, bank_checked: bankChecked }
  }));
}

// Manager/admin: the customer paid this booking in cash at the counter
// (by any hour of the booking - what the booking grid has).
export async function markBookingPaidInCash(bookingId: string): Promise<ReviewResult> {
  const r = await request<{ booking_code: string; bookings_count: number; points_awarded: number; late?: boolean }>(
    `/admin/bookings/${encodeURIComponent(bookingId)}/mark-cash`, { method: 'POST', session: 'staff' }
  );
  return { bookingCode: r.booking_code, bookingsCount: r.bookings_count, pointsAwarded: r.points_awarded, late: r.late };
}

// Staff: the customer didn't come for this (started) hour.
export async function markNoShow(bookingId: string): Promise<void> {
  await request(`/staff/bookings/${encodeURIComponent(bookingId)}/no-show`, { method: 'POST', session: 'staff' });
}

// The customer came after all: the no-show goes back to confirmed and its
// points are given back. Refused (409) once the hour was sold again.
export async function undoNoShow(bookingId: string): Promise<{ pointsRestored: number }> {
  const res = await request<{ points_restored: number }>(`/staff/bookings/${encodeURIComponent(bookingId)}/undo-no-show`, { method: 'POST', session: 'staff' });
  return { pointsRestored: res.points_restored };
}

export interface DaySummary {
  date: string;
  cashReceived: number;
  promptpayVerified: number;
  refunded: number; // refunds of money counted as received = cash + promptpay below
  refundedCash: number;
  refundedPromptpay: number;
  refundedNotReceived: number; // refunds of transfers never approved
  paidBookings: number;
  // Counter sales (F&B, equipment, rentals) that day
  ordersCash: number;
  ordersPromptpay: number;
  fbSales: number;
  equipmentSales: number;
  rentalIncome: number;
  ordersCount: number;
}

// Staff: money received on a day by method (cash drawer) - bookings and
// counter orders - and refunds.
export async function daySummary(date: string): Promise<DaySummary> {
  const r = await request<{
    date: string; cash_received: number; promptpay_verified: number; refunded: number; paid_bookings: number;
    refunded_cash: number; refunded_promptpay: number; refunded_not_received: number;
    orders_cash: number; orders_promptpay: number; fb_sales: number; equipment_sales: number; rental_income: number; orders_count: number;
  }>(`/staff/summary?date=${encodeURIComponent(date)}`, { session: 'staff' });
  return {
    date: r.date, cashReceived: r.cash_received, promptpayVerified: r.promptpay_verified, refunded: r.refunded, paidBookings: r.paid_bookings,
    refundedCash: r.refunded_cash ?? 0, refundedPromptpay: r.refunded_promptpay ?? 0, refundedNotReceived: r.refunded_not_received ?? 0,
    ordersCash: r.orders_cash, ordersPromptpay: r.orders_promptpay, fbSales: r.fb_sales, equipmentSales: r.equipment_sales,
    rentalIncome: r.rental_income, ordersCount: r.orders_count
  };
}

// Admin: the no-show rules - re-sale price of a no-show hour (% of the
// normal price, 1-100) and minutes after the start before it can be marked.
export async function setNoShowRules(resalePercent: number, graceMinutes: number): Promise<void> {
  await request('/admin/pricing-config', { method: 'PUT', session: 'admin', body: { no_show_resale_percent: resalePercent, no_show_grace_minutes: graceMinutes } });
}

// Admin: how many days ahead customers may book online.
export async function setMaxAdvanceDays(days: number): Promise<void> {
  await request('/admin/pricing-config', { method: 'PUT', session: 'admin', body: { max_advance_days: days } });
}

// Admin: opening hours (first slot start, last slot end, 0-24).
export async function setOpeningHours(openHour: number, closeHour: number): Promise<void> {
  await request('/admin/pricing-config', { method: 'PUT', session: 'admin', body: { open_hour: openHour, close_hour: closeHour } });
}

// ---- courts (admin) ----

// Every court including closed ones (managers/admins).
export async function adminListCourts(): Promise<Court[]> {
  return (await request<ApiCourt[]>('/admin/courts', { session: 'admin' })).map(toCourt);
}

// Admin: add a standalone court (halfCourt = priced at the half-court rate).
// A half court names the full court it is half of (halfOf); the server
// puts both in one booking group.
export async function createCourt(input: { name: string; type: CourtType; halfCourt: boolean; halfOf?: string }): Promise<Court> {
  return toCourt(await request<ApiCourt>('/admin/courts', {
    method: 'POST', session: 'admin', body: { name: input.name, type: input.type, half_court: input.halfCourt, half_of: input.halfCourt ? input.halfOf : undefined }
  }));
}

// Admin: rename, open/close for booking. upcomingBookings: bookings still
// standing on a court that was just closed.
export async function updateCourt(id: string, patch: { name?: string; isActive?: boolean; offPeakOnly?: boolean }): Promise<{ court: Court; upcomingBookings: number; upcoming: Booking[] }> {
  const r = await request<{ court: ApiCourt; upcoming_bookings: number; upcoming?: ApiBooking[] }>(`/admin/courts/${encodeURIComponent(id)}`, {
    method: 'PUT', session: 'admin', body: { name: patch.name, is_active: patch.isActive, off_peak_only: patch.offPeakOnly }
  });
  return { court: toCourt(r.court), upcomingBookings: r.upcoming_bookings, upcoming: (r.upcoming || []).map(b => toBooking(b)) };
}

// ---- loyalty rewards (FR-4.2/4.3) ----

// kind FREE_OFFPEAK_HOUR: the voucher pays for one off-peak hour, booked by
// staff at the counter; ITEM: a thing handed over at the counter.
interface RewardItem { id: string; name: string; emoji: string; pointsCost: number; kind: string }

export interface VoucherInfo {
  id: string;
  code: string;
  rewardId: string;
  rewardName: string;
  rewardEmoji: string;
  rewardKind: string;
  pointsSpent: number;
  status: 'ACTIVE' | 'REDEEMED' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
  dispensedAt?: string;
  userName?: string;
  userPhone?: string;
}

interface ApiVoucher {
  id: string; code: string; reward_id: string; reward_name: string; reward_emoji: string; reward_kind: string; points_spent: number;
  status: string; created_at: string; expires_at: string; dispensed_at?: string; user_name?: string; user_phone?: string;
}

const toVoucher = (v: ApiVoucher): VoucherInfo => ({
  id: v.id, code: v.code, rewardId: v.reward_id, rewardName: v.reward_name, rewardEmoji: v.reward_emoji, rewardKind: v.reward_kind,
  pointsSpent: v.points_spent, status: v.status as VoucherInfo['status'], createdAt: v.created_at,
  expiresAt: v.expires_at, dispensedAt: v.dispensed_at, userName: v.user_name, userPhone: v.user_phone
});

export async function listRewards(): Promise<RewardItem[]> {
  return (await request<{ id: string; name: string; emoji: string; points_cost: number; kind: string }[]>('/rewards'))
    .map(r => ({ id: r.id, name: r.name, emoji: r.emoji, pointsCost: r.points_cost, kind: r.kind }));
}

export async function redeemReward(rewardId: string): Promise<VoucherInfo> {
  return toVoucher(await request<ApiVoucher>(`/me/rewards/${encodeURIComponent(rewardId)}/redeem`, { method: 'POST', session: 'customer' }));
}

export async function myVouchers(): Promise<VoucherInfo[]> {
  return (await request<ApiVoucher[]>('/me/vouchers', { session: 'customer' })).map(toVoucher);
}

export async function lookupVoucher(code: string): Promise<VoucherInfo> {
  return toVoucher(await request<ApiVoucher>(`/staff/vouchers/${encodeURIComponent(code.trim())}`, { session: 'staff' }));
}

export async function dispenseVoucher(code: string): Promise<VoucherInfo> {
  return toVoucher(await request<ApiVoucher>(`/staff/vouchers/${encodeURIComponent(code.trim())}/dispense`, { method: 'POST', session: 'staff' }));
}

// ---- counter shop: catalog, sales, rentals (FR-5.2/5.3) ----

interface ApiVariant { id: string; product_id: string; label: string; gender?: string; stock: number }
interface ApiProduct {
  id: string; name: string; category: string; sub_category?: string; price: number; is_rental: boolean;
  deposit?: number; stock: number; is_active: boolean; variants?: ApiVariant[];
}
interface ApiOrderItem {
  id: string; order_id: string; product_id: string; product_name: string; variant_id?: string; qty: number;
  unit_price: number; returned_at?: string; shoe_size?: string; shoe_gender?: string;
}
interface ApiOrder {
  id: string; order_code: string; user_id?: string; customer_name: string; court_id?: string; type: string;
  status: string; total_amount: number; paid_amount: number; payment_method: string; created_by: string;
  created_at: string; items: ApiOrderItem[]; voided_at?: string; void_reason?: string; created_by_name?: string;
  deposit_amount?: number; deposit_returned?: number; deposit_kept?: number; deposit_note?: string; deposit_settled_at?: string;
}

const toProduct = (p: ApiProduct): Product => ({
  id: p.id, name: p.name, category: p.category as ProductCat, subCategory: p.sub_category, price: p.price,
  isRental: p.is_rental, deposit: p.deposit ?? 0, stock: p.stock, isActive: p.is_active,
  variants: p.variants?.length
    ? p.variants.map(v => ({ id: v.id, productId: v.product_id, label: v.label, gender: v.gender as ProductVariant['gender'], stock: v.stock }))
    : undefined
});

// Orders carry each line's product name, so lists don't need the catalog.
export type OrderWithNames = Order & { items: (OrderItem & { productName: string })[]; createdByName?: string };

const toOrder = (o: ApiOrder): OrderWithNames => ({
  id: o.id, orderCode: o.order_code, userId: o.user_id, customerName: o.customer_name, courtId: o.court_id,
  type: o.type as OrderType, status: o.status as OrderStatus, totalAmount: o.total_amount, paidAmount: o.paid_amount,
  paymentMethod: o.payment_method as PaymentMethod, createdAt: o.created_at, createdBy: o.created_by, createdByName: o.created_by_name,
  voidedAt: o.voided_at, voidReason: o.void_reason,
  depositAmount: o.deposit_amount ?? 0, depositReturned: o.deposit_returned ?? 0, depositKept: o.deposit_kept ?? 0,
  depositNote: o.deposit_note, depositSettledAt: o.deposit_settled_at,
  items: (o.items || []).map(i => ({
    id: i.id, orderId: i.order_id, productId: i.product_id, productName: i.product_name, variantId: i.variant_id,
    qty: i.qty, unitPrice: i.unit_price, returnedAt: i.returned_at, shoeSize: i.shoe_size,
    shoeGender: i.shoe_gender as OrderItem['shoeGender']
  }))
});

export async function listProducts(): Promise<Product[]> {
  return (await request<ApiProduct[]>('/staff/products', { session: 'staff' })).map(toProduct);
}

interface CheckoutInput {
  type: OrderType;
  paymentMethod: PaymentMethod;
  items: { productId: string; variantId?: string; qty: number }[];
  customerName?: string;
  customerPhone?: string; // a registered customer's phone earns the points
  courtId?: string;
  // One id per cart / rental form (kept until it succeeds): makes a new sale's
  // body differ from an earlier identical one, and lets the server replay a
  // retried sale inside its own transaction.
  idempotencyKey?: string;
}

// Staff: sell or rent out. Prices and stock are the server's. A retry of
// the same sale is answered with the first one (see request()).
export const newActionId = () => newIdempotencyKey();

export async function checkout(input: CheckoutInput): Promise<{ order: OrderWithNames; pointsEarned: number }> {
  const r = await request<{ order: ApiOrder; points_earned: number }>('/pos/order', {
    method: 'POST', session: 'staff',
    body: {
      type: input.type, payment_method: input.paymentMethod, customer_name: input.customerName || '',
      customer_phone: input.customerPhone || '', court_id: input.courtId || undefined,
      items: input.items.map(i => ({ product_id: i.productId, variant_id: i.variantId, qty: i.qty })),
      idempotency_key: input.idempotencyKey
    }
  });
  return { order: toOrder(r.order), pointsEarned: r.points_earned };
}

export async function listOrders(date: string): Promise<OrderWithNames[]> {
  return (await request<ApiOrder[]>(`/staff/orders?date=${encodeURIComponent(date)}`, { session: 'staff' })).map(toOrder);
}

export async function activeRentals(): Promise<OrderWithNames[]> {
  return (await request<ApiOrder[]>('/staff/rentals', { session: 'staff' })).map(toOrder);
}

// keepDeposit: the part of the deposit kept for damage or loss (with a
// note) - only when this is the rental's last item out.
export async function returnRentalItem(itemId: string, keepDeposit = 0, note = ''): Promise<OrderWithNames> {
  return toOrder(await request<ApiOrder>(`/staff/rentals/items/${encodeURIComponent(itemId)}/return`, {
    method: 'POST', session: 'staff', body: keepDeposit > 0 ? { keep_deposit: keepDeposit, note } : undefined
  }));
}

// Managers/admins (Admin panel session): the catalog incl. inactive items.
export async function adminListProducts(): Promise<Product[]> {
  return (await request<ApiProduct[]>('/admin/products', { session: 'admin' })).map(toProduct);
}

export interface ProductInput { name: string; category: ProductCat; subCategory?: string; price: number; isRental: boolean; deposit?: number; stock?: number; isActive?: boolean }

const productBody = (p: ProductInput) => ({
  name: p.name, category: p.category, sub_category: p.subCategory || undefined, price: p.price,
  is_rental: p.isRental, deposit: p.deposit ?? 0, stock: p.stock ?? 0, is_active: p.isActive
});

// Edits a product's details (not its stock - see adjustStock).
export async function updateProduct(p: Product, changes: Partial<ProductInput>): Promise<Product> {
  const body = productBody({ name: p.name, category: p.category, subCategory: p.subCategory, price: p.price, isRental: p.isRental,
    deposit: p.deposit, isActive: p.isActive, ...changes });
  return toProduct(await request<ApiProduct>(`/admin/products/${encodeURIComponent(p.id)}`, { method: 'PUT', session: 'admin', body }));
}

export async function createProducts(list: ProductInput[]): Promise<Product[]> {
  return (await request<ApiProduct[]>('/admin/products', { method: 'POST', session: 'admin', body: { products: list.map(productBody) } })).map(toProduct);
}

export async function adjustStock(id: string, delta: number, reason: string, variantId?: string): Promise<Product> {
  return toProduct(await request<ApiProduct>(`/admin/products/${encodeURIComponent(id)}/stock`, {
    method: 'POST', session: 'admin', body: { delta, reason, variant_id: variantId }
  }));
}

// ---- admin reports from the database (FR-7.2-7.4) ----

export interface DashboardData {
  date: string;
  dailyBookingsRevenue: number;
  dailyBookingsCount: number;
  dailyOrderRevenue: number;
  dailyTotalRevenue: number;
  occupancyRate: number;
  physicalCourts: number;
  hoursPerDay: number;
  pendingRevenue: number;
  allTimeBookingSales: number;
  allTimeOrderSales: number;
  allTimeRefunds: number;
  customerCount: number;
  monthlyRevenue: { month: string; bookings: number; orders: number }[];
  hourlyOccupancy: { hour: string; percent: number }[];
  salesSplit: { food: number; equipment: number; rental: number };
  monthBySport: Record<string, number>;
}

export async function dashboard(date: string): Promise<DashboardData> {
  const d = await request<{
    date: string; daily_bookings_revenue: number; daily_bookings_count: number; daily_order_revenue: number;
    daily_total_revenue: number; occupancy_rate: number; physical_courts: number; hours_per_day: number;
    pending_revenue: number; all_time_booking_sales: number; all_time_order_sales: number; all_time_refunds: number;
    customer_count: number; monthly_revenue: { month: string; bookings: number; orders: number }[];
    hourly_occupancy: { hour: string; percent: number }[]; sales_split: { food: number; equipment: number; rental: number };
    month_by_sport: Record<string, number>;
  }>(`/admin/dashboard?date=${encodeURIComponent(date)}`, { session: 'admin' });
  return {
    date: d.date, dailyBookingsRevenue: d.daily_bookings_revenue, dailyBookingsCount: d.daily_bookings_count,
    dailyOrderRevenue: d.daily_order_revenue, dailyTotalRevenue: d.daily_total_revenue, occupancyRate: d.occupancy_rate,
    physicalCourts: d.physical_courts, hoursPerDay: d.hours_per_day, pendingRevenue: d.pending_revenue,
    allTimeBookingSales: d.all_time_booking_sales, allTimeOrderSales: d.all_time_order_sales, allTimeRefunds: d.all_time_refunds,
    customerCount: d.customer_count, monthlyRevenue: d.monthly_revenue || [], hourlyOccupancy: d.hourly_occupancy || [],
    salesSplit: d.sales_split, monthBySport: d.month_by_sport || {}
  };
}

export interface ReportBookingRow extends Omit<Booking, 'paymentMethod' | 'paymentStatus'> { courtName: string; paymentMethod: string; paymentStatus: string; refundAmount: number }

export async function monthReport(month: string, kind?: string): Promise<{ bookings: ReportBookingRow[]; orders: OrderWithNames[] }> {
  const r = await request<{ bookings: (ApiBooking & { court_name: string; payment_method: string; payment_status: string; refund_amount: number })[]; orders: ApiOrder[] }>(
    `/admin/report?month=${encodeURIComponent(month)}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`, { session: 'admin' });
  return {
    bookings: (r.bookings || []).map(b => ({ ...toBooking(b), courtName: b.court_name, paymentMethod: b.payment_method, paymentStatus: b.payment_status, refundAmount: b.refund_amount })),
    orders: (r.orders || []).map(toOrder)
  };
}

interface ApiAuditLog {
  id: string; user_id: string; user_name: string; action: string; target_type: string; target_id: string;
  before_state?: unknown; after_state?: unknown; reason?: string; created_at: string;
}

// jsonb columns arrive as JSON values; the panel shows objects.
const asRecord = (v: unknown): Record<string, unknown> | undefined => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') {
    try { return asRecord(JSON.parse(v)); } catch { return { value: v }; }
  }
  return typeof v === 'object' ? v as Record<string, unknown> : { value: v };
};

// Admins: the server's audit trail, newest first.
export async function auditLogs(opts: { search?: string; targetType?: string; limit?: number } = {}): Promise<AuditLog[]> {
  const q = new URLSearchParams();
  if (opts.search) q.set('search', opts.search);
  if (opts.targetType) q.set('target_type', opts.targetType);
  q.set('limit', String(opts.limit ?? 500));
  return (await request<ApiAuditLog[]>(`/admin/audit-logs?${q}`, { session: 'admin' })).map(l => ({
    id: l.id, userId: l.user_id, userName: l.user_name, action: l.action, targetType: l.target_type as AuditLog['targetType'],
    targetId: l.target_id, before: asRecord(l.before_state), after: asRecord(l.after_state), reason: l.reason, createdAt: l.created_at
  }));
}

// Managers (staff session of a manager): cancel today's counter sale.
// cancelledVouchers: rewards cancelled because the customer had already
// spent this sale's points on them.
export async function voidOrder(orderId: string, reason: string): Promise<OrderWithNames & { cancelledVouchers: string[] }> {
  const r = await request<ApiOrder & { cancelled_vouchers?: string[] }>(`/admin/orders/${encodeURIComponent(orderId)}/void`, { method: 'POST', session: 'staff', body: { reason } });
  return { ...toOrder(r), cancelledVouchers: r.cancelled_vouchers || [] };
}

// ---- cash drawer shifts (FR-6.1/6.2) ----

// A shift with the cash taken while it was open.
// blind: the cash figures are withheld from counter staff (blind count).
export interface ShiftView extends Shift { cashBookings: number; cashOrders: number; cashDeposits: number; expected: number; blind?: boolean }

interface ApiShift {
  id: string; staff_id: string; staff_name: string; opened_at: string; opening_float: number; opening_note?: string; closed_at?: string;
  counted_cash?: number; banked_cash?: number; expected_cash?: number; variance_cash?: number; notes?: string; closed_by_name?: string;
  cash_bookings: number; cash_orders: number; cash_deposits?: number; expected: number; blind?: boolean;
}

const toShift = (s: ApiShift): ShiftView => ({
  id: s.id, staffId: s.staff_id, staffName: s.staff_name, openedAt: s.opened_at, openingFloat: s.opening_float,
  openingNote: s.opening_note, closedAt: s.closed_at, countedCash: s.counted_cash, bankedCash: s.banked_cash, expectedCash: s.expected_cash, varianceCash: s.variance_cash,
  notes: s.notes, closedByName: s.closed_by_name, cashBookings: s.cash_bookings, cashOrders: s.cash_orders, cashDeposits: s.cash_deposits ?? 0, expected: s.expected,
  blind: s.blind
});

export async function currentShift(): Promise<ShiftView | null> {
  const s = await request<ApiShift | null>('/staff/shift', { session: 'staff' });
  return s ? toShift(s) : null;
}

// The open shift, or - when none is open - the cash counted at the last
// close (null before the first), which the next float should match.
export async function shiftState(): Promise<{ shift: ShiftView | null; lastCount: number | null }> {
  const r = await request<{ data: ApiShift | null; last_count?: number | null }>('/staff/shift', { session: 'staff', withMeta: true });
  return { shift: r.data ? toShift(r.data) : null, lastCount: r.last_count ?? null };
}

// note: required by the server when openingFloat isn't the last count.
export async function openShift(openingFloat: number, note: string): Promise<ShiftView> {
  return toShift(await request<ApiShift>('/staff/shift/open', { method: 'POST', session: 'staff', body: { opening_float: openingFloat, opening_note: note } }));
}

// bankedCash: taken out of the drawer at close (bank, safe), 0 if none.
export async function closeShift(countedCash: number, notes: string, bankedCash = 0): Promise<ShiftView> {
  return toShift(await request<ApiShift>('/staff/shift/close', { method: 'POST', session: 'staff', body: { counted_cash: countedCash, banked_cash: bankedCash, notes } }));
}

// Managers: recent shifts with over/short.
export async function listShifts(): Promise<ShiftView[]> {
  return (await request<ApiShift[]>('/admin/shifts', { session: 'staff' })).map(toShift);
}
