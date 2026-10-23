// Permissions a role can have - the same list as the Go backend's
// model/permissions.go. The server enforces them on every call; here they
// only decide which screens, tabs and buttons to show.
import { User, UserRole } from './types';

export type Permission =
  | 'book_online' | 'counter_bookings' | 'verify_slips' | 'sell_rent' | 'shifts' | 'day_summary'
  | 'cancel_refund' | 'manage_products' | 'manage_members' | 'adjust_points' | 'manage_closures'
  | 'view_reports' | 'manage_courts' | 'edit_pricing' | 'manage_staff' | 'manage_roles' | 'view_audit_log';

// Display order and Thai labels for the roles screen.
export const PERMISSIONS: { id: Permission; label: string; hint: string }[] = [
  { id: 'book_online', label: 'จองสนามออนไลน์', hint: 'จองสนาม ส่งสลิป แลกแต้มรางวัล (สิทธิ์ของลูกค้า)' },
  { id: 'counter_bookings', label: 'จองหน้าเคาน์เตอร์', hint: 'จอง Walk-in, บันทึกไม่มาตามนัด, เห็นชื่อผู้จองในตาราง' },
  { id: 'verify_slips', label: 'ตรวจสลิป', hint: 'อนุมัติ / ปฏิเสธสลิปโอนเงินของลูกค้า' },
  { id: 'sell_rent', label: 'ขายของ / เช่าอุปกรณ์', hint: 'ขายอาหาร-เครื่องดื่ม, เช่า-คืนอุปกรณ์, จ่ายของรางวัล' },
  { id: 'shifts', label: 'เปิด-ปิดกะเงินสด', hint: 'เปิดกะ นับเงินสด ปิดกะ' },
  { id: 'day_summary', label: 'ยอดขายวันนี้', hint: 'ดูยอดสรุปของวันที่เคาน์เตอร์' },
  { id: 'cancel_refund', label: 'ยกเลิก / คืนเงิน', hint: 'ยกเลิกการจอง คืนเงิน บันทึกรับเงินสด/ชำระล่าช้า ยกเลิกบิลขาย' },
  { id: 'manage_products', label: 'จัดการสินค้า', hint: 'เพิ่มสินค้า แก้ราคา ปรับสต๊อก' },
  { id: 'manage_members', label: 'จัดการสมาชิก', hint: 'รายชื่อลูกค้าและระดับสมาชิก' },
  { id: 'adjust_points', label: 'ปรับแต้ม', hint: 'เพิ่ม/ลดแต้มสะสมด้วยมือ' },
  { id: 'manage_closures', label: 'วันปิดบริการ', hint: 'ปิดสนามทั้งวันหรือบางช่วงเวลา' },
  { id: 'view_reports', label: 'รายงาน', hint: 'แดชบอร์ด รายงานรายเดือน ประวัติกะ และเห็นยอดเงินสดที่ควรมีตอนปิดกะ' },
  { id: 'manage_courts', label: 'จัดการสนาม', hint: 'เพิ่ม เปลี่ยนชื่อ เปิด/ปิดรับจองสนาม' },
  { id: 'edit_pricing', label: 'ตั้งราคา', hint: 'กติการาคา ส่วนลดสมาชิก ราคาครึ่งสนาม ข้อมูลร้าน' },
  { id: 'manage_staff', label: 'จัดการบัญชีพนักงาน', hint: 'กำหนดบทบาทให้บัญชี ระงับ/เปิดใช้บัญชี' },
  { id: 'manage_roles', label: 'จัดการบทบาท', hint: 'สร้าง/แก้ไข/ลบบทบาทและสิทธิ์' },
  { id: 'view_audit_log', label: 'ดูบันทึกการใช้งาน', hint: 'Audit log ทุกการกระทำในระบบ' }
];

const STAFF: Permission[] = ['book_online', 'counter_bookings', 'verify_slips', 'sell_rent', 'shifts', 'day_summary'];
const MANAGER: Permission[] = [...STAFF, 'cancel_refund', 'manage_products', 'manage_members', 'adjust_points', 'manage_closures', 'view_reports'];

// Built-in roles (same rights as the server's seed). Used in browser-only
// mode, and as a fallback for a session stored before permissions existed.
export const BUILTIN_ROLE_PERMISSIONS: Record<string, Permission[]> = {
  [UserRole.CUSTOMER]: ['book_online'],
  [UserRole.STAFF]: STAFF,
  [UserRole.MANAGER]: MANAGER,
  [UserRole.ADMIN]: PERMISSIONS.map(p => p.id)
};

// Built-in role names (same as the server's seed) for browser-only mode and
// as the starting role list before the server's arrives.
export const BUILTIN_ROLES: { id: string; name: string; permissions: Permission[]; isBuiltin: true; userCount: number }[] = [
  { id: UserRole.CUSTOMER, name: 'ลูกค้า', permissions: BUILTIN_ROLE_PERMISSIONS[UserRole.CUSTOMER], isBuiltin: true, userCount: 0 },
  { id: UserRole.STAFF, name: 'พนักงานเคาน์เตอร์', permissions: BUILTIN_ROLE_PERMISSIONS[UserRole.STAFF], isBuiltin: true, userCount: 0 },
  { id: UserRole.MANAGER, name: 'ผู้จัดการ', permissions: BUILTIN_ROLE_PERMISSIONS[UserRole.MANAGER], isBuiltin: true, userCount: 0 },
  { id: UserRole.ADMIN, name: 'ผู้บริหาร (Admin)', permissions: BUILTIN_ROLE_PERMISSIONS[UserRole.ADMIN], isBuiltin: true, userCount: 0 }
];

export function permissionsOf(user: Pick<User, 'role' | 'permissions'> | null | undefined): Permission[] {
  if (!user) return [];
  return (user.permissions as Permission[] | undefined) ?? BUILTIN_ROLE_PERMISSIONS[user.role] ?? [];
}

// True if the user has any one of perms.
export function can(user: Pick<User, 'role' | 'permissions'> | null | undefined, ...perms: Permission[]): boolean {
  const mine = permissionsOf(user);
  return perms.some(p => mine.includes(p));
}

// True if perms hold a right the user lacks (book_online aside - every
// customer has it): the server's missingPermissions. Nobody grants such a
// role, or changes / suspends an account that has one.
export function outranks(perms: readonly string[], user: Pick<User, 'role' | 'permissions'> | null | undefined): boolean {
  const mine = permissionsOf(user);
  return perms.some(p => p !== 'book_online' && !mine.includes(p as Permission));
}

// Which screens a user may open: the counter (Staff POS) and settings (Admin).
export const COUNTER_PERMISSIONS: Permission[] = ['counter_bookings', 'verify_slips', 'sell_rent', 'shifts', 'day_summary', 'cancel_refund'];
export const SETTINGS_PERMISSIONS: Permission[] = ['manage_products', 'manage_members', 'adjust_points', 'manage_closures', 'view_reports', 'manage_courts', 'edit_pricing', 'manage_staff', 'manage_roles', 'view_audit_log'];
export const canUseCounter = (user: Pick<User, 'role' | 'permissions'> | null | undefined) => can(user, ...COUNTER_PERMISSIONS);
export const canUseSettings = (user: Pick<User, 'role' | 'permissions'> | null | undefined) => can(user, ...SETTINGS_PERMISSIONS);
