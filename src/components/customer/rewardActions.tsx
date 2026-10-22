import { LineMessage, User, LedgerEntryType } from '../../types';
import { StorageService, normalizePhone, formatDate, formatDateTime } from '../../mockData';
import * as api from '../../api';
import { notify, ask } from '../Dialog';
import type { CustomerPanelCore } from './useCustomerPanel';
import { Reward, Redemption } from './shared';


// Loyalty rewards: redeem points for a voucher.
export function useRewardActions(deps: CustomerPanelCore) {
  const {
    loggedInUser,
    onAddAuditLog,
    onRefreshAll,
    sessionStillMine,
    setLineMessages,
    setLoggedInUser,
    setRedemptions
  } = deps;
  const handleRedeemReward = async (reward: Reward) => {
    if (!loggedInUser) {
      notify('กรุณาเข้าสู่ระบบก่อนทำการแลกรางวัลค่ะ!');
      return;
    }
    // API mode: points live in the backend's ledger; the server deducts
    // them and issues the voucher in one transaction.
    if (api.USE_BACKEND) {
      if (!(await ask(`ใช้ ${reward.cost} แต้ม แลก "${reward.emoji} ${reward.name}"?`, { title: '🎁 แลกแต้ม', okLabel: 'แลกเลย' }))) return;
      if (!sessionStillMine()) return;
      return api.redeemReward(reward.id)
        .then(v => {
          onAddAuditLog('LOYALTY_POINT_REDEEMED', 'User', loggedInUser.id, null, { gift: v.rewardName, voucherCode: v.code });
          notify(`🎉 แลกรางวัลสำเร็จ!\nรหัสรับของรางวัล: ${v.code}\nแสดงรหัสนี้ที่เคาน์เตอร์ภายในวันที่ ${formatDate(v.expiresAt)}`);
          onRefreshAll();
        })
        .catch(err => notify(`แลกรางวัลไม่สำเร็จ: ${err.message}`));
    }

    // The stored balance, not the copy taken at sign-in.
    const currentPoints = StorageService.get<User[]>('users', []).find(u => u.id === loggedInUser.id)?.points ?? loggedInUser.points ?? 0;
    if (currentPoints < reward.cost) {
      notify(`ขออภัยค่ะ! แต้มสะสมของคุณไม่เพียงพอสำหรับการแลก ${reward.name} (ต้องการ ${reward.cost} แต้ม แต่คุณมี ${currentPoints} แต้ม)`);
      return;
    }

    if (!(await ask(`ใช้ ${reward.cost} แต้ม แลก "${reward.emoji} ${reward.name}"?`, { title: '🎁 แลกแต้ม', okLabel: 'แลกเลย' }))) return;
    // Re-read after the question: the balance may have changed meanwhile.
    const balanceNow = StorageService.get<User[]>('users', []).find(u => u.id === loggedInUser.id)?.points ?? 0;
    if (balanceNow < reward.cost) {
      notify(`แต้มไม่พอแล้ว (ต้องการ ${reward.cost} แต้ม มี ${balanceNow} แต้ม)`);
      onRefreshAll();
      return;
    }

    // Deduct through the points ledger, like every other points change.
    const claimCode = `RW-${String(Math.floor(100000 + Math.random() * 900000))}`;
    const voucherId = 'voucher-' + Date.now();
    StorageService.addLedgerEntry(loggedInUser.id, LedgerEntryType.REDEEM, -reward.cost, loggedInUser.id, { refType: 'Voucher', refId: voucherId, note: reward.name });
    const newPoints = balanceNow - reward.cost;
    const updatedUser = { ...loggedInUser, points: newPoints };
    setLoggedInUser(updatedUser);

    // Create redemption voucher
    const newVoucher: Redemption = {
      id: voucherId,
      userId: loggedInUser.id,
      userName: loggedInUser.name,
      rewardId: reward.id,
      rewardName: reward.name,
      pointsSpent: reward.cost,
      claimCode,
      redeemedAt: formatDateTime(Date.now()) + ' น.'
    };

    const currentVouchers = StorageService.get<Redemption[]>('redemptions', []);
    const updatedVouchers = [newVoucher, ...currentVouchers];
    StorageService.set('redemptions', updatedVouchers);
    setRedemptions(updatedVouchers);

    // Add Audit Log
    onAddAuditLog('LOYALTY_POINT_REDEEMED', 'User', loggedInUser.id, { pointsBefore: balanceNow }, { pointsAfter: newPoints, gift: reward.name, voucherCode: claimCode });

    // Send Line simulated notification
    const cleanPhone = normalizePhone(loggedInUser.phone || '');
    const lpMsg = `🎁 แลกรับสิทธิ์ของรางวัลสำเร็จ!\n🏆 คุณได้ใช้แต้มสะสมจำนวน -${reward.cost} แต้ม เพื่อแลกรับรางวัล "${reward.emoji} ${reward.name}"\n🔑 รหัสเคลมของรางวัล (Claim Code): ${claimCode}\n\n*โปรดแสดงรหัสสิทธิ์นี้ให้สตาฟเห็นเพื่อรับของรางวัลทันทีที่เคาน์เตอร์ขอบสนามค่ะ! 🎉`;
    
    // Call the pushMessage simulator
    const currentLine = StorageService.get<LineMessage[]>('line_messages', []);
    const newMsg: LineMessage = {
      id: 'msg-' + Date.now(),
      recipientPhone: cleanPhone,
      recipientName: loggedInUser.name,
      text: lpMsg,
      timestamp: new Date().toISOString(),
      type: 'CONFIRMED'
    };
    StorageService.set('line_messages', [newMsg, ...currentLine]);
    setLineMessages([newMsg, ...currentLine]);

    notify(`🎉 แลกรางวัล "${reward.name}" สำเร็จ!\nระบบได้หักคะแนนคงเหลือของคุณ -${reward.cost} แต้ม\n\nรหัสคูปองสำหรับเคลมของคุณคือ: ${claimCode}\n(รายละเอียดและรหัสเคลมระบุไว้ในประวัติแลกด้านล่าง และส่งแจ้งเตือนเข้าทางช่องแชท LINE เรียบร้อยแล้วค่ะ!)`);
    
    onRefreshAll();
  };
  return {
    handleRedeemReward
  };
}
