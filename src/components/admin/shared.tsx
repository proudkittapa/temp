import { AddAuditLog } from '../../types';
import { openingHours } from '../../mockData';
import { Permission } from '../../permissions';

// Bookable hours per court per day (dashboard occupancy).
export const hoursPerDay = () => { const { open, close } = openingHours(); return close - open; };

export interface AdminPanelProps {
  onAddAuditLog: AddAuditLog;
  triggerRefresh: number;
  onRefreshAll: () => void;
}

// Settings tabs and the permissions that open each (any one is enough).
export type AdminTab = 'dashboard' | 'pricing' | 'courts' | 'products' | 'users' | 'reports' | 'audit_logs' | 'member_discounts' | 'roles';

export const ADMIN_TABS: { id: AdminTab; label: string }[] = [
  { id: 'dashboard', label: '📊 แดชบอร์ด' },
  { id: 'pricing', label: '⚙️ Pricing Engine ตั้งราคา' },
  { id: 'courts', label: '🏟️ บริหารสนาม & วันปิดบริการ' },
  { id: 'products', label: '🥤 คุมตู้เครื่องดื่ม F&B' },
  { id: 'users', label: '👥 บัญชีสตาฟเวร' },
  { id: 'member_discounts', label: '🌟 ตั้งค่าสิทธิ์ส่วนลด (Membership Tiers)' },
  { id: 'reports', label: '📥 ออกรายงาน Excel' },
  { id: 'roles', label: '🔐 สิทธิ์และบทบาท' },
  { id: 'audit_logs', label: '🛡️ Audit Log ล็อกกลโกง' }
];

export const ADMIN_TAB_PERMISSIONS: Record<AdminTab, Permission[]> = {
  dashboard: ['view_reports'], pricing: ['edit_pricing'], courts: ['manage_closures', 'manage_courts'],
  products: ['manage_products'], users: ['manage_members', 'adjust_points', 'manage_staff'],
  member_discounts: ['edit_pricing'], reports: ['view_reports'], roles: ['manage_roles'], audit_logs: ['view_audit_log']
};

// Custom simple helper icons inside layout
export function SettingChevron({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}
