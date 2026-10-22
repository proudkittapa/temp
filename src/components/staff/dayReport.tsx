import {
  Booking, BookingStatus, PaymentStatus,
  PaymentMethod, Order, OrderStatus, OrderType, User
} from '../../types';
import { StorageService, getTodayDateStr, bookingGroupOf, roundBaht, isPaidBooking, localDateOf, businessInfo } from '../../mockData';
import * as api from '../../api';
import type { StaffPOSCore } from './useStaffPOS';


// Today's figures for the drawer report and receipts.
export function useDayReport(deps: StaffPOSCore) {
  const {
    bookingPool,
    bookings,
    daySummary,
    orders,
    payments,
    selectedReceiptBooking,
    selectedReceiptOrder,
    todayBookingsApi
  } = deps;
  // Today's (Bangkok) non-cancelled counter orders. API mode loads only
  // today's; stored times are UTC, so compare by local calendar date.
  const todaysOrders = () => orders.filter(o => o.status !== OrderStatus.CANCELLED &&
    (api.USE_BACKEND || localDateOf(o.createdAt) === getTodayDateStr()));

  const todayBookingList = api.USE_BACKEND ? todayBookingsApi : bookings.filter(b => b.date === getTodayDateStr());

  // The open receipt: a booking's whole group (one receipt per payment),
  // how it was paid, and whether it is paid at all - an unpaid booking
  // gets no receipt.
  // Local mode stores a user id (older rows a name) as who took the money.
  const nameOfUser = (idOrName?: string) => idOrName ? StorageService.get<User[]>('users', []).find(u => u.id === idOrName)?.name ?? idOrName : undefined;
  const shop = businessInfo();
  const receipt = (() => {
    const b = selectedReceiptBooking;
    if (b) {
      const pool = bookingPool();
      const group = bookingGroupOf(b, pool).filter(x => x.status !== BookingStatus.CANCELLED);
      const rows = (group.length ? group : [b]).sort((x, y) => (x.startTime + x.courtId).localeCompare(y.startTime + y.courtId));
      const paidRows = rows.filter(isPaidBooking);
      const ids = new Set(bookingGroupOf(b, pool).map(x => x.id));
      const pay = api.USE_BACKEND ? undefined : payments.find(p => ids.has(p.bookingId) && p.verifiedAt);
      const method = api.USE_BACKEND ? b.paymentMethod : (pay ?? payments.find(p => ids.has(p.bookingId)))?.method;
      const cashier = api.USE_BACKEND ? b.paymentVerifiedByName : nameOfUser(pay?.verifiedBy);
      const paidAt = api.USE_BACKEND ? b.paymentVerifiedAt : pay?.verifiedAt;
      return { code: b.bookingCode, rows: paidRows.length ? paidRows : rows, total: roundBaht(paidRows.reduce((n, x) => n + x.totalAmount, 0)), method, paid: paidRows.length > 0, cashier, paidAt };
    }
    const o = selectedReceiptOrder;
    if (o) return { code: o.orderCode, rows: [] as Booking[], total: o.totalAmount, method: o.paymentMethod, paid: o.status !== OrderStatus.CANCELLED,
      cashier: (o as api.OrderWithNames).createdByName || nameOfUser(o.createdBy), paidAt: o.createdAt };
    return null;
  })();
  const METHOD_LABEL: Partial<Record<PaymentMethod, string>> = {
    [PaymentMethod.CASH]: 'เงินสด (CASH)',
    [PaymentMethod.PROMPTPAY]: 'โอนผ่านพร้อมเพย์ (PROMPTPAY)',
    [PaymentMethod.VOUCHER]: 'คูปองชั่วโมงฟรี (VOUCHER)'
  };
  const calculateLedger = () => {
    const todayStr = getTodayDateStr();
    const paidBookings = todayBookingList.filter(isPaidBooking);

    // Day's counter orders: from the server's summary in API mode.
    const dayOrders = todaysOrders();
    const sumOf = (list: Order[]) => list.reduce((sum, o) => sum + Number(o.totalAmount), 0);
    const fbIncome = roundBaht(api.USE_BACKEND ? (daySummary?.fbSales ?? 0) + (daySummary?.equipmentSales ?? 0)
      : sumOf(dayOrders.filter(o => o.type !== OrderType.EQUIPMENT_RENT)));
    const rentalIncome = roundBaht(api.USE_BACKEND ? daySummary?.rentalIncome ?? 0 : sumOf(dayOrders.filter(o => o.type === OrderType.EQUIPMENT_RENT)));
    const cashSumFromOrders = api.USE_BACKEND ? daySummary?.ordersCash ?? 0 : sumOf(dayOrders.filter(o => o.paymentMethod === PaymentMethod.CASH));
    const qrSumFromOrders = api.USE_BACKEND ? daySummary?.ordersPromptpay ?? 0 : sumOf(dayOrders.filter(o => o.paymentMethod === PaymentMethod.PROMPTPAY));

    let cashFromBookings = 0, qrFromBookings = 0, refundedCash = 0, refundedQr = 0, refundedNotReceived = 0;
    if (api.USE_BACKEND) {
      cashFromBookings = daySummary?.cashReceived ?? 0;
      qrFromBookings = daySummary?.promptpayVerified ?? 0;
      refundedCash = daySummary?.refundedCash ?? 0;
      refundedQr = daySummary?.refundedPromptpay ?? 0;
      refundedNotReceived = daySummary?.refundedNotReceived ?? 0;
    } else {
      // Money received today, whatever day it was for - as the server
      // counts it: payments approved today (refunded ones too, their refund
      // is counted separately).
      for (const p of payments) {
        if (!p.verifiedAt || localDateOf(p.verifiedAt) !== todayStr) continue;
        if (p.status !== PaymentStatus.VERIFIED && p.status !== PaymentStatus.REFUNDED) continue;
        if (p.method === PaymentMethod.CASH) cashFromBookings += p.amount;
        else if (p.method === PaymentMethod.PROMPTPAY) qrFromBookings += p.amount;
      }
      // Each refund on its own day (older data has only the running total),
      // split like the server: by method, and money never approved apart.
      for (const p of payments) {
        const today = p.refunds
          ? p.refunds.filter(r => localDateOf(r.at) === todayStr).reduce((n, r) => n + r.amount, 0)
          : (p.refundedAt && localDateOf(p.refundedAt) === todayStr ? p.refundAmount || 0 : 0);
        if (!p.verifiedAt) refundedNotReceived += today;
        else if (p.method === PaymentMethod.CASH) refundedCash += today;
        else refundedQr += today;
      }
    }
    const bookingIncome = roundBaht(cashFromBookings + qrFromBookings);

    return {
      bookingCount: api.USE_BACKEND ? daySummary?.paidBookings ?? paidBookings.length : paidBookings.length,
      walkinCount: paidBookings.filter(b => b.createdBy !== 'customer' && b.createdBy !== b.userId).length,
      bookingIncome,
      fbIncome,
      rentalIncome,
      cashExpected: roundBaht(cashFromBookings + cashSumFromOrders),
      qrExpected: roundBaht(qrFromBookings + qrSumFromOrders),
      refunded: roundBaht(refundedCash + refundedQr),
      refundedCash: roundBaht(refundedCash),
      refundedQr: roundBaht(refundedQr),
      refundedNotReceived: roundBaht(refundedNotReceived),
      totalExpected: roundBaht(bookingIncome + fbIncome + rentalIncome)
    };
  };
  return {
    todaysOrders,
    todayBookingList,
    nameOfUser,
    shop,
    receipt,
    METHOD_LABEL,
    calculateLedger
  };
}
