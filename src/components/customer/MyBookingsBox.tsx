import { BookingStatus, PaymentStatus } from '../../types';
import { slotTiming, formatBaht } from '../../mockData';
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
  return (
    <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 text-white space-y-4 shadow-xl">
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div>
          <p className="text-sm font-bold tracking-tight">ตรวจสอบสถานะการจองล่าสุดทั้งหมด</p>
          <p className="text-xs text-slate-400">สถานะการจองและสลิปการชำระเงินของคุณ</p>
        </div>
        <span className="text-xs bg-slate-800 text-slate-300 font-bold px-2.5 py-1 rounded-full">เรียงใหม่</span>
      </div>

      <div className="space-y-3 max-h-[250px] overflow-y-auto pr-1">
        {(() => {
          if (!loggedInUser) {
            return (
              <p className="text-xs text-slate-400 text-center py-4">
                🔒 กรุณาลงชื่อเข้าใช้ระบบข้างต้นเสียก่อนเพื่อตรวจสอบประวัติตารางจองของท่านเอง
              </p>
            );
          }

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

          const groupsWithButton = new Set<string>();
          return userFilteredFutureBookings.map((booking) => {
            const courtName = courtNameById.get(booking.courtId) || 'สนามกีฬาทั่วไป';
            // The payment hangs off the group's first row; every row of
            // the group shares it.
            const matchedPayment = paymentForBooking(booking);
            // A slip can be sent while the booking awaits payment, and also
            // after the hold expired (late payment: the customer paid but
            // the slip came too late).
            const lateSlip = !!matchedPayment && (matchedPayment.status === PaymentStatus.EXPIRED ||
              (matchedPayment.status === PaymentStatus.SLIP_UPLOADED && !!matchedPayment.expiredAt));
            const awaitingSlip = !!matchedPayment && (lateSlip || (booking.status === BookingStatus.PENDING_PAYMENT &&
              (matchedPayment.status === PaymentStatus.PENDING || matchedPayment.status === PaymentStatus.SLIP_UPLOADED)));
            // One upload button per booking group, not one per hour.
            const showUploadButton = awaitingSlip && !groupsWithButton.has(booking.bookingCode);
            if (showUploadButton) groupsWithButton.add(booking.bookingCode);

            let statusBadge = '';
            if (booking.status === BookingStatus.CONFIRMED || booking.status === BookingStatus.COMPLETED) statusBadge = 'bg-emerald-600 text-white';
            else if (booking.status === BookingStatus.PENDING_PAYMENT) statusBadge = 'bg-amber-500 text-white';
            else if (booking.status === BookingStatus.CANCELLED) statusBadge = 'bg-slate-600 text-slate-300';
            else statusBadge = 'bg-red-500 text-white';

            return (
              <div key={booking.id} className="bg-slate-800/80 hover:bg-slate-800 rounded-xl p-4 border border-slate-700/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs transition">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-slate-200">{booking.bookingCode}</span>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${statusBadge}`}>
                      {booking.status === BookingStatus.CONFIRMED && 'อนุมัติเรียบร้อย'}
                      {booking.status === BookingStatus.PENDING_PAYMENT && (matchedPayment?.status === PaymentStatus.SLIP_UPLOADED ? 'รอสต๊าฟเช็คสลิป' : 'รอชำระเงิน / รอสลิป')}
                      {booking.status === BookingStatus.CANCELLED && (
                        matchedPayment?.status === PaymentStatus.EXPIRED ? 'หมดเวลาชำระ'
                          : lateSlip ? 'ส่งสลิปล่าช้า รอพนักงานตรวจ'
                          : 'ยกเลิกรายการ')}
                      {booking.status === BookingStatus.COMPLETED && 'เล่นแล้ว'}
                      {booking.status === BookingStatus.NO_SHOW && 'ไม่มาใช้สนาม'}
                    </span>
                  </div>
                  <p className="font-bold text-slate-100">{courtName}</p>
                  <p className="text-xs text-slate-400">
                    วันที่จอง: {booking.date} | เวลา: {booking.startTime} - {booking.endTime} น.
                  </p>
                  <p className="text-xs text-slate-400">
                    ผู้ติดต่อ: {booking.userName} | โทร: {booking.userPhone}
                  </p>
                </div>

                <div className="flex flex-col items-start sm:items-end justify-between gap-1">
                  <p className="font-bold text-emerald-400 text-sm">{formatBaht(booking.totalAmount)} บาท</p>
                  <span className="text-xs text-slate-400">
                    หลักฐานสลิป: {matchedPayment?.slipUrl ? (
                      <a href={matchedPayment.slipUrl} target="_blank" rel="noreferrer" className="text-sky-400 underline font-bold hover:text-sky-300">กดดูรูปสลิป</a>
                    ) : 'ไม่มีการอัพโหลด'}
                  </span>
                  {!!matchedPayment?.refundAmount && (
                    <span className="text-xs font-bold text-sky-300">
                      💸 คืนเงินแล้ว {formatBaht(matchedPayment.refundAmount)} บาท{matchedPayment.refundReason ? ` (${matchedPayment.refundReason})` : ''}
                    </span>
                  )}
                  {booking.status === BookingStatus.CANCELLED && booking.cancellationReason && !lateSlip && matchedPayment?.status !== PaymentStatus.EXPIRED && (
                    <span className="text-xs text-slate-400">เหตุผล: {booking.cancellationReason}</span>
                  )}
                  {showUploadButton && matchedPayment && (
                    <button
                      type="button"
                      onClick={() => {
                        const root = bookingById.get(matchedPayment.bookingId) || booking;
                        handleReopenPayment(root, matchedPayment);
                      }}
                      className="mt-1 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg transition"
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
