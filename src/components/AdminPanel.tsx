import React, { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { 
  Court, CourtType, PricingRule, DayType, PriceType, 
  User, UserRole, MemberType, Booking, BookingStatus, 
  Payment, Product, ProductCat, Order, OrderStatus, OrderType, AuditLog, DayOff, MemberDiscountRule, PricingConfig, LedgerEntryType
} from '../types';
import { StorageService, findClosure, getTodayDateStr, DEFAULT_MEMBER_DISCOUNTS, isHourOffPeak, courtsConflict, memberTierLabel, openingHours, openSlotHours, isPaidBooking, lastBookableDate, roundBaht, formatBaht, localDateOf, bangkokStamp, formatDateTime } from '../mockData';
import * as api from '../api';
import { notify, ask, askText } from './Dialog';
import DemoLogins, { DEMO_ADMINS } from './DemoLogins';
import { can, canUseSettings, Permission, BUILTIN_ROLES } from '../permissions';
import RolesTab from './RolesTab';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line 
} from 'recharts';
import { Settings, Users, FileDown, Search, ShieldCheck } from 'lucide-react';

// Bookable hours per court per day (dashboard occupancy).
const hoursPerDay = () => { const { open, close } = openingHours(); return close - open; };

interface AdminPanelProps {
  onAddAuditLog: (action: string, targetType: string, targetId: string, before?: any, after?: any) => void;
  triggerRefresh: number;
  onRefreshAll: () => void;
}

