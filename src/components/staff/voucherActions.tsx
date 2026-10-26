import {
  PaymentMethod, User
} from '../../types';
import { StorageService, FREE_HOUR_REWARD_IDS, formatDate } from '../../mockData';
import * as api from '../../api';
import { notify } from '../Dialog';
import type { StaffPOSCore } from './useStaffPOS';
import { LocalVoucher } from './shared';


// Reward voucher check, hand-out and free-hour use.
export function useVoucherActions(deps: StaffPOSCore) {
  const {
    onAddAuditLog,
    setActivePosTab,
    setVoucherCode,
    setVoucherError,
    setVoucherFound,
    setWalkinName,
    setWalkinPayMethod,
    setWalkinPhone,
    setWalkinVoucherCode,
    voucherCode,
    voucherFound
  } = deps;
  // A used free-hour voucher: clear the voucher check (it would still show
  // the code as usable) and go back to the default payment method.
  const resetVoucherCheck = () => {
    setVoucherCode('');
    setVoucherFound(null);
    setVoucherError(null);
    setWalkinPayMethod(PaymentMethod.PROMPTPAY);
  };

  // Reward voucher check: look the code up, then mark it handed over.
  // Browser-only mode keeps vouchers in localStorage ("redemptions").
  const handleLookupVoucher = async () => {
    setVoucherError(null);
    setVoucherFound(null);
    const code = voucherCode.trim().toUpperCase();
    if (!code) return;
    if (api.USE_BACKEND) {
      await api.lookupVoucher(code)
        .then(v => setVoucherFound({ code: v.code, reward: `${v.rewardEmoji} ${v.rewardName}`, customer: `${v.userName || ''} ${v.userPhone || ''}`,
          name: v.userName || '', phone: v.userPhone || '', freeHour: v.rewardKind === 'FREE_OFFPEAK_HOUR', status: v.status,
          expires: formatDate(v.expiresAt) }))
        .catch(err => setVoucherError(err instanceof api.ApiError && err.status === 404 ? 'ไม่พบรหัสนี้' : err.message));
      return;
    }
    const v = StorageService.get<LocalVoucher[]>('redemptions', []).find(r => r.claimCode === code);
    if (!v) { setVoucherError('ไม่พบรหัสนี้'); return; }
    const owner = StorageService.get<User[]>('users', []).find(u => u.id === v.userId);
    setVoucherFound({ code: v.claimCode, reward: v.rewardName, customer: `${v.userName} ${owner?.phone || ''}`, name: owner?.name || v.userName,
      phone: owner?.phone || '', freeHour: FREE_HOUR_REWARD_IDS.includes(v.rewardId), status: v.status || 'ACTIVE' });
  };

  // A free off-peak hour is used by booking it: open the walk-in form with
  // the voucher and the customer filled in; staff pick the court and hour.
  const handleUseFreeHourVoucher = () => {
    if (!voucherFound) return;
    setWalkinPayMethod(PaymentMethod.VOUCHER);
    setWalkinVoucherCode(voucherFound.code);
    setWalkinName(voucherFound.name);
    setWalkinPhone(voucherFound.phone);
    setActivePosTab('walkin');
  };

  const handleDispenseVoucher = async () => {
    if (!voucherFound) return;
    const code = voucherFound.code;
    const done = () => {
      onAddAuditLog('VOUCHER_DISPENSED', 'Voucher', code, { status: 'ACTIVE' }, { status: 'REDEEMED' });
      setVoucherFound({ ...voucherFound, status: 'REDEEMED' });
      notify(`มอบของรางวัล ${voucherFound.reward} แล้ว`);
    };
    if (api.USE_BACKEND) {
      await api.dispenseVoucher(code).then(done).catch(err => setVoucherError(err.message));
      return;
    }
    const list = StorageService.get<LocalVoucher[]>('redemptions', []);
    // As the server: only an ACTIVE voucher (not handed out, cancelled by
    // a void or cancel since it was looked up), and not a free court hour.
    const stored = list.find(r => r.claimCode === code);
    const status = stored ? (stored.status || 'ACTIVE') : 'ไม่พบ';
    if (status === 'REDEEMED') { setVoucherError('รหัสนี้รับของไปแล้ว'); return; }
    if (status !== 'ACTIVE') { setVoucherError(`คูปอง ${code} ใช้ไม่ได้ (${status})`); return; }
    if (FREE_HOUR_REWARD_IDS.includes(stored!.rewardId)) { setVoucherError('คูปองนี้เป็นชั่วโมงฟรี ใช้จองที่ฟอร์ม Walk-in'); return; }
    StorageService.set('redemptions', list.map(r => r.claimCode === code ? { ...r, status: 'REDEEMED', dispensedAt: new Date().toISOString() } : r));
    done();
  };
  return {
    resetVoucherCheck,
    handleLookupVoucher,
    handleUseFreeHourVoucher,
    handleDispenseVoucher
  };
}
