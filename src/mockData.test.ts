import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  courtsConflict,
  isHubCourt,
  findConflictingBooking,
  isCourtSlotAvailable,
  findNoShow,
  resalePrice,
  calculatePrice,
  getDayType,
  generatePromptPayPayload,
  crc16,
  bookingGroupOf,
  normalizePhone,
  slotTiming,
  memberTierLabel,
  localDateOf,
  bangkokStamp,
  findClosure,
  initializeState,
  StorageService,
  parseCourtCounts,
  buildDefaultCourts,
  DEFAULT_COURT_COUNTS,
} from './mockData';
import { Court, CourtType, Booking, BookingStatus, PriceType, MemberType, DayType, DayOff } from './types';

function makeCourt(overrides: Partial<Court>): Court {
  return {
    id: 'court-x',
    name: 'Test Court',
    type: CourtType.BASKETBALL,
    shareOfGroup: 1,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeBooking(overrides: Partial<Booking>): Booking {
  return {
    id: 'bk-x',
    bookingCode: 'BK-X',
    courtId: 'court-x',
    userId: 'u-1',
    userName: 'Test User',
    userPhone: '0800000000',
    date: '2026-09-20', // a Sunday, used consistently across tests
    startTime: '10:00',
    endTime: '11:00',
    isHalfCourt: false,
    priceType: PriceType.NORMAL,
    totalAmount: 100,
    status: BookingStatus.CONFIRMED,
    isEventBlock: false,
    createdAt: '2026-09-20T08:00:00.000Z',
    createdBy: 'u-1',
    ...overrides,
  };
}

// Basketball trio matching mockData.ts's DEFAULT_COURTS shape: one full
// court plus two independently-bookable half-court sides sharing a mutex
// group with it.
const fullCourt = makeCourt({ id: 'b_full_a', mutexGroupId: 'bball-court-1', shareOfGroup: 1 });
const halfB = makeCourt({ id: 'b_half_b', mutexGroupId: 'bball-court-1', shareOfGroup: 0.5, offPeakOnly: true });
const halfC = makeCourt({ id: 'b_half_c', mutexGroupId: 'bball-court-1', shareOfGroup: 0.5, offPeakOnly: true });
const standalone = makeCourt({ id: 'bad-1', type: CourtType.BADMINTON, mutexGroupId: undefined, shareOfGroup: 1 });

describe('isHubCourt', () => {
  it('is true for a full-share court', () => {
    expect(isHubCourt(fullCourt)).toBe(true);
  });
  it('is false for a half-share court', () => {
    expect(isHubCourt(halfB)).toBe(false);
  });
});

describe('courtsConflict (FR-1.2 mutex group rule)', () => {
  it('the same court always conflicts with itself', () => {
    expect(courtsConflict(halfB, halfB)).toBe(true);
  });

  it('the full court conflicts with either half-court side', () => {
    expect(courtsConflict(fullCourt, halfB)).toBe(true);
    expect(courtsConflict(fullCourt, halfC)).toBe(true);
    expect(courtsConflict(halfB, fullCourt)).toBe(true);
  });

  it('two different half-court sides do NOT conflict - they are independently bookable', () => {
    expect(courtsConflict(halfB, halfC)).toBe(false);
    expect(courtsConflict(halfC, halfB)).toBe(false);
  });

  it('courts in different mutex groups (or no group) never conflict', () => {
    expect(courtsConflict(standalone, fullCourt)).toBe(false);
    expect(courtsConflict(standalone, halfB)).toBe(false);
  });
});

describe('findConflictingBooking / isCourtSlotAvailable', () => {
  const courts = [fullCourt, halfB, halfC, standalone];

  it('booking half-court B blocks the full court for that hour', () => {
    const bookings = [makeBooking({ courtId: 'b_half_b', startTime: '10:00' })];
    expect(isCourtSlotAvailable('b_full_a', '2026-09-20', '10:00', bookings, courts)).toBe(false);
  });

  it('booking the full court blocks both half-court sides for that hour', () => {
    const bookings = [makeBooking({ courtId: 'b_full_a', startTime: '10:00' })];
    expect(isCourtSlotAvailable('b_half_b', '2026-09-20', '10:00', bookings, courts)).toBe(false);
    expect(isCourtSlotAvailable('b_half_c', '2026-09-20', '10:00', bookings, courts)).toBe(false);
  });

  it('booking half-court B does NOT block half-court C at the same hour (regression: an earlier version treated the whole mutex group as all-vs-all)', () => {
    const bookings = [makeBooking({ courtId: 'b_half_b', startTime: '10:00' })];
    expect(isCourtSlotAvailable('b_half_c', '2026-09-20', '10:00', bookings, courts)).toBe(true);
    expect(findConflictingBooking('b_half_c', '2026-09-20', '10:00', bookings, courts)).toBeUndefined();
  });

  it('a cancelled booking does not block the slot', () => {
    const bookings = [makeBooking({ courtId: 'b_full_a', startTime: '10:00', status: BookingStatus.CANCELLED })];
    expect(isCourtSlotAvailable('b_half_b', '2026-09-20', '10:00', bookings, courts)).toBe(true);
  });

  it('a booking on an unrelated standalone court never conflicts with the basketball group', () => {
    const bookings = [makeBooking({ courtId: 'bad-1', startTime: '10:00' })];
    expect(isCourtSlotAvailable('b_full_a', '2026-09-20', '10:00', bookings, courts)).toBe(true);
  });
});

describe('no-show frees the court for resale', () => {
  const courts = [fullCourt, halfB, halfC, standalone];

  it("a no-show doesn't hold its court or its basketball group", () => {
    const bookings = [makeBooking({ courtId: 'b_full_a', startTime: '10:00', status: BookingStatus.NO_SHOW })];
    expect(isCourtSlotAvailable('b_full_a', '2026-09-20', '10:00', bookings, courts)).toBe(true);
    expect(isCourtSlotAvailable('b_half_b', '2026-09-20', '10:00', bookings, courts)).toBe(true);
    // ...and that free hour is the re-sellable one (any conflicting court)
    expect(findNoShow('b_half_c', '2026-09-20', '10:00', bookings, courts)?.status).toBe(BookingStatus.NO_SHOW);
    expect(findNoShow('bad-1', '2026-09-20', '10:00', bookings, courts)).toBeUndefined();
    expect(findNoShow('b_full_a', '2026-09-20', '11:00', bookings, courts)).toBeUndefined();
  });
});

describe('getDayType', () => {
  it('classifies Saturday/Sunday as WEEKEND', () => {
    expect(getDayType('2026-09-19')).toBe(DayType.WEEKEND); // Saturday
    expect(getDayType('2026-09-20')).toBe(DayType.WEEKEND); // Sunday
  });
  it('classifies Mon-Fri as WEEKDAY', () => {
    expect(getDayType('2026-09-21')).toBe(DayType.WEEKDAY); // Monday
  });
});

// calculatePrice takes the court itself; these mirror DEFAULT_COURTS.
const court = (id: string) => ({ shareOfGroup: id.startsWith('b_half') ? 0.5 : 1 });

describe('calculatePrice (FR-2)', () => {
  // 2026-06-15 is a Monday (weekday), 09:00 falls in badminton's weekday
  // off-peak window (07:00-17:00, rate 180) per DEFAULT_PRICING_RULES.
  it('full-court normal member pays the base off-peak rate with no discount', () => {
    const result = calculatePrice(CourtType.BADMINTON, '2026-06-15', '09:00', MemberType.NORMAL, court('bad-1'));
    expect(result.total).toBe(180);
  });

  it('half-court rate is exactly 50% of the full rate (FR-2.4), not the old hardcoded 60%', () => {
    // b_half_b's basketball weekday off-peak base rate is 500 per DEFAULT_PRICING_RULES.
    const result = calculatePrice(CourtType.BASKETBALL, '2026-06-15', '09:00', MemberType.NORMAL, court('b_half_b'));
    expect(result.total).toBe(250); // 500 * 0.5, NOT 500 * 0.6 = 300
  });

  it('member discount percentages match REQUIREMENTS.md FR-2.3 (15/10/20), applied to the badminton weekday off-peak rate of 180', () => {
    expect(calculatePrice(CourtType.BADMINTON, '2026-06-15', '09:00', MemberType.STUDENT, court('bad-1')).total).toBe(153); // 180 * 0.85
    expect(calculatePrice(CourtType.BADMINTON, '2026-06-15', '09:00', MemberType.MEMBER, court('bad-1')).total).toBe(162); // 180 * 0.90
    expect(calculatePrice(CourtType.BADMINTON, '2026-06-15', '09:00', MemberType.CORPORATE, court('bad-1')).total).toBe(144); // 180 * 0.80
  });

  it('half-court rate and membership discount compose (rate applied before discount)', () => {
    // b_half_b at 500 base * 0.5 half-court rate = 250, then * 0.85 student discount
    const result = calculatePrice(CourtType.BASKETBALL, '2026-06-15', '09:00', MemberType.STUDENT, court('b_half_b'));
    expect(result.total).toBe(212.5); // 250 * 0.85, kept to the satang (NFR-4)
  });
});

describe('resalePrice (no-show resale, same rule as the server)', () => {
  it('is the normal hourly price x 50% by default - no member or half-court rate', () => {
    expect(resalePrice(standalone, '2026-06-15', '09:00')).toBe(90); // 180 * 50%
    expect(resalePrice(halfB, '2026-06-15', '09:00')).toBe(250); // 500 * 50%, not the half-court 250 * 50%
  });
});

describe('calculatePrice - UI agrees with the server', () => {
  it('the full court is never halved; a half-court side always is', () => {
    expect(calculatePrice(CourtType.BASKETBALL, '2026-06-15', '09:00', MemberType.NORMAL, court('b_full_a')).total).toBe(500);
    expect(calculatePrice(CourtType.BASKETBALL, '2026-06-15', '09:00', MemberType.NORMAL, court('b_half_c')).total).toBe(250);
  });

  it('a half court the browser has never stored (server-only court) is still half price', () => {
    // The court object comes from the caller, not a localStorage lookup by id.
    expect(calculatePrice(CourtType.BASKETBALL, '2026-06-15', '09:00', MemberType.NORMAL, { shareOfGroup: 0.5 }).total).toBe(250);
  });

  it('an hour no pricing rule covers is closed, not priced at a fallback rate', () => {
    for (const hour of ['03:00', '23:00']) {
      const result = calculatePrice(CourtType.BADMINTON, '2026-06-15', hour, MemberType.NORMAL, court('bad-1'));
      expect(result.isOpen).toBe(false);
      expect(result.total).toBe(0);
    }
    expect(calculatePrice(CourtType.BADMINTON, '2026-06-15', '22:00', MemberType.NORMAL, court('bad-1')).isOpen).toBe(true);
  });
});

describe('generatePromptPayPayload (EMVCo / Thai QR)', () => {
  // Expected strings are the output of the promptpay-qr npm package (v0.5.0)
  // and identical to golang-backend/internal/pkg/promptpay's tests.
  it('encodes a mobile number with sub-tag 01 and a valid CRC', () => {
    expect(generatePromptPayPayload('0812345678', 100))
      .toBe('00020101021229370016A000000677010111011300668123456785802TH53037645406100.006304BB8A');
    expect(generatePromptPayPayload('081-234-5678', 100))
      .toBe('00020101021229370016A000000677010111011300668123456785802TH53037645406100.006304BB8A');
  });

  it('encodes a 13-digit tax ID with sub-tag 02', () => {
    expect(generatePromptPayPayload('0105561008012', 1530))
      .toBe('00020101021229370016A000000677010111021301055610080125802TH530376454071530.006304797B');
  });

  it('uses the standard CRC-16/CCITT-FALSE checksum', () => {
    expect(crc16('123456789')).toBe('29B1');
  });

  it('rejects an ID that is neither a phone nor a tax ID', () => {
    expect(() => generatePromptPayPayload('12345', 100)).toThrow();
  });
});

describe('bookingGroupOf', () => {
  it('returns every hour of one checkout and nothing from another customer or date', () => {
    const root = makeBooking({ id: 'r', bookingCode: 'BK-1', userId: 'u-1', date: '2026-09-20', startTime: '10:00' });
    const sameGroup = makeBooking({ id: 'g2', bookingCode: 'BK-1', userId: 'u-1', date: '2026-09-20', startTime: '11:00' });
    const otherUser = makeBooking({ id: 'x1', bookingCode: 'BK-1', userId: 'u-2', date: '2026-09-20' });
    const otherDate = makeBooking({ id: 'x2', bookingCode: 'BK-1', userId: 'u-1', date: '2026-09-21' });
    const ids = bookingGroupOf(root, [root, sameGroup, otherUser, otherDate]).map(b => b.id);
    expect(ids).toEqual(['r', 'g2']);
  });
});

describe('normalizePhone (same canonical form as the backend)', () => {
  it('treats dashes, spaces and the +66 country code as the same number', () => {
    for (const p of ['0812345678', '081-234-5678', '081 234 5678', '+66 81 234 5678', '+66812345678', '0066812345678']) {
      expect(normalizePhone(p)).toBe('0812345678');
    }
    expect(normalizePhone('+66 2 123 4567')).toBe('021234567');
    expect(normalizePhone(undefined)).toBe('');
  });
});

describe('slotTiming (Bangkok time)', () => {
  afterEach(() => vi.useRealTimers());

  it('marks hours that have started or ended, judged in Asia/Bangkok', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T11:20:00Z')); // 18:20 in Bangkok
    expect(slotTiming('2026-10-20', '17:00')).toEqual({ started: true, ended: true });
    expect(slotTiming('2026-10-20', '18:00')).toEqual({ started: true, ended: false }); // counter only
    expect(slotTiming('2026-10-20', '19:00')).toEqual({ started: false, ended: false });
    expect(slotTiming('2026-10-21', '07:00')).toEqual({ started: false, ended: false });
    expect(slotTiming('2026-10-19', '22:00')).toEqual({ started: true, ended: true });
  });
});

describe('memberTierLabel', () => {
  it('shows the configured percentages from REQUIREMENTS.md FR-2.3 (not hard-coded ones)', () => {
    expect(memberTierLabel(MemberType.STUDENT)).toContain('15%');
    expect(memberTierLabel(MemberType.CORPORATE)).toContain('20%');
    expect(memberTierLabel(MemberType.MEMBER)).toContain('10%');
  });
});

describe('roundBaht / formatBaht (2 decimals)', () => {
  it('keeps satang and formats whole baht without decimals', async () => {
    const { roundBaht, formatBaht } = await import('./mockData');
    expect(roundBaht(212.5)).toBe(212.5);
    expect(roundBaht(153.004)).toBe(153);
    expect(roundBaht(10 / 3)).toBe(3.33);
    expect(formatBaht(212.5)).toBe('212.50');
    expect(formatBaht(1530)).toBe('1,530');
  });
});

describe('localDateOf / bangkokStamp (Bangkok calendar, any browser time zone)', () => {
  it('rolls over at midnight Bangkok, not UTC', () => {
    expect(localDateOf('2026-10-20T16:59:00Z')).toBe('2026-10-20'); // 23:59 Bangkok
    expect(localDateOf('2026-10-20T17:00:00Z')).toBe('2026-10-21'); // 00:00 Bangkok
  });
  it('returns an empty string for an unreadable value', () => {
    expect(localDateOf('13:56:02')).toBe('');
  });
  it('stamps CSV times in Bangkok', () => {
    expect(bangkokStamp('2026-10-20T06:56:02Z')).toBe('2026-10-20 13:56:02');
  });
});

// Closures follow the booking group rule (same as the server's
// repository.ClosureFor): closing a full court closes its halves, closing a
// half closes the full court but not the other half.
describe('findClosure (court groups)', () => {
  const otherFull = makeCourt({ id: 'bb-b-full', mutexGroupId: 'bball-court-2', shareOfGroup: 1 });
  const courts = [fullCourt, halfB, halfC, otherFull, standalone];
  const closure = (courtId: string, extra: Partial<DayOff> = {}): DayOff => ({ id: 'do-1', date: '2026-09-20', courtId, reason: 'ซ่อม', isFullDay: true, ...extra });
  const blocks = (closedId: string, targetId: string) => !!findClosure([closure(closedId)], '2026-09-20', targetId, 10, courts);

  it('closing the full court closes both halves', () => {
    expect(blocks('b_full_a', 'b_full_a')).toBe(true);
    expect(blocks('b_full_a', 'b_half_b')).toBe(true);
    expect(blocks('b_full_a', 'b_half_c')).toBe(true);
  });

  it('closing one half closes the full court but not the other half', () => {
    expect(blocks('b_half_b', 'b_half_b')).toBe(true);
    expect(blocks('b_half_b', 'b_full_a')).toBe(true);
    expect(blocks('b_half_b', 'b_half_c')).toBe(false);
  });

  it('never reaches another court group or an unrelated court', () => {
    expect(blocks('b_full_a', 'bb-b-full')).toBe(false);
    expect(blocks('bb-b-full', 'b_half_b')).toBe(false);
    expect(blocks('b_full_a', 'bad-1')).toBe(false);
  });

  it('still applies the hour window and the all-courts closure', () => {
    const partial = [closure('b_full_a', { isFullDay: false, startHour: 9, endHour: 12 })];
    expect(findClosure(partial, '2026-09-20', 'b_half_c', 11, courts)).toBeDefined();
    expect(findClosure(partial, '2026-09-20', 'b_half_c', 12, courts)).toBeUndefined();
    expect(findClosure([closure('all')], '2026-09-20', 'bad-1', 10, courts)).toBeDefined();
  });
});

// In-memory localStorage so initializeState can run under Node.
function stubLocalStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
}

