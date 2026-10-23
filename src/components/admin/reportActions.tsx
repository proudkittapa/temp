import { Order, OrderStatus } from '../../types';
import { roundBaht, localDateOf, bangkokStamp, bookingGroupOf } from '../../mockData';
import * as api from '../../api';
import { notify } from '../Dialog';
import type { AdminPanelCore } from './useAdminPanel';


// Monthly CSV report and the audit-log filter.
export function useReportActions(deps: AdminPanelCore) {
  const {
    auditLogs,
    auditSearch,
    auditTypeFilter,
    bookings,
    courts,
    onAddAuditLog,
    orders,
    payments,
    products,
    reportsMonth,
    reportsYear
  } = deps;
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
      // A group's payment hangs off one of its rows. Same code, customer
      // and date (browser-only codes can repeat between customers).
      const groupIds = new Set(bookingGroupOf(b, bookings).map(x => x.id));
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
        data.monthOrders.flatMap(o => [
          ...o.items.map(it => [
            o.orderCode, bangkokStamp(o.createdAt), o.type, o.customerName, o.paymentMethod || '', o.status,
            productName(it.productId, it.productName), it.shoeSize ? `${it.shoeSize}${it.shoeGender || ''}` : '', it.qty, it.unitPrice,
            roundBaht(it.qty * it.unitPrice), it.returnedAt ? bangkokStamp(it.returnedAt) : ''
          ]),
          // A kept rental deposit is income (owner 2026-10-23): its own row,
          // dated when it was kept, so LineTotal adds up to the income.
          ...(o.depositKept && o.status !== OrderStatus.CANCELLED ? [[
            o.orderCode, o.depositSettledAt ? bangkokStamp(o.depositSettledAt) : bangkokStamp(o.createdAt), o.type, o.customerName, 'CASH', o.status,
            `มัดจำที่ยึด (kept deposit)${o.depositNote ? `: ${o.depositNote}` : ''}`, '', 1, o.depositKept, o.depositKept, ''
          ]] : [])
        ]));
    }
    onAddAuditLog('REPORT_CSV_EXPORTED', 'Report', 'csv-gen', null, { kind, month: reportsMonth, year: reportsYear });
  };

  // Filtering Audit Logs (Module 4 search spec)
  const filteredAuditLogs = auditLogs.filter(log => {
    const term = auditSearch.trim().toLowerCase();
    // The box says "...or ID": the target's id is searched too.
    const matchTerm = log.userName.toLowerCase().includes(term) ||
                      log.action.toLowerCase().includes(term) ||
                      log.targetType.toLowerCase().includes(term) ||
                      (log.targetId || '').toLowerCase().includes(term);
    const matchType = auditTypeFilter === 'ALL' || log.targetType === auditTypeFilter;
    return matchTerm && matchType;
  });
  return {
    csvCell,
    downloadCsv,
    monthData,
    handleDownloadCSVReport,
    filteredAuditLogs
  };
}
