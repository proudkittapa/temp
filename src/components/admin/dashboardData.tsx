import { UserRole, Booking, BookingStatus, ProductCat, OrderStatus, OrderType } from '../../types';
import { courtsConflict, openSlotHours, isPaidBooking, roundBaht, localDateOf } from '../../mockData';
import * as api from '../../api';
import type { AdminPanelCore } from './useAdminPanel';
import { hoursPerDay } from './shared';


// Dashboard figures and chart data (from the server's dashboard in API mode, from local data otherwise).
export function useDashboardData(deps: AdminPanelCore) {
  const {
    bookings,
    courts,
    dash,
    dashboardSelectedDate,
    orders,
    payments,
    products,
    users
  } = deps;
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
    // Kept rental deposits are income, on the day they were kept (as the
    // server's dashboard).
    const keptOn = (match: (day: string) => boolean) => orders
      .filter(o => o.status !== OrderStatus.CANCELLED && o.depositKept && o.depositSettledAt && match(localDateOf(o.depositSettledAt)))
      .reduce((n, o) => n + (o.depositKept || 0), 0);
    const dailyOrderRevenue = dailyOrders.reduce((sum, o) => sum + Number(o.totalAmount), 0) + keptOn(d => d === targetDateStr);

    // Occupancy on dashboardSelectedDate: share of physical court-hours sold
    // (a half-court booking fills half of its court).
    const occupancyRate = Math.round(occupiedShare(dailyBookings) / (physicalCourtCount() * hoursPerDay() || 1) * 1000) / 10;

    // All-time Metrics
    const confirmedBookings = bookings.filter(b => isPaidBooking(b));
    const totalBookingsRevenue = confirmedBookings.reduce((sum, b) => sum + Number(b.totalAmount), 0);

    // All time F&B products sale receipt amount
    const totalOrderRevenue = orders.filter(o => o.status !== OrderStatus.CANCELLED).reduce((sum, o) => sum + Number(o.totalAmount) + (o.depositKept || 0), 0);

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
  // Active courts only, as the server counts them (a closed court has no
  // hours to fill).
  const physicalCourtCount = () => api.USE_BACKEND ? dash?.physicalCourts ?? 0 : new Set(courts.filter(c => c.isActive).map(c => c.mutexGroupId || c.id)).size;
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
        'รายได้เครื่องดื่ม/เช่าแร็ก': roundBaht(orders.filter(o => localDateOf(o.createdAt).startsWith(key) && o.status !== OrderStatus.CANCELLED).reduce((s, o) => s + Number(o.totalAmount), 0)
          // kept deposits in the month they were kept
          + orders.filter(o => o.status !== OrderStatus.CANCELLED && o.depositKept && o.depositSettledAt && localDateOf(o.depositSettledAt).startsWith(key)).reduce((s, o) => s + (o.depositKept || 0), 0))
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
    // Kept deposits count as rental income (as the server's split).
    if (!api.USE_BACKEND) rental += orders.filter(o => o.status !== OrderStatus.CANCELLED).reduce((n, o) => n + (o.depositKept || 0), 0);
    return [
      { name: 'อาหารและเครื่องดื่ม', value: roundBaht(food) },
      { name: 'อุปกรณ์กีฬา (ขาย)', value: roundBaht(equipment) },
      { name: 'ค่าเช่าอุปกรณ์', value: roundBaht(rental) }
    ];
  };

  const PIE_COLORS = ['#34d399', '#f59e0b', '#38bdf8'];

  // Computed once per render (the JSX reads it in a dozen places).
  const dashStats = getDashboardStats();
  return {
    getDashboardStats,
    physicalCourtCount,
    occupiedShare,
    getRevenueChartData,
    getDayCapacityChartData,
    getPieChartData,
    PIE_COLORS,
    dashStats
  };
}
