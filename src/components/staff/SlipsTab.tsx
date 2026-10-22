import { formatBaht, formatDateTime } from '../../mockData';
import * as api from '../../api';
import { Check, AlertTriangle, ShieldCheck, CheckCircle2 } from 'lucide-react';
import { useStaffPOSContext } from './useStaffPOS';

export default function SlipsTab() {
  const {
    busy,
    canManageBookings,
    courts,
    guarded,
    handleDismissRefundCheck,
    handleRefundPayment,
    handleRejectSlip,
    handleStaffLogout,
    handleVerifySlip,
    pendingSlipPayments,
    refundChecks,
    rejectId,
    rejectReason,
    seenSlip,
    setRejectId,
    setRejectReason,
    setSeenSlip,
    slipQueueBookings,
    staffUser
  } = useStaffPOSContext();
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
          <ShieldCheck className="h-5 w-5 text-emerald-600" />
          คิวตรวจสอบสลิปโอนเงินลูกค้าออนไลน์ (Line Slip Verify Stage)
        </h3>
        <p className="text-xs text-slate-500">กรุณากดตรวจเช็กรายละเอียด รูปสลิปผู้เข้าใช้บริการก่อนการยืนยันจอง ป้องกันความคลาดเคลื่อนและสลิปปลอมแปลง</p>
      </div>



      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {api.USE_BACKEND && staffUser && (
          <p className="md:col-span-2 text-[11px] text-slate-500">
            ตรวจสลิปในนาม <span className="font-bold text-slate-700">{staffUser.name}</span>
            <button type="button" onClick={handleStaffLogout} className="ml-2 underline text-slate-500 hover:text-slate-700">ออกจากระบบ</button>
          </p>
        )}

        {/* Slip list queue */}
        <div className="space-y-3">
          <span className="text-xs font-bold text-slate-700 block">สลิปที่รอสต๊าฟเวอริฟายเดลิเวอร์รี ({pendingSlipPayments.length} รายการ):</span>

          <div className="space-y-3 max-h-[400px] overflow-y-auto pr-1">
            {pendingSlipPayments.map((pay) => {
              const bookingObj = slipQueueBookings.find(b => b.id === pay.bookingId);
              if (!bookingObj) return null;
              const groupHours = slipQueueBookings.filter(b => b.bookingCode === bookingObj.bookingCode).length;
              const courtName = courts.find(c => c.id === bookingObj.courtId)?.name || 'สนาม';
              const slipChanged = api.USE_BACKEND && pay.id in seenSlip && seenSlip[pay.id] !== pay.slipUploadedAt;

              return (
                <div key={pay.id} className="bg-slate-50 hover:bg-slate-100 p-4 rounded-xl border border-slate-200 text-xs space-y-2 relative transition">
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="text-[10px] bg-[#1e293b] text-white px-2 py-0.5 rounded font-mono font-bold">{bookingObj.bookingCode}</span>
                      <p className="font-black text-slate-800 mt-1.5">{courtName}</p>
                      <p className="text-[10px] text-slate-500">ผู้จอง: <span className="text-slate-800 font-semibold">{bookingObj.userName}</span> | โทร: {bookingObj.userPhone}</p>
                      <p className="text-[10px] text-slate-500">จองเล่นวันที่: {bookingObj.date} | เวลา: {bookingObj.startTime} - {bookingObj.endTime} น.{groupHours > 1 ? ` (+${groupHours - 1} ชั่วโมงในกลุ่มเดียวกัน)` : ''}</p>
                    </div>

                    <div className="text-right">
                      {pay.expiredAt && (
                        <p className="text-[9.5px] font-black text-rose-700 bg-rose-50 border border-rose-200 rounded px-1.5 py-0.5 mb-1">⚠️ ส่งสลิปหลังหมดเวลา</p>
                      )}
                      <p className="font-extrabold text-emerald-700 text-sm">{formatBaht(pay.amount)} บาท</p>
                      <p className="text-[9px] text-slate-400">อัพโหลดเมื่อ: {pay.slipUploadedAt ? formatDateTime(pay.slipUploadedAt) : 'ไม่ระบุ'}</p>
                    </div>
                  </div>

                  {slipChanged && (
                    <div id="slip-changed-notice" className="bg-amber-50 border border-amber-300 text-amber-900 rounded-lg p-2 text-[11px] font-bold flex items-center justify-between gap-2">
                      <span>⚠️ ลูกค้าส่งสลิปใหม่ระหว่างที่ตรวจ - ตรวจสลิปใหม่ด้านล่างก่อนอนุมัติ/ปฏิเสธ</span>
                      <button
                        type="button"
                        onClick={() => setSeenSlip(prev => ({ ...prev, [pay.id]: pay.slipUploadedAt }))}
                        className="shrink-0 bg-amber-600 hover:bg-amber-500 text-white px-2 py-1 rounded"
                      >
                        ตรวจสลิปใหม่แล้ว
                      </button>
                    </div>
                  )}

                  {/* Interactive check actions */}
                  <div className="flex items-center gap-2 pt-2 border-t border-slate-200">
                    {/* The slip itself, so it is checked before approving
                        (tap to open it full size). */}
                    {pay.slipUrl && (
                      <a 
                        href={pay.slipUrl} 
                        target="_blank" 
                        rel="noreferrer" 
                        title="เปิดสลิปขนาดเต็ม"
                        className="mr-auto flex items-center gap-2 text-xs text-sky-800 font-bold"
                      >
                        <img src={pay.slipUrl} alt="สลิปโอนเงิน" className="h-20 w-16 object-cover rounded border border-slate-300 bg-white" />
                        <span className="underline">ดูสลิปเต็ม</span>
                      </a>
                    )}

                    {canManageBookings && (
                      <button
                        type="button"
                        disabled={busy} onClick={guarded(() => handleRefundPayment(pay))}
                        title="ลูกค้าโอนแล้วแต่ยืนยันการจองไม่ได้ (เช่น ส่งสลิปช้าและมีผู้อื่นจองไปแล้ว) - บันทึกการคืนเงิน"
                        className="bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-200 py-1.5 px-3 rounded text-[11px] font-bold transition"
                      >
                        💸 คืนเงิน
                      </button>
                    )}

                    <button
                      disabled={slipChanged}
                      onClick={() => {
                        setRejectId(pay.id);
                        setRejectReason('');
                      }}
                      className="disabled:opacity-40 bg-slate-200 hover:bg-slate-300 text-slate-700 py-1.5 px-3 rounded text-[11px] font-bold transition"
                    >
                      ❌ ปฏิเสธ
                    </button>

                    <button
                      type="button"
                      disabled={busy || slipChanged} onClick={guarded(() => handleVerifySlip(pay.id))}
                      className="disabled:opacity-40 bg-emerald-600 hover:bg-emerald-500 text-white py-1.5 px-4 rounded text-[11px] font-bold flex items-center gap-1 shadow-sm transition"
                    >
                      <Check className="h-3.5 w-3.5" /> อนุมัติสล็อตจอง
                    </button>
                  </div>
                </div>
              );
            })}

            {pendingSlipPayments.length === 0 && (
              <div className="text-center py-16 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                <p className="text-xs text-slate-500 font-bold">ไม่มีรายการสลิปรอการยืนยันในตู้ทำงานขณะนี้ 🎉</p>
                <p className="text-[10px] text-slate-400 mt-1">คิวเป็นระเบียบเรียบร้อยทั้งหมด</p>
              </div>
            )}
          </div>

          {/* Refunds asked for when cancelling, not recorded because the slip
              was never approved: check the bank account, then refund or
              close them. */}
          {api.USE_BACKEND && canManageBookings && refundChecks.length > 0 && (
            <div id="refund-checks" className="space-y-2 pt-2">
              <span className="text-xs font-bold text-amber-800 block">💸 รอตรวจยอดในบัญชีก่อนคืนเงิน ({refundChecks.length} รายการ):</span>
              {refundChecks.map(({ payment: pay, bookings: group }) => {
                const first = group[0];
                return (
                  <div key={pay.id} className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs space-y-2">
                    <div className="flex justify-between gap-2">
                      <div>
                        <span className="text-[10px] bg-[#1e293b] text-white px-2 py-0.5 rounded font-mono font-bold">{first?.bookingCode ?? pay.bookingId}</span>
                        <p className="text-[10px] text-slate-600 mt-1">{first?.userName} · {first?.userPhone} · {first?.date} (ยกเลิกแล้ว)</p>
                      </div>
                      {/* What the customer sent; the server refunds only what no
                          booked hour still pays for. */}
                      <p className="text-right text-[10px] text-slate-600">ยอดที่ลูกค้าโอน<br /><span className="font-extrabold text-amber-800 text-xs">{formatBaht(pay.amount)} บาท</span></p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {pay.slipUrl && <a href={pay.slipUrl} target="_blank" rel="noreferrer" className="mr-auto underline text-sky-800 font-bold">ดูสลิป</a>}
                      <button type="button" disabled={busy} onClick={guarded(() => handleDismissRefundCheck(pay))}
                        className="bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 py-1.5 px-3 rounded font-bold">ไม่มีเงินเข้า (ไม่ต้องคืน)</button>
                      <button type="button" disabled={busy} onClick={guarded(() => handleRefundPayment(pay))}
                        className="bg-sky-600 hover:bg-sky-500 text-white py-1.5 px-3 rounded font-bold">💸 เงินเข้าจริง — คืนเงิน</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Reject / Slip Reject dialogue drawer simulation */}
        <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200 flex flex-col justify-between">
          {rejectId ? (
            <div className="space-y-4 text-xs">
              <p className="font-bold text-slate-800 flex items-center gap-1 text-rose-700">
                <AlertTriangle className="h-4 w-4" /> ปฏิเสธหลักฐานรูปสลิปลูกค้า
              </p>
              <p className="text-slate-500 text-[10px]">ระบบจะยิงแจ้งเตือนยกเลิกการสลักเวลา และยิง Push message คัดสิทธิ์ คืนเงิน ผ่านทางพอร์ท LINE OA ลูกค้าทันที</p>

              <div>
                <label className="block text-slate-700 font-semibold mb-1.5">ระบุเหตุผลการปฏิเสธยอดสลิป:</label>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="เช่น มียอดเบี่ยงเบนเล็กน้อย, สลิปซ้ำซ้อนรอบบ่าย, ตรวจสอบเงินไม่เข้าธนาคารกสิกร"
                  className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs focus:outline-none"
                  rows={3}
                />
              </div>

              <div className="flex gap-2">
                <button
                  disabled={busy} onClick={guarded(() => handleRejectSlip(rejectId))}
                  className="bg-rose-600 hover:bg-rose-500 text-white font-bold py-2 px-4 rounded"
                >
                  ยืนยันการปฎิเสธ (Cancel Booking)
                </button>
                <button
                  onClick={() => setRejectId(null)}
                  className="bg-slate-200 hover:bg-slate-300 text-slate-700 py-2 px-4 rounded"
                >
                  ยกเลิก
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center py-20 text-slate-400 font-sans space-y-2">
              <CheckCircle2 className="h-10 w-10 text-slate-300 mx-auto" />
              <p className="text-xs font-bold">ยังไม่ได้เลือกรายการที่จะปฏิเสธ</p>
              <p className="text-[9.5px] text-slate-400">เลือกกด 'ปฏิเสธ (Reject)' เพื่อเปิดแผงสาเหตุที่นี่</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