// Settings tabs and the permissions that open each (any one is enough).
type AdminTab = 'dashboard' | 'pricing' | 'courts' | 'products' | 'users' | 'reports' | 'audit_logs' | 'member_discounts' | 'roles';
const ADMIN_TABS: { id: AdminTab; label: string }[] = [
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
const ADMIN_TAB_PERMISSIONS: Record<AdminTab, Permission[]> = {
  dashboard: ['view_reports'], pricing: ['edit_pricing'], courts: ['manage_closures', 'manage_courts'],
  products: ['manage_products'], users: ['manage_members', 'adjust_points', 'manage_staff'],
  member_discounts: ['edit_pricing'], reports: ['view_reports'], roles: ['manage_roles'], audit_logs: ['view_audit_log']
};

export default function AdminPanel({ onAddAuditLog, triggerRefresh, onRefreshAll }: AdminPanelProps) {
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

  const handleStageDiscountField = (id: string, field: 'name' | 'discountPercent' | 'isActive', value: any) => {
    setEditingDiscounts(prev => {
      const current = prev[id] || {
        name: memberDiscounts.find(d => d.id === id)?.name || '',
        discountPercent: memberDiscounts.find(d => d.id === id)?.discountPercent || 0,
        isActive: memberDiscounts.find(d => d.id === id)?.isActive ?? true
      };
      
      let processedVal = value;
      if (field === 'discountPercent') {
        // Below 100%: a free booking would need a 0.00 THB PromptPay QR,
        // which banking apps reject (the server enforces the same limit).
        processedVal = Math.min(99, Math.max(0, parseInt(value, 10) || 0));
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
  const occupiedShare = (list: Booking[]) =>
    list.reduce((sum, b) => sum + (courts.find(c => c.id === b.courtId)?.shareOfGroup ?? 1), 0);

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
  const canEditPricing = can(actingAdmin, 'edit_pricing');
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
      return api.createProducts([{ name: newProductName, category: newProductCat, price: Number(newProductPrice), isRental: newProductCat === ProductCat.EQUIPMENT && newProductIsRental, stock: Number(newProductStock) }])
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
    reader.onload = (evt) => {
      try {
        const wb = XLSX.read(evt.target?.result as ArrayBuffer, { type: 'array' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json<any>(ws);

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

        data.forEach((row: any) => {
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

          apiRows.push({
            name: cleanName, category, price, isRental, stock, subCategory: subCategoryVal ? String(subCategoryVal) : undefined
          });
          const pId = 'pd-excel-' + Math.random().toString(36).slice(2, 11);
          newProds.push({
            id: pId,
            name: cleanName,
            category: category,
            price,
            stock,
            isRental: isRental,
            isActive: true,
            subCategory: subCategoryVal ? String(subCategoryVal) : undefined
          });
          importedCount++;
        });

        const skippedNote = skipped.length ? `\n\nข้าม ${skipped.length} รายการ:\n${skipped.slice(0, 15).join('\n')}${skipped.length > 15 ? '\n…' : ''}` : '';
        if (importedCount > 0 && api.USE_BACKEND) {
          api.createProducts(apiRows)
            .then(list => {
              onRefreshAll();
              notify(`นำเข้าสินค้า ${list.length} รายการเรียบร้อย${skippedNote}`);
            })
            .catch(err => notify(`นำเข้าไม่สำเร็จ (ไม่มีรายการใดถูกบันทึก): ${err.message}`));
        } else if (importedCount > 0) {
          StorageService.set('products', newProds);
          setProducts(newProds);
          onAddAuditLog('PRODUCTS_UPLOADED_VIA_EXCEL', 'Product', 'bulk', null, { count: importedCount });
          onRefreshAll();
          notify(`อัปโหลดเสร็จสมบูรณ์! นำเข้าสินค้าแถวใหม่ ${importedCount} รายการเข้าสู่ตู้อัตโนมัติและคลังสต๊อกสำเร็จค่ะ 🚀${skippedNote}`);
        } else {
          notify(`ไม่มีสินค้าใหม่ให้นำเข้า (หัวคอลัมน์ต้องตรงกับไฟล์ตัวอย่างด้านบน)${skippedNote}`);
        }
      } catch (err: any) {
        notify('เกิดข้อผิดพลาดขณะแกะไฟล์สเปรดชีต Excel: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // Monthly CSV exports (FR-7.4): the booking register and the counter
  // sales. API mode reads the month from the server.
  const csvCell = (v: unknown) => {
    // Quote every field (names can hold commas) and neutralise leading
    // = + - @ so a customer name can't run as a spreadsheet formula.
    const t = String(v ?? '');
    return `"${(/^[=+\-@]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;
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

  // API mode: the settings here act as a manager/admin, so sign in first
  // (separately from the customer and staff logins in the same browser).
  if (api.USE_BACKEND && !adminUser) {
    return (
      <div className="max-w-sm mx-auto my-10 bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <form onSubmit={handleAdminLogin} className="space-y-3 text-xs">
          <p className="text-sm font-bold text-slate-800">เข้าสู่ระบบผู้จัดการ / ผู้บริหาร</p>
          {adminApiError && (
            <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">⚠️ {adminApiError}</p>
          )}
          <input value={adminIdentity} onChange={e => setAdminIdentity(e.target.value)} placeholder="เบอร์โทร หรือ อีเมลผู้จัดการ" className="w-full border border-slate-300 rounded-lg px-3 py-2" required />
          <input type="password" value={adminPassword} onChange={e => setAdminPassword(e.target.value)} placeholder="รหัสผ่าน" className="w-full border border-slate-300 rounded-lg px-3 py-2" required />
          <button type="submit" disabled={busy} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg py-2">เข้าสู่ระบบ</button>
          <DemoLogins accounts={DEMO_ADMINS} onPick={adminLoginWith} />
        </form>
      </div>
    );
  }

  // Computed once per render (the JSX reads it in a dozen places).
  const dashStats = getDashboardStats();

  return (
    <div className="space-y-6">
      {/* A failed load leaves older data on screen - say so on every tab. */}
      {api.USE_BACKEND && adminApiError && (
        <p id="admin-load-error" role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-2">
          ⚠️ โหลดข้อมูลล่าสุดไม่สำเร็จ ข้อมูลที่เห็นอาจไม่เป็นปัจจุบัน: {adminApiError}{' '}
          <button type="button" onClick={onRefreshAll} className="underline font-bold">ลองใหม่</button>
        </p>
      )}

      {/* Admin header layout with visual privilege banner */}
      <div className="bg-slate-900 text-white p-5 rounded-2xl flex flex-wrap items-center justify-between gap-4 shadow-md border border-slate-800">
        <div>
          <h2 className="text-sm font-bold flex items-center gap-1.5 text-emerald-400">
            <Settings className="h-5 w-5 animate-spin-slow text-emerald-400" />
            บอร์ดบริหารคอมเพล็กซ์ระบบอัจฉริยะ (Manager & Administrator Console)
          </h2>
          <p className="text-[10px] text-slate-400 mt-1">ผู้เข้าใช้ระดับพรีเมียม: ยินดีต้อนรับกลับสิทธิ์บริหารระดับสูงสุดของคุณ</p>
          {/* API mode: who is signed in, and a way to switch accounts (e.g.
              from the manager to the admin account) - there was none. */}
          {api.USE_BACKEND && adminUser && (
            <p className="text-[11px] text-slate-300 mt-1">
              เข้าสู่ระบบในนาม <span className="font-bold text-white">{adminUser.name}</span> ({roleName(adminUser.role)})
              <button type="button" onClick={handleAdminLogout} className="ml-2 underline text-slate-400 hover:text-white">ออกจากระบบ</button>
            </p>
          )}
        </div>

        {/* Dashboard quick navigation links */}
        <div id="admin-navbar" className="flex flex-wrap gap-1 bg-slate-800 p-1.5 rounded-xl border border-slate-700 text-xs">
          {ADMIN_TABS.filter(t => adminTabAllowed(t.id)).map(t => (
            <button
              key={t.id}
              onClick={() => setActiveAdminTab(t.id)}
              className={`px-3 py-1.5 rounded-lg ${activeAdminTab === t.id ? 'bg-emerald-600 text-white font-bold' : 'text-slate-300 hover:text-white'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Container workspace */}
      <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm min-h-[400px]">
        
        {/* Sub Module 1: Main Dashboard (Recharts Visuals) */}
        {activeAdminTab === 'dashboard' && adminTabAllowed('dashboard') && (
          <div className="space-y-6">
            
            {/* Header with Date Selection */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-slate-900 text-white p-5 rounded-2xl border border-slate-800 gap-4">
              <div>
                <h4 className="text-sm font-bold flex items-center gap-1.5 text-emerald-400">
                  <span>📅 แผงสถิติรวมสนามกีฬาเจาะลึกประจำวัน</span>
                </h4>
                <p className="text-[11px] text-slate-400 mt-1">
                  เลือกตรวจสอบผลการดำเนินงาน, ปริมาณคนใช้สนามกีฬา และรายรับตู้ POS ย้อนหลังได้ทุกยอดค่ำคืน
                </p>
              </div>
              
              <div className="flex items-center gap-2 bg-slate-800 px-3 py-1.5 rounded-xl border border-slate-700">
                <span className="text-xs font-bold text-emerald-400">เลือกวันที่ตรวจสอบ:</span>
                <input 
                  type="date"
                  value={dashboardSelectedDate}
                  onChange={(e) => setDashboardSelectedDate(e.target.value)}
                  className="bg-slate-700 px-3 py-1 rounded text-xs font-black text-white outline-none cursor-pointer focus:ring-1 focus:ring-emerald-500"
                />
              </div>
            </div>

            {/* Target Daily Metrics for selected date */}
            <div className="space-y-2">
              <span className="text-[11px] font-bold text-slate-500 block uppercase tracking-wider">📊 สถิติแบบแยกรายวัน ณ วันที่ ({dashboardSelectedDate}):</span>
              
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-emerald-50 p-4 rounded-xl border border-emerald-200 text-xs shadow-xs">
                  <span className="text-emerald-800 block font-bold text-[10px]">รายได้ค่าคอร์ทวันนี้ (Booking Revenue)</span>
                  <span className="text-2xl font-extrabold text-emerald-900 mt-1 block">{formatBaht(dashStats.dailyBookingsRevenue)} บาท</span>
                  <p className="text-[9px] text-emerald-700 font-bold mt-1">จำนวนจองอนุมัติสำเร็จ: {dashStats.dailyBookingsCount} รายการ</p>
                </div>

                <div className="bg-amber-50 p-4 rounded-xl border border-amber-200 text-xs shadow-xs">
                  <span className="text-amber-800 block font-bold text-[10px]">รายรับสินค้า/เช่าแร็กวันนี้ (Today F&B)</span>
                  <span className="text-2xl font-extrabold text-amber-900 mt-1 block">{formatBaht(dashStats.dailyOrderRevenue)} บาท</span>
                  <p className="text-[9px] text-amber-700 mt-1">จากระบบ Walkin และ POS เคาเตอร์</p>
                </div>

                <div className="bg-sky-50 p-4 rounded-xl border border-sky-200 text-xs shadow-xs">
                  <span className="text-sky-800 block font-bold text-[10px]">รายรับรวมสุทธิของวันนี้</span>
                  <span className="text-2xl font-extrabold text-sky-950 mt-1 block">{formatBaht(dashStats.dailyTotalRevenue)} บาท</span>
                  <p className="text-[9px] text-sky-700 mt-1">สรุปรวมลิ้นชักการรับเงินสองทางวันนี้</p>
                </div>

                <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-200 text-xs shadow-xs">
                  <span className="text-indigo-800 block font-bold text-[10px]">อัตราเข้าใช้สนามประจำวัน (Occupancy)</span>
                  <span className="text-2xl font-extrabold text-indigo-950 mt-1 block">{dashStats.occupancyRate}%</span>
                  <p className="text-[9px] text-indigo-700 mt-1">ชั่วโมงสนามที่ขายได้ จาก {physicalCourtCount()} สนาม × {api.USE_BACKEND ? dash?.hoursPerDay ?? hoursPerDay() : hoursPerDay()} ชั่วโมง</p>
                </div>
              </div>
            </div>

            {/* All-Time Historical Cumulative Metrics */}
            <div className="space-y-2">
              <span className="text-[11px] font-bold text-slate-500 block uppercase tracking-wider">🌎 สรุปยอดสะสมและประวัติทางบัญชีภาพรวมทั้งหมด:</span>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs">
                  <span className="text-slate-400 block font-bold text-[10px]">รายรับรวมประเวศทุกก๊วน (All-Time Revenue)</span>
                  <span className="text-2xl font-extrabold text-slate-800 mt-1 block">{formatBaht(dashStats.allTimeRevenue)} บาท</span>
                  <div className="flex gap-2 text-[9px] text-slate-500 mt-1.5 font-mono">
                    <span>จากคอร์ท: {formatBaht(dashStats.bookingSales)}</span>
                    <span>|</span>
                    <span>ตู้ POS: {formatBaht(dashStats.fbSales)}</span>
                  </div>
                  <p className="text-[9px] text-slate-500 mt-1">รอชำระ (ยังไม่นับ): {formatBaht(dashStats.pendingRevenue)} · คืนเงินแล้ว: {formatBaht(dashStats.refunds)} บาท</p>
                </div>

                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs">
                  <span className="text-slate-400 block font-bold text-[10px]">จำนวนสมาชิกจองในก๊วนคัพ (Registered Accounts)</span>
                  <span className="text-2xl font-extrabold text-slate-800 mt-1 block">{dashStats.customerCount} บัญชี</span>
                  <p className="text-[9px] text-slate-500 mt-1.5">ลูกค้าระดับ MOU องค์กร / สโมสร และนักซ้อมอิสระ</p>
                </div>

                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs">
                  <span className="text-slate-400 block font-bold text-[10px]">รวมมูลค่าเคาน์เตอร์สะสม (Total POS Products)</span>
                  <span className="text-2xl font-extrabold text-slate-800 mt-1 block">{formatBaht(dashStats.fbSales)} บาท</span>
                  <p className="text-[9px] text-slate-500 mt-1.5">เครื่องดื่ม น้ำเกลือแร่ สนับเข่า ดรายไอซ์ และเช่าแร็กเก็ต</p>
                </div>
              </div>
            </div>

            {/* Graphs Row (Module 4 visual specifications) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-2">
              
              {/* Line graph of revenue growth */}
              <div className="col-span-1 lg:col-span-8 bg-slate-50 p-5 rounded-2xl border border-slate-200/60">
                <div className="mb-4">
                  <h4 className="text-xs font-bold text-slate-800">รายรับแยกประเภท 6 เดือนล่าสุด (บาท)</h4>
                  <p className="text-[10px] text-slate-400 mt-0.5">ค่าสนามที่ชำระแล้ว เทียบกับยอดขาย/เช่าที่เคาน์เตอร์ ถึงเดือนของวันที่เลือก</p>
                </div>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={getRevenueChartData()}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" fontSize={11} stroke="#64748b" />
                      <YAxis fontSize={11} stroke="#64748b" />
                      <Tooltip />
                      <Legend fontSize={10} />
                      <Bar dataKey="รายได้ค่าคอร์ท" fill="#15803d" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="รายได้เครื่องดื่ม/เช่าแร็ก" fill="#38bdf8" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Pie graph of product shares */}
              <div className="col-span-1 lg:col-span-4 bg-slate-50 p-5 rounded-2xl border border-slate-200/60 flex flex-col justify-between">
                <div>
                  <h4 className="text-xs font-bold text-slate-800">สัดส่วนรายรับจากเช่าของ / อาหาร</h4>
                  <p className="text-[10px] text-slate-400 mt-0.5">ยอดขายเคาน์เตอร์สะสมทั้งหมด แยกตามประเภทสินค้า</p>
                </div>

                <div className="h-44 relative flex items-center justify-center my-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={getPieChartData()}
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={70}
                        paddingAngle={5}
                        dataKey="value"
                      >
                        {getPieChartData().map((_, index) => (
                          <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Total indicator overlay */}
                  <div className="absolute text-center">
                    <p className="text-[9px] text-slate-400 uppercase font-bold tracking-tight">รวม</p>
                    <p className="font-extrabold text-slate-800 text-sm">{formatBaht(dashStats.fbSales)} บ.</p>
                  </div>
                </div>

                {/* Pie legend layout */}
                <div className="space-y-1.5 text-[10px]">
                  {getPieChartData().map((entry, index) => (
                    <div key={index} className="flex justify-between items-center text-slate-600 font-medium">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: PIE_COLORS[index] }} />
                        {entry.name}
                      </span>
                      <span className="font-bold text-slate-800 font-mono">{formatBaht(entry.value)} บาท</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Peak Hours Occupancy trend chart */}
            <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200/60">
              <div className="mb-4">
                <span className="text-xs bg-amber-100 text-amber-800 font-extrabold px-2.5 py-1 rounded-full uppercase text-[9px]">Peak / Off-Peak Rate Analysis</span>
                <h4 className="text-xs font-bold text-slate-800 mt-2">อัตราการใช้สนามเฉลี่ยรายชั่วโมง (%) ช่วง 30 วันถึงวันที่เลือก</h4>
                <p className="text-[10px] text-slate-400 mt-0.5">ใช้ดูว่าช่วงไหนคนเต็ม เพื่อกำหนดช่วง Peak / Off-Peak</p>
              </div>

              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={getDayCapacityChartData()}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="hourName" fontSize={11} stroke="#64748b" />
                    <YAxis fontSize={11} stroke="#64748b" />
                    <Tooltip />
                    <Line type="monotone" dataKey="เฉลี่ยอัตรา (%)" stroke="#eab308" strokeWidth={3} dot={{ r: 5 }} activeDot={{ r: 8 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* COMPREHENSIVE MANAGER COURT BOOKING VISUALIZER MATRIX */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4 shadow-sm text-xs">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                  <h4 className="text-xs font-bold text-slate-800 uppercase tracking-widest flex items-center gap-1.5 font-sans">
                    🎾 มอนิเตอร์ดีมานด์ภาพรวมคอร์ท (Comprehensive Court Occupancy Grid)
                  </h4>
                  <p className="text-[10px] text-slate-500 mt-0.5">
                    ตรวจสอบช่วงเวลาสนามว่าง/เต็มทุกชั่วโมง สำหรับใช้พิจารณารับผู้เล่น Walk-in และตัดใจอัปย้ายโปรโมชั่นล่วงหน้า
                  </p>
                </div>

                {/* Sub Sport Selection Tab bar */}
                <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200">
                  {Object.values(CourtType).map((sport) => {
                    const countActive = courts.filter(c => c.type === sport && c.isActive).length;
                    return (
                      <button
                        key={sport}
                        type="button"
                        onClick={() => setDashboardSelectedSport(sport)}
                        className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition flex items-center gap-1 ${
                          dashboardSelectedSport === sport 
                            ? 'bg-emerald-600 text-white shadow-xs font-black' 
                            : 'text-slate-600 hover:text-slate-950 hover:bg-slate-50'
                        }`}
                      >
                        {sport === CourtType.BADMINTON ? '🏸 ' : sport === CourtType.BASKETBALL ? '🏀 ' : '⚽ '}
                        {sport} ({countActive})
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Grid content container with horizontal scroll */}
              <div className="overflow-x-auto border border-slate-200 rounded-xl bg-slate-50/50">
                <table className="w-full text-left border-collapse min-w-[1000px]">
                  <thead>
                    <tr className="bg-slate-100 text-[10px] uppercase font-black text-slate-500 border-b border-slate-200">
                      <th className="p-3 bg-slate-100 sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] w-36">สนาม (Court Name)</th>
                      {openSlotHours().map((time) => (
                        <th key={time} className="p-2 text-center text-[9px] min-w-[70px] border-l border-slate-200">
                          {time} น.
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white text-[10px]">
                    {courts.filter(c => c.type === dashboardSelectedSport && c.isActive).map((court) => (
                      <tr key={court.id} className="hover:bg-slate-50 transition-colors">
                        {/* Court Name sticky column */}
                        <td className="p-3 font-semibold text-slate-800 bg-slate-50 sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] border-r border-slate-200">
                          <span className="flex items-center gap-1.5 text-[11px] text-[#0f172a]">
                            🎯 {court.name}
                          </span>
                        </td>

                        {/* Hourly timeline slot cells */}
                        {openSlotHours().map((time) => {
                          const targetH = parseInt(time.split(':')[0], 10);
                          
                          // 1. Check for double booking - includes mutex-group
                          // conflicts (FR-1.2: the full court blocks every
                          // half-court side, but two half-court sides do NOT
                          // block each other), not just this exact court id.
                          const matchedBooking = gridBookings.find(b => {
                            if (b.date !== dashboardSelectedDate || b.status === BookingStatus.CANCELLED) return false;
                            const bookedCourt = courts.find(c => c.id === b.courtId);
                            if (!bookedCourt || !courtsConflict(court, bookedCourt)) return false;
                            const startH = parseInt(b.startTime.split(':')[0], 10);
                            const endH = parseInt(b.endTime.split(':')[0], 10);
                            return targetH >= startH && targetH < endH;
                          });

                          // 2. Check for closure/maintenance
                          const closureItem = findClosure(api.USE_BACKEND ? dashClosures : daysOff, dashboardSelectedDate, court.id, targetH, courts);

                          // 3. Peak/Offpeak, read from the same PricingRule
                          // config the price itself uses.
                          const isPeak = !isHourOffPeak(court.type, dashboardSelectedDate, targetH);
                          const isRestrictedPeakBasketball = !!court.offPeakOnly && isPeak;

                          if (matchedBooking) {
                            const isPending = matchedBooking.status === BookingStatus.PENDING_PAYMENT;
                            return (
                              <td 
                                key={time} 
                                className={`p-1.5 border-l border-slate-200 text-center relative group select-none min-h-[44px] ${
                                  isPending ? 'bg-amber-100 text-amber-900 border-l-amber-200' : 'bg-emerald-50 text-emerald-950 border-l-emerald-200 font-bold'
                                }`}
                              >
                                <div className="font-bold truncate max-w-[70px] text-[9.5px]">
                                  👤 {matchedBooking.userName}
                                </div>
                                <span className="absolute bottom-0.5 right-1 text-[8px] opacity-70 font-mono scale-[0.8]">
                                  {isPending ? '⏳ รอชำระ' : '✓ ชำระแล้ว'}
                                </span>
                                {/* Hover interactive tooltip */}
                                <div className="absolute hidden group-hover:block bg-slate-900 text-slate-50 text-[9.5px] p-2.5 rounded-lg shadow-md z-30 w-44 left-1/2 -translate-x-1/2 -top-16 border border-slate-700 bg-[#0f172a] text-[#f8fafc] leading-tight text-left">
                                  <p className="font-bold text-emerald-400">🚨 รายละเอียดคอร์ทจอง</p>
                                  <p>ผู้จอง: <span className="font-extrabold">{matchedBooking.userName}</span></p>
                                  <p className="font-mono">เบอร์โทร: {matchedBooking.userPhone || 'ไม่ระบุ'}</p>
                                  <p className="font-mono text-amber-300">เวลาเล่น: {matchedBooking.startTime} - {matchedBooking.endTime} น.</p>
                                  <p className="font-mono text-[8.5px] text-slate-400">รหัสจอง: {matchedBooking.bookingCode}</p>
                                </div>
                              </td>
                            );
                          } else if (closureItem) {
                            return (
                              <td 
                                key={time} 
                                className="p-1 border-l border-slate-200 bg-rose-100/75 text-rose-900 text-center min-h-[44px] select-none font-bold"
                                title={`ปิดให้บริการ: ${closureItem.reason}`}
                              >
                                <span className="block text-[8px] text-rose-700">⚠️ ปิดสนาม</span>
                                <span className="text-[7.5px] text-rose-900 block max-w-[65px] truncate mx-auto">
                                  {closureItem.reason}
                                </span>
                              </td>
                            );
                          } else if (isRestrictedPeakBasketball) {
                            return (
                              <td 
                                key={time} 
                                className="p-1 border-l border-slate-200 bg-slate-100 text-slate-400 text-center min-h-[44px] select-none"
                                title="เฉพาะช่วงเวลาเพื่อสุขภาพ (Off-peak) เท่านั้น"
                              >
                                <span className="block text-[8px] font-semibold text-slate-500 leading-none">🚫 ปิดช่วง Peak</span>
                                <span className="text-[7px] text-slate-400 block scale-[0.95]">ครึ่งสนาม</span>
                              </td>
                            );
                          } else {
                            return (
                              <td key={time} className="p-1.5 border-l border-slate-200 text-emerald-800 text-center bg-emerald-50/5 hover:bg-emerald-100/10 transition cursor-default">
                                <span className="font-mono text-[9px] font-bold block text-emerald-600">🟢 ว่าง</span>
                                <span className="text-[8px] text-slate-400 mt-0.5 block scale-90 leading-tight">ว่างเปล่า</span>
                              </td>
                            );
                          }
                        })}
                      </tr>
                    ))}

                    {courts.filter(c => c.type === dashboardSelectedSport && c.isActive).length === 0 && (
                      <tr>
                        <td colSpan={17} className="text-center text-slate-400 py-10 font-bold">
                          ยังไม่มีข้อมูลสนามของประเภทกีฬา {dashboardSelectedSport} ที่เปิดการใช้งานเวลานี้
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Informative advice for active managers */}
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center text-[10px] text-slate-500 bg-slate-50 p-3 rounded-xl border border-slate-200 gap-2 font-mono">
                <span className="font-semibold text-emerald-800 flex items-center gap-1">
                  💡 คำแนะนำผู้บริหาร: แถบสีเขียวคือยอดชำระแล้วเรียบร้อย แถบสีเหลืองคือสัญญารอโอนเงินผ่านระบบ และสล็อตว่างสามารถจัดสรรขายหน้างานตั๋ว Walk-in ได้ทันที
                </span>
                <span className="font-bold text-slate-800 uppercase">
                  ประเภทกีฬา: {dashboardSelectedSport} (จำนวนสนาม: {courts.filter(c => c.type === dashboardSelectedSport && c.isActive).length})
                </span>
              </div>
            </div>

          </div>
        )}

        {/* Sub Module 2: Pricing Engine configurations */}
        {activeAdminTab === 'pricing' && adminTabAllowed('pricing') && (
          <div className="space-y-6">
            <div>
              <h3 className="text-base font-bold text-slate-900">ตัวเครื่องมือตั้งและปรับราคาล่วงหน้า (Pricing Engine Configurator)</h3>
              <div id="max-advance-days-setting" className="mt-2 flex flex-wrap items-center gap-2 text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 w-fit">
                <span className="text-slate-600">ลูกค้าจองออนไลน์ล่วงหน้าได้</span>
                <input type="number" min={1} max={365} value={maxAdvanceDays} onChange={e => setMaxAdvanceDays(Number(e.target.value))}
                  className="w-20 border border-slate-300 rounded px-2 py-1" />
                <span className="text-slate-600">วัน (พนักงานจองที่เคาน์เตอร์ได้ไม่จำกัด)</span>
                <button type="button" disabled={busy} onClick={guarded(handleSaveMaxAdvanceDays)} className="disabled:opacity-50 bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-3 py-1 rounded">บันทึก</button>
              </div>
              <div id="opening-hours-setting" className="mt-2 flex flex-wrap items-center gap-2 text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 w-fit">
                <span className="text-slate-600">เวลาเปิดให้จอง</span>
                <select value={openHourSetting} onChange={e => setOpenHourSetting(Number(e.target.value))} className="border border-slate-300 rounded px-2 py-1">
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                </select>
                <span className="text-slate-600">ถึง</span>
                <select value={closeHourSetting} onChange={e => setCloseHourSetting(Number(e.target.value))} className="border border-slate-300 rounded px-2 py-1">
                  {Array.from({ length: 24 }, (_, i) => i + 1).map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                </select>
                <button type="button" disabled={busy} onClick={guarded(handleSaveOpeningHours)} className="disabled:opacity-50 bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-3 py-1 rounded">บันทึก</button>
                <span className="text-[10px] text-slate-500 w-full">ในช่วงนี้ ชั่วโมงที่มีกฎราคาเท่านั้นที่จองได้ (เช่น ไม่มีเรท 06:00 = กีฬานั้นยังไม่เปิด 06:00)</span>
              </div>
              <div id="business-setting" className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 max-w-2xl">
                <span className="text-slate-600 font-bold sm:col-span-2">ข้อมูลร้าน (พิมพ์บนใบเสร็จ และแสดงเป็นชื่อบัญชีผู้รับตอนลูกค้าโอน)</span>
                <label className="flex flex-col gap-1"><span className="text-slate-600">ชื่อร้าน / ชื่อบัญชีรับเงิน</span>
                  <input maxLength={200} value={business.name} onChange={e => setBusiness({ ...business, name: e.target.value })} className="border border-slate-300 rounded px-2 py-1" /></label>
                <label className="flex flex-col gap-1"><span className="text-slate-600">เบอร์โทร</span>
                  <input maxLength={50} value={business.phone} onChange={e => setBusiness({ ...business, phone: e.target.value })} className="border border-slate-300 rounded px-2 py-1" /></label>
                <label className="flex flex-col gap-1 sm:col-span-2"><span className="text-slate-600">ที่อยู่</span>
                  <input maxLength={500} value={business.address} onChange={e => setBusiness({ ...business, address: e.target.value })} className="border border-slate-300 rounded px-2 py-1" /></label>
                <label className="flex flex-col gap-1"><span className="text-slate-600">เลขประจำตัวผู้เสียภาษี (13 หลัก)</span>
                  <input inputMode="numeric" maxLength={17} value={business.taxId} onChange={e => setBusiness({ ...business, taxId: e.target.value })} className="border border-slate-300 rounded px-2 py-1" /></label>
                <label className="flex items-center gap-2 self-end pb-1"><input type="checkbox" checked={business.vatRegistered} onChange={e => setBusiness({ ...business, vatRegistered: e.target.checked })} />
                  <span className="text-slate-600">จดทะเบียน VAT (ใบเสร็จแสดงภาษี 7%)</span></label>
                <div className="sm:col-span-2"><button type="button" disabled={busy} onClick={guarded(handleSaveBusiness)} className="disabled:opacity-50 bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-3 py-1 rounded">บันทึกข้อมูลร้าน</button></div>
              </div>
              <p className="text-xs text-slate-500">คุณสามารถกำหนดค่า ราคาปกติ, ราคา Peak ยิ่งเร่งด่วนตามเงื่อนไขช่วงชั่วโมง, และชนิดวันธรรมดา/เสาร์อาทิตย์</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              
              {/* Rule Creator form (Left side) */}
              <div className="col-span-1 lg:col-span-4 bg-slate-50 p-5 rounded-2xl border border-slate-200">
                <p className="text-xs font-bold text-slate-800 flex items-center gap-1.5 mb-4 text-emerald-800">
                  <SettingChevron className="h-4 w-4 shrink-0" />
                  {editingRuleId ? '🔧 แก้ไขสูตรกฎการตั้งราคา' : '➕ เพิ่มมิติสูตรกฎการตั้งราคา'}
                </p>

                <form onSubmit={e => { e.preventDefault(); void guarded(handleSavePricingRule)(e); }} className="space-y-4 text-xs">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">1. ชนิดของกีฬาหน้าสนาม</label>
                    <select 
                      value={ruleCourtType}
                      onChange={(e) => setRuleCourtType(e.target.value as CourtType)}
                      className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg"
                    >
                      {Object.values(CourtType).map(v => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-700 font-semibold mb-1.5">2. มิติชนิดวันในสัปดาห์</label>
                      <select 
                        value={ruleDayType}
                        onChange={(e) => setRuleDayType(e.target.value as DayType)}
                        className="w-full bg-white border border-slate-200 py-1.5 px-3 rounded-lg"
                      >
                        {Object.values(DayType).map(v => (
                          <option key={v} value={v}>{v === DayType.WEEKDAY ? 'วันธรรมดา' : 'เสาร์ - อาทิตย์'}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-slate-700 font-semibold mb-1.5">3. มิติระดับสิทธิ์เร่งด่วน</label>
                      <select 
                        value={rulePriceType}
                        onChange={(e) => setRulePriceType(e.target.value as PriceType)}
                        className="w-full bg-white border border-slate-200 py-1.5 px-3 rounded-lg"
                      >
                        {Object.values(PriceType).map(v => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-700 font-semibold mb-1.5">4. ช่วงชั่วโมงเวลา เริ่ม (0-23)</label>
                      <input 
                        type="number"
                        min={0} max={23}
                        value={ruleStartHour}
                        onChange={(e) => setRuleStartHour(Number(e.target.value))}
                        className="w-full bg-white border border-slate-200 py-1.5 px-3 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-700 font-semibold mb-1.5">5. ชั่วโมง สิ้นสุด (1-24)</label>
                      <input 
                        type="number"
                        min={1} max={24}
                        value={ruleEndHour}
                        onChange={(e) => setRuleEndHour(Number(e.target.value))}
                        className="w-full bg-white border border-slate-200 py-1.5 px-3 rounded-lg"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">6. ป้ายชื่อแสดงหน้าร้าน (Label):</label>
                    <input 
                      type="text"
                      required
                      placeholder="เช่น แบดมินตัน พีคเย็นจันทร์ถึงศุกร์"
                      value={ruleLabel}
                      onChange={(e) => setRuleLabel(e.target.value)}
                      className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">7. ค่าบริการ (บาท ต่อชั่วโมงการเล่น):</label>
                    <input 
                      type="number"
                      required min={0}
                      value={rulePrice}
                      onChange={(e) => setRulePrice(Number(e.target.value))}
                      className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg font-bold text-slate-800"
                    />
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="submit" disabled={busy}
                      className="flex-1 bg-emerald-700 hover:bg-emerald-600 font-bold py-2 rounded text-white text-xs transition"
                    >
                      {editingRuleId ? 'ปรับสูตรประเมิน' : 'สลักสิทธิ์กฎใหม่'}
                    </button>
                    {editingRuleId && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingRuleId(null);
                          setRuleLabel('');
                          setRulePrice(200);
                        }}
                        className="bg-slate-300 py-2 px-3 text-slate-700 rounded hover:bg-slate-400"
                      >
                        ยกเลิก
                      </button>
                    )}
                  </div>
                </form>
              </div>

              {/* Rules interactive table (Right side) */}
              <div className="col-span-1 lg:col-span-8 space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold text-slate-700 block">ตารางเกณฑ์คำนวณราคาปัจจุบันทั้งหมด (Active Engine Table):</span>
                  {(filterCourtType || filterDayType || filterPriceType || filterLabel) && (
                    <button 
                      type="button"
                      onClick={() => {
                        setFilterCourtType('');
                        setFilterDayType('');
                        setFilterPriceType('');
                        setFilterLabel('');
                      }} 
                      className="text-[10px] text-emerald-700 font-bold hover:underline transition"
                    >
                      ล้างตัวกรองทั้งหมด [Reset]
                    </button>
                  )}
                </div>
                
                <div className="overflow-x-auto border border-slate-200 rounded-xl">
                  <table className="w-full text-xs text-left text-slate-500">
                    <thead className="text-[10px] text-slate-700 bg-slate-50 border-b border-slate-100 uppercase font-bold">
                      <tr>
                        <th className="px-4 py-3">ประเภทกีฬา</th>
                        <th className="px-4 py-3">ช่วงชั่วโมง</th>
                        <th className="px-4 py-3">วัน</th>
                        <th className="px-4 py-3">ประเภทราคา</th>
                        <th className="px-4 py-3 text-right">ค่าเช่า / ชม.</th>
                        <th className="px-4 py-3 text-center">จัดการคำสั่ง</th>
                      </tr>
                      {/* Search & Filter Controls per Column Row */}
                      <tr className="bg-slate-100/60 border-b border-slate-200">
                        <th className="p-2">
                          <input 
                            type="text"
                            placeholder="ค้นหากีฬา..."
                            value={filterCourtType}
                            onChange={(e) => setFilterCourtType(e.target.value)}
                            className="w-full bg-white border border-slate-200 font-normal py-1 px-2 rounded text-[10px] text-slate-700"
                          />
                        </th>
                        <th className="p-2">
                          <input
                            type="text"
                            placeholder="ค้นหาป้ายชื่อ..."
                            value={filterLabel}
                            onChange={(e) => setFilterLabel(e.target.value)}
                            className="w-full bg-white border border-slate-200 font-normal py-1 px-2 rounded text-[10px] text-slate-700"
                          />
                        </th>
                        <th className="p-2">
                          <select
                            value={filterDayType}
                            onChange={(e) => setFilterDayType(e.target.value)}
                            className="w-full bg-white border border-slate-200 font-normal py-1 px-1.5 rounded text-[10px] text-slate-700"
                          >
                            <option value="">ทั้งหมด</option>
                            <option value="WEEKDAY">วันธรรมดา</option>
                            <option value="WEEKEND">วันหยุด</option>
                          </select>
                        </th>
                        <th className="p-2">
                          <input 
                            type="text"
                            placeholder="PEAK / OFFPEAK..."
                            value={filterPriceType}
                            onChange={(e) => setFilterPriceType(e.target.value)}
                            className="w-full bg-white border border-slate-200 font-normal py-1 px-2 rounded text-[10px] text-slate-700"
                          />
                        </th>
                        <th className="p-2"></th>
                        <th className="p-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredPricingRules.map((rule) => (
                        <tr key={rule.id} className="hover:bg-slate-50 transition">
                          <td className="px-4 py-3 font-bold text-slate-800">
                            {rule.courtType}
                            {rule.label && <span className="block text-[10px] font-normal text-slate-500">{rule.label}</span>}
                          </td>
                          <td className="px-4 py-3 font-mono">{rule.startHour.toString().padStart(2, '0')}:00 - {rule.endHour.toString().padStart(2, '0')}:00 น.</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold whitespace-nowrap ${
                              rule.dayType === DayType.WEEKDAY ? 'bg-slate-100 text-slate-700' : 'bg-emerald-100 text-emerald-800'
                            }`}>
                              {rule.dayType === DayType.WEEKDAY ? 'วันธรรมดา จ-ศ' : 'เสาร์ - อาทิตย์'}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-semibold">{rule.priceType}</td>
                          <td className="px-4 py-3 text-right font-black text-slate-950 whitespace-nowrap">{formatBaht(rule.pricePerHour)} บาท</td>
                          <td className="px-4 py-3 text-center flex justify-center gap-1.5">
                            <button
                              onClick={() => {
                                setEditingRuleId(rule.id);
                                setRuleCourtType(rule.courtType);
                                setRuleDayType(rule.dayType);
                                setRuleStartHour(rule.startHour);
                                setRuleEndHour(rule.endHour);
                                setRulePrice(rule.pricePerHour);
                                setRulePriceType(rule.priceType);
                                setRuleLabel(rule.label);
                              }}
                              className="text-sky-600 hover:text-sky-800 font-bold"
                            >
                              แก้ไข
                            </button>
                            <button
                              disabled={busy} onClick={guarded(() => handleDeletePricingRule(rule.id))}
                              className="text-rose-600 hover:text-rose-800 font-bold"
                            >
                              ลบ
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Sub Module 2.5: Manage Courts and Special Holidays */}
        {activeAdminTab === 'courts' && adminTabAllowed('courts') && (
          <div className="space-y-6 animate-fade-in text-xs">
            <div>
              <h3 className="text-base font-bold text-slate-900">ระบบบริหารสนามกีฬาและตั้งเกณฑ์วันปิดบริการพิเศษ (Complex Facility & Holiday Manager)</h3>
              <p className="text-xs text-slate-500">คุณสามารถควบคุมสนามแต่ละเลข เพิ่มสนามกีฬาเมื่อขยายธุรกิจ หรือบล็อกระงับวันหยุดพิเศษไม่ให้ลูกค้าจอง</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Creator Forms (Col 4) */}
              <div className="col-span-1 lg:col-span-4 space-y-6">
                
                {/* 1. Add Court Form (admins) */}
                {canManageCourts && (
                <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200">
                  <span className="text-xs font-bold text-slate-800 block mb-4 text-emerald-950">🏟️ เพิ่มรายสนามกีฬาในระบบ</span>
                  
                  <form onSubmit={e => { e.preventDefault(); void guarded(handleCreateCourt)(e); }} className="space-y-4 text-xs font-sans">
                    <div>
                      <label className="block text-slate-700 font-semibold mb-1.5 font-sans">ชื่อหรือเลขที่สนาม:</label>
                      <input 
                        type="text"
                        required
                        placeholder="เช่น สนามแบดมินตัน 13"
                        value={newCourtName}
                        onChange={(e) => setNewCourtName(e.target.value)}
                        className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg text-slate-800 text-xs font-sans"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-slate-700 font-semibold mb-1.5">ประเภทกีฬา:</label>
                        <select 
                          value={newCourtType}
                          onChange={(e) => setNewCourtType(e.target.value as CourtType)}
                          className="w-full bg-white border border-slate-200 py-1.5 px-2 rounded-lg text-xs"
                        >
                          {Object.values(CourtType).map(v => (
                            <option key={v} value={v}>{v}</option>
                          ))}
                        </select>
                      </div>

                      <div className="flex items-center pt-5">
                        <label className="flex items-center gap-1.5 cursor-pointer text-slate-700 font-bold text-[11px]">
                          <input 
                            type="checkbox"
                            checked={newCourtAllowHalf}
                            onChange={(e) => setNewCourtAllowHalf(e.target.checked)}
                            className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                          />
                          เป็นครึ่งสนาม (คิดราคาครึ่งสนาม)
                        </label>
                      </div>
                    </div>

                    {newCourtAllowHalf && (
                      <div>
                        <label htmlFor="new-court-half-of" className="block text-slate-700 font-semibold mb-1.5">เป็นครึ่งหนึ่งของสนาม:</label>
                        <select id="new-court-half-of" value={newCourtHalfOf} onChange={e => setNewCourtHalfOf(e.target.value)}
                          className="w-full bg-white border border-slate-200 py-1.5 px-2 rounded-lg text-xs">
                          <option value="">-- เลือกสนามเต็มสนาม --</option>
                          {courts.filter(c => c.type === newCourtType && c.shareOfGroup >= 1).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <p className="text-[10px] text-slate-500 mt-1">จองครึ่งสนามแล้ว สนามเต็มจะจองช่วงนั้นไม่ได้ (และกลับกัน)</p>
                      </div>
                    )}

                    <button 
                      type="submit" disabled={busy} 
                      className="w-full bg-slate-900 hover:bg-slate-800 py-2.5 rounded text-white font-bold transition text-xs shadow-sm font-sans"
                    >
                      เพิ่มสนาม
                    </button>
                  </form>
                </div>
                )}

                {/* 2. Add Special Closed Day / Holiday */}
                <div className="bg-rose-50/50 p-5 rounded-2xl border border-rose-200 text-xs space-y-4 shadow-sm">
                  <div>
                    <span className="text-xs font-bold text-rose-900 block mb-1">📅 กำหนดวันปิดหยุดบริการพิเศษ</span>
                    <p className="text-[10px] text-slate-500 leading-normal">บล็อกช่วงวันไม่ให้ทำรายการจองล่วงหน้าเพื่อปิดบำรุงรักษาคอมเพล็กซ์</p>
                  </div>

                  <form onSubmit={e => { e.preventDefault(); void guarded(handleSaveDayOff)(e); }} className="space-y-3 font-sans">
                    <div>
                      <label className="block text-slate-700 font-semibold mb-1">เลือกวันที่ปิดระงับบริการ:</label>
                      <input 
                        type="date"
                        required
                        value={newDayOffDate}
                        onChange={(e) => setNewDayOffDate(e.target.value)}
                        className="w-full bg-white border border-slate-200 py-1.5 px-3 rounded-lg text-xs font-bold text-slate-800"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-700 font-semibold mb-1">เป้าหมายสนามที่ปิด:</label>
                      <select 
                        value={newDayOffCourtId}
                        onChange={(e) => setNewDayOffCourtId(e.target.value)}
                        className="w-full bg-white border border-slate-200 py-1.5 px-2 rounded-lg text-xs text-slate-800 font-bold"
                      >
                        <option value="all">-- ปิดบริการทุกสนาม (บำรุงทั้งคลับ) --</option>
                        {courts.map(c => (
                          <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-slate-700 font-semibold mb-1">ขอบเขตระยะเวลา:</label>
                      <div className="flex gap-4 mb-2 py-0.5">
                        <label className="flex items-center gap-1.5 cursor-pointer text-slate-700 font-medium">
                          <input 
                            type="radio" 
                            name="newDayOffIsFullDay" 
                            checked={newDayOffIsFullDay} 
                            onChange={() => setNewDayOffIsFullDay(true)} 
                          />
                          <span>ปิดเต็มวัน</span>
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer text-slate-700 font-medium">
                          <input 
                            type="radio" 
                            name="newDayOffIsFullDay" 
                            checked={!newDayOffIsFullDay} 
                            onChange={() => setNewDayOffIsFullDay(false)} 
                          />
                          <span>ระบุช่วงเวลาชั่วโมง</span>
                        </label>
                      </div>
                    </div>

                    {!newDayOffIsFullDay && (
                      <div className="grid grid-cols-2 gap-2 bg-rose-100/30 p-2 rounded-lg border border-rose-200/50">
                        <div>
                          <label className="block text-slate-700 font-bold mb-1 text-[10px]">ตั้งแต่ (Start):</label>
                          <select
                            value={newDayOffStartHour}
                            onChange={(e) => setNewDayOffStartHour(Number(e.target.value))}
                            className="w-full bg-white border border-slate-200 py-1 px-1.5 rounded text-xs font-bold text-slate-800"
                          >
                            {openSlotHours().map(t => parseInt(t, 10)).map(h => (
                              <option key={h} value={h}>{String(h).padStart(2, '0')}:00 น.</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-slate-700 font-bold mb-1 text-[10px]">ถึงเวลา (End):</label>
                          <select
                            value={newDayOffEndHour}
                            onChange={(e) => setNewDayOffEndHour(Number(e.target.value))}
                            className="w-full bg-white border border-slate-200 py-1 px-1.5 rounded text-xs font-bold text-slate-800"
                          >
                            {openSlotHours().map(t => parseInt(t, 10) + 1).map(h => (
                              <option key={h} value={h}>{String(h).padStart(2, '0')}:00 น.</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )}

                    <div>
                      <label className="block text-slate-700 font-semibold mb-1">เหตุผลหรือหมายเหตุ (ขยายหน้าร้าน):</label>
                      <input 
                        type="text"
                        required
                        placeholder="เช่น งานบำรุงรักษาพื้นผิวทาสีขาวใหม่"
                        value={newDayOffReason}
                        onChange={(e) => setNewDayOffReason(e.target.value)}
                        className="w-full bg-white border border-slate-200 py-1.5 px-3 rounded-lg text-xs text-slate-800"
                      />
                    </div>

                    <button 
                      type="submit" disabled={busy} 
                      className="w-full bg-rose-700 hover:bg-rose-800 py-2.5 rounded text-white font-bold transition text-xs shadow-sm font-sans"
                    >
                      บันทึกวันปิดบริการ
                    </button>
                  </form>
                </div>

              </div>

              {/* Data Lists Table (Col 8) */}
              <div className="col-span-1 lg:col-span-8 space-y-6">
                
                {/* A. Active Courts Management */}
                <div className="space-y-3">
                  <span className="text-xs font-bold text-slate-700 block">สนามกีฬาและห้องประชุมคอมเพล็กซ์ทั้งหมด ({courts.length} สนาม):</span>
                  <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white shadow-sm">
                    <table className="w-full text-xs text-left text-slate-500">
                      <thead className="text-[10px] text-slate-700 bg-slate-50 border-b border-slate-100 uppercase font-bold">
                        <tr>
                          <th className="px-4 py-3">รหัสสนาม</th>
                          <th className="px-4 py-3">ชื่อเรียกสนามกีฬา</th>
                          <th className="px-4 py-3 font-sans">ประเภท</th>
                          <th className="px-4 py-3 font-sans">เงื่อนไขครึ่งสนาม</th>
                          <th className="px-4 py-3 text-center font-sans">สถานะบริการ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-sans">
                        {courts.map((court) => (
                          <tr key={court.id} className="hover:bg-slate-50 transition">
                            <td className="px-4 py-3 font-mono text-[10px] text-slate-400">{court.id}</td>
                            <td className="px-4 py-3 font-bold text-slate-800">
                              <span>{court.name}</span>
                              <button
                                type="button"
                                disabled={!canManageCourts || busy}
                                title={canManageCourts ? 'เปลี่ยนชื่อสนาม' : 'เฉพาะ Admin'}
                                onClick={guarded(() => handleRenameCourt(court.id))}
                                className="ml-2 text-[10px] font-bold text-sky-700 hover:text-sky-900 disabled:text-slate-300"
                              >
                                ✏️ เปลี่ยนชื่อ
                              </button>
                            </td>
                            <td className="px-4 py-3 font-medium text-slate-600">{court.type}</td>
                            <td className="px-4 py-3">
                              {court.shareOfGroup < 1 ? (
                                <span className="bg-emerald-50 text-emerald-700 text-[10px] font-bold px-2 py-0.5 rounded-full">
                                  ครึ่งสนาม (ราคาครึ่งสนาม)
                                </span>
                              ) : (
                                <span className="bg-slate-100 text-slate-500 text-[10px] px-2 py-0.5 rounded-full font-sans">
                                  เต็มสนามเท่านั้น
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <button
                                type="button"
                                disabled={!canManageCourts || busy}
                                title={canManageCourts ? 'กดเพื่อเปิด/ปิดรับจอง' : 'เฉพาะ Admin (ปิดชั่วคราวใช้ "วันปิดบริการ")'}
                                onClick={guarded(() => handleToggleCourtActive(court.id))}
                                className={`px-2.5 py-1 rounded-full text-[10px] font-black transition ${
                                  court.isActive 
                                    ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200' 
                                    : 'bg-rose-100 text-rose-800 hover:bg-rose-200'
                                }`}
                              >
                                {court.isActive ? '● กำลังเปิด' : '○ ปิดระงับบริการ'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* B. Special Closed Days Management */}
                <div className="space-y-3">
                  <span className="text-xs font-bold text-slate-700 block">ปฏิทินเวลาหยุด/ระงับจองพิเศษล่วงหน้า ({daysOff.length} รายการ):</span>
                  <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white shadow-sm">
                    <table className="w-full text-xs text-left text-slate-500 font-sans">
                      <thead className="text-[10px] text-slate-700 bg-rose-50 border-b border-rose-100 uppercase font-bold">
                        <tr>
                          <th className="px-4 py-3">วันที่ปิดระงับ</th>
                          <th className="px-4 py-3">สนามกีฬาที่ปิดบล็อก</th>
                          <th className="px-4 py-3">ระวางเวลา</th>
                          <th className="px-4 py-3">เหตุผลในระบบ</th>
                          <th className="px-4 py-3 text-center">ปลดการบล็อกสนาม</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {daysOff.map((day) => {
                          const targetCourt = day.courtId === 'all' ? 'ทุกสนาม (บำรุงทั้งคลับ)' : (courts.find(c => c.id === day.courtId)?.name || 'สนามเฉพาะกิจ');
                          const rangeStr = (day.isFullDay || day.isFullDay === undefined) 
                            ? '🔴 ตลอดทั้งวัน' 
                            : `⏳ ${String(day.startHour).padStart(2, '0')}:00 - ${String(day.endHour).padStart(2, '0')}:00 น.`;
                          return (
                            <tr key={day.id} className="hover:bg-slate-50 transition">
                              <td className="px-4 py-3 font-mono font-bold text-rose-700">{day.date}</td>
                              <td className="px-4 py-3 font-semibold text-slate-800 font-sans">{targetCourt}</td>
                              <td className="px-4 py-3 font-bold text-slate-700">{rangeStr}</td>
                              <td className="px-4 py-3 text-slate-500 italic font-sans font-medium">"{day.reason}"</td>
                              <td className="px-4 py-3 text-center">
                                <button
                                  type="button"
                                  disabled={busy} onClick={guarded(() => handleDeleteDayOff(day.id))}
                                  className="text-emerald-700 hover:text-emerald-950 font-bold text-[10.5px] hover:underline"
                                >
                                  🔓 เปิดให้บริการหน้าร้านปกติ
                                </button>
                              </td>
                            </tr>
                          );
                        })}

                        {daysOff.length === 0 && (
                          <tr>
                            <td colSpan={5} className="text-center py-10 text-slate-400 text-[10px]">
                              ยังไม่มีการตั้งวันหยุด/บล็อกระงับจองล่วงหน้าในคอมเพล็กซ์แห่งนี้ 🎉 ทุกวันเปิดตามตารางปกติ
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

              </div>
            </div>
          </div>
        )}

        {/* Sub Module 3: Product catalogue & inventory management */}
        {activeAdminTab === 'products' && adminTabAllowed('products') && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="text-base font-bold text-slate-900">คุมสต๊อกตู้เย็น F&B และอุปกรณ์สนาม (Stock Inventory System)</h3>
                <p className="text-xs text-slate-500">จัดการราคาสินค้าน้ำ และจำลองสต๊อกขวดแบ่งขาย สรรหาสตาฟตรวจสอบเวลาเบิกปิดยอด</p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Product creator & Excel (Col-4) */}
              <div className="col-span-1 lg:col-span-4 space-y-4">
                <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200">
                  <span className="text-xs font-bold text-slate-800 block mb-4 text-sky-900">🥤 เพิ่มรายการสินค้าในตู้ POS</span>
                  
                  <form onSubmit={e => { e.preventDefault(); void guarded(handleCreateProduct)(e); }} className="space-y-4 text-xs">
                    <div>
                      <label className="block text-slate-700 font-semibold mb-1.5">ชื่อผลิตภัณฑ์:</label>
                      <input 
                        type="text"
                        required
                        placeholder="เช่น น้ำแร่ธรรมชาติ 1.5L, ยาริสเบียร์"
                        value={newProductName}
                        onChange={(e) => setNewProductName(e.target.value)}
                        className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-slate-700 font-semibold mb-1.5">ประเภท:</label>
                        <select 
                          value={newProductCat}
                          onChange={(e) => setNewProductCat(e.target.value as ProductCat)}
                          className="w-full bg-white border border-slate-200 py-1.5 px-3 rounded-lg"
                        >
                          <option value={ProductCat.FB}>F&B ทานตู้เย็น</option>
                          <option value={ProductCat.EQUIPMENT}>เช่าอุปกรณ์เล่น</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-slate-700 font-semibold mb-1.5">ราคาขาย/ชม (บ.):</label>
                        <input 
                          type="number"
                          min={1} required
                          value={newProductPrice}
                          onChange={(e) => setNewProductPrice(Number(e.target.value))}
                          className="w-full bg-white border border-slate-200 py-1 px-3 rounded-lg font-bold text-slate-800"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-slate-700 font-semibold mb-1.5">ยอดเปิดคลังครั้งแรก:</label>
                      <input 
                        type="number"
                        min={0}
                        value={newProductStock}
                        onChange={(e) => setNewProductStock(Number(e.target.value))}
                        className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg"
                      />
                    </div>

                    {newProductCat === ProductCat.EQUIPMENT && (
                      <label className="flex items-center gap-2 text-slate-700">
                        <input type="checkbox" checked={newProductIsRental} onChange={e => setNewProductIsRental(e.target.checked)} />
                        ให้เช่า (คืนเข้าคลังหลังใช้) — ไม่ติ๊ก = ขายขาด เช่น ลูกแบด
                      </label>
                    )}

                    <button 
                      type="submit" disabled={busy} 
                      className="w-full bg-slate-900 hover:bg-slate-800 py-2 rounded text-white font-bold transition"
                    >
                      แอดนำเข้าแคตตาล็อกสินค้า
                    </button>
                  </form>
                </div>

                {/* Excel Importer Card */}
                <div className="bg-emerald-50/50 p-5 rounded-2xl border border-emerald-200 text-xs space-y-4 shadow-sm">
                  <div>
                    <span className="text-xs font-bold text-emerald-800 block mb-1">📊 นำเข้ารายการสินค้าด่วนด้วย Excel</span>
                    <p className="text-[10px] text-slate-500 leading-normal">คุณสามารถอัปโหลดไฟล์สเปรดชีต Excel (.xlsx, .xls) เพื่อดาวน์โหลดหรือตั้งแคตตาล็อกหลายรายการได้ทีเดียว</p>
                  </div>

                  <div className="space-y-2.5">
                    <button
                      type="button"
                      onClick={handleDownloadTemplate}
                      className="w-full bg-white hover:bg-slate-100 text-slate-700 font-bold border border-slate-200 py-2 rounded text-[11px] transition flex items-center justify-center gap-1.5 shadow-sm"
                    >
                      <FileDown className="h-4 w-4 text-emerald-600" /> โหลดเทมเพลตสเปรดชีต Excel (.xlsx)
                    </button>

                    <div className="bg-white p-3 rounded-lg border border-slate-200 space-y-2">
                      <label className="block text-[10px] text-slate-600 font-bold">เลือกไฟล์เทมเพลตที่กรอกข้อมูลแล้ว:</label>
                      <input
                        type="file"
                        id="excel-file-upload-input"
                        accept=".xlsx, .xls"
                        onChange={handleExcelUpload}
                        className="w-full text-[10.5px] cursor-pointer"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Product Inventory tracker table */}
              <div className="col-span-1 lg:col-span-8 space-y-4">
                <span className="text-xs font-bold text-slate-700 block">สต๊อกรายการเครื่องดื่ม/บริการสนามปัจจุบัน (Realtime Stock Ledger):</span>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {products.map((p) => (
                    <div key={p.id} className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-center justify-between text-xs hover:border-slate-300 transition">
                      <div>
                        <span className={`text-[8px] font-black px-1.5 py-0.5 rounded ${p.isRental ? 'bg-[#93c5fd] text-sky-950' : 'bg-amber-100 text-amber-800'}`}>
                          {p.isRental ? 'ปล่อยเช่าเก็บคืน' : 'กระปุกแบ่งขายขาด'}
                        </span>
                        <p className="font-bold text-slate-800 mt-1">{p.name || 'สินค้า'}</p>
                        <p className="text-[10px] text-slate-500">มูลค่าต่อหน่วย: <span className="font-bold text-slate-700">{formatBaht(p.price)} บาท</span>{!p.isActive && <span className="ml-1 text-rose-600 font-bold">(ปิดขาย)</span>}</p>
                      </div>

                      {/* Stock adjustments levers */}
                      <div className="flex flex-col items-end gap-1.5">
                        <span className={`text-xs font-black font-mono ${p.stock > 10 ? 'text-emerald-700' : 'text-rose-600 bg-rose-50 px-2 py-0.5 rounded'}`}>
                          คลังเหลือ: {p.stock} ชิ้น
                        </span>
                        {!!p.variants?.length && (
                          <select
                            value={stockVariantSel[p.id] || ''}
                            onChange={e => setStockVariantSel(sel => ({ ...sel, [p.id]: e.target.value }))}
                            className="text-[10px] border border-slate-300 rounded px-1 py-0.5 bg-white"
                          >
                            <option value="">เลือกเบอร์</option>
                            {p.variants.map(v => (
                              <option key={v.id} value={v.id}>{v.label}{v.gender ? ` ${v.gender}` : ''} (เหลือ {v.stock})</option>
                            ))}
                          </select>
                        )}
                        
                        <div className="flex gap-1">
                          <button 
                            disabled={busy} onClick={guarded(() => handleUpdateStockValue(p.id, -5))} 
                            className="bg-slate-200 h-6 w-9 rounded bg-slate-200 border border-slate-300 hover:bg-slate-200 text-[10px] font-bold text-slate-800 text-center"
                          >
                            -5
                          </button>
                          <button 
                            disabled={busy} onClick={guarded(() => handleUpdateStockValue(p.id, 10))} 
                            className="h-6 w-9 rounded bg-[#dcfce7] border border-emerald-300 hover:bg-emerald-100 text-[10px] font-bold text-emerald-800 text-center"
                          >
                            +10
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Sub Module 4: Users accounts roles */}
        {activeAdminTab === 'users' && adminTabAllowed('users') && (
          <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">แผงพนักงานเวร และระดับสิทธิ์สมาชิก (Staff & User Membership management)</h3>
                <p className="text-xs text-slate-500">แต่งตั้งสตาฟคุมคอร์ทจากรายชื่อผู้จอง ปรับสิทธิ์ส่วนลดพิเศษ และควบคุมเสถียรภาพระบบ</p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Creator with promote logic */}
              <div className="col-span-1 lg:col-span-4 bg-slate-50 p-5 rounded-2xl border border-slate-200 h-fit space-y-4">
                <span className="text-xs font-black text-slate-800 block text-emerald-800 uppercase tracking-wider">👥 แต่งตั้งสตาฟ/เวรปฏิบัติการ</span>
                
                <p className="text-[11px] text-slate-500 leading-normal">
                  เลือกผู้ใช้งานทั่วไปที่เคยลงทะเบียนเข้ามาร่วมก๊วน เพื่อเลื่อนสิทธิ์เป็นพนักงานปฏิบัติการ (Staff) หรือผู้บริหารระบบ โดยไม่ต้องสร้างข้อมูลซ้ำซ้อน
                </p>

                {!canManageAccounts ? (
                  <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
                    การแต่งตั้งพนักงาน เปลี่ยนบทบาท และระงับบัญชี ทำได้เฉพาะผู้ดูแลระบบ (Admin) ส่วนระดับสมาชิก (ส่วนลด) และแต้มสะสมแก้ไขได้ในตารางด้านขวา
                  </p>
                ) : (
                <form onSubmit={e => { e.preventDefault(); void guarded(handlePromoteUser)(e); }} className="space-y-4 text-xs">
                  <div>
                    <label className="block text-slate-700 font-bold mb-1.5">ค้นหาเลือกจากผู้เล่นที่ลงไว้ในก๊วน:</label>
                    {users.filter(u => u.role === UserRole.CUSTOMER).length === 0 ? (
                      <div className="p-3 bg-slate-100 rounded-lg text-[10.5px] font-sans text-slate-600 border border-slate-200">
                        ⚠️ ขณะนี้ไม่มีลูกค้าที่เป็นบทบาท CUSTOMER ว่างเลย กรุณาลงทะเบียนที่หน้าสมัครแท็บลูกค้าก่อนค่ะ เพื่อนำมาเลื่อนระดับงาน
                      </div>
                    ) : (
                      <select 
                        required
                        value={userIdToPromote}
                        onChange={(e) => setUserIdToPromote(e.target.value)}
                        className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg text-slate-800 font-medium"
                      >
                        <option value="">-- กรุณาเลือกบัญชีผู้ใช้จริง --</option>
                        {users.filter(u => u.role === UserRole.CUSTOMER).map(u => (
                          <option key={u.id} value={u.id}>
                            👤 {u.name} (โทร {u.phone || 'ไม่ระบุ'}) - สิทธิ์ {u.memberType || 'NORMAL'}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div>
                    <label className="block text-slate-700 font-bold mb-1.5">ยศตำแหน่งเวรทำงานที่จะแต่งตั้ง (Assigned Role):</label>
                    <select 
                      value={newUserRole}
                      onChange={(e) => setNewUserRole(e.target.value as UserRole)}
                      className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg text-slate-800"
                    >
                      {roles.filter(r => r.id !== UserRole.CUSTOMER).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </div>

                  <button 
                    type="submit" 
                    disabled={!userIdToPromote}
                    className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-300 py-2.5 rounded-lg text-white font-bold transition shadow-sm"
                  >
                    🚀 ยืนยันสลับระดับแต่งตั้งพนักงาน
                  </button>
                </form>
                )}
              </div>

              {/* Comprehensive Users list & management search */}
              <div className="col-span-1 lg:col-span-8 space-y-4">
                <span className="text-xs font-black text-slate-800 block uppercase tracking-wider">🗄️ ระบบบริหารสมุดรายชื่อสิทธิ์สมาชิกพอร์ทัล ({users.length} รายการ)</span>
                
                {/* Search Bar filter controls */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 mb-1">ค้นหาด่วนตามชื่อ/เบอร์/เมลล์:</label>
                    <input
                      type="text"
                      placeholder="เช่น สมศักดิ์, 085..."
                      value={userSearchQuery}
                      onChange={(e) => setUserSearchQuery(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg py-1.5 px-2.5 text-xs text-slate-800 focus:outline-none focus:border-emerald-600"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 mb-1">คัดกรอง ยศบทบาทงาน:</label>
                    <select
                      value={userRoleFilter}
                      onChange={(e) => setUserRoleFilter(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg py-1.5 px-2 text-xs text-slate-800"
                    >
                      <option value="">ทั้งหมด</option>
                      <option value={UserRole.CUSTOMER}>CUSTOMER (ผู้ลงจองเอง)</option>
                      <option value={UserRole.STAFF}>STAFF (สตาฟเวร)</option>
                      <option value={UserRole.MANAGER}>MANAGER (ผู้จัดการ)</option>
                      <option value={UserRole.ADMIN}>ADMIN (แอดมิน)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 mb-1">สิทธิ์ระดับสมาชิก (MemberType):</label>
                    <select
                      value={userTierFilter}
                      onChange={(e) => setUserTierFilter(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg py-1.5 px-2 text-xs text-slate-800"
                    >
                      <option value="">ทุกระดับ</option>
                      {Object.values(MemberType).map(t => <option key={t} value={t}>{memberTierLabel(t)}</option>)}
                    </select>
                  </div>
                </div>

                <div className="border border-slate-200 rounded-xl overflow-hidden text-xs bg-white shadow-sm overflow-x-auto">
                  <table className="w-full text-left text-slate-600 min-w-[700px]">
                    <thead className="bg-slate-50 font-bold border-b border-slate-100 text-slate-800 text-[10px] uppercase tracking-wider">
                      <tr>
                        <th className="p-3">ข้อมูลโปรไฟล์หลัก / ล็อกอิน</th>
                        <th className="p-3">ระดับสิทธิ์และส่วนลด</th>
                        <th className="p-3">ยศเวรทำงาน (Role)</th>
                        <th className="p-3 text-center">🏆 แต้มสะสม CRM</th>
                        <th className="p-3 text-center">ปฏิบัติการและมาตรการ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-sans">
                      {users
                        .filter(item => {
                          const matchesSearch = !userSearchQuery || 
                            item.name.toLowerCase().includes(userSearchQuery.toLowerCase()) ||
                            (item.phone || '').includes(userSearchQuery) ||
                            (item.email || '').toLowerCase().includes(userSearchQuery.toLowerCase());
                          
                          const matchesRole = !userRoleFilter || item.role === userRoleFilter;
                          // Tiers apply to customers; an account with none is NORMAL.
                          const matchesTier = !userTierFilter || (item.role === UserRole.CUSTOMER && (item.memberType ?? MemberType.NORMAL) === userTierFilter);
                          return matchesSearch && matchesRole && matchesTier;
                        })
                        .map((item) => (
                          <tr key={item.id} className="hover:bg-slate-50/50 transition duration-150">
                            {/* Profile card column */}
                            <td className="p-3">
                              <div className="font-bold text-slate-900 text-xs">{item.name}</div>
                              <div className="text-[10px] text-slate-500 font-mono mt-0.5">เบอร์: {item.phone || 'ไม่ระบุ'}</div>
                              <div className="text-[9px] text-slate-400 mt-0.5">{item.email || 'ไม่มีอีเมล'}</div>
                            </td>

                            {/* Member type dropdown */}
                            <td className="p-3">
                              <select 
                                value={userPendingChanges[item.id]?.memberType ?? item.memberType ?? MemberType.NORMAL}
                                onChange={(e) => handleStageUserMemberType(item.id, e.target.value as MemberType)}
                                className={`border rounded py-1 px-1.5 text-[11px] font-medium text-slate-800 focus:outline-none focus:border-emerald-600 transition duration-150 ${
                                  userPendingChanges[item.id]?.memberType !== undefined && userPendingChanges[item.id]?.memberType !== (item.memberType ?? MemberType.NORMAL)
                                    ? 'bg-amber-50 border-amber-300 font-bold text-amber-900 ring-2 ring-amber-100'
                                    : 'bg-slate-50 border-slate-200'
                                }`}
                              >
                                {[MemberType.NORMAL, MemberType.MEMBER, MemberType.STUDENT, MemberType.CORPORATE].map(t => (
                                  <option key={t} value={t}>{memberTierLabel(t)}</option>
                                ))}
                              </select>
                              {userPendingChanges[item.id]?.memberType !== undefined && userPendingChanges[item.id]?.memberType !== (item.memberType ?? MemberType.NORMAL) && (
                                <span className="block text-[8px] font-black text-amber-700 mt-1 uppercase animate-pulse">⚠️ รอยืนยันเซฟ</span>
                              )}
                            </td>

                            {/* Role modifier selection */}
                            <td className="p-3">
                              <select 
                                value={userPendingChanges[item.id]?.role ?? item.role}
                                onChange={(e) => handleStageUserRole(item.id, e.target.value as UserRole)}
                                disabled={!canManageAccounts || item.id === adminUser?.id}
                                title={!canManageAccounts ? 'เปลี่ยนบทบาทได้เฉพาะผู้ดูแลระบบ (Admin)' : item.id === adminUser?.id ? 'เปลี่ยนบทบาทของตัวเองไม่ได้' : undefined}
                                className={`border rounded py-1 px-1.5 text-[11px] font-mono font-bold transition duration-150 ${
                                  userPendingChanges[item.id]?.role !== undefined && userPendingChanges[item.id]?.role !== item.role
                                    ? 'bg-amber-50 border-amber-300 text-amber-900 ring-2 ring-amber-100'
                                    : 'bg-slate-50 border-slate-200 text-slate-800'
                                }`}
                              >
                                {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                                {!roles.some(r => r.id === item.role) && <option value={item.role}>{item.role}</option>}
                              </select>
                              {userPendingChanges[item.id]?.role !== undefined && userPendingChanges[item.id]?.role !== item.role && (
                                <span className="block text-[8px] font-black text-amber-700 mt-1 uppercase animate-pulse">⚠️ รอยืนยันเซฟ</span>
                              )}
                            </td>

                             {/* Points balance cell */}
                             <td className="p-3 text-center bg-amber-50/10 font-bold text-amber-600 font-mono text-xs">
                               {item.role === UserRole.CUSTOMER ? (
                                 <div className="flex items-center justify-center gap-1.5 min-w-[110px]">
                                   <button 
                                     disabled={busy} onClick={guarded(() => handleAdjustPoints(item.id, -1))}
                                     className="h-5 w-6 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded font-black text-xs flex items-center justify-center active:scale-90"
                                     title="ลด 1 คะแนน"
                                   >
                                     -1
                                   </button>
                                   <span className="min-w-[40px] font-black text-amber-700">🏆 {item.points || 0}</span>
                                   <button 
                                     disabled={busy} onClick={guarded(() => handleAdjustPoints(item.id, 1))}
                                     className="h-5 w-6 bg-[#fef3c7] hover:bg-amber-200 text-amber-800 rounded font-black text-xs flex items-center justify-center active:scale-90"
                                     title="เพิ่ม 1 คะแนน"
                                   >
                                     +1
                                   </button>
                                 </div>
                               ) : (
                                 <span className="text-slate-400 font-medium text-[10px]">- (เฉพาะผู้เล่น)</span>
                               )}
                             </td>

                            {/* Action Operations */}
                            <td className="p-3 flex flex-col items-center justify-center gap-1.5 min-w-[120px]">
                              {userPendingChanges[item.id] && (
                                userPendingChanges[item.id].role !== item.role || 
                                // an account with no tier is NORMAL - not a change
                                userPendingChanges[item.id].memberType !== (item.memberType ?? MemberType.NORMAL)
                              ) ? (
                                <div className="flex flex-col gap-1 w-full p-1 bg-amber-50/50 rounded border border-amber-200 shadow-xs">
                                  <button
                                    disabled={busy} onClick={guarded(() => handleSaveUserPermissions(item.id))}
                                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black py-1 px-2 rounded text-[9px] shadow-sm transition duration-150 flex items-center justify-center gap-1 active:scale-95"
                                  >
                                    💾 เซฟบันทึกสิทธิ์
                                  </button>
                                  <button
                                    onClick={() => handleCancelUserStage(item.id)}
                                    className="w-full bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold py-0.5 px-2 rounded text-[8px] transition duration-150 text-center"
                                  >
                                    ยกเลิก
                                  </button>
                                </div>
                              ) : api.USE_BACKEND ? (
                                // No delete through the API: suspending keeps the
                                // account's bookings and points history.
                                canManageAccounts && item.id !== adminUser?.id ? (
                                  <button
                                    disabled={busy} onClick={guarded(() => handleToggleUserActive(item.id, item.isActive))}
                                    className={`px-2.5 py-1 text-[9px] rounded-lg font-bold shadow-xs transition ${
                                      item.isActive ? 'bg-emerald-100 text-emerald-800 hover:bg-amber-100 hover:text-amber-800' : 'bg-rose-100 text-rose-800 hover:bg-slate-200'
                                    }`}
                                  >
                                    {item.isActive ? 'ใช้งาน' : 'ระงับชั่วคราว'}
                                  </button>
                                ) : (
                                  <span className="text-[9px] text-slate-400">{item.isActive ? 'ใช้งาน' : 'ระงับ'}</span>
                                )
                              ) : (
                                <div className="flex items-center gap-1">
                                  <button
                                    disabled={busy} onClick={guarded(() => handleToggleUserActive(item.id, item.isActive))}
                                    className={`px-2.5 py-1 text-[9px] rounded-lg font-bold shadow-xs transition ${
                                      item.isActive ? 'bg-emerald-100 text-emerald-800 hover:bg-amber-100 hover:text-amber-800' : 'bg-rose-100 text-rose-800 hover:bg-slate-200'
                                    }`}
                                  >
                                    {item.isActive ? 'ใช้งาน' : 'ระงับชั่วคราว'}
                                  </button>
                                  
                                  {/* With the backend accounts are suspended, never deleted
                                      (their bookings and payments must stay on record). */}
                                  {!api.USE_BACKEND && <button
                                    disabled={busy} onClick={guarded(() => handleDeleteUserByAdmin(item.id, item.name))}
                                    className="bg-rose-50 hover:bg-rose-600 hover:text-white text-rose-700 font-bold p-1 rounded transition text-[10px]"
                                    title="ลบข้อมูลถาวร"
                                  >
                                    🗑️ ลบไอดี
                                  </button>}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Sub Module 5: Consolidated reports downloadable excel simulated CSV */}
        {activeAdminTab === 'reports' && adminTabAllowed('reports') && (
          <div className="space-y-6">
            <div>
              <h3 className="text-base font-bold text-slate-900">สรุปพิมพ์ดาวน์โหลดรายงานรายได้ (Exporter Console)</h3>
              <p className="text-xs text-slate-500">ข้อมูลจะรี่เรียงออกมาจัดรูปตามมติบัญชี สำหรับยื่นปิดงบดุลประจำปีกับสำนักบัญชีสัญญารุ่นไทย</p>
            </div>

            <div className="bg-slate-50 p-6 rounded-2xl border border-slate-200 max-w-4xl space-y-4">
              <span className="text-xs font-bold text-slate-700 block flex items-center gap-1.5"><FileDown className="h-4 w-4 text-emerald-600" /> ตัวกรองสร้างลิ้งก์ดาวน์โหลดรายงานรายชั่วโมงกิจกรรม:</span>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div>
                  <label className="block text-slate-500 mb-1.5">คาบเลือกเดือนปิดบิล:</label>
                  <select 
                    value={reportsMonth} 
                    onChange={(e) => setReportsMonth(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded p-2 text-xs"
                  >
                    <option value="01">มกราคม (Jan)</option>
                    <option value="02">กุมภาพันธ์ (Feb)</option>
                    <option value="03">มีนาคม (Mar)</option>
                    <option value="04">เมษายน (Apr)</option>
                    <option value="05">พฤษภาคม (May)</option>
                    <option value="06">มิถุนายน (Jun)</option>
                    <option value="07">กรกฎาคม (Jul)</option>
                    <option value="08">สิงหาคม (Aug)</option>
                    <option value="09">กันยายน (Sep)</option>
                    <option value="10">ตุลาคม (Oct)</option>
                    <option value="11">พฤศจิกายน (Nov)</option>
                    <option value="12">ธันวาคม (Dec)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-500 mb-1.5">ปีปฏิทิน:</label>
                  <select 
                    value={reportsYear} 
                    onChange={(e) => setReportsYear(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded p-2 text-xs"
                  >
                    {/* next year down to 5 years back */}
                    {Array.from({ length: 7 }, (_, i) => Number(getTodayDateStr().slice(0, 4)) + 1 - i).map(y => (
                      <option key={y} value={String(y)}>{y}</option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col justify-end gap-2">
                  <button
                    id="report-csv-bookings"
                    onClick={() => handleDownloadCSVReport('bookings')}
                    className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-2.5 rounded text-xs flex items-center justify-center gap-2 transition shadow-sm"
                  >
                    <FileDown className="h-4 w-4" /> การจองสนาม .CSV
                  </button>
                  <button
                    id="report-csv-orders"
                    onClick={() => handleDownloadCSVReport('orders')}
                    className="w-full bg-white hover:bg-slate-100 text-slate-900 border border-slate-300 font-bold py-2.5 rounded text-xs flex items-center justify-center gap-2 transition shadow-sm"
                  >
                    <FileDown className="h-4 w-4" /> ยอดขาย/เช่าที่เคาน์เตอร์ .CSV
                  </button>
                </div>
              </div>

              <div className="p-4 bg-emerald-50 rounded-xl text-[10.5px] border border-emerald-200 text-emerald-800 space-y-1">
                <p className="font-bold">✨ ระบบอำนวยความสะดวกบัญชีปิดกานต์อัตโนมัติ:</p>
                <p>รายงานรูปแบบ CSV นี้สามารถดับเบิ้ลคลิกเปิดด้วย Microsoft Excel หรือทำการดึงเข้า Google Sheets ได้ทันประกอบสมบูรณ์ 100%</p>
              </div>
            </div>
          </div>
        )}

        {/* Sub Module 6: Anti-Fraud Audit LOG interactive system (Anti-Fraud and DB track specifications) */}
        {activeAdminTab === 'roles' && adminTabAllowed('roles') && (
          <RolesTab
            roles={roles}
            editable={api.USE_BACKEND}
            onChanged={() => api.listRoles().then(setRoles).catch(err => notify(`โหลดบทบาทไม่สำเร็จ: ${err.message}`))}
            onAddAuditLog={onAddAuditLog}
          />
        )}

        {activeAdminTab === 'audit_logs' && adminTabAllowed('audit_logs') && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-1">
                  <ShieldCheck className="h-5 w-5 text-rose-600 animate-pulse" />
                  ระบบบันทึกความปลอดภัยต้านทุจริตภายใน (System Audit Database)
                </h3>
                <p className="text-xs text-slate-500">บันทึกทุกพฤติกรรมการแก้ไขยอดเงิน, การสลับเกณฑ์ราคา หรือการเปลี่ยนสถานะโอนความถี่สูตรสลับ</p>
              </div>

              {/* Real-time filters (Module 4 spec) */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold text-slate-500 whitespace-nowrap">กรองตามประเภท:</span>
                  <select
                    value={auditTypeFilter}
                    onChange={(e) => setAuditTypeFilter(e.target.value)}
                    className="bg-slate-50 border border-slate-200 text-xs py-1.5 px-3 rounded-xl text-slate-800 font-bold focus:bg-white focus:outline-none"
                  >
                    <option value="ALL">🔍 ค้นหาประเภททั้งหมด (All Resources)</option>
                    <option value="User">👥 ฐานข้อมูลสิทธิ์และบทบาทสมาชิก (User/Member)</option>
                    <option value="Booking">📅 งานจองคอร์ทและสนาม (Booking Arena)</option>
                    <option value="PricingRule">💰 เกณฑ์อัตราดอกเบี้ยและกฎราคา (Pricing Rules)</option>
                    <option value="Court">🏸 ตั้งค่าระเบียบและสนามแข่งขัน (Courts Config)</option>
                    <option value="DayOff">🚫 สล็อตวันหยุดปิดบริการและจองสนาม (Day Off)</option>
                    <option value="Product">🥤 ระบบสต็อกสินค้า POS และ F&B (Products/Rentals)</option>
                    <option value="Report">📊 งานส่งออกชุดบันทึกสถิติ (Reports Export)</option>
                  </select>
                </div>

                <div className="relative w-full sm:w-auto">
                  <input
                    type="text"
                    placeholder="ค้นหายูสเซอร์, การกระทำ หรือ ID..."
                    value={auditSearch}
                    onChange={(e) => setAuditSearch(e.target.value)}
                    className="bg-slate-50 border border-slate-200 outline-none text-xs py-1.5 pl-8 pr-4 rounded-xl w-full sm:w-56 text-slate-800 focus:bg-white"
                  />
                  <Search className="h-4 w-4 text-slate-400 absolute left-2.5 top-2" />
                </div>
              </div>
            </div>

            {/* Logs loop */}
            <p className="text-xs text-slate-500">{filteredAuditLogs.length} รายการ (ล่าสุดอยู่บนสุด)</p>
            <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1 text-xs">
              {filteredAuditLogs.length === 0 ? (
                <p className="text-slate-400 text-center py-10">ไม่พบประวัติพฤติกรรมในฐานสลักสำหรับเกณฑ์ค่าดึงค้นหานี้</p>
              ) : (
                filteredAuditLogs.map((log) => {
                    const meta = (() => {
                      switch (log.targetType) {
                        case 'User':
                          return {
                            label: '👥 ฐานข้อมูลสิทธิ์และบทบาทสมาชิก (Users / Members)',
                            badgeStyle: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
                            cardBorder: 'border-l-4 border-l-amber-500'
                          };
                        case 'Booking':
                          return {
                            label: '📅 งานจองคอร์ทและสนามแข่งขัน (Booking Arena)',
                            badgeStyle: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
                            cardBorder: 'border-l-4 border-l-emerald-500'
                          };
                        case 'PricingRule':
                          return {
                            label: '💰 เกณฑ์อัตราดอกเบี้ยและกฎราคา (Pricing Rules)',
                            badgeStyle: 'bg-sky-500/20 text-sky-300 border border-sky-500/30',
                            cardBorder: 'border-l-4 border-l-sky-500'
                          };
                        case 'Court':
                          return {
                            label: '🏸 ตั้งค่าระเบียบและสนามแข่งขัน (Courts Config)',
                            badgeStyle: 'bg-purple-500/20 text-purple-300 border border-purple-500/30',
                            cardBorder: 'border-l-4 border-l-purple-500'
                          };
                        case 'DayOff':
                          return {
                            label: '🚫 สล็อตวันหยุดปิดบริการและจองสนาม (Day Off)',
                            badgeStyle: 'bg-rose-500/20 text-rose-300 border border-rose-500/30',
                            cardBorder: 'border-l-4 border-l-rose-500'
                          };
                        case 'Product':
                          return {
                            label: '🥤 ระบบสต็อกสินค้า POS และ F&B (Products & Rentals)',
                            badgeStyle: 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30',
                            cardBorder: 'border-l-4 border-l-indigo-500'
                          };
                        case 'Report':
                          return {
                            label: '📊 งานส่งออกชุดบันทึกสถิติ (Reports Export)',
                            badgeStyle: 'bg-teal-500/20 text-teal-300 border border-teal-500/30',
                            cardBorder: 'border-l-4 border-l-teal-500'
                          };
                        default:
                          return {
                            label: `🛡️ ทรัพยากรความปลอดภัยทั่วไป (${log.targetType})`,
                            badgeStyle: 'bg-slate-500/20 text-slate-300 border border-slate-500/30',
                            cardBorder: 'border-l-4 border-l-slate-500'
                          };
                      }
                    })();

                    // Parse properties that changed
                    const changedProperties = (() => {
                      try {
                        const beforeObj = log.before && typeof log.before === 'object' ? log.before : {};
                        const afterObj = log.after && typeof log.after === 'object' ? log.after : {};
                        const unionKeys = Array.from(new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]));
                        return unionKeys.filter(k => JSON.stringify(beforeObj[k]) !== JSON.stringify(afterObj[k]));
                      } catch {
                        return [];
                      }
                    })();

                    return (
                      <div 
                        key={log.id} 
                        className={`bg-slate-900 text-slate-100 p-4 rounded-xl border border-slate-800 space-y-3 font-mono transition shadow-lg ${meta.cardBorder}`}
                      >
                        {/* Audit Category Header */}
                        <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-950/45 p-2 rounded-lg border border-slate-800/60">
                          <span className="text-[10.5px] font-bold text-slate-300 flex items-center gap-1.5">
                            {meta.label}
                          </span>
                          <span className="text-[10px] text-slate-400/90 font-sans">
                            🕒 {formatDateTime(log.createdAt, true)} น.
                          </span>
                        </div>

                        {/* Event action description row */}
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] bg-rose-600/20 text-rose-300 font-black px-2 py-0.5 rounded border border-rose-500/30 tracking-wider">
                              {log.action}
                            </span>
                            <span className="text-slate-400 text-[10px] font-bold">
                              (Target ID: <span className="text-slate-200 select-all font-sans">{log.targetId}</span>)
                            </span>
                          </div>
                          
                          <div className="text-[11px] font-sans text-slate-300">
                            👤 ผู้ทำรายการ: <span className="bg-slate-800 px-2 py-0.5 rounded text-white font-mono font-bold">{log.userName}</span>
                          </div>
                        </div>

                        {/* Details fold away: a sale lists a dozen fields, which
                            used to fill the whole box with one entry. */}
                        {(changedProperties.length > 0 || log.before || log.after) && (
                        <details className="group/d">
                          <summary className="text-[10px] text-sky-300 hover:text-sky-200 cursor-pointer select-none font-bold font-sans">
                            ดูรายละเอียด{changedProperties.length > 0 ? ` (${changedProperties.length} ค่า)` : ''}
                          </summary>
                          <div className="space-y-3 mt-2">
                        {changedProperties.length > 0 && (
                          <div className="bg-slate-950/70 p-2.5 rounded-lg border border-slate-800 text-[10.5px] space-y-1.5 font-sans">
                            <span className="text-[9.5px] font-black text-amber-400 uppercase tracking-widest flex items-center gap-1">
                              🔍 ตรวจทุจริตเปลี่ยนค่าที่แสตมป์ (Property Changes):
                            </span>
                            <div className="divide-y divide-slate-800">
                              {changedProperties.map(key => {
                                const beforeVal = (log.before as any)?.[key];
                                const afterVal = (log.after as any)?.[key];
                                return (
                                  <div key={key} className="py-1 flex flex-col md:flex-row md:items-center justify-between gap-1 text-slate-300">
                                    <span className="font-extrabold text-slate-400 text-[11px] bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">{key}</span>
                                    <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
                                      <span className="line-through text-rose-400 bg-rose-950/40 px-1.5 py-0.5 rounded font-mono">
                                        {beforeVal === null || beforeVal === undefined ? 'ว่าง' : JSON.stringify(beforeVal)}
                                      </span>
                                      <span className="text-slate-500">➔</span>
                                      <span className="text-emerald-400 bg-emerald-950/40 px-1.5 py-0.5 rounded font-mono font-bold">
                                        {afterVal === null || afterVal === undefined ? 'ว่าง' : JSON.stringify(afterVal)}
                                      </span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Raw snap expander details */}
                        {(log.before || log.after) && (
                          <details className="group">
                            <summary className="text-[9px] text-slate-500 hover:text-slate-400 cursor-pointer select-none font-bold uppercase tracking-wider flex items-center gap-1 focus:outline-none">
                              <span>📁 คลิกเพื่อดูฐานข้อมูลดิบ (Toggle Raw Snapshot Metadata)</span>
                            </summary>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2 bg-slate-950 p-2.5 rounded border border-slate-900 text-[9px] group-open:animate-fadeIn">
                              <div>
                                <p className="text-slate-500 font-extrabold mb-1">📋 SNAPSHOT [ก่อนหน้า] (BEFORE):</p>
                                <pre className="text-rose-400 bg-rose-950/10 p-1.5 rounded border border-rose-950/30 max-h-32 overflow-y-auto pr-1">{JSON.stringify(log.before || {}, null, 1)}</pre>
                              </div>
                              <div>
                                <p className="text-slate-500 font-extrabold mb-1">📋 SNAPSHOT [ล่าสุด] (AFTER):</p>
                                <pre className="text-emerald-400 bg-emerald-950/10 p-1.5 rounded border border-emerald-950/30 max-h-32 overflow-y-auto pr-1">{JSON.stringify(log.after || {}, null, 1)}</pre>
                              </div>
                            </div>
                          </details>
                        )}
                          </div>
                        </details>
                        )}
                      </div>
                    );
                  })
              )}
            </div>
          </div>
        )}

        {/* Sub Module: Membership Tiers & Discounts (dynamic management of privileges) */}
        {activeAdminTab === 'member_discounts' && adminTabAllowed('member_discounts') && (
          <div className="space-y-6">
            <div>
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
                <Settings className="h-5 w-5 text-emerald-600 animate-pulse" />
                ระบบจัดการระดับสิทธิ์สมาชิกอัจฉริยะ (Membership & Privilege Engine)
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                กำหนดระดับสิทธิ์สมาชิก (Membership Tiers) และสัดส่วนค่าเปอร์เซ็นต์ส่วนลดในการใช้บริการสนามและห้องประชุม 
                เมื่อมีลูกค้าที่ครอบครองสิทธิ์ประเภทนั้นทำการจอง ระบบคำนวณราคา Price Engine จะใช้อัตรานี้โดยอัตโนมัติ
              </p>
            </div>

            <div className="bg-slate-50 rounded-2xl border border-slate-200/60 p-4 space-y-4">
              <h4 className="text-xs font-black text-slate-600 flex items-center gap-2 uppercase tracking-wider">
                💡 คำแนะนำสิทธิ์การลดราคานักกีฬา:
              </h4>
              <ul className="list-disc list-inside text-[11px] text-slate-600 space-y-1.5 pl-1 leading-relaxed">
                <li>
                  <span className="font-bold text-slate-800">ลูกค้าทั่วไป (NORMAL):</span> โดยปกติจะตั้งเป็น 0% เพื่อเป็นจุดตั้งต้นในการคิดราคามาตรฐาน (เปลี่ยนชื่อตามต้องการได้)
                </li>
                <li>
                  <span className="font-bold text-slate-800">การยกเลิกสิทธิ์ชั่วคราว:</span> หากท่านสลับสถานะเป็น <b>"ระงับใช้งานสิทธิ์"</b> ลูกค้าที่มีเกณฑ์สิทธิ์ดังกล่าวจะไม่ได้รับส่วนลดใดๆ (คิดอ้างอิงเป็นราคาลูกค้าระดับทั่วไปแทน)
                </li>
                <li>
                  <span className="font-bold text-slate-800">การคำนวณราคาขั้นสูง:</span> ระบบตรวจจับทุจริตแบบเรียลไทม์จะตรวจสอบมูลค่าส่วนลดและพฤติกรรมการแก้ไข เปรียบเทียบย้อนหลังในตะกร้า Audit Log ทันทีที่กดเซฟสล็อตสิทธิ์
                </li>
              </ul>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-xs">
              <div className="p-4 bg-slate-900 text-white flex justify-between items-center">
                <span className="text-xs font-bold font-mono">🌟 บูธปรับแต่งระดับสิทธิ์ (Privilege Tier Configuration)</span>
                <span className="text-[10px] bg-emerald-600 text-white font-extrabold px-2 py-0.5 rounded uppercase font-sans">
                  Engine: Active
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 border-b border-slate-200 text-slate-600 font-extrabold text-[10.5px]">
                      <th className="p-3.5">🔑 ID รหัสระบบ</th>
                      <th className="p-3.5">🏷️ ชื่อเรียกสิทธิ์ระดับสมาชิก (Display Title)</th>
                      <th className="p-3.5 w-1/5">💰 ส่วนลดเป็นเปอร์เซ็นต์ (%)</th>
                      <th className="p-3.5 text-center">🎯 สถานะเปิดใช้</th>
                      <th className="p-3.5 text-center">👥 จำนวนบัญชีที่ครองสิทธิ์</th>
                      <th className="p-3.5 text-center w-[150px]">⚙️ เซฟบันทึก</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {memberDiscounts.map((tier) => {
                      const staged = editingDiscounts[tier.id];
                      const currentName = staged?.name ?? tier.name;
                      const currentPercent = staged?.discountPercent ?? tier.discountPercent;
                      const currentIsActive = staged?.isActive ?? tier.isActive;

                      const isStaged = staged !== undefined && (
                        staged.name !== tier.name ||
                        staged.discountPercent !== tier.discountPercent ||
                        staged.isActive !== tier.isActive
                      );

                      // Calculate how many users currently belong to this Membership Type
                      const userCount = users.filter(u => {
                        if (tier.id === MemberType.NORMAL) {
                          return !u.memberType || u.memberType === MemberType.NORMAL;
                        }
                        return u.memberType === tier.id;
                      }).length;

                      return (
                        <tr 
                          key={tier.id} 
                          className={`hover:bg-slate-50/55 transition duration-155 ${
                            isStaged ? 'bg-amber-50/30' : ''
                          }`}
                        >
                          {/* ID Code Badge */}
                          <td className="p-3.5 font-mono">
                            <span className="bg-slate-200 text-slate-800 text-[10px] font-black px-2 py-0.5 rounded-lg">
                              {tier.id}
                            </span>
                          </td>

                          {/* Editable Display Name */}
                          <td className="p-3.5">
                            <input 
                              type="text"
                              value={currentName}
                              onChange={(e) => handleStageDiscountField(tier.id, 'name', e.target.value)}
                              className={`w-full max-w-xs border rounded px-2 py-1 text-xs outline-none transition focus:border-emerald-500 ${
                                isStaged ? 'border-amber-400 bg-amber-50 font-bold' : 'border-slate-200 bg-white'
                              }`}
                              placeholder="เช่น ลูกค้าทัวร์นาเมนต์ VIP"
                            />
                            {isStaged && staged.name !== tier.name && (
                              <span className="block text-[9px] text-amber-600 font-bold mt-1">
                                (เดิม: {tier.name})
                              </span>
                            )}
                          </td>

                          {/* Editable Percent Discount */}
                          <td className="p-3.5">
                            <div className="flex items-center gap-1.5">
                              <input 
                                type="number"
                                min="0"
                                max="100"
                                value={currentPercent}
                                onChange={(e) => handleStageDiscountField(tier.id, 'discountPercent', e.target.value)}
                                className={`w-16 border rounded px-2 py-1 text-xs outline-none transition font-bold font-mono text-center focus:border-emerald-500 ${
                                  isStaged ? 'border-amber-400 bg-amber-50 font-extrabold focus:bg-amber-100' : 'border-slate-200 bg-white'
                                }`}
                              />
                              <span className="text-slate-500 font-bold">%</span>
                            </div>
                            {isStaged && staged.discountPercent !== tier.discountPercent && (
                              <span className="block text-[9px] text-amber-600 font-bold mt-1">
                                (เดิม: {tier.discountPercent}%)
                              </span>
                            )}
                          </td>

                          {/* Toggle Active status */}
                          <td className="p-3.5 text-center">
                            <select
                              value={currentIsActive ? 'ACTIVE' : 'INACTIVE'}
                              onChange={(e) => handleStageDiscountField(tier.id, 'isActive', e.target.value === 'ACTIVE')}
                              className={`border rounded py-1 px-2 text-[10.5px] font-bold outline-none transition ${
                                currentIsActive 
                                  ? 'bg-emerald-50 border-emerald-300 text-emerald-800' 
                                  : 'bg-rose-50 border-rose-300 text-rose-800'
                              } ${isStaged ? 'ring-2 ring-amber-100' : ''}`}
                            >
                              <option value="ACTIVE">🟢 เปิดใช้งาน</option>
                              <option value="INACTIVE">🔴 ปิดระงับสิทธิ์</option>
                            </select>
                          </td>

                          {/* Active Occupants stats */}
                          <td className="p-3.5 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <Users className="h-3.5 w-3.5 text-slate-400" />
                              <span className="font-extrabold text-slate-800 font-mono">
                                {userCount} บัญชี
                              </span>
                            </div>
                          </td>

                          {/* Save operations */}
                          <td className="p-3.5 text-center">
                            {isStaged ? (
                              <div className="flex flex-col gap-1 items-center">
                                <button
                                  disabled={busy} onClick={guarded(() => handleSaveDiscountTier(tier.id))}
                                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black py-1 px-2.5 rounded-lg text-[9px] shadow-sm transition flex items-center justify-center gap-1"
                                >
                                  💾 เซฟส่วนลดใหม่
                                </button>
                                <button
                                  onClick={() => {
                                    setEditingDiscounts(prev => {
                                      const copy = { ...prev };
                                      delete copy[tier.id];
                                      return copy;
                                    });
                                  }}
                                  className="text-[8px] text-slate-500 hover:underline block"
                                >
                                  ยกเลิก
                                </button>
                              </div>
                            ) : (
                              <span className="text-[10px] text-slate-400 font-medium">บันทึกเรียบร้อย</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

// Custom simple helper icons inside layout
function SettingChevron({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}