describe('basketball courts A, B, C (seed and upgrade)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const basketball = () => StorageService.get<Court[]>('courts', []).filter(c => c.type === CourtType.BASKETBALL);

  it('a fresh start has three courts, each a full court plus two halves', () => {
    stubLocalStorage();
    initializeState();
    const groups = new Map<string, Court[]>();
    for (const c of basketball()) groups.set(c.mutexGroupId!, [...(groups.get(c.mutexGroupId!) || []), c]);
    expect([...groups.keys()].sort()).toEqual(['bball-court-1', 'bball-court-2', 'bball-court-3']);
    for (const rows of groups.values()) {
      expect(rows.map(r => r.shareOfGroup).sort()).toEqual([0.5, 0.5, 1]);
      expect(rows.filter(r => r.shareOfGroup < 1).every(r => r.offPeakOnly)).toBe(true);
    }
  });

  it('upgrading keeps court A ids, renames its halves only if unchanged, and adds B and C', () => {
    const oldCourts = [
      makeCourt({ id: 'b_full_a', name: 'สนามบาสเกตบอล A (เต็มสนาม)', mutexGroupId: 'bball-court-1' }),
      makeCourt({ id: 'b_half_b', name: 'สนามบาสเกตบอล B (ครึ่งสนาม: ซ้าย)', mutexGroupId: 'bball-court-1', shareOfGroup: 0.5 }),
      makeCourt({ id: 'b_half_c', name: 'ฝั่งประตูหลัง', mutexGroupId: 'bball-court-1', shareOfGroup: 0.5 }), // renamed by the owner
    ];
    stubLocalStorage({ sports_complex_init: 'true', sports_complex_courts: JSON.stringify(oldCourts) });
    initializeState();
    const byId = new Map(basketball().map(c => [c.id, c]));
    expect(byId.get('b_half_b')?.name).toBe('สนามบาสเกตบอล A (ครึ่งซ้าย)');
    expect(byId.get('b_half_c')?.name).toBe('ฝั่งประตูหลัง');
    expect(byId.size).toBe(9);
    expect(byId.get('bb-c-right')?.mutexGroupId).toBe('bball-court-3');
  });
});

