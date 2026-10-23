import {
  Payment, PaymentStatus,
  PaymentMethod, Order, OrderStatus, UserRole, Shift, AddAuditLog, User, LedgerEntryType
} from '../../types';
import { roundBaht, StorageService } from '../../mockData';
import * as api from '../../api';
import { dialog } from '../Dialog';

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
  // Refunds paid back in cash from the drawer while open.
  const cashRefunds = roundBaht(payments.reduce((n, p) =>
    n + (p.refunds || []).filter(r => r.method === 'CASH' && r.at >= from && r.at < to).reduce((m, r) => m + r.amount, 0), 0));
  return { ...sh, cashBookings, cashOrders, cashDeposits, cashRefunds,
    expected: sh.expectedCash ?? roundBaht(sh.openingFloat + cashBookings + cashOrders + cashDeposits - cashRefunds) };
}

// Browser-only mode keeps reward vouchers in localStorage ("redemptions").
export interface LocalVoucher { id: string; claimCode: string; rewardId: string; rewardName: string; userId: string; userName: string; pointsSpent?: number; status?: string; bookingId?: string; dispensedAt?: string }

// Browser-only mode's coverPointsWithRewards (pos.go): before taking `need`
// points back from a customer who has fewer, their unused rewards are
// cancelled, newest first, until the points cover it. plan says which and
// what still can't be covered (short); applyPointsCover does it.
export function planPointsCover(userId: string, need: number): { cancel: LocalVoucher[]; short: number } {
  const balance = StorageService.get<User[]>('users', []).find(u => u.id === userId)?.points ?? 0;
  let short = need - balance;
  const cancel: LocalVoucher[] = [];
  if (short <= 0) return { cancel, short: 0 };
  const usable = StorageService.get<LocalVoucher[]>('redemptions', [])
    .filter(v => v.userId === userId && (v.status || 'ACTIVE') === 'ACTIVE').reverse();
  for (const v of usable) {
    if (short <= 0) break;
    cancel.push(v);
    short -= v.pointsSpent || 0;
  }
  return { cancel, short: Math.max(0, short) };
}

export function applyPointsCover(userId: string, cancel: LocalVoucher[], why: string, actor: string): string[] {
  if (!cancel.length) return [];
  const ids = new Set(cancel.map(v => v.id));
  StorageService.set('redemptions', StorageService.get<LocalVoucher[]>('redemptions', []).map(v => ids.has(v.id) ? { ...v, status: 'CANCELLED' } : v));
  for (const v of cancel) {
    StorageService.addLedgerEntry(userId, LedgerEntryType.VOUCHER_CANCELLED, v.pointsSpent || 0, actor, { refType: 'Voucher', refId: v.id, note: `Voucher ${v.claimCode} cancelled: ${why}` });
  }
  return cancel.map(v => v.claimCode);
}

// How a refund goes back (owner 2026-10-23: staff may pay it from the
// drawer). null = the manager closed the box: nothing is recorded.
export async function askRefundMethod(amountText: string): Promise<api.RefundMethod | null> {
  const r = await dialog({
    title: '💸 คืนเงินอย่างไร',
    message: `ยอดคืน ${amountText} บาท`,
    choices: [
      { value: 'TRANSFER', label: 'โอนคืนลูกค้า' },
      { value: 'CASH', label: 'จ่ายเงินสดจากลิ้นชัก (ต้องเปิดกะอยู่ · หักจากยอดเงินสดของกะ)' }
    ],
    okLabel: 'ยืนยันการคืนเงิน'
  });
  return r ? (r.choice === 'CASH' ? 'CASH' : 'TRANSFER') : null;
}
