import { describe, it, expect } from 'vitest';
import {
  courtsConflict,
  isHubCourt,
  findConflictingBooking,
  isCourtSlotAvailable,
  calculatePrice,
  getDayType,
  generatePromptPayPayload,
  crc16,
  bookingGroupOf,
} from './mockData';
import { Court, CourtType, Booking, BookingStatus, PriceType, MemberType, DayType } from './types';

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

describe('getDayType', () => {
  it('classifies Saturday/Sunday as WEEKEND', () => {
    expect(getDayType('2026-09-19')).toBe(DayType.WEEKEND); // Saturday
    expect(getDayType('2026-09-20')).toBe(DayType.WEEKEND); // Sunday
  });
  it('classifies Mon-Fri as WEEKDAY', () => {
    expect(getDayType('2026-09-21')).toBe(DayType.WEEKDAY); // Monday
  });
});

describe('calculatePrice (FR-2)', () => {
  // 2026-06-15 is a Monday (weekday), 09:00 falls in badminton's weekday
  // off-peak window (07:00-17:00, rate 180) per DEFAULT_PRICING_RULES.
  it('full-court normal member pays the base off-peak rate with no discount', () => {
    const result = calculatePrice(CourtType.BADMINTON, '2026-06-15', '09:00', MemberType.NORMAL, false, 'bad-1');
    expect(result.total).toBe(180);
  });

  it('half-court rate is exactly 50% of the full rate (FR-2.4), not the old hardcoded 60%', () => {
    // b_half_b's basketball weekday off-peak base rate is 500 per DEFAULT_PRICING_RULES.
    const result = calculatePrice(CourtType.BASKETBALL, '2026-06-15', '09:00', MemberType.NORMAL, false, 'b_half_b');
    expect(result.total).toBe(250); // 500 * 0.5, NOT 500 * 0.6 = 300
  });

  it('member discount percentages match REQUIREMENTS.md FR-2.3 (15/10/20), applied to the badminton weekday off-peak rate of 180', () => {
    expect(calculatePrice(CourtType.BADMINTON, '2026-06-15', '09:00', MemberType.STUDENT, false, 'bad-1').total).toBe(153); // 180 * 0.85
    expect(calculatePrice(CourtType.BADMINTON, '2026-06-15', '09:00', MemberType.MEMBER, false, 'bad-1').total).toBe(162); // 180 * 0.90
    expect(calculatePrice(CourtType.BADMINTON, '2026-06-15', '09:00', MemberType.CORPORATE, false, 'bad-1').total).toBe(144); // 180 * 0.80
  });

  it('half-court rate and membership discount compose (rate applied before discount)', () => {
    // b_half_b at 500 base * 0.5 half-court rate = 250, then * 0.85 student discount
    const result = calculatePrice(CourtType.BASKETBALL, '2026-06-15', '09:00', MemberType.STUDENT, false, 'b_half_b');
    expect(result.total).toBe(213); // round(250 * 0.85) = round(212.5) = 213
  });
});

describe('calculatePrice - UI agrees with the server', () => {
  it('the half-court flag does not halve the full court (it is a full-share court)', () => {
    const result = calculatePrice(CourtType.BASKETBALL, '2026-06-15', '09:00', MemberType.NORMAL, true, 'b_full_a');
    expect(result.total).toBe(500);
  });

  it('an hour no pricing rule covers is closed, not priced at a fallback rate', () => {
    for (const hour of ['03:00', '23:00']) {
      const result = calculatePrice(CourtType.BADMINTON, '2026-06-15', hour, MemberType.NORMAL, false, 'bad-1');
      expect(result.isOpen).toBe(false);
      expect(result.total).toBe(0);
    }
    expect(calculatePrice(CourtType.BADMINTON, '2026-06-15', '22:00', MemberType.NORMAL, false, 'bad-1').isOpen).toBe(true);
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
