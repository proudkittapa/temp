import {
  Payment, PaymentStatus,
  PaymentMethod, Order, OrderStatus, UserRole, Shift, AddAuditLog
} from '../../types';
import { roundBaht } from '../../mockData';
import * as api from '../../api';

export interface StaffPOSProps {
  currentUserRole: UserRole;
  onAddAuditLog: AddAuditLog;
  triggerRefresh: number;
  onRefreshAll: () => void;
}

// Browser-only mode: a shift's cash taken (same rule as the server: cash
// payments approved and non-voided cash orders while the shift was open).
export function localShiftView(sh: Shift, payments: Payment[], orders: Order[]): api.ShiftView {
  const from = sh.openedAt, to = sh.closedAt || '9999';
  const cashBookings = roundBaht(payments.filter(p => p.method === PaymentMethod.CASH && p.verifiedAt && p.verifiedAt >= from && p.verifiedAt < to &&
    (p.status === PaymentStatus.VERIFIED || p.status === PaymentStatus.REFUNDED)).reduce((n, p) => n + p.amount, 0));
  const cashOrders = roundBaht(orders.filter(o => o.paymentMethod === PaymentMethod.CASH && o.status !== OrderStatus.CANCELLED &&
    o.createdAt >= from && o.createdAt < to).reduce((n, o) => n + o.totalAmount, 0));
  // Rental deposits: taken (voided rentals too) minus given back.
  const cashDeposits = roundBaht(orders.reduce((n, o) =>
    n + (o.createdAt >= from && o.createdAt < to ? o.depositAmount ?? 0 : 0)
      - (o.depositSettledAt && o.depositSettledAt >= from && o.depositSettledAt < to ? o.depositReturned ?? 0 : 0), 0));
  return { ...sh, cashBookings, cashOrders, cashDeposits,
    expected: sh.expectedCash ?? roundBaht(sh.openingFloat + cashBookings + cashOrders + cashDeposits) };
}

// Browser-only mode keeps reward vouchers in localStorage ("redemptions").
export interface LocalVoucher { id: string; claimCode: string; rewardId: string; rewardName: string; userId: string; userName: string; pointsSpent?: number; status?: string; bookingId?: string; dispensedAt?: string }
