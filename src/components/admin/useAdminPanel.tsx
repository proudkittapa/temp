import React, { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import {
  Court, CourtType, PricingRule, DayType, PriceType,
  User, UserRole, MemberType, Booking, BookingStatus,
  Payment, Product, ProductCat, Order, OrderStatus, OrderType, AuditLog, DayOff, MemberDiscountRule, PricingConfig, LedgerEntryType, AddAuditLog
} from '../../types';
import { StorageService, getTodayDateStr, DEFAULT_MEMBER_DISCOUNTS, courtsConflict, memberTierLabel, openingHours, openSlotHours, isPaidBooking, lastBookableDate, roundBaht, formatBaht, localDateOf, bangkokStamp } from '../../mockData';
import * as api from '../../api';
import { notify, ask, askText } from '../Dialog';
import { can, canUseSettings, Permission, BUILTIN_ROLES } from '../../permissions';
import { createContext, useContext } from 'react';

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



// State and handlers of AdminPanel (moved here as they were). The panel
// and its tab components read them through AdminPanelContext.
export function useAdminPanel({ onAddAuditLog, triggerRefresh, onRefreshAll }: AdminPanelProps) {
  const [courts, setCourts] = useState<Court[]>([]);
  const [pricingRules, setPricingRules] = useState<PricingRule[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  // Menu tab state
  const [activeAdminTab, setActiveAdminTab] = useState<AdminTab>('dashboard');
  const [memberDiscounts, setMemberDiscounts] = useState<MemberDiscountRule[]>([]);

  // Search filters
  const [auditSearch, setAuditSearch] = useState<string>('');
  const [auditTypeFilter, setAuditTypeFilter] = useState<string>('ALL');
  const [reportsMonth, setReportsMonth] = useState<string>(() => getTodayDateStr().slice(5, 7));
  const [reportsYear, setReportsYear] = useState<string>(() => getTodayDateStr().slice(0, 4));
  const [dashboardSelectedDate, setDashboardSelectedDate] = useState<string>(() => getTodayDateStr());
  const [dashboardSelectedSport, setDashboardSelectedSport] = useState<CourtType>(CourtType.BADMINTON);

  // Pricing edit dialog state
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleCourtType, setRuleCourtType] = useState<CourtType>(CourtType.BADMINTON);
  const [ruleDayType, setRuleDayType] = useState<DayType>(DayType.WEEKDAY);
  const [ruleStartHour, setRuleStartHour] = useState<number>(17);
  const [ruleEndHour, setRuleEndHour] = useState<number>(22);
  const [rulePrice, setRulePrice] = useState<number>(300);
  const [rulePriceType, setRulePriceType] = useState<PriceType>(PriceType.PEAK);
  const [ruleLabel, setRuleLabel] = useState<string>('');

  // Pricing tab column filters
  const [filterCourtType, setFilterCourtType] = useState<string>('');
  const [filterPriceType, setFilterPriceType] = useState<string>('');
  const [filterDayType, setFilterDayType] = useState<string>('');
  const [filterLabel, setFilterLabel] = useState<string>('');

  // Manage Courts state
  const [newCourtName, setNewCourtName] = useState<string>('');
  const [newCourtType, setNewCourtType] = useState<CourtType>(CourtType.BADMINTON);
  const [newCourtAllowHalf, setNewCourtAllowHalf] = useState<boolean>(false);
  const [newCourtHalfOf, setNewCourtHalfOf] = useState<string>(''); // the full court a half court belongs to

  // Manage Special Day-Off state
  const [daysOff, setDaysOff] = useState<DayOff[]>([]);
  const [newDayOffDate, setNewDayOffDate] = useState<string>('');
  const [newDayOffCourtId, setNewDayOffCourtId] = useState<string>('all');
  const [newDayOffReason, setNewDayOffReason] = useState<string>('');
  const [newDayOffIsFullDay, setNewDayOffIsFullDay] = useState<boolean>(true);
  const [newDayOffStartHour, setNewDayOffStartHour] = useState<number>(7);
  const [newDayOffEndHour, setNewDayOffEndHour] = useState<number>(22);

  // User edit state
  const [newUserRole, setNewUserRole] = useState<UserRole>(UserRole.STAFF);
  
  // Advanced User Management States
  const [userIdToPromote, setUserIdToPromote] = useState<string>('');
  const [userSearchQuery, setUserSearchQuery] = useState<string>('');
  const [userRoleFilter, setUserRoleFilter] = useState<string>('');
  const [userTierFilter, setUserTierFilter] = useState<string>('');
  const [userPendingChanges, setUserPendingChanges] = useState<Record<string, { role: UserRole; memberType: MemberType }>>({});

  // Discount rule edit state
  const [editingDiscounts, setEditingDiscounts] = useState<Record<string, { name: string; discountPercent: number; isActive: boolean }>>({});

  const handleStageDiscountField = (id: string, field: 'name' | 'discountPercent' | 'isActive', value: string | boolean) => {
    setEditingDiscounts(prev => {
      const current = prev[id] || {
        name: memberDiscounts.find(d => d.id === id)?.name || '',
        discountPercent: memberDiscounts.find(d => d.id === id)?.discountPercent || 0,
        isActive: memberDiscounts.find(d => d.id === id)?.isActive ?? true
      };
      
      let processedVal: string | number | boolean = value;
      if (field === 'discountPercent') {
        // Below 100%: a free booking would need a 0.00 THB PromptPay QR,
        // which banking apps reject (the server enforces the same limit).
        processedVal = Math.min(99, Math.max(0, parseInt(String(value), 10) || 0));
      }
      
      return {
        ...prev,
        [id]: {
          ...current,
          [field]: processedVal
        }
      };
    });
  };

  const handleSaveDiscountTier = (id: MemberType) => {
    const staged = editingDiscounts[id];
    if (!staged) return;

    const original = memberDiscounts.find(d => d.id === id);
    if (!original) return;

    if (api.USE_BACKEND) {
      return api.updateMemberDiscount({ ...original, name: staged.name, discountPercent: staged.discountPercent, isActive: staged.isActive })
        .then(() => {
          setEditingDiscounts(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          onAddAuditLog('MEMBER_DISCOUNT_PERCENT_MODIFIED', 'PricingRule', id,
            { name: original.name, discountPercent: original.discountPercent, isActive: original.isActive },
            { name: staged.name, discountPercent: staged.discountPercent, isActive: staged.isActive });
          onRefreshAll(); // reloads pricing from the server
          notify(`บันทึกการตั้งราคา/เปอร์เซ็นต์ส่วนลดสำหรับ '${staged.name}' เรียบร้อยแล้วค่ะ!`);
        })
        .catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }

    const updatedList = memberDiscounts.map(d => {
      if (d.id === id) {
        return {
          ...d,
          name: staged.name,
          discountPercent: staged.discountPercent,
          isActive: staged.isActive
        };
      }
      return d;
    });

    StorageService.set('member_discounts', updatedList);
    setMemberDiscounts(updatedList);
    setEditingDiscounts(prev => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });

    onAddAuditLog(
      'MEMBER_DISCOUNT_PERCENT_MODIFIED',
      'PricingRule',
      id,
      { name: original.name, discountPercent: original.discountPercent, isActive: original.isActive },
      { name: staged.name, discountPercent: staged.discountPercent, isActive: staged.isActive }
    );
    onRefreshAll();
    notify(`บันทึกการตั้งราคา/เปอร์เซ็นต์ส่วนลดสำหรับ '${staged.name}' เรียบร้อยแล้วค่ะ!`);
  };

  // API mode: the dashboard and its court grid come from the server.
  const [dash, setDash] = useState<api.DashboardData | null>(null);
  const [dashBookings, setDashBookings] = useState<Booking[]>([]);
  // Size chosen for a per-size (shoes) stock change, by product id.
  const [stockVariantSel, setStockVariantSel] = useState<Record<string, string>>({});

  // Product edit state
  const [newProductName, setNewProductName] = useState<string>('');
  const [newProductCat, setNewProductCat] = useState<ProductCat>(ProductCat.FB);
  const [newProductPrice, setNewProductPrice] = useState<number>(20);
  const [newProductStock, setNewProductStock] = useState<number>(50);
  // Equipment can be sold (shuttlecocks) or rented out (rackets, shoes).
  const [newProductIsRental, setNewProductIsRental] = useState<boolean>(false);
  const [newProductDeposit, setNewProductDeposit] = useState<number>(0);

  // Load state from localStorage on triggerRefresh
  useEffect(() => {
    // In API mode courts, like the rest below, come from the backend.
    if (!api.USE_BACKEND) setCourts(StorageService.get<Court[]>('courts', []));
    if (!api.USE_BACKEND) setPricingRules(StorageService.get<PricingRule[]>('pricing_rules', []));
    if (!api.USE_BACKEND) setProducts(StorageService.get<Product[]>('products', []));
    // In API mode the user list comes from the backend (see the effect below).
    if (!api.USE_BACKEND) setUsers(StorageService.get<User[]>('users', []));
    setBookings(StorageService.get<Booking[]>('bookings', []));
    setPayments(StorageService.get<Payment[]>('payments', []));
    setOrders(StorageService.get<Order[]>('orders', []));
    if (!api.USE_BACKEND) setAuditLogs(StorageService.get<AuditLog[]>('audit_logs', []));
    if (!api.USE_BACKEND) setDaysOff(StorageService.get<DayOff[]>('days_off', []));
    if (!api.USE_BACKEND) setMemberDiscounts(StorageService.get<MemberDiscountRule[]>('member_discounts', DEFAULT_MEMBER_DISCOUNTS));
  }, [triggerRefresh]);


  // Bookings shown in the dashboard's court grid.
  const gridBookings = api.USE_BACKEND ? dashBookings : bookings;

  // Calculations for Dashboards
  const getDashboardStats = () => {
    if (api.USE_BACKEND) {
      return {
        allTimeRevenue: roundBaht((dash?.allTimeBookingSales ?? 0) + (dash?.allTimeOrderSales ?? 0)),
        bookingSales: dash?.allTimeBookingSales ?? 0,
        fbSales: dash?.allTimeOrderSales ?? 0,
        customerCount: dash?.customerCount ?? 0,
        occupancyRate: dash?.occupancyRate ?? 0,
        dailyBookingsCount: dash?.dailyBookingsCount ?? 0,
        dailyBookingsRevenue: dash?.dailyBookingsRevenue ?? 0,
        dailyOrderRevenue: dash?.dailyOrderRevenue ?? 0,
        dailyTotalRevenue: dash?.dailyTotalRevenue ?? 0,
        pendingRevenue: dash?.pendingRevenue ?? 0,
        refunds: dash?.allTimeRefunds ?? 0
      };
    }
    const targetDateStr = dashboardSelectedDate;
    
    // Daily target date metrics
    const dailyBookings = bookings.filter(b => b.date === targetDateStr && isPaidBooking(b));
    const dailyBookingsRevenue = dailyBookings.reduce((sum, b) => sum + Number(b.totalAmount), 0);

    const dailyOrders = orders.filter(o => {
      const orderDate = localDateOf(o.createdAt);
      return orderDate === targetDateStr && o.status !== OrderStatus.CANCELLED;
    });
    const dailyOrderRevenue = dailyOrders.reduce((sum, o) => sum + Number(o.totalAmount), 0);

    // Occupancy on dashboardSelectedDate: share of physical court-hours sold
    // (a half-court booking fills half of its court).
    const occupancyRate = Math.round(occupiedShare(dailyBookings) / (physicalCourtCount() * hoursPerDay() || 1) * 1000) / 10;

    // All-time Metrics
    const confirmedBookings = bookings.filter(b => isPaidBooking(b));
    const totalBookingsRevenue = confirmedBookings.reduce((sum, b) => sum + Number(b.totalAmount), 0);

    // All time F&B products sale receipt amount
    const totalOrderRevenue = orders.filter(o => o.status !== OrderStatus.CANCELLED).reduce((sum, o) => sum + Number(o.totalAmount), 0);

    // Total active registered member accounts count
    const activeMembersCount = users.filter(u => u.role === UserRole.CUSTOMER).length;

    return {
      allTimeRevenue: totalBookingsRevenue + totalOrderRevenue,
      bookingSales: totalBookingsRevenue,
      fbSales: totalOrderRevenue,
      customerCount: activeMembersCount,
      occupancyRate,
      dailyBookingsCount: dailyBookings.length,
      dailyBookingsRevenue,
      dailyOrderRevenue,
      dailyTotalRevenue: dailyBookingsRevenue + dailyOrderRevenue,
      pendingRevenue: roundBaht(bookings.filter(b => b.status === BookingStatus.PENDING_PAYMENT).reduce((sum, b) => sum + Number(b.totalAmount), 0)),
      refunds: roundBaht(payments.reduce((sum, p) => sum + (p.refundAmount || 0), 0))
    };
  };

  // Physical courts: a full court and its half-court sides share one
  // mutex group and count once.
  const physicalCourtCount = () => api.USE_BACKEND ? dash?.physicalCourts ?? 0 : new Set(courts.map(c => c.mutexGroupId || c.id)).size;
  // A no-show hour that a later paid booking re-used (same or conflicting
  // court) is filled by that booking: counted once, as the server's report.
  const occupiedShare = (list: Booking[]) => {
    const reused = (ns: Booking) => {
      const nsCourt = courts.find(c => c.id === ns.courtId);
      return bookings.some(r => r.id !== ns.id && r.date === ns.date && r.startTime === ns.startTime && isPaidBooking(r) &&
        r.createdAt > ns.createdAt && (r.courtId === ns.courtId || (!!nsCourt && !!courts.find(c => c.id === r.courtId) &&
          courtsConflict(nsCourt, courts.find(c => c.id === r.courtId)!))));
    };
    return list.reduce((sum, b) => b.status === BookingStatus.NO_SHOW && reused(b) ? sum
      : sum + (courts.find(c => c.id === b.courtId)?.shareOfGroup ?? 1), 0);
  };

  // Recharts chart data, all from recorded bookings and orders: the six
  // months up to the dashboard date.
  const getRevenueChartData = () => {
    const monthNames = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
    if (api.USE_BACKEND) {
      return (dash?.monthlyRevenue || []).map(r => {
        const [y, m] = r.month.split('-').map(Number);
        return { name: `${monthNames[m - 1]} ${y}`, 'รายได้ค่าคอร์ท': r.bookings, 'รายได้เครื่องดื่ม/เช่าแร็ก': r.orders };
      });
    }
    const [y, m] = dashboardSelectedDate.split('-').map(Number);
    return Array.from({ length: 6 }, (_, i) => {
      const d = new Date(y, m - 1 - (5 - i), 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      return {
        name: `${monthNames[d.getMonth()]} ${d.getFullYear()}`,
        'รายได้ค่าคอร์ท': roundBaht(bookings.filter(b => b.date.startsWith(key) && isPaidBooking(b)).reduce((s, b) => s + Number(b.totalAmount), 0)),
        'รายได้เครื่องดื่ม/เช่าแร็ก': roundBaht(orders.filter(o => localDateOf(o.createdAt).startsWith(key) && o.status !== OrderStatus.CANCELLED).reduce((s, o) => s + Number(o.totalAmount), 0))
      };
    });
  };

  // Average occupancy per hour over the 30 days up to the dashboard date.
  const getDayCapacityChartData = () => {
    if (api.USE_BACKEND) return (dash?.hourlyOccupancy || []).map(h => ({ hourName: h.hour, 'เฉลี่ยอัตรา (%)': h.percent }));
    const end = dashboardSelectedDate;
    const startD = new Date(`${end}T00:00:00`);
    startD.setDate(startD.getDate() - 29);
    const start = `${startD.getFullYear()}-${String(startD.getMonth() + 1).padStart(2, '0')}-${String(startD.getDate()).padStart(2, '0')}`;
    const inRange = bookings.filter(b => b.date >= start && b.date <= end && isPaidBooking(b));
    const capacity = physicalCourtCount() * 30 || 1;
    const out = [];
    for (const label of openSlotHours()) {
      out.push({ hourName: label, 'เฉลี่ยอัตรา (%)': Math.round(occupiedShare(inRange.filter(b => b.startTime === label)) / capacity * 100) });
    }
    return out;
  };

  // F&B / rental split of counter sales, by the sold products' category.
  const getPieChartData = () => {
    let food = 0, equipment = 0, rental = 0;
    if (api.USE_BACKEND) ({ food, equipment, rental } = dash?.salesSplit ?? { food: 0, equipment: 0, rental: 0 });
    else
    orders.filter(o => o.status !== OrderStatus.CANCELLED).forEach(o => o.items.forEach(it => {
      const prod = products.find(p => p.id === it.productId);
      const amount = it.qty * it.unitPrice;
      if (prod?.isRental || o.type === OrderType.EQUIPMENT_RENT) rental += amount;
      else if (prod?.category === ProductCat.EQUIPMENT) equipment += amount;
      else food += amount;
    }));
    return [
      { name: 'อาหารและเครื่องดื่ม', value: roundBaht(food) },
      { name: 'อุปกรณ์กีฬา (ขาย)', value: roundBaht(equipment) },
      { name: 'ค่าเช่าอุปกรณ์', value: roundBaht(rental) }
    ];
  };

  const PIE_COLORS = ['#34d399', '#f59e0b', '#38bdf8'];

  // Opening hours (admin setting): first slot start / last slot end.
  const [openHourSetting, setOpenHourSetting] = useState<number>(() => openingHours().open);
  const [closeHourSetting, setCloseHourSetting] = useState<number>(() => openingHours().close);

  // Hours inside [open, close) that some sport has no price for on weekdays
  // or weekends - those can't be booked for that sport.
  const unpricedHours = (open: number, close: number) => {
    const gaps: string[] = [];
    for (const type of Object.values(CourtType)) {
      for (const day of [DayType.WEEKDAY, DayType.WEEKEND]) {
        const missing: number[] = [];
        for (let h = open; h < close; h++) {
          if (!pricingRules.some(r => r.isActive && r.courtType === type && r.dayType === day && h >= r.startHour && h < r.endHour)) missing.push(h);
        }
        if (missing.length) gaps.push(`${type} ${day === DayType.WEEKDAY ? 'วันธรรมดา' : 'เสาร์-อาทิตย์'}: ${missing.map(h => `${String(h).padStart(2, '0')}:00`).join(', ')}`);
      }
    }
    return gaps;
  };

  const handleSaveOpeningHours = async () => {
    const open = Number(openHourSetting), close = Number(closeHourSetting);
    if (!(open >= 0 && close <= 24 && open < close)) {
      notify('เวลาเปิดต้องน้อยกว่าเวลาปิด (0:00 - 24:00)');
      return;
    }
    const gaps = unpricedHours(open, close);
    if (gaps.length && !(await ask(`ชั่วโมงต่อไปนี้ยังไม่มีเรทราคา จะยังจองไม่ได้จนกว่าจะเพิ่มกฎราคา:\n${gaps.join('\n')}\n\nบันทึกเวลาเปิด-ปิดต่อไหม?`, { title: 'เวลาเปิด-ปิด', okLabel: 'บันทึก' }))) return;
    const done = () => {
      onAddAuditLog('OPENING_HOURS_UPDATED', 'PricingConfig', 'global', null, { openHour: open, closeHour: close });
      onRefreshAll();
      notify(`บันทึกเวลาเปิด-ปิด ${String(open).padStart(2, '0')}:00 - ${String(close).padStart(2, '0')}:00 แล้ว`);
    };
    if (api.USE_BACKEND) {
      return api.setOpeningHours(open, close).then(() => api.syncPricingCache()).then(done).catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }
    StorageService.set('pricing_config', { ...StorageService.get<PricingConfig>('pricing_config', { id: 'global', halfCourtRatePercent: 50 }), openHour: open, closeHour: close });
    done();
  };

  // How many days ahead customers may book online (admin setting).
  const [maxAdvanceDays, setMaxAdvanceDays] = useState<number>(() =>
    StorageService.get<{ maxAdvanceDays?: number }>('pricing_config', {}).maxAdvanceDays ?? 30);
  const handleSaveMaxAdvanceDays = () => {
    const days = Math.round(Number(maxAdvanceDays));
    if (!(days >= 1 && days <= 365)) {
      notify('กรุณาระบุ 1–365 วัน');
      return;
    }
    const before = StorageService.get<{ maxAdvanceDays?: number }>('pricing_config', {}).maxAdvanceDays;
    const done = () => {
      onAddAuditLog('PRICING_CONFIG_UPDATED', 'PricingConfig', 'global', { maxAdvanceDays: before }, { maxAdvanceDays: days });
      onRefreshAll();
      notify(`ตั้งค่าแล้ว: ลูกค้าจองออนไลน์ล่วงหน้าได้ ${days} วัน (ถึง ${lastBookableDate()})`);
    };
    if (api.USE_BACKEND) {
      return api.setMaxAdvanceDays(days).then(() => api.syncPricingCache()).then(done).catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }
    StorageService.set('pricing_config', { ...StorageService.get('pricing_config', {}), maxAdvanceDays: days });
    done();
  };

  // Business details printed on receipts and shown on the payment screen.
  const emptyBusiness = { name: '', address: '', phone: '', taxId: '', vatRegistered: false };
  const businessFrom = (c: Partial<PricingConfig>) => ({
    name: c.businessName ?? '', address: c.businessAddress ?? '', phone: c.businessPhone ?? '',
    taxId: c.businessTaxId ?? '', vatRegistered: !!c.vatRegistered,
  });
  const [business, setBusiness] = useState(() => ({ ...emptyBusiness, ...businessFrom(StorageService.get<Partial<PricingConfig>>('pricing_config', {})) }));
  const handleSaveBusiness = () => {
    const b = { name: business.name.trim(), address: business.address.trim(), phone: business.phone.trim(),
      taxId: business.taxId.replace(/\D/g, ''), vatRegistered: business.vatRegistered };
    if (b.taxId && b.taxId.length !== 13) {
      notify('เลขประจำตัวผู้เสียภาษีต้องมี 13 หลัก');
      return;
    }
    if (b.vatRegistered && (!b.name || !b.address || !b.taxId)) {
      notify('ถ้าจด VAT ต้องใส่ชื่อ ที่อยู่ และเลขประจำตัวผู้เสียภาษี');
      return;
    }
    const before = businessFrom(StorageService.get<Partial<PricingConfig>>('pricing_config', {}));
    const done = () => {
      onAddAuditLog('BUSINESS_INFO_UPDATED', 'PricingConfig', 'global', before, b);
      setBusiness(b);
      onRefreshAll();
      notify('บันทึกข้อมูลร้านแล้ว');
    };
    if (api.USE_BACKEND) {
      return api.updateBusiness(b).then(() => api.syncPricingCache()).then(done).catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }
    StorageService.set('pricing_config', { ...StorageService.get('pricing_config', {}), businessName: b.name, businessAddress: b.address,
      businessPhone: b.phone, businessTaxId: b.taxId, vatRegistered: b.vatRegistered });
    done();
  };

  // Pricing CRUD functions
  const handleSavePricingRule = (e: React.FormEvent) => {
    e.preventDefault();

    // Same limits as the server: a rule covers part of 00:00-24:00 (only
    // the part inside the opening hours can be booked), and a free hour
    // can't be paid by PromptPay.
    if (ruleStartHour < 0 || ruleEndHour > 24 || ruleStartHour >= ruleEndHour) {
      notify('ช่วงเวลาต้องอยู่ระหว่าง 0:00 - 24:00 และเวลาเริ่มต้องน้อยกว่าเวลาสิ้นสุด');
      return;
    }
    if (!(Number(rulePrice) > 0)) {
      notify('ราคาต่อชั่วโมงต้องมากกว่า 0 บาท');
      return;
    }

    const ruleId = editingRuleId || 'rule-' + Date.now();
    
    const newRule: PricingRule = {
      id: ruleId,
      courtType: ruleCourtType,
      dayType: ruleDayType,
      startHour: Number(ruleStartHour),
      endHour: Number(ruleEndHour),
      pricePerHour: Number(rulePrice),
      priceType: rulePriceType,
      label: ruleLabel || `${ruleCourtType} (${rulePriceType})`,
      isActive: true
    };

    if (api.USE_BACKEND) {
      const existing = editingRuleId ? pricingRules.find(r => r.id === editingRuleId) : undefined;
      return api.savePricingRule({ ...newRule, id: editingRuleId || '', isActive: existing ? existing.isActive : true })
        .then(saved => {
          onAddAuditLog(editingRuleId ? 'PRICING_UPDATED' : 'PRICING_CREATED', 'PricingRule', saved.id, existing ?? null, saved);
          setEditingRuleId(null);
          setRuleLabel('');
          setRulePrice(200);
          onRefreshAll(); // reloads pricing from the server
          notify('บันทึกกติกาตั้งราคาเรียบร้อย! มีผลทันทีในกลไกเซิร์ฟเวอร์');
        })
        .catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }

    const currentRules = StorageService.get<PricingRule[]>('pricing_rules', []);
    const prevRule = editingRuleId ? currentRules.find(r => r.id === editingRuleId) : undefined;
    newRule.isActive = prevRule ? prevRule.isActive : true; // editing doesn't re-enable a rule
    // Two active rules for the same hour would make the price depend on
    // which one is found first; the server refuses this too.
    const clash = newRule.isActive && currentRules.find(r =>
      r.id !== editingRuleId && r.isActive && r.courtType === newRule.courtType && r.dayType === newRule.dayType &&
      r.startHour < newRule.endHour && newRule.startHour < r.endHour);
    if (clash) {
      notify(`ช่วงเวลาซ้อนกับกติกา "${clash.label}" (${clash.startHour}:00-${clash.endHour}:00) กรุณาแก้ไขหรือปิดกติกานั้นก่อน`);
      return;
    }
    let updated = [];
    
    if (editingRuleId) {
      updated = currentRules.map(r => r.id === editingRuleId ? newRule : r);
      onAddAuditLog('PRICING_UPDATED', 'PricingRule', ruleId, currentRules.find(r => r.id === editingRuleId), newRule);
    } else {
      updated = [...currentRules, newRule];
      onAddAuditLog('PRICING_CREATED', 'PricingRule', ruleId, null, newRule);
    }

    StorageService.set('pricing_rules', updated);
    setPricingRules(updated);

    // reset Form
    setEditingRuleId(null);
    setRuleLabel('');
    setRulePrice(200);
    onRefreshAll();
    notify('บันทึกกติกาตั้งราคาเรียบร้อย! มีผลทันทีในกลไกเซิร์ฟเวอร์');
  };

  const handleDeletePricingRule = async (id: string) => {
    if (!(await ask('ลบกฎราคานี้? ชั่วโมงที่กฎนี้ครอบคลุมจะจองไม่ได้จนกว่าจะมีกฎใหม่', { okLabel: 'ลบกฎราคา', danger: true }))) return;
    if (api.USE_BACKEND) {
      const ruleToDelete = pricingRules.find(r => r.id === id);
      return api.deletePricingRule(id)
        .then(() => {
          onAddAuditLog('PRICING_DELETED', 'PricingRule', id, ruleToDelete, null);
          onRefreshAll();
        })
        .catch(err => notify(`ลบไม่สำเร็จ: ${err.message}`));
    }
    const currentRules = StorageService.get<PricingRule[]>('pricing_rules', []);
    const ruleToDelete = currentRules.find(r => r.id === id);
    const updated = currentRules.filter(r => r.id !== id);

    StorageService.set('pricing_rules', updated);
    setPricingRules(updated);

    onAddAuditLog('PRICING_DELETED', 'PricingRule', id, ruleToDelete, null);
    onRefreshAll();
  };

  // Court Management functions
  const handleCreateCourt = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCourtName) return;
    // A half court shares a full court's floor: it must name that court, so
    // booking one blocks the other (as on the server).
    const fullCourt = newCourtAllowHalf ? courts.find(c => c.id === newCourtHalfOf && c.type === newCourtType && c.shareOfGroup >= 1) : undefined;
    if (newCourtAllowHalf && !fullCourt) {
      notify('ครึ่งสนามต้องเลือกว่าเป็นครึ่งของสนามเต็มสนามใด (ประเภทเดียวกัน)');
      return;
    }
    if (api.USE_BACKEND) {
      return api.createCourt({ name: newCourtName, type: newCourtType, halfCourt: newCourtAllowHalf, halfOf: fullCourt?.id })
        .then(c => {
          onAddAuditLog('COURT_CREATED', 'Court', c.id, null, c);
          setNewCourtName('');
          setNewCourtAllowHalf(false);
          setNewCourtHalfOf('');
          onRefreshAll();
          notify(`เพิ่มสนาม "${c.name}" แล้ว ลูกค้าและพนักงานจองได้ทันที`);
        })
        .catch(err => notify(`เพิ่มสนามไม่สำเร็จ: ${err.message}`));
    }
    const current = StorageService.get<Court[]>('courts', []);
    const cId = newCourtType.toLowerCase().substring(0, 3) + '-' + (current.length + 1) + '-' + Math.floor(100 + Math.random() * 900);
    const newC: Court = {
      id: cId,
      name: newCourtName,
      type: newCourtType,
      // A half court joins its full court's group (made on the spot if the
      // full court had none), priced at the half-court rate.
      shareOfGroup: newCourtAllowHalf ? 0.5 : 1,
      mutexGroupId: fullCourt ? (fullCourt.mutexGroupId || `grp-${fullCourt.id}`) : undefined,
      isActive: true,
      createdAt: new Date().toISOString()
    };
    const updated = [...current.map(c => fullCourt && c.id === fullCourt.id && !c.mutexGroupId ? { ...c, mutexGroupId: newC.mutexGroupId } : c), newC];
    StorageService.set('courts', updated);
    setCourts(updated);
    onAddAuditLog('COURT_CREATED', 'Court', newC.id, null, newC);
    setNewCourtName('');
    setNewCourtAllowHalf(false);
    setNewCourtHalfOf('');
    onRefreshAll();
    notify(`เพิ่มสนามกีฬา "${newC.name}" เข้าสู่คอมเพล็กซ์สำเร็จเรียบร้อยค่ะ!`);
  };

  // Rename a court (e.g. to match the signs on site). The id - which
  // bookings point at - never changes, so existing bookings keep working.
  const handleRenameCourt = async (id: string) => {
    const court = courts.find(c => c.id === id);
    if (!court) return;
    const name = (await askText(`ชื่อใหม่ของ "${court.name}"`, { title: 'เปลี่ยนชื่อสนาม', defaultValue: court.name, required: true, okLabel: 'บันทึกชื่อ' }))?.trim();
    if (!name || name === court.name) return;
    if (courts.some(c => c.id !== id && c.name.trim().toLowerCase() === name.toLowerCase())) {
      notify(`มีสนามชื่อ "${name}" อยู่แล้ว กรุณาใช้ชื่ออื่น`);
      return;
    }
    if (api.USE_BACKEND) {
      return api.updateCourt(id, { name })
        .then(r => {
          onAddAuditLog('COURT_RENAMED', 'Court', id, { name: court.name }, { name: r.court.name });
          onRefreshAll();
          notify(`เปลี่ยนชื่อเป็น "${r.court.name}" แล้ว`);
        })
        .catch(err => notify(`เปลี่ยนชื่อไม่สำเร็จ: ${err.message}`));
    }
    const updated = StorageService.get<Court[]>('courts', []).map(c => c.id === id ? { ...c, name } : c);
    StorageService.set('courts', updated);
    setCourts(updated);
    onAddAuditLog('COURT_RENAMED', 'Court', id, { name: court.name }, { name });
    onRefreshAll();
  };

  // Open/close a court for new bookings. Courts are never deleted: old
  // bookings and reports point at them.
  const handleToggleCourtActive = async (id: string) => {
    if (api.USE_BACKEND) {
      const court = courts.find(c => c.id === id);
      if (!court) return;
      if (court.isActive && !(await ask(`ปิด "${court.name}" ไม่ให้จองใหม่?\n(การจองที่มีอยู่แล้วจะถามต่อว่าจะยกเลิกหรือไม่)`, { okLabel: 'ปิดสนาม', danger: true }))) return;
      return api.updateCourt(id, { isActive: !court.isActive })
        .then(async r => {
          onAddAuditLog('COURT_TOGGLED_ACTIVE', 'Court', id, { active: court.isActive }, { active: r.court.isActive });
          onRefreshAll();
          if (r.upcoming.length > 0) {
            // The court takes no new bookings; offer to cancel the ones it
            // still has (FR-6.3), recording a refund for paid hours.
            const list = r.upcoming.map(b => `- ${b.date} ${b.startTime}–${b.endTime} ${b.userName} (${b.bookingCode})${b.status === BookingStatus.PENDING_PAYMENT ? ' ยังไม่ชำระ' : ''}`).join('\n');
            if (!(await ask(`ปิด "${r.court.name}" แล้ว แต่ยังมีการจอง ${r.upcoming.length} รายการ:\n${list}\n\nยกเลิกทั้งหมดเลยไหม? รายการที่ชำระแล้ว (หรือส่งสลิปแล้ว) จะถูกบันทึกว่าคืนเงิน (โอนคืนลูกค้าเอง)`, { title: 'การจองบนสนามที่ปิด', okLabel: 'ยกเลิกทั้งหมด', cancelLabel: 'เก็บไว้ ติดต่อลูกค้าเอง', danger: true }))) return;
            return (async () => {
              let refunded = 0, failed = 0;
              for (const b of r.upcoming) {
                try {
                  // refund=true: the server records a refund only of money it received
                  // (paid hours, or a slip still waiting), and ignores it otherwise.
                  const res = await api.cancelBooking(b.id, `ปิดสนาม ${r.court.name}`, true, [b.id], 'admin');
                  refunded += res.refundAmount;
                } catch {
                  failed++;
                }
              }
              onAddAuditLog('COURT_CLOSED_BOOKINGS_CANCELLED', 'Court', id, null, { cancelled: r.upcoming.length - failed, refunded });
              onRefreshAll();
              notify(`ยกเลิก ${r.upcoming.length - failed} รายการแล้ว${refunded ? ` · ต้องโอนคืนลูกค้ารวม ${formatBaht(refunded)} บาท` : ''}${failed ? ` · ไม่สำเร็จ ${failed} รายการ` : ''}`);
            })();
          }
        })
        .catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }
    const current = StorageService.get<Court[]>('courts', []);
    const updated = current.map(c => {
      if (c.id === id) {
        const nextState = !c.isActive;
        onAddAuditLog('COURT_TOGGLED_ACTIVE', 'Court', id, { active: c.isActive }, { active: nextState });
        return { ...c, isActive: nextState };
      }
      return c;
    });
    StorageService.set('courts', updated);
    setCourts(updated);
    onRefreshAll();
  };


  // API mode: closures live in the backend (which enforces them on every
  // booking), and changing them needs a manager/admin login.
  // The one shared session, if its role may use settings; a signed-in
  // account without such permissions gets the sign-in form with a note.
  const [adminUser, setAdminUser] = useState<User | null>(() => {
    const u = api.USE_BACKEND ? api.getSession('admin')?.user ?? null : null;
    return canUseSettings(u) ? u : null;
  });
  // Who is acting: the signed-in account (API mode) or the built-in ADMIN
  // role (browser-only mode, where this panel is the admin's). Tabs and
  // buttons follow its permissions; the server checks every call anyway.
  const actingAdmin = api.USE_BACKEND ? adminUser : { role: UserRole.ADMIN };
  // Roles for the role pickers and the roles tab: the server's (incl. ones
  // the admin made) in API mode, the built-ins in browser-only mode.
  const [roles, setRoles] = useState<api.RoleView[]>(BUILTIN_ROLES);
  const roleName = (id: string) => roles.find(r => r.id === id)?.name ?? id;
  const canManageAccounts = can(actingAdmin, 'manage_staff');
  const canManageCourts = can(actingAdmin, 'manage_courts');
  const adminTabAllowed = (t: AdminTab) => can(actingAdmin, ...ADMIN_TAB_PERMISSIONS[t]);
  const firstAdminTab = ADMIN_TABS.find(t => adminTabAllowed(t.id))?.id;
  useEffect(() => {
    if (!adminTabAllowed(activeAdminTab) && firstAdminTab) setActiveAdminTab(firstAdminTab);
  }, [activeAdminTab, firstAdminTab]);
  // One save at a time: a double click must not create two products,
  // closures, courts or pricing rules (the server doesn't refuse all such
  // duplicates). Wraps the button/form handlers; `busy` greys them.
  const busyRef = React.useRef(false);
  const [busy, setBusy] = useState(false);
  const guarded = <A extends unknown[]>(fn: (...args: A) => unknown) => async (...args: A) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await fn(...args); } finally { busyRef.current = false; setBusy(false); }
  };
  const [adminIdentity, setAdminIdentity] = useState<string>('');
  const [adminPassword, setAdminPassword] = useState<string>('');
  const [adminApiError, setAdminApiError] = useState<string | null>(null);

  // Effects key on the id and role: the session check below stores the
  // server's fresh copy of the user (a role changed by another admin takes
  // effect without signing in again).
  const adminUserId = adminUser?.id;
  const adminRole = adminUser?.role;
  useEffect(() => {
    if (!api.USE_BACKEND || !adminUserId) return;
    let cancelled = false;
    (async () => {
      try {
        const me = await api.refreshMe('admin');
        if (cancelled) return;
        if (!canUseSettings(me)) {
          setAdminUser(null);
          setAdminApiError('เซสชันผู้จัดการหมดอายุหรือไม่มีสิทธิ์ กรุณาเข้าสู่ระบบอีกครั้ง');
          return;
        }
        setAdminUser(me);
        const [closures, pricing, apiUsers, apiProducts, apiCourts, logs] = await Promise.all([
          // Each list only if the role may read it - a custom role missing
          // one permission must still get the rest of the panel.
          api.listDaysOff(getTodayDateStr()), api.syncPricingCache(),
          can(me, 'manage_members', 'adjust_points', 'manage_staff') ? api.listUsers() : Promise.resolve([] as User[]),
          can(me, 'manage_products') ? api.adminListProducts() : Promise.resolve([] as Product[]),
          can(me, 'manage_closures', 'manage_courts') ? api.adminListCourts() : api.listCourts(),
          can(me, 'view_audit_log') ? api.auditLogs({ limit: 500 }) : Promise.resolve([] as AuditLog[])
        ]);
        if (cancelled) return;
        if (can(me, 'manage_roles', 'manage_staff')) {
          api.listRoles().then(r => { if (!cancelled) setRoles(r); }).catch(() => {});
        }
        setDaysOff(closures);
        setUsers(apiUsers);
        setProducts(apiProducts);
        setCourts(apiCourts);
        setOpenHourSetting(pricing.config.openHour ?? 7);
        setCloseHourSetting(pricing.config.closeHour ?? 23);
        setAuditLogs(logs);
        setMaxAdvanceDays(pricing.config.maxAdvanceDays ?? 30);
        setBusiness(businessFrom(pricing.config));
        setPricingRules(pricing.rules);
        setMemberDiscounts(pricing.memberDiscounts);
        setAdminApiError(null);
      } catch (err) {
        if (!cancelled) setAdminApiError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [triggerRefresh, adminUserId, adminRole]);

  // The dashboard's date: its numbers, bookings and closures (the list
  // above has closures from today on only, so a past date needs its own).
  const [dashClosures, setDashClosures] = useState<DayOff[]>([]);
  const canSeeDashboard = can(adminUser, 'view_reports');
  useEffect(() => {
    if (!api.USE_BACKEND || !adminUserId || !canSeeDashboard) return;
    let cancelled = false;
    Promise.all([api.dashboard(dashboardSelectedDate), api.listBookingsByDate(dashboardSelectedDate, 'admin'),
      api.listDaysOff(dashboardSelectedDate, dashboardSelectedDate)])
      .then(([d, list, closures]) => {
        if (cancelled) return;
        setDash(d);
        setDashBookings(list);
        setDashClosures(closures);
        setAdminApiError(null);
      })
      .catch(err => {
        if (cancelled) return;
        // Don't leave the previous date's numbers under the new date.
        setDash(null);
        setDashBookings([]);
        setAdminApiError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [triggerRefresh, adminUserId, dashboardSelectedDate, canSeeDashboard]);

  const handleAdminLogout = () => {
    api.logout('admin');
    setAdminUser(null);
    setActiveAdminTab('dashboard');
  };

  const handleAdminLogin = (e: React.FormEvent) => {
    e.preventDefault();
    adminLoginWith(adminIdentity, adminPassword);
  };

  const adminLoginWith = (identity: string, password: string) => {
    setAdminApiError(null);
    api.login('admin', identity, password)
      .then(user => {
        if (!canUseSettings(user)) {
          setAdminApiError('บัญชีนี้ไม่มีสิทธิ์ใช้หน้าตั้งค่า - เข้าสู่ระบบด้วยบัญชีผู้จัดการหรือผู้บริหาร');
          return;
        }
        setAdminUser(user);
        setAdminIdentity('');
        setAdminPassword('');
      })
      .catch(err => setAdminApiError(err.message));
  };

  // DayOff / Special Holidays Settings functions
  const handleSaveDayOff = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDayOffDate || !newDayOffReason) return;
    
    if (!newDayOffIsFullDay && newDayOffStartHour >= newDayOffEndHour) {
      notify('⚠️ เวลาเริ่มต้นจะต้องน้อยกว่าเวลาสิ้นสุดการปิดบริการค่ะ กรุณากรอกใหม่');
      return;
    }

    if (api.USE_BACKEND) {
      return api.createDayOff({
        date: newDayOffDate,
        courtId: newDayOffCourtId,
        reason: newDayOffReason,
        isFullDay: newDayOffIsFullDay,
        startHour: newDayOffIsFullDay ? undefined : newDayOffStartHour,
        endHour: newDayOffIsFullDay ? undefined : newDayOffEndHour
      })
        .then(async ({ dayOff, affectedBookings }) => {
          onAddAuditLog('DAY_OFF_CREATED', 'DayOff', dayOff.id, null, dayOff);
          setNewDayOffDate('');
          setNewDayOffReason('');
          setNewDayOffIsFullDay(true);
          setNewDayOffStartHour(7);
          setNewDayOffEndHour(22);
          onRefreshAll();
          // A closure blocks new bookings only; existing ones still stand.
          const affectedNote = affectedBookings.length > 0
            ? `\n\n⚠️ มีการจองเดิม ${affectedBookings.length} รายการในช่วงเวลาที่ปิด (ยังไม่ถูกยกเลิก) กรุณาติดต่อลูกค้า:\n` +
              affectedBookings.map(b => `- ${courts.find(c => c.id === b.courtId)?.name || b.courtId} ${b.startTime}–${b.endTime} (${b.bookingCode})`).join('\n')
            : '';
          notify('บันทึกปิดบริการ/ระงับการจองวันหยุดพิเศษเรียบร้อยแล้วค่ะ!' + affectedNote);
          // Offer to cancel the overlapped bookings right away (FR-6.3),
          // recording a refund for hours that were already paid.
          const active = affectedBookings.filter(b => b.status === BookingStatus.CONFIRMED || b.status === BookingStatus.PENDING_PAYMENT);
          if (active.length > 0 && await ask(`ยกเลิกการจองที่ได้รับผลกระทบ ${active.length} รายการเลยไหม?\nรายการที่ชำระแล้ว (หรือส่งสลิปแล้ว) จะถูกบันทึกว่าคืนเงิน (โอนคืนลูกค้าเอง)`, { okLabel: 'ยกเลิกทั้งหมด', cancelLabel: 'เก็บไว้', danger: true })) {
            return (async () => {
              let refunded = 0, failed = 0;
              for (const b of active) {
                try {
                  // refund=true: the server records a refund only of money it received
                  // (paid hours, or a slip still waiting), and ignores it otherwise.
                  const res = await api.cancelBooking(b.id, `ปิดสนาม: ${dayOff.reason}`, true, [b.id], 'admin');
                  refunded += res.refundAmount;
                } catch {
                  failed++;
                }
              }
              onAddAuditLog('DAY_OFF_BOOKINGS_CANCELLED', 'DayOff', dayOff.id, null, { cancelled: active.length - failed, refunded });
              onRefreshAll();
              notify(`ยกเลิก ${active.length - failed} รายการแล้ว${refunded ? ` · ต้องโอนคืนลูกค้ารวม ${formatBaht(refunded)} บาท` : ''}${failed ? ` · ไม่สำเร็จ ${failed} รายการ` : ''}`);
            })();
          }
        })
        .catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }

    const current = StorageService.get<DayOff[]>('days_off', []);
    const newDay: DayOff = {
      id: 'do-' + Date.now(),
      date: newDayOffDate,
      courtId: newDayOffCourtId,
      reason: newDayOffReason,
      isFullDay: newDayOffIsFullDay,
      startHour: newDayOffIsFullDay ? undefined : newDayOffStartHour,
      endHour: newDayOffIsFullDay ? undefined : newDayOffEndHour
    };
    const updated = [...current, newDay];
    StorageService.set('days_off', updated);
    setDaysOff(updated);
    onAddAuditLog('DAY_OFF_CREATED', 'DayOff', newDay.id, null, newDay);
    
    setNewDayOffDate('');
    setNewDayOffReason('');
    setNewDayOffIsFullDay(true);
    setNewDayOffStartHour(7);
    setNewDayOffEndHour(22);
    onRefreshAll();
    notify('บันทึกปิดบริการ/ระงับการจองวันหยุดพิเศษเรียบร้อยแล้วค่ะ!');
  };

  const handleDeleteDayOff = async (id: string) => {
    if (!(await ask('ลบวันปิดนี้ และเปิดให้จองตามปกติ?', { okLabel: 'ลบวันปิด' }))) return;
    if (api.USE_BACKEND) {
      return api.deleteDayOff(id)
        .then(() => {
          onAddAuditLog('DAY_OFF_DELETED', 'DayOff', id, null, null);
          onRefreshAll();
          notify('ปลดบล็อกช่วงวันหยุดพิเศษและเปิดให้บริการปกติแล้วค่ะ');
        })
        .catch(err => notify(`ลบไม่สำเร็จ: ${err.message}`));
    }
    const current = StorageService.get<DayOff[]>('days_off', []);
    const updated = current.filter(item => item.id !== id);
    StorageService.set('days_off', updated);
    setDaysOff(updated);
    onAddAuditLog('DAY_OFF_DELETED', 'DayOff', id, null, null);
    onRefreshAll();
    notify('ปลดบล็อกช่วงวันหยุดพิเศษและเปิดให้บริการปกติแล้วค่ะ');
  };


  // User Management actions (Promote existing registered users to staff operator role)
  const handlePromoteUser = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userIdToPromote) {
      notify('🔒 กรุณาเลือกผู้ใช้ที่มีในระบบเพื่อใช้ลากเลื่อนระดับสิทธิ์ปฏิบัติงานเวร!');
      return;
    }

    if (api.USE_BACKEND) {
      const before = users.find(u => u.id === userIdToPromote);
      return api.setUserRole(userIdToPromote, newUserRole)
        .then(updated => {
          setUsers(prev => prev.map(u => (u.id === updated.id ? updated : u)));
          onAddAuditLog('USER_PROMOTED_TO_OPERATOR_BY_ADMIN', 'User', updated.id, before ?? null, updated);
          setUserIdToPromote('');
          onRefreshAll();
          notify(`🎉 เลื่อนสิทธิ์ให้คุณ "${updated.name}" เป็น "${updated.role}" เรียบร้อยแล้วค่ะ!`);
        })
        .catch(err => notify(`เลื่อนสิทธิ์ไม่สำเร็จ: ${err.message}`));
    }

    const currentUsers = StorageService.get<User[]>('users', []);
    const foundIdx = currentUsers.findIndex(u => u.id === userIdToPromote);
    
    if (foundIdx === -1) {
      notify('ไม่พบผู้ใช้ที่ท่านระบุในสารบบ!');
      return;
    }

    const userToPromote = currentUsers[foundIdx];
    const beforeUser = { ...userToPromote };
    
    // Promote user role
    userToPromote.role = newUserRole;
    currentUsers[foundIdx] = userToPromote;
    
    StorageService.set('users', currentUsers);
    setUsers(currentUsers);

    onAddAuditLog('USER_PROMOTED_TO_OPERATOR_BY_ADMIN', 'User', userIdToPromote, beforeUser, userToPromote);
    
    setUserIdToPromote('');
    onRefreshAll();
    notify(`🎉 เลื่อนสิทธิ์ให้คุณ "${userToPromote.name}" ขึ้นสู่ตำแหน่ง "${newUserRole}" ในสังกัดของคลับเรียบร้อยแล้วค่ะ!`);
  };

  const handleDeleteUserByAdmin = async (id: string, name: string) => {
    const confirmDelete = await ask(`ลบบัญชี "${name}" ถาวร?\nสิทธิ์และส่วนลดของบัญชีนี้จะหายไป (โหมดสาธิต)`, { title: '⚠️ ลบบัญชี', okLabel: 'ลบบัญชี', danger: true });
    if (!confirmDelete) return;

    const currentUsers = StorageService.get<User[]>('users', []);
    const filtered = currentUsers.filter(u => u.id !== id);

    StorageService.set('users', filtered);
    setUsers(filtered);

    onAddAuditLog('USER_DELETED_BY_ADMIN', 'User', id, { name }, null);
    onRefreshAll();
    notify('ลบบัญชีและทำลายสิทธิ์ของผู้ใช้งานเรียบร้อยแล้วค่ะ');
  };

  // Stage memberType (discount tier) modifications locally
  const handleStageUserMemberType = (id: string, type: MemberType) => {
    const userObj = users.find(u => u.id === id);
    if (!userObj) return;
    setUserPendingChanges(prev => ({
      ...prev,
      [id]: {
        role: prev[id]?.role ?? userObj.role,
        memberType: type
      }
    }));
  };

  // Stage userRole modifications locally
  const handleStageUserRole = (id: string, role: UserRole) => {
    const userObj = users.find(u => u.id === id);
    if (!userObj) return;
    setUserPendingChanges(prev => ({
      ...prev,
      [id]: {
        role: role,
        memberType: prev[id]?.memberType ?? userObj.memberType ?? MemberType.NORMAL
      }
    }));
  };

  // Commit and write modified permissions/roles to the database with detailed Audit Logging
  const handleSaveUserPermissions = (id: string) => {
    const target = userPendingChanges[id];
    if (!target) return;

    if (api.USE_BACKEND) {
      // The server prices bookings with the tier stored there, so it must
      // be changed there. Roles can't be changed from the panel yet.
      const before = users.find(u => u.id === id);
      if (!before) return;
      // Role first (admin only), then the tier (only customers have one).
      const roleStep = target.role !== before.role
        ? api.setUserRole(id, target.role)
        : Promise.resolve(before);
      roleStep
        .then(afterRole => (target.memberType !== (afterRole.memberType ?? MemberType.NORMAL) && afterRole.role === UserRole.CUSTOMER
          ? api.setMemberType(id, target.memberType)
          : afterRole))
        .then(updated => {
          setUsers(prev => prev.map(u => (u.id === id ? updated : u)));
          onAddAuditLog('USER_PERMISSIONS_SAVED_BY_ADMIN', 'User', id,
            { name: before.name, role: before.role, memberType: before.memberType },
            { name: updated.name, role: updated.role, memberType: updated.memberType });
          setUserPendingChanges(prev => {
            const copy = { ...prev };
            delete copy[id];
            return copy;
          });
          onRefreshAll();
          notify(`💾 บันทึกสิทธิ์ของ "${updated.name}" แล้ว: ${updated.role} · ${memberTierLabel(updated.memberType)}`);
        })
        .catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
      return;
    }

    const currentUsers = StorageService.get<User[]>('users', []);
    const foundIdx = currentUsers.findIndex(u => u.id === id);
    if (foundIdx === -1) {
      notify('ไม่พบบัญชีผู้ใช้เป้าหมาย!');
      return;
    }

    const beforeUser = { ...currentUsers[foundIdx] };
    const afterUser = { 
      ...beforeUser, 
      role: target.role, 
      memberType: target.memberType 
    };

    currentUsers[foundIdx] = afterUser;
    StorageService.set('users', currentUsers);
    setUsers(currentUsers);

    // Save customized audit log with specific targetType 'User'
    // Log the before and after state as JSON snapshot for verification
    onAddAuditLog(
      'USER_PERMISSIONS_SAVED_BY_ADMIN', 
      'User', 
      id, 
      { 
        name: beforeUser.name, 
        role: beforeUser.role, 
        memberType: beforeUser.memberType || MemberType.NORMAL 
      }, 
      { 
        name: afterUser.name, 
        role: afterUser.role, 
        memberType: afterUser.memberType 
      }
    );

    // Remove from pending cache list
    setUserPendingChanges(prev => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });

    onRefreshAll();
    notify(`บันทึกสิทธิ์ของ "${afterUser.name}" เรียบร้อยแล้ว\n\n• ระดับสมาชิก: ${beforeUser.memberType || 'NORMAL'} ➔ ${afterUser.memberType}\n• บทบาท: ${beforeUser.role} ➔ ${afterUser.role}`);
  };

  // Discard pending changes
  const handleCancelUserStage = (id: string) => {
    setUserPendingChanges(prev => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
  };

  const handleToggleUserActive = (id: string, currentlyActive: boolean) => {
    if (api.USE_BACKEND) {
      return api.setUserActive(id, !currentlyActive)
        .then(updated => {
          setUsers(prev => prev.map(u => (u.id === id ? updated : u)));
          onAddAuditLog('USER_STATUS_TOGGLED', 'User', id, { isActive: currentlyActive }, { isActive: updated.isActive });
          onRefreshAll();
        })
        .catch(err => notify(`เปลี่ยนสถานะไม่สำเร็จ: ${err.message}`));
    }
    const currentUsers = StorageService.get<User[]>('users', []);
    const updated = currentUsers.map(u => u.id === id ? { ...u, isActive: !currentlyActive } : u);

    StorageService.set('users', updated);
    setUsers(updated);

    onAddAuditLog('USER_STATUS_TOGGLED', 'User', id, { isActive: currentlyActive }, { isActive: !currentlyActive });
    onRefreshAll();
  };

  const handleAdjustPoints = async (userId: string, diff: number) => {
    if (api.USE_BACKEND) {
      // Points live in the backend's ledger; a manual change needs a reason
      // (it is audit-logged with it).
      const reason = await askText(`เหตุผลในการ${diff > 0 ? 'เพิ่ม' : 'ลด'}แต้ม ${Math.abs(diff)} แต้ม (จำเป็น):`, { title: 'ปรับแต้ม' });
      if (!reason) return;
      return api.adjustPoints(userId, diff, reason)
        .then(balance => {
          setUsers(prev => prev.map(u => (u.id === userId ? { ...u, points: balance } : u)));
          onAddAuditLog('USER_POINTS_ADJUSTED_BY_ADMIN', 'User', userId, null, { diff, reason });
          onRefreshAll();
        })
        .catch(err => notify(`ปรับแต้มไม่สำเร็จ: ${err.message}`));
    }
    // Through the points ledger, so the change is in the customer's points
    // history like every other one.
    const reason = await askText(`เหตุผลในการ${diff > 0 ? 'เพิ่ม' : 'ลด'}แต้ม ${Math.abs(diff)} แต้ม (จำเป็น):`, { title: 'ปรับแต้ม' });
    if (!reason) return;
    const applied = StorageService.addLedgerEntry(userId, LedgerEntryType.ADJUST_MANUAL, diff, adminUser?.id || 'admin', { note: reason });
    setUsers(StorageService.get<User[]>('users', []));
    // Points never go below 0: a cut on an empty balance changes nothing,
    // so nothing is logged.
    if (applied === 0) { notify('แต้มเป็น 0 อยู่แล้ว ไม่มีอะไรเปลี่ยน'); return; }

    onAddAuditLog('USER_POINTS_ADJUSTED_BY_ADMIN', 'User', userId, null, { diff: applied, reason });
    onRefreshAll();
  };

  // Product Inventory management
  const handleCreateProduct = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProductName || !newProductPrice) return;

    if (api.USE_BACKEND) {
      return api.createProducts([{ name: newProductName, category: newProductCat, price: Number(newProductPrice), isRental: newProductCat === ProductCat.EQUIPMENT && newProductIsRental,
        deposit: newProductCat === ProductCat.EQUIPMENT && newProductIsRental ? Number(newProductDeposit) || 0 : 0, stock: Number(newProductStock) }])
        .then(() => {
          setNewProductName('');
          setNewProductPrice(20);
          setNewProductStock(50);
          onRefreshAll();
          notify('บันทึกเพิ่มสินค้า/บริการสำเร็จ!');
        })
        .catch(err => notify(`เพิ่มสินค้าไม่สำเร็จ: ${err.message}`));
    }

    const newProdId = 'pd-' + Date.now();
    const newProd: Product = {
      id: newProdId,
      name: newProductName,
      category: newProductCat,
      price: Number(newProductPrice),
      isRental: newProductCat === ProductCat.EQUIPMENT && newProductIsRental,
      deposit: newProductCat === ProductCat.EQUIPMENT && newProductIsRental ? Number(newProductDeposit) || 0 : 0,
      stock: Number(newProductStock),
      isActive: true
    };

    const currentProds = StorageService.get<Product[]>('products', []);
    const updated = [...currentProds, newProd];

    StorageService.set('products', updated);
    setProducts(updated);

    onAddAuditLog('PRODUCT_CREATED_BY_ADMIN', 'Product', newProdId, null, newProd);

    // reset
    setNewProductName('');
    setNewProductPrice(20);
    setNewProductStock(50);
    onRefreshAll();
    notify('บันทึกเพิ่มสินค้า/บริการสำเร็จ!');
  };

  // Restock (+) or count correction (-), with a reason for the audit log.
  // Shoes are stocked per size: the size picked next to the buttons.
  // Rental deposit per unit (cash, given back on return).
  const handleSetDeposit = async (p: Product) => {
    const raw = await askText(`มัดจำต่อชิ้นของ "${p.name}" (บาท, 0 = ไม่เก็บมัดจำ)\nพนักงานเก็บเป็นเงินสดตอนเช่า และคืนให้ตอนคืนของ`,
      { title: 'ตั้งมัดจำ', defaultValue: String(p.deposit ?? 0), required: true, okLabel: 'บันทึก' });
    if (raw === null) return;
    const deposit = Number(raw.trim());
    if (!Number.isFinite(deposit) || deposit < 0 || deposit > 100000) {
      notify('มัดจำต้องเป็นตัวเลข 0 - 100,000 บาท');
      return;
    }
    const done = () => {
      onAddAuditLog('PRODUCT_UPDATED', 'Product', p.id, { deposit: p.deposit ?? 0 }, { deposit });
      onRefreshAll();
      notify(`ตั้งมัดจำ "${p.name}" เป็น ${formatBaht(deposit)} บาทแล้ว`);
    };
    if (api.USE_BACKEND) {
      return api.updateProduct(p, { deposit }).then(done).catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }
    const updated = StorageService.get<Product[]>('products', []).map(x => x.id === p.id ? { ...x, deposit } : x);
    StorageService.set('products', updated);
    setProducts(updated);
    done();
  };

  const handleUpdateStockValue = async (prodId: string, val: number) => {
    const prod = products.find(p => p.id === prodId);
    if (!prod) return;
    const variant = prod.variants?.find(v => v.id === stockVariantSel[prodId]);
    if (prod.variants?.length && !variant) {
      notify('เลือกเบอร์ที่จะปรับสต๊อกก่อน');
      return;
    }
    const what = variant ? `${prod.name} เบอร์ ${variant.label}${variant.gender ? ` (${variant.gender})` : ''}` : prod.name;
    const reason = await askText(`เหตุผลการ${val > 0 ? 'เพิ่ม' : 'ลด'}สต๊อก ${what} ${val > 0 ? '+' : ''}${val} ชิ้น:`, { title: 'ปรับสต๊อก', defaultValue: val > 0 ? 'รับสินค้าเข้า' : 'ปรับยอดตามนับจริง' });
    if (!reason) return;

    if (api.USE_BACKEND) {
      return api.adjustStock(prodId, val, reason, variant?.id)
        .then(updated => setProducts(list => list.map(p => p.id === prodId ? updated : p)))
        .catch(err => notify(`ปรับสต๊อกไม่สำเร็จ: ${err.message}`));
    }

    const currentProds = StorageService.get<Product[]>('products', []);
    const updated = currentProds.map(p => {
      if (p.id !== prodId) return p;
      if (variant) {
        const variants = p.variants?.map(v => v.id === variant.id ? { ...v, stock: Math.max(0, v.stock + val) } : v);
        const afterStock = (variants || []).reduce((n, v) => n + v.stock, 0);
        onAddAuditLog('PRODUCT_STOCK_ADJUSTED', 'Product', prodId, { stock: p.stock, variant: variant.id, variantStock: variant.stock }, { stock: afterStock, reason });
        return { ...p, variants, stock: afterStock };
      }
      const afterStock = Math.max(0, p.stock + val);
      onAddAuditLog('PRODUCT_STOCK_ADJUSTED', 'Product', prodId, { stock: p.stock }, { stock: afterStock, reason });
      return { ...p, stock: afterStock };
    });

    StorageService.set('products', updated);
    setProducts(updated);
    onRefreshAll();
  };

  const handleDownloadTemplate = () => {
    const wsData = [
      {
        "ชื่อสินค้า": "ลูกแบดมินตัน RSL Silver",
        "ราคา": 80,
        "สต็อก": 200,
        "หมวดหมู่": "EQUIPMENT",
        "เช่า": "FALSE",
        "หมวดย่อย": ""
      },
      {
        "ชื่อสินค้า": "รองเท้ากีฬาแกรนสปอร์ต ชาย/หญิง",
        "ราคา": 50,
        "สต็อก": 25,
        "หมวดหมู่": "EQUIPMENT",
        "เช่า": "TRUE",
        "หมวดย่อย": "shoes"
      },
      {
        "ชื่อสินค้า": "ข้าวกะเพราหมูสับไข่ดาว",
        "ราคา": 65,
        "สต็อก": 40,
        "หมวดหมู่": "FB",
        "เช่า": "FALSE",
        "หมวดย่อย": ""
      },
      {
        "ชื่อสินค้า": "น้ำดื่มแร่สิงห์ 600ml",
        "ราคา": 15,
        "สต็อก": 150,
        "หมวดหมู่": "FB",
        "เช่า": "FALSE",
        "หมวดย่อย": ""
      }
    ];

    const ws = XLSX.utils.json_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "รายชื่ออาหารและเครื่องกีฬา");
    XLSX.writeFile(wb, "product_upload_template.xlsx");
  };

  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared so the same file can be picked again after fixing an error.
    e.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const wb = XLSX.read(evt.target?.result as ArrayBuffer, { type: 'array' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);

        if (data.length === 0) {
          notify('ไม่พบข้อมูลรายการสินค้าในสเปรดชีต Excel นี้');
          return;
        }

        const currentProds = StorageService.get<Product[]>('products', []);
        let importedCount = 0;
        const newProds: Product[] = [...currentProds];
        const apiRows: api.ProductInput[] = [];
        // A product already in the catalog (or twice in the file) is skipped,
        // so importing a corrected copy doesn't duplicate everything.
        const knownNames = new Set((api.USE_BACKEND ? products : currentProds).map(p => p.name.trim().toLowerCase()));
        const skipped: string[] = [];

        data.forEach(row => {
          // The first column that has a value - a 0 price or 0 stock is a
          // value, not a missing cell.
          const pick = (...keys: string[]) => {
            for (const k of keys) if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
            return undefined;
          };
          const name = pick('ชื่อสินค้า', 'name', 'Name');
          const priceVal = pick('ราคา', 'price', 'Price');
          const stockVal = pick('จำนวนสินค้า', 'สต็อก', 'stock', 'Stock');
          const categoryVal = pick('หมวดหมู่', 'category', 'Category');
          const isRentalVal = pick('เช่า', 'isRental', 'IsRental', 'เช่าเล่น') ?? false;
          const subCategoryVal = pick('หมวดย่อย', 'subCategory', 'SubCategory');
          const depositVal = Number(pick('มัดจำ', 'deposit', 'Deposit') ?? 0);

          const cleanName = String(name ?? '').trim();
          const price = Number(priceVal);
          const stock = stockVal === undefined ? 50 : Number(stockVal);
          // The server's limits, so browser-only mode accepts the same rows.
          if (!cleanName || cleanName.length > 200 || priceVal === undefined || !Number.isFinite(price) || price < 0 || price > 100000 ||
              !Number.isInteger(stock) || stock < 0 || stock > 100000) {
            if (cleanName) skipped.push(`${cleanName} (ข้อมูลไม่ถูกต้อง)`);
            return;
          }
          if (knownNames.has(cleanName.toLowerCase())) {
            skipped.push(`${cleanName} (มีอยู่แล้ว)`);
            return;
          }
          knownNames.add(cleanName.toLowerCase());

          const category = String(categoryVal).toUpperCase() === 'EQUIPMENT' || String(categoryVal).includes('อุปกรณ์') || String(categoryVal).includes('เช่า')
            ? ProductCat.EQUIPMENT
            : ProductCat.FB;

          // The template's เช่า column decides; F&B is never rented.
          const isRental = category === ProductCat.EQUIPMENT && (isRentalVal === true || String(isRentalVal).toLowerCase() === 'true');

          const deposit = isRental && Number.isFinite(depositVal) && depositVal > 0 && depositVal <= 100000 ? depositVal : 0;
          apiRows.push({
            name: cleanName, category, price, isRental, deposit, stock, subCategory: subCategoryVal ? String(subCategoryVal) : undefined
          });
          const pId = 'pd-excel-' + Math.random().toString(36).slice(2, 11);
          newProds.push({
            id: pId,
            name: cleanName,
            category: category,
            price,
            stock,
            isRental: isRental,
            deposit,
            isActive: true,
            subCategory: subCategoryVal ? String(subCategoryVal) : undefined
          });
          importedCount++;
        });

        const skippedNote = skipped.length ? `\n\nข้าม ${skipped.length} รายการ:\n${skipped.slice(0, 15).join('\n')}${skipped.length > 15 ? '\n…' : ''}` : '';
        // Preview: nothing is saved until the admin has seen what was read.
        if (importedCount > 0) {
          const lines = apiRows.slice(0, 20).map(r =>
            `• ${r.name} — ${r.category === ProductCat.EQUIPMENT ? (r.isRental ? `อุปกรณ์ให้เช่า${r.deposit ? ` (มัดจำ ${formatBaht(r.deposit)})` : ''}` : 'อุปกรณ์') : 'อาหาร/เครื่องดื่ม'} · ${formatBaht(r.price)} บาท · สต๊อก ${r.stock}`);
          const more = apiRows.length > 20 ? `\n… และอีก ${apiRows.length - 20} รายการ` : '';
          if (!(await ask(`จะนำเข้าสินค้าใหม่ ${importedCount} รายการ:\n${lines.join('\n')}${more}${skippedNote}`,
            { title: 'ตรวจรายการก่อนนำเข้า', okLabel: `นำเข้า ${importedCount} รายการ` }))) return;
        }
        if (importedCount > 0 && api.USE_BACKEND) {
          api.createProducts(apiRows)
            .then(list => {
              onRefreshAll();
              notify(`นำเข้าสินค้า ${list.length} รายการเรียบร้อย${skippedNote}`);
            })
            .catch(err => notify(`นำเข้าไม่สำเร็จ (ไม่มีรายการใดถูกบันทึก): ${err.message}`));
        } else if (importedCount > 0) {
          // Re-read: stock may have changed (e.g. a sale in another tab)
          // while the preview was open; only the new rows are added.
          const saved = [...StorageService.get<Product[]>('products', []), ...newProds.slice(currentProds.length)];
          StorageService.set('products', saved);
          setProducts(saved);
          onAddAuditLog('PRODUCTS_UPLOADED_VIA_EXCEL', 'Product', 'bulk', null, { count: importedCount });
          onRefreshAll();
          notify(`อัปโหลดเสร็จสมบูรณ์! นำเข้าสินค้าแถวใหม่ ${importedCount} รายการเข้าสู่ตู้อัตโนมัติและคลังสต๊อกสำเร็จค่ะ 🚀${skippedNote}`);
        } else {
          notify(`ไม่มีสินค้าใหม่ให้นำเข้า (หัวคอลัมน์ต้องตรงกับไฟล์ตัวอย่างด้านบน)${skippedNote}`);
        }
      } catch (err) {
        notify('เกิดข้อผิดพลาดขณะแกะไฟล์สเปรดชีต Excel: ' + (err instanceof Error ? err.message : String(err)));
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // Monthly CSV exports (FR-7.4): the booking register and the counter
  // sales. API mode reads the month from the server.
  const csvCell = (v: unknown) => {
    // Quote every field (names can hold commas) and neutralise text that
    // starts with = + - @ (also after spaces) or a tab / CR, so a customer
    // name can't run as a spreadsheet formula. Numbers (e.g. -50) stay
    // numbers.
    const t = String(v ?? '');
    const risky = typeof v !== 'number' && /^(\s*[=+\-@]|[\t\r])/.test(t);
    return `"${(risky ? `'${t}` : t).replace(/"/g, '""')}"`;
  };
  const downloadCsv = (filename: string, header: string[], rows: unknown[][]) => {
    // The BOM makes Excel read the file as UTF-8 (Thai names stay readable).
    const text = '\uFEFF' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Later, not at once: some browsers cancel a download whose URL is
    // revoked right after the click.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const monthData = async (kind: string): Promise<{ rows: api.ReportBookingRow[]; monthOrders: Order[] }> => {
    const month = `${reportsYear}-${reportsMonth}`;
    if (api.USE_BACKEND) {
      const r = await api.monthReport(month, kind); // the server logs the export
      return { rows: r.bookings, monthOrders: r.orders };
    }
    const rows = bookings.filter(b => b.date.startsWith(month)).map(b => {
      // A group's payment hangs off one of its rows.
      const groupIds = new Set(bookings.filter(x => x.bookingCode === b.bookingCode).map(x => x.id));
      const pay = payments.find(p => groupIds.has(p.bookingId));
      // The group's refund is listed once, on the row the payment hangs off
      // (as the server's report does), so summing the column is right.
      return { ...b, courtName: courts.find(c => c.id === b.courtId)?.name || '', paymentMethod: pay?.method || '', paymentStatus: pay?.status || '', refundAmount: pay && pay.bookingId === b.id ? pay.refundAmount || 0 : 0 };
    });
    return { rows, monthOrders: orders.filter(o => localDateOf(o.createdAt).startsWith(month)) };
  };

  const handleDownloadCSVReport = async (kind: 'bookings' | 'orders') => {
    let data;
    try {
      data = await monthData(kind);
    } catch (err) {
      notify(`ดึงรายงานไม่สำเร็จ: ${err instanceof Error ? err.message : err}`);
      return;
    }
    const tag = `${reportsYear}_${reportsMonth}`;
    if (kind === 'bookings') {
      const rows = [...data.rows].sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
      downloadCsv(`SportsComplex_Bookings_${tag}.csv`,
        ['BookingCode', 'CourtName', 'CustomerName', 'Phone', 'Date', 'Time', 'PriceType', 'Amount', 'BookingStatus', 'PaymentMethod', 'PaymentStatus', 'Refunded'],
        rows.map(b => [b.bookingCode, b.courtName, b.userName, b.userPhone, b.date, b.startTime, b.priceType, b.totalAmount, b.status, b.paymentMethod, b.paymentStatus, b.refundAmount]));
    } else {
      const productName = (id: string, fallback?: string) => fallback || products.find(p => p.id === id)?.name || id;
      downloadCsv(`SportsComplex_CounterSales_${tag}.csv`,
        ['OrderCode', 'DateTime', 'Type', 'Customer', 'PaymentMethod', 'Status', 'Item', 'Size', 'Qty', 'UnitPrice', 'LineTotal', 'Returned'],
        data.monthOrders.flatMap(o => o.items.map(it => [
          o.orderCode, bangkokStamp(o.createdAt), o.type, o.customerName, o.paymentMethod || '', o.status,
          productName(it.productId, it.productName), it.shoeSize ? `${it.shoeSize}${it.shoeGender || ''}` : '', it.qty, it.unitPrice,
          roundBaht(it.qty * it.unitPrice), it.returnedAt ? bangkokStamp(it.returnedAt) : ''
        ])));
    }
    onAddAuditLog('REPORT_CSV_EXPORTED', 'Report', 'csv-gen', null, { kind, month: reportsMonth, year: reportsYear });
  };

  // Filtering Audit Logs (Module 4 search spec)
  const filteredAuditLogs = auditLogs.filter(log => {
    const term = auditSearch.toLowerCase();
    const matchTerm = log.userName.toLowerCase().includes(term) ||
                      log.action.toLowerCase().includes(term) ||
                      log.targetType.toLowerCase().includes(term);
    const matchType = auditTypeFilter === 'ALL' || log.targetType === auditTypeFilter;
    return matchTerm && matchType;
  });

  // Column-by-column filtering for Pricing Rules (Active Engine Table)
  const filteredPricingRules = pricingRules.filter(rule => {
    const matchCourt = !filterCourtType || rule.courtType.toLowerCase().includes(filterCourtType.toLowerCase());
    const matchPrice = !filterPriceType || rule.priceType.toLowerCase().includes(filterPriceType.toLowerCase());
    const matchDay = !filterDayType || rule.dayType.toLowerCase().includes(filterDayType.toLowerCase());
    const matchLabel = !filterLabel || rule.label.toLowerCase().includes(filterLabel.toLowerCase());
    return matchCourt && matchPrice && matchDay && matchLabel;
  });

  // Computed once per render (the JSX reads it in a dozen places).
  const dashStats = getDashboardStats();
  return {
    onAddAuditLog,
    triggerRefresh,
    onRefreshAll,
    courts,
    setCourts,
    pricingRules,
    setPricingRules,
    products,
    setProducts,
    users,
    setUsers,
    bookings,
    setBookings,
    payments,
    setPayments,
    orders,
    setOrders,
    auditLogs,
    setAuditLogs,
    activeAdminTab,
    setActiveAdminTab,
    memberDiscounts,
    setMemberDiscounts,
    auditSearch,
    setAuditSearch,
    auditTypeFilter,
    setAuditTypeFilter,
    reportsMonth,
    setReportsMonth,
    reportsYear,
    setReportsYear,
    dashboardSelectedDate,
    setDashboardSelectedDate,
    dashboardSelectedSport,
    setDashboardSelectedSport,
    editingRuleId,
    setEditingRuleId,
    ruleCourtType,
    setRuleCourtType,
    ruleDayType,
    setRuleDayType,
    ruleStartHour,
    setRuleStartHour,
    ruleEndHour,
    setRuleEndHour,
    rulePrice,
    setRulePrice,
    rulePriceType,
    setRulePriceType,
    ruleLabel,
    setRuleLabel,
    filterCourtType,
    setFilterCourtType,
    filterPriceType,
    setFilterPriceType,
    filterDayType,
    setFilterDayType,
    filterLabel,
    setFilterLabel,
    newCourtName,
    setNewCourtName,
    newCourtType,
    setNewCourtType,
    newCourtAllowHalf,
    setNewCourtAllowHalf,
    newCourtHalfOf,
    setNewCourtHalfOf,
    daysOff,
    setDaysOff,
    newDayOffDate,
    setNewDayOffDate,
    newDayOffCourtId,
    setNewDayOffCourtId,
    newDayOffReason,
    setNewDayOffReason,
    newDayOffIsFullDay,
    setNewDayOffIsFullDay,
    newDayOffStartHour,
    setNewDayOffStartHour,
    newDayOffEndHour,
    setNewDayOffEndHour,
    newUserRole,
    setNewUserRole,
    userIdToPromote,
    setUserIdToPromote,
    userSearchQuery,
    setUserSearchQuery,
    userRoleFilter,
    setUserRoleFilter,
    userTierFilter,
    setUserTierFilter,
    userPendingChanges,
    setUserPendingChanges,
    editingDiscounts,
    setEditingDiscounts,
    handleStageDiscountField,
    handleSaveDiscountTier,
    dash,
    setDash,
    dashBookings,
    setDashBookings,
    stockVariantSel,
    setStockVariantSel,
    newProductName,
    setNewProductName,
    newProductCat,
    setNewProductCat,
    newProductPrice,
    setNewProductPrice,
    newProductStock,
    setNewProductStock,
    newProductIsRental,
    setNewProductIsRental,
    newProductDeposit,
    setNewProductDeposit,
    gridBookings,
    getDashboardStats,
    physicalCourtCount,
    occupiedShare,
    getRevenueChartData,
    getDayCapacityChartData,
    getPieChartData,
    PIE_COLORS,
    openHourSetting,
    setOpenHourSetting,
    closeHourSetting,
    setCloseHourSetting,
    unpricedHours,
    handleSaveOpeningHours,
    maxAdvanceDays,
    setMaxAdvanceDays,
    handleSaveMaxAdvanceDays,
    emptyBusiness,
    businessFrom,
    business,
    setBusiness,
    handleSaveBusiness,
    handleSavePricingRule,
    handleDeletePricingRule,
    handleCreateCourt,
    handleRenameCourt,
    handleToggleCourtActive,
    adminUser,
    setAdminUser,
    actingAdmin,
    roles,
    setRoles,
    roleName,
    canManageAccounts,
    canManageCourts,
    adminTabAllowed,
    firstAdminTab,
    busyRef,
    busy,
    setBusy,
    guarded,
    adminIdentity,
    setAdminIdentity,
    adminPassword,
    setAdminPassword,
    adminApiError,
    setAdminApiError,
    adminUserId,
    adminRole,
    dashClosures,
    setDashClosures,
    canSeeDashboard,
    handleAdminLogout,
    handleAdminLogin,
    adminLoginWith,
    handleSaveDayOff,
    handleDeleteDayOff,
    handlePromoteUser,
    handleDeleteUserByAdmin,
    handleStageUserMemberType,
    handleStageUserRole,
    handleSaveUserPermissions,
    handleCancelUserStage,
    handleToggleUserActive,
    handleAdjustPoints,
    handleCreateProduct,
    handleSetDeposit,
    handleUpdateStockValue,
    handleDownloadTemplate,
    handleExcelUpload,
    csvCell,
    downloadCsv,
    monthData,
    handleDownloadCSVReport,
    filteredAuditLogs,
    filteredPricingRules,
    dashStats
  };
}

export type AdminPanelState = ReturnType<typeof useAdminPanel>;
export const AdminPanelContext = createContext<AdminPanelState | null>(null);
export function useAdminPanelContext(): AdminPanelState {
  const value = useContext(AdminPanelContext);
  if (!value) throw new Error('useAdminPanelContext outside AdminPanel');
  return value;
}