// Same names, defaults, limits and ids as the Go backend's seed_courts.go.
describe('court counts (BASKETBALL_COURT_COUNT etc.)', () => {
  it('defaults to 3 basketball (each full + 2 halves), 12 badminton, 3 pickleball, 1 meeting room', () => {
    expect(parseCourtCounts({})).toEqual(DEFAULT_COURT_COUNTS);
    const courts = buildDefaultCourts(DEFAULT_COURT_COUNTS);
    expect(courts).toHaveLength(9 + 12 + 3 + 1);
    expect(courts.filter(c => c.type === CourtType.BASKETBALL).map(c => c.id)).toEqual(
      ['b_full_a', 'b_half_b', 'b_half_c', 'bb-b-full', 'bb-b-left', 'bb-b-right', 'bb-c-full', 'bb-c-left', 'bb-c-right']);
  });

  it('BASKETBALL_COURT_COUNT=5 gives courts A-E, each its own group of full + 2 halves', () => {
    const courts = buildDefaultCourts(parseCourtCounts({ basketball: '5', badminton: '8', pickleball: '0', meetingRoom: '2' }));
    const bball = courts.filter(c => c.type === CourtType.BASKETBALL);
    expect(bball).toHaveLength(15);
    expect(new Set(bball.map(c => c.mutexGroupId)).size).toBe(5);
    expect(bball.find(c => c.id === 'bb-e-right')?.name).toBe('สนามบาสเกตบอล E (ครึ่งขวา)');
    expect(courts.filter(c => c.type === CourtType.BADMINTON)).toHaveLength(8);
    expect(courts.filter(c => c.type === CourtType.PICKLEBALL)).toHaveLength(0);
    expect(courts.filter(c => c.type === CourtType.MEETING_ROOM).map(c => c.id)).toEqual(['meet-1', 'meet-2']);
  });

  it('falls back to the default for values that are not a whole number in range', () => {
    for (const bad of ['three', '-1', '27', '2.5']) {
      expect(parseCourtCounts({ basketball: bad }).basketball).toBe(3);
    }
    expect(parseCourtCounts({ badminton: '51' }).badminton).toBe(12);
  });
});
