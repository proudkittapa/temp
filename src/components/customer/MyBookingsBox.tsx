import { Booking, BookingStatus, PaymentStatus } from '../../types';
import { slotTiming, formatBaht, formatDate } from '../../mockData';
import { useCustomerPanelContext } from './useCustomerPanel';

export default function MyBookingsBox() {
  const {
    bookingById,
    bookings,
    courtNameById,
    handleReopenPayment,
    loggedInUser,
    paymentForBooking
  } = useCustomerPanelContext();
  // Guests have no bookings to show; the box comes with signing in.
  if (!loggedInUser) return null;
  return (
    <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 text-white space-y-4 shadow-xl">
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div>
          <p className="text-sm font-bold tracking-tight">ตรวจสอบสถานะการจองล่าสุดทั้งหมด</p>
          <p className="text-xs text-slate-400">สถานะการจองและสลิปการชำระเงินของคุณ</p>
        </div>
        <span className="text-xs bg-slate-800 text-slate-300 font-bold px-2.5 py-1 rounded-full">เรียงใหม่</span>
      </div>

      <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
        {(() => {
          // Upcoming and in-progress bookings only, judged in Bangkok time
          // (the browser's own clock/time zone used to decide this).
          const userFilteredFutureBookings = bookings.filter(booking =>
            booking.userId === loggedInUser.id && !slotTiming(booking.date, booking.startTime).ended
          );

          if (userFilteredFutureBookings.length === 0) {
            return (
              <p className="text-xs text-slate-500 text-center py-6 leading-relaxed">
                🌟 ไม่พบประวัติการจองล่วงหน้าสำหรับบัญชีคุณในขณะนี้ <br/>
                <span className="text-xs text-slate-400">(ระบบจะแสดงเฉพาะรอบจองที่ยังไม่ถึงเวลาเล่นของท่านเท่านั้น รอบที่เคยผ่านไปแล้วจะไม่แสดงเพื่อความรวดเร็วและเป็นส่วนตัวค่ะ)</span>
              </p>
            );
          }

          // One card per booking (booking code): a 2-hour booking is one
          // card with two lines, one total and one payment.
          const groups: Booking[][] = [];
          const byCode = new Map<string, Booking[]>();
          for (const b of userFilteredFutureBookings) {
            const key = b.bookingCode || b.id;
            let g = byCode.get(key);
            if (!g) { g = []; byCode.set(key, g); groups.push(g); }
            g.push(b);
          }

          return groups.map(group => {
            const first = group[0];
            // The payment hangs off the group's first row; every row of
            // the group shares it.
            const matchedPayment = paymentForBooking(first);
            // A slip can be sent while the booking awaits payment, and also
            // after the hold expired (late payment: the customer paid but
            // the slip came too late).
            const lateSlip = !!matchedPayment && (matchedPayment.status === PaymentStatus.EXPIRED ||
              (matchedPayment.status === PaymentStatus.SLIP_UPLOADED && !!matchedPayment.expiredAt));
            const awaitingSlip = !!matchedPayment && (lateSlip || (group.some(b => b.status === BookingStatus.PENDING_PAYMENT) &&
              (matchedPayment.status === PaymentStatus.PENDING || matchedPayment.status === PaymentStatus.SLIP_UPLOADED)));
            const sameStatus = group.every(b => b.status === first.status);
            const total = group.reduce((sum, b) => sum + b.totalAmount, 0);
            const rows = [...group].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.courtId.localeCompare(b.courtId));
            const dates = [...new Set(rows.map(b => b.date))];

            const badge = (b: Booking) => {
              let cls = 'bg-red-500 text-white';
              if (b.status === BookingStatus.CONFIRMED || b.status === BookingStatus.COMPLETED) cls = 'bg-emerald-600 text-white';
              else if (b.status === BookingStatus.PENDING_PAYMENT) cls = 'bg-amber-500 text-white';
              else if (b.status === BookingStatus.CANCELLED) cls = 'bg-slate-600 text-slate-300';
              return (
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${cls}`}>
                  {b.status === BookingStatus.CONFIRMED && 'อนุมัติเรียบร้อย'}
                  {b.status === BookingStatus.PENDING_PAYMENT && (matchedPayment?.status === PaymentStatus.SLIP_UPLOADED ? 'รอสต๊าฟเช็คสลิป' : 'รอชำระเงิน / รอสลิป')}
                  {b.status === BookingStatus.CANCELLED && (
                    matchedPayment?.status === PaymentStatus.EXPIRED ? 'หมดเวลาชำระ'
                      : lateSlip ? 'ส่งสลิปล่าช้า รอพนักงานตรวจ'
                      : 'ยกเลิกรายการ')}
                  {b.status === BookingStatus.COMPLETED && 'เล่นแล้ว'}
                  {b.status === BookingStatus.NO_SHOW && 'ไม่มาใช้สนาม'}
                </span>
              );
            };

            return (
              <div key={first.bookingCode || first.id} data-booking-code={first.bookingCode} className="my-booking-card bg-slate-800/80 hover:bg-slate-800 rounded-xl p-4 border border-slate-700/50 space-y-2 text-xs transition">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono font-bold text-slate-200">{first.bookingCode}</span>
                    {sameStatus && badge(first)}
                  </div>
                  <p className="font-bold text-emerald-400 text-sm whitespace-nowrap">{formatBaht(total)} บาท</p>
                </div>
                {dates.length === 1 && <p className="text-xs text-slate-400">วันที่ {formatDate(dates[0])}</p>}

                <ul className="space-y-1">
                  {rows.map(b => (
                    <li key={b.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="text-slate-100">
                        <span className="font-bold">{courtNameById.get(b.courtId) || 'สนาม'}</span>
                        <span className="text-slate-400"> · {dates.length > 1 ? `${formatDate(b.date)} ` : ''}{b.startTime}-{b.endTime} น.</span>
                      </span>
                      <span className="flex items-center gap-2">
                        {!sameStatus && badge(b)}
                        {group.length > 1 && <span className="text-slate-400">{formatBaht(b.totalAmount)} บาท</span>}
                      </span>
                      {b.status === BookingStatus.CANCELLED && b.cancellationReason && !lateSlip && matchedPayment?.status !== PaymentStatus.EXPIRED && (
                        <span className="w-full text-xs text-slate-400">เหตุผล: {b.cancellationReason}</span>
                      )}
                    </li>
                  ))}
                </ul>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-700/50">
                  <span className="text-xs text-slate-400">
                    สลิป: {matchedPayment?.slipUrl ? (
                      <a href={matchedPayment.slipUrl} target="_blank" rel="noreferrer" className="text-sky-400 underline font-bold hover:text-sky-300">ดูรูปสลิป</a>
                    ) : 'ยังไม่ได้ส่ง'}
                    {!!matchedPayment?.refundAmount && (
                      <span className="block font-bold text-sky-300">
                        💸 คืนเงินแล้ว {formatBaht(matchedPayment.refundAmount)} บาท{matchedPayment.refundReason ? ` (${matchedPayment.refundReason})` : ''}
                      </span>
                    )}
                  </span>
                  {awaitingSlip && matchedPayment && (
                    <button
                      type="button"
                      onClick={() => {
                        const root = bookingById.get(matchedPayment.bookingId) || first;
                        handleReopenPayment(root, matchedPayment);
                      }}
                      className="text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white px-3 min-h-[36px] rounded-lg transition"
                    >
                      {matchedPayment.status === PaymentStatus.EXPIRED ? '📤 โอนแล้วแต่หมดเวลา? ส่งสลิป'
                        : matchedPayment.status === PaymentStatus.SLIP_UPLOADED ? '🔁 ส่งสลิปใหม่' : '📤 ชำระเงิน / อัปโหลดสลิป'}
                    </button>
                  )}
                </div>
              </div>
            );
          });
        })()}
      </div>
    </div>
  );
}
