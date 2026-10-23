import React, { useState, useEffect, createContext, useContext } from 'react';
import {
  Court, CourtType, PricingRule, DayType, PriceType,
  User, UserRole, MemberType, Booking, Payment, Product, ProductCat, Order, AuditLog, DayOff, MemberDiscountRule, PricingConfig
} from '../../types';
import { StorageService, getTodayDateStr, DEFAULT_MEMBER_DISCOUNTS, openingHours, expireUnpaidLocal } from '../../mockData';
import * as api from '../../api';
import { can, canUseSettings, BUILTIN_ROLES } from '../../permissions';
import { useAdminSession } from './sessionActions';
import { useDashboardData } from './dashboardData';
import { usePricingActions } from './pricingActions';
import { useCourtActions } from './courtActions';
import { useUserActions } from './userActions';
import { useProductActions } from './productActions';
import { useReportActions } from './reportActions';
import { AdminPanelProps, AdminTab, ADMIN_TABS, ADMIN_TAB_PERMISSIONS } from './shared';
export * from './shared';

// Shared state, effects and data loading of the panel. The handlers are in
// one hook per area: sessionActions, dashboardData, pricingActions, courtActions, userActions, productActions, reportActions.
function useAdminPanelCore({ onAddAuditLog, triggerRefresh, onRefreshAll }: AdminPanelProps) {
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
    if (!api.USE_BACKEND) expireUnpaidLocal();
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

  // Opening hours (admin setting): first slot start / last slot end.
  const [openHourSetting, setOpenHourSetting] = useState<number>(() => openingHours().open);
  const [closeHourSetting, setCloseHourSetting] = useState<number>(() => openingHours().close);

  // How many days ahead customers may book online (admin setting).
  const [maxAdvanceDays, setMaxAdvanceDays] = useState<number>(() =>
    StorageService.get<{ maxAdvanceDays?: number }>('pricing_config', {}).maxAdvanceDays ?? 30);

  // Business details printed on receipts and shown on the payment screen.
  const emptyBusiness = { name: '', address: '', phone: '', taxId: '', vatRegistered: false };
  const businessFrom = (c: Partial<PricingConfig>) => ({
    name: c.businessName ?? '', address: c.businessAddress ?? '', phone: c.businessPhone ?? '',
    taxId: c.businessTaxId ?? '', vatRegistered: !!c.vatRegistered,
  });
  const [business, setBusiness] = useState(() => ({ ...emptyBusiness, ...businessFrom(StorageService.get<Partial<PricingConfig>>('pricing_config', {})) }));


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
        const [closures, pricing, apiProducts, apiCourts, logs] = await Promise.all([
          // Each list only if the role may read it - a custom role missing
          // one permission must still get the rest of the panel.
          api.listDaysOff(getTodayDateStr()), api.syncPricingCache(),
          can(me, 'manage_products') ? api.adminListProducts() : Promise.resolve([] as Product[]),
          can(me, 'manage_closures', 'manage_courts') ? api.adminListCourts() : api.listCourts(),
          can(me, 'view_audit_log') ? api.auditLogs({ limit: 500 }) : Promise.resolve([] as AuditLog[])
        ]);
        if (cancelled) return;
        if (can(me, 'manage_roles', 'manage_staff')) {
          api.listRoles().then(r => { if (!cancelled) setRoles(r); }).catch(() => {});
        }
        setDaysOff(closures);
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

  // API mode: the user list is one page from the server, searched there
  // (after a pause in typing) - it is never loaded whole.
  const [usersHasMore, setUsersHasMore] = useState(false);
  useEffect(() => {
    if (!api.USE_BACKEND || !adminUserId || !can(adminUser, 'manage_members', 'adjust_points', 'manage_staff')) return;
    let cancelled = false;
    const search = userSearchQuery.trim();
    const t = setTimeout(() => {
      api.listUsers({ search })
        .then(r => { if (!cancelled) { setUsers(r.users); setUsersHasMore(r.hasMore); } })
        .catch(err => { if (!cancelled) setAdminApiError(err instanceof Error ? err.message : String(err)); });
    }, search ? 300 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [triggerRefresh, adminUserId, adminRole, userSearchQuery]);

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
    usersHasMore,
    setUserSearchQuery,
    userRoleFilter,
    setUserRoleFilter,
    userTierFilter,
    setUserTierFilter,
    userPendingChanges,
    setUserPendingChanges,
    editingDiscounts,
    setEditingDiscounts,
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
    openHourSetting,
    setOpenHourSetting,
    closeHourSetting,
    setCloseHourSetting,
    maxAdvanceDays,
    setMaxAdvanceDays,
    emptyBusiness,
    businessFrom,
    business,
    setBusiness,
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
    canSeeDashboard
  };
}

export type AdminPanelCore = ReturnType<typeof useAdminPanelCore>;

// Everything the panel and its tabs use (read through the context below):
// the core plus each area's handlers, in dependency order.
export function useAdminPanel(props: AdminPanelProps) {
  const core = useAdminPanelCore(props);
  const session = useAdminSession(core);
  const dashboardData = useDashboardData(core);
  const pricingActions = usePricingActions(core);
  const courtActions = useCourtActions(core);
  const userActions = useUserActions(core);
  const productActions = useProductActions(core);
  const reportActions = useReportActions(core);
  return { ...core, ...session, ...dashboardData, ...pricingActions, ...courtActions, ...userActions, ...productActions, ...reportActions };
}

export type AdminPanelState = ReturnType<typeof useAdminPanel>;
export const AdminPanelContext = createContext<AdminPanelState | null>(null);
export function useAdminPanelContext(): AdminPanelState {
  const value = useContext(AdminPanelContext);
  if (!value) throw new Error('useAdminPanelContext outside AdminPanel');
  return value;
}
