import { CourtType, User, AddAuditLog } from '../../types';
import { formatDateTime } from '../../mockData';
import * as api from '../../api';

// How long an online booking waits for its slip before the backend cancels
// it (service.PaymentHoldDuration in the Go backend).
export const PAYMENT_HOLD_MINUTES = 30;

export interface CustomerPanelProps {
  onAddAuditLog: AddAuditLog;
  triggerRefresh: number;
  onRefreshAll: () => void;
  // One login for everyone: a staff/admin account signed in here is handed
  // to App, which opens the screen its role may use.
  onStaffSignIn?: (user: User) => void;
}

export interface Reward {
  id: string;
  name: string;
  cost: number;
  description: string;
  emoji: string;
}

export interface Redemption {
  id: string;
  status?: 'ACTIVE' | 'REDEEMED' | 'EXPIRED' | 'CANCELLED';
  userId: string;
  userName: string;
  rewardId: string;
  rewardKind?: string; // FREE_OFFPEAK_HOUR for a free court hour (API mode)
  rewardName: string;
  pointsSpent: number;
  claimCode: string;
  redeemedAt: string;
}

// The LINE chat preview simulates notifications that aren't sent yet (see
// TODO.md item 2): demo and dev builds only, never a real customer site.
export const SHOW_LINE_SIM = !(import.meta.env.PROD && api.USE_BACKEND);

export const COURT_TYPE_LABEL: Record<CourtType, string> = {
  [CourtType.BADMINTON]: '🏸 แบดมินตัน',
  [CourtType.BASKETBALL]: '🏀 บาสเกตบอล',
  [CourtType.PICKLEBALL]: '🏓 พิกเคิลบอล',
  [CourtType.MEETING_ROOM]: '👥 ห้องประชุม'
};

// LINE message times: ISO timestamps, shown in Bangkok time. Older saved
// messages stored only a local time string ("13:56:02"); show those as-is.
export function lineMessageTime(ts: string): string {
  if (!ts) return '';
  return isNaN(new Date(ts).getTime()) ? ts : formatDateTime(ts);
}

export const LOYALTY_REWARDS: Reward[] = [
  { id: 'water', name: "น้ำดื่มเย็น 1 ขวด", cost: 5, description: "รับที่เคาน์เตอร์", emoji: "🥤" },
  { id: 'sponsor', name: "เครื่องดื่มเกลือแร่ 1 ขวด", cost: 8, description: "รับที่เคาน์เตอร์", emoji: "⚡" },
  { id: 'towel', name: "เช่าผ้าขนหนูฟรี 1 ผืน", cost: 10, description: "รับที่เคาน์เตอร์", emoji: "🧼" },
  { id: 'court', name: "เล่นฟรี 1 ชั่วโมง (ช่วงนอกพีค)", cost: 25, description: "แจ้งรหัสที่เคาน์เตอร์เพื่อจอง", emoji: "🏸" }
];

export type SlotState =
| { kind: 'booked'; pending: boolean; mine: boolean }
| { kind: 'closed'; reason: string }
| { kind: 'started' }
| { kind: 'peakBlocked' }
| { kind: 'notOpen' }
| { kind: 'free' | 'selected'; price: number; isPeak: boolean; isOffPeak: boolean };
