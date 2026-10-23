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
  { id: 'water', name: "น้ำแร่ภูเขาแช่เย็น (Free Mineral Water)", cost: 5, description: "น้ำดื่มสุขภาพเย็นฉ่ำขวดใหญ่ ดับกระหายลุยศึกซูเปอร์แมตช์", emoji: "🥤" },
  { id: 'sponsor', name: "เกลือแร่สปอนเซอร์ (Free Energy Drink)", cost: 8, description: "เพิ่มประจุพลังงานฟิตเต็มร้อยพร้อมเสิร์ฟตบคีย์สปีดสปอร์ต", emoji: "⚡" },
  { id: 'towel', name: "ผ้าขนหนูเช่าซักสะอาดยกชุด (Free Towel Rental)", cost: 10, description: "สิทธิ์ผ้าเช็ดตัวไมโครไฟเบอร์ นิ่มเนียน สะอาดแห้งอบโอโซน", emoji: "🧼" },
  { id: 'court', name: "เช่าสนามฟรี 1 สล็อต Off-Peak (Free 1-Hr Court)", cost: 25, description: "ยกเว้นค่าธรรมเนียมสนามในช่วงเวลา Off-Peak 1 ชั่วโมงเต็ม", emoji: "🏸" }
];

export type SlotState =
| { kind: 'booked'; pending: boolean; mine: boolean }
| { kind: 'closed'; reason: string }
| { kind: 'started' }
| { kind: 'peakBlocked' }
| { kind: 'notOpen' }
| { kind: 'free' | 'selected'; price: number; isPeak: boolean; isOffPeak: boolean };
