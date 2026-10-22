import { BookingStatus, PaymentStatus } from '../types';
import { bookingGroupOf, slotTiming, formatBaht, formatDateTime, formatTaxId, noShowOpenAt } from '../mockData';
import * as api from '../api';
import DemoLogins, { DEMO_STAFF, DEMO_ADMINS } from './DemoLogins';
import { X, Receipt, AlertOctagon } from 'lucide-react';
import { useStaffPOS, StaffPOSContext, StaffPOSProps } from './staff/useStaffPOS';
import WalkinTab from './staff/WalkinTab';
import SlipsTab from './staff/SlipsTab';
import ShopTab from './staff/ShopTab';
import RentalsTab from './staff/RentalsTab';
import VouchersTab from './staff/VouchersTab';
import DayTotalTab from './staff/DayTotalTab';

export default function StaffPOS(props: StaffPOSProps) {
  const s = useStaffPOS(props);
  const {
    METHOD_LABEL,
    actingUser,
    activePosTab,
    bookingPool,
    busy,
    canManageBookings,
    courts,
    goOpenShift,
    gridError,
    guarded,
    handleCancelBooking,
    handleMarkNoShow,
    handleMarkPaidInCash,
    handleStaffLogin,
    handleUndoNoShow,
    lastSyncAt,
    onAddAuditLog,
    onRefreshAll,
    payments,
    pendingSlipPayments,
    products,
    receipt,
    selectedReceiptBooking,
    selectedReceiptOrder,
    setActivePosTab,
    setSelectedReceiptBooking,
    setSelectedReceiptOrder,
    setStaffIdentity,
    setStaffPassword,
    shift,
    shop,
    signedInElsewhere,
    staffApiError,
    staffIdentity,
    staffLoginWith,
    staffPassword,
    staffUser,
    tabAllowed
  } = s;
  if (api.USE_BACKEND && !staffUser) {
    return (
      <div className="max-w-sm mx-auto my-10 bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <form onSubmit={handleStaffLogin} className="space-y-3 text-xs">
          <p className="text-sm font-bold text-slate-800">เข้าสู่ระบบพนักงาน (Staff POS)</p>
          {signedInElsewhere && (
            <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">ตอนนี้เข้าสู่ระบบเป็น "{signedInElsewhere.name}" ซึ่งไม่มีสิทธิ์ใช้หน้าเคาน์เตอร์ - เข้าสู่ระบบด้วยบัญชีพนักงานเพื่อสลับบัญชี</p>
          )}
          {staffApiError && (
            <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">⚠️ {staffApiError}</p>
          )}
          <input value={staffIdentity} onChange={e => setStaffIdentity(e.target.value)} placeholder="เบอร์โทร หรือ อีเมลพนักงาน" className="w-full border border-slate-300 rounded-lg px-3 py-2" required />
          <input type="password" value={staffPassword} onChange={e => setStaffPassword(e.target.value)} placeholder="รหัสผ่าน" className="w-full border border-slate-300 rounded-lg px-3 py-2" required />
          <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg py-2">เข้าสู่ระบบ</button>
          <DemoLogins accounts={[...DEMO_STAFF, ...DEMO_ADMINS]} onPick={staffLoginWith} />
        </form>
      </div>
    );
  }

  return (
    <StaffPOSContext.Provider value={s}>
    <div className="space-y-6">
      {/* A failed load leaves the previous data on screen - say so on every
          tab, not only on the slips tab. */}
      {api.USE_BACKEND && (staffApiError || gridError) && (
        <p id="staff-load-error" role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-2">
          ⚠️ โหลดข้อมูลล่าสุดไม่สำเร็จ ข้อมูลที่เห็นอาจไม่เป็นปัจจุบัน: {staffApiError || gridError}{' '}
          <button type="button" onClick={onRefreshAll} className="underline font-bold">ลองใหม่</button>
        </p>
      )}

      {!shift && (
        <button type="button" id="no-shift-banner" onClick={goOpenShift}
          className="w-full text-left text-xs bg-amber-50 border border-amber-300 text-amber-900 rounded-xl px-4 py-2 font-bold">
          ⚠️ ยังไม่ได้เปิดกะลิ้นชัก — รับเงินสดไม่ได้จนกว่าจะเปิดกะ (กดที่นี่เพื่อเปิดกะ)
        </button>
      )}

      {/* Staff Workspace Alert banner */}
      <div className="bg-slate-800 text-white p-4 rounded-2xl flex flex-wrap items-center justify-between gap-4 border border-slate-700 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 bg-emerald-950 text-emerald-400 rounded-xl flex items-center justify-center font-bold font-mono">POS</div>
          <div>
            <p className="text-xs font-bold">แผงทำงานพนักงานสปอร์ตคอมเพล็กซ์ (Staff Panel)</p>
            <p className="text-[10px] text-slate-400">ผู้ใช้งาน: {staffUser ? staffUser.name : 'คุณ กิตติ (เดโม)'} | สิทธิ์ของคุณ: <span className="text-emerald-400 font-extrabold">{actingUser?.role}</span>
              {lastSyncAt && <span id="staff-last-sync"> · อัปเดตอัตโนมัติ {new Date(lastSyncAt).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false })}</span>}</p>
          </div>
        </div>

        {/* Quick notification queue tracker */}
        <div className="flex gap-4">
          <span className="text-xs bg-amber-500/20 text-amber-300 font-bold px-3 py-1.5 rounded-xl border border-amber-500/30 flex items-center gap-1">
            <AlertOctagon className="h-4 w-4 shrink-0 shrink-0" />
            คิวอนุมัติสลิปโอน: {pendingSlipPayments.length} รายการ
          </span>
        </div>
      </div>

      {/* POS Sub Tabs controller */}
      <div id="staff-pos-tabs" className="flex flex-wrap border-b border-slate-200 gap-1">
{tabAllowed('walkin') && (
        <button
          onClick={() => setActivePosTab('walkin')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'walkin' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          🏸 บันทึก Walk-in ด่วน
        </button>
        )}
{tabAllowed('slips') && (
        <button
          onClick={() => setActivePosTab('slips')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition relative ${activePosTab === 'slips' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          📝 อนุมัติ Slip โอน ({pendingSlipPayments.length})
          {pendingSlipPayments.length > 0 && (
            <span className="absolute top-1 right-1 h-2.5 w-2.5 rounded-full bg-rose-600 animate-ping" />
          )}
        </button>
        )}
{tabAllowed('fb') && (
        <button
          onClick={() => setActivePosTab('fb')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'fb' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          ☕️ POS ขายอาหาร F&B / ลูกแบด
        </button>
        )}
{tabAllowed('rentals') && (
        <button
          onClick={() => setActivePosTab('rentals')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'rentals' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          🏸 ยืม/เช่าแร็กเกต & รองเท้า
        </button>
        )}
{tabAllowed('vouchers') && (
        <button
          onClick={() => setActivePosTab('vouchers')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'vouchers' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          🎁 รับของรางวัล
        </button>
        )}
{tabAllowed('todays_total') && (
        <button
          onClick={() => setActivePosTab('todays_total')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'todays_total' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          📊 ยอดลิ้นชักวันนี้ (Read-Only)
        </button>
        )}
      </div>

      {/* POS Contents Rendering */}
      <div id="pos-content-sections" className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm min-h-[400px]">
        
        {/* Tab 1: Walkin Booking */}
        {activePosTab === 'walkin' && tabAllowed('walkin') && <WalkinTab />}

        {/* Tab 2: Approve Slips */}
        {activePosTab === 'slips' && tabAllowed('slips') && <SlipsTab />}
        {activePosTab === 'fb' && tabAllowed('fb') && <ShopTab />}

        {/* Tab 4: Equipment Rental */}
        {activePosTab === 'rentals' && tabAllowed('rentals') && <RentalsTab />}

        {/* Reward vouchers: staff check an RW-XXXXXX claim code and hand the
            reward over (FR-4.3). */}
        {activePosTab === 'vouchers' && tabAllowed('vouchers') && <VouchersTab />}

        {/* Tab 5: Today's consolidate accounting summary (Read only block for staff) */}
        {activePosTab === 'todays_total' && tabAllowed('todays_total') && <DayTotalTab />}

      </div>

      {/* Printable Receipt Overlay Modal (ออกใบเสร็จรับเงินอย่างเป็นทางการ) */}
      {(selectedReceiptBooking || selectedReceiptOrder) && (
        <div className="fixed inset-0 bg-slate-900/65 flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-white rounded-2xl max-w-sm w-full p-5 shadow-2xl border border-slate-300 relative space-y-4">
            
            {/* Close button */}
            <button
              onClick={() => {
                setSelectedReceiptBooking(null);
                setSelectedReceiptOrder(null);
              }}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 transition"
              type="button"
            >
              <X className="h-4 w-4" />
            </button>

            {/* Printable Frame Area */}
            <div id="invoice-receipt-print" className="p-4 bg-slate-50 rounded-xl border border-dashed border-slate-300 font-sans text-[11px] text-slate-800 space-y-3.5 shadow-inner">
              
              {/* Receipt Header logo */}
              <div className="text-center space-y-1 pb-3 border-b border-slate-200">
                {shop.name
                  ? <h2 id="receipt-shop-name" className="text-xs font-black tracking-tight text-slate-900 uppercase">{shop.name}</h2>
                  : <h2 id="receipt-shop-name" className="text-xs font-bold text-rose-600">ยังไม่ได้ตั้งชื่อร้าน (ผู้ดูแลตั้งได้ที่แท็บราคา)</h2>}
                {shop.address && <p className="text-[8.5px] text-slate-500">{shop.address}</p>}
                {shop.phone && <p className="text-[8.5px] text-slate-500 font-mono">โทร {shop.phone}</p>}
                {shop.vatRegistered && shop.taxId && <p className="text-[8.5px] text-slate-500">เลขประจำตัวผู้เสียภาษี (TAX ID): <span className="font-mono">{formatTaxId(shop.taxId)}</span></p>}
                <p id="receipt-title" className="text-[10px] font-bold text-slate-800 underline uppercase mt-2">{shop.vatRegistered ? 'ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ' : 'ใบเสร็จรับเงิน'}</p>
                <p className="text-[9px] font-semibold text-slate-600 bg-slate-200/60 inline-block px-1.5 py-0.5 rounded mt-0.5 font-mono">{shop.vatRegistered ? 'RECEIPT / TAX INVOICE (ABB.)' : 'RECEIPT'}</p>
              </div>

              {/* Receipt metadata info */}
              <div className="space-y-1 text-[9.5px] text-slate-600 bg-white p-2 rounded border border-slate-100">
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-500">เลขที่ใบเสร็จ (No.):</span>
                  <span className="font-mono font-bold text-slate-800">
                    {selectedReceiptBooking ? `REC-${selectedReceiptBooking.bookingCode}` : `REC-${selectedReceiptOrder?.orderCode}`}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-500">วันที่ออก (Date):</span>
                  <span className="font-mono">
                    {formatDateTime(Date.now())} น.
                  </span>
                </div>
                {receipt?.paid && receipt.paidAt && (
                  <div className="flex justify-between">
                    <span className="font-semibold text-slate-500">วันที่รับเงิน (Paid):</span>
                    <span id="receipt-paid-at" className="font-mono">{formatDateTime(receipt.paidAt)} น.</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-500">ชื่อผู้ซื้อ (Customer):</span>
                  <span className="font-bold text-slate-800">
                    {selectedReceiptBooking ? selectedReceiptBooking.userName : selectedReceiptOrder?.customerName}
                  </span>
                </div>
                {selectedReceiptBooking?.userPhone && (
                  <div className="flex justify-between">
                    <span className="font-semibold text-slate-500">เบอร์โทรศัพท์:</span>
                    <span className="font-mono">{selectedReceiptBooking.userPhone}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-500">ผู้รับชำระ (Cashier):</span>
                  <span id="receipt-cashier" className="italic">{receipt?.cashier || '-'}</span>
                </div>
              </div>

              {/* Items detail list */}
              <div className="border-t border-b border-slate-200 py-2">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[8.5px] font-black text-slate-500 uppercase tracking-wide border-b border-slate-200 pb-1">
                      <th className="pb-1">รายการ (Item)</th>
                      <th className="pb-1 text-center">จํานวน</th>
                      <th className="pb-1 text-right">สุทธิ (บ.)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-[10px]">
                    {selectedReceiptBooking && receipt?.rows.map(row => (
                      <tr key={row.id}>
                        <td className="py-1">
                          <span className="font-medium text-slate-800">{courts.find(c => c.id === row.courtId)?.name || 'สนามหลักคอมเพล็กซ์'}</span>
                          <div className="text-[8.5px] text-slate-400 font-mono">
                            วันที่เล่น {row.date} ({row.startTime} - {row.endTime} น.)
                          </div>
                        </td>
                        <td className="py-1 text-center font-mono">1 ชม.</td>
                        <td className="py-1 text-right font-mono font-bold text-slate-800">{formatBaht(row.totalAmount)}</td>
                      </tr>
                    ))}

                    {selectedReceiptOrder && selectedReceiptOrder.items.map((it, idx) => {
                      const prodName = it.productName || products.find(p => p.id === it.productId)?.name || 'สินค้า F&B / อุปกรณ์กีฬา';
                      return (
                        <tr key={idx}>
                          <td className="py-1">
                            <span className="font-medium text-slate-800">{prodName}</span>
                            {it.shoeSize && (
                              <span className="text-[8px] text-indigo-700 bg-indigo-50 border border-indigo-100 px-1 rounded ml-1">
                                Size {it.shoeSize} ({it.shoeGender === 'M' ? 'ชาย' : 'หญิง'})
                              </span>
                            )}
                          </td>
                          <td className="py-1 text-center font-mono">{it.qty}</td>
                          <td className="py-1 text-right font-mono font-bold text-slate-800">{formatBaht(it.unitPrice * it.qty)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Financial Calculation footer */}
              <div className="space-y-0.5 text-[9.5px] text-slate-700">
                {shop.vatRegistered && (() => {
                  const total = receipt?.total || 0;
                  const vat = Math.round(total * 7 / 107 * 100) / 100;
                  return (<>
                    <div className="flex justify-between">
                      <span>ฐานภาษี (VATAble Base):</span>
                      <span className="font-mono">{(total - vat).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>ภาษีมูลค่าเพิ่ม (VAT 7%):</span>
                      <span id="receipt-vat" className="font-mono mr-1">{vat.toFixed(2)}</span>
                    </div>
                  </>);
                })()}
                <div className="flex justify-between font-black text-slate-900 border-t border-slate-200 pt-1.5 text-[11px]">
                  <span>ยอดชำระสุทธิ (Grand Total):</span>
                  <span className="font-mono text-emerald-700 text-[11.5px]">
                    {formatBaht(receipt?.total || 0)} บาท
                  </span>
                </div>
              </div>

              {/* Signature stamp */}
              <div className="pt-2.5 text-center border-t border-slate-200 space-y-0.5 text-[8.5px] text-slate-400">
                {receipt?.paid
                  ? <p>💸 รับชำระแล้วโดย: <span id="receipt-method" className="font-bold text-slate-700 uppercase">{(receipt.method && METHOD_LABEL[receipt.method]) || receipt.method || '-'}</span></p>
                  : <p id="receipt-unpaid" className="font-bold text-rose-600">ยังไม่ได้รับชำระเงิน / ยกเลิกแล้ว — ไม่ออกใบเสร็จ</p>}
                <p className="italic">"ขอบพระคุณลูกค้าที่วางใจคอมเพล็กซ์ของเราค่ะ"</p>
              </div>
            </div>

            {/* Booking actions: cancel/refund and cash for managers, no-show
                for any staff. */}
            {selectedReceiptBooking && (() => {
              const b = selectedReceiptBooking;
              const timing = slotTiming(b.date, b.startTime);
              const canNoShow = (b.status === BookingStatus.CONFIRMED || b.status === BookingStatus.COMPLETED) && timing.started;
              // Allowed from the grace period after the start (server setting).
              const noShowFrom = noShowOpenAt(b.date, b.startTime);
              const noShowYet = Date.now() >= noShowFrom.getTime();
              const canCancel = canManageBookings && (b.status === BookingStatus.CONFIRMED || b.status === BookingStatus.PENDING_PAYMENT);
              // Not while a slip waits for review (approve/reject it instead).
              const ids = new Set(bookingGroupOf(b, bookingPool()).map(x => x.id));
              const payStatus = api.USE_BACKEND ? b.paymentStatus : payments.find(p => ids.has(p.bookingId))?.status;
              const canCash = canManageBookings && b.status === BookingStatus.PENDING_PAYMENT && payStatus !== PaymentStatus.SLIP_UPLOADED;
              const canUndoNoShow = b.status === BookingStatus.NO_SHOW;
              if (!canNoShow && !canCancel && !canCash && !canUndoNoShow) return null;
              return (
                <div id="booking-actions" className="flex flex-wrap gap-2 text-[11px]">
                  {canCash && (
                    <button type="button" disabled={busy} onClick={guarded(() => handleMarkPaidInCash(b))} className="disabled:opacity-50 flex-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 font-bold py-1.5 rounded-lg">💵 รับเงินสดแล้ว</button>
                  )}
                  {canNoShow && (
                    <button type="button" id="no-show-button" disabled={busy || !noShowYet} onClick={guarded(() => handleMarkNoShow(b))}
                      title={noShowYet ? 'สนามจะว่างให้ขายต่อในราคาพิเศษ' : undefined}
                      className="disabled:opacity-50 flex-1 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 font-bold py-1.5 rounded-lg">
                      🚫 ไม่มาใช้สนาม{noShowYet ? '' : ` (กดได้ตั้งแต่ ${noShowFrom.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false })})`}
                    </button>
                  )}
                  {canUndoNoShow && (
                    <button type="button" id="undo-no-show-button" disabled={busy} onClick={guarded(() => handleUndoNoShow(b))}
                      title="ลูกค้ามาสาย - ยกเลิกการบันทึกไม่มา (ถ้ายังไม่ได้ขายชั่วโมงนี้ให้คนอื่น)"
                      className="disabled:opacity-50 flex-1 bg-violet-50 hover:bg-violet-100 text-violet-800 border border-violet-200 font-bold py-1.5 rounded-lg">
                      ↩️ ลูกค้ามาแล้ว (ยกเลิก "ไม่มา")
                    </button>
                  )}
                  {canCancel && (
                    <button type="button" disabled={busy} onClick={guarded(() => handleCancelBooking(b))} className="disabled:opacity-50 flex-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-bold py-1.5 rounded-lg">✖ ยกเลิก / คืนเงิน</button>
                  )}
                </div>
              );
            })()}

            {/* Print action buttons */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                onClick={() => {
                  setSelectedReceiptBooking(null);
                  setSelectedReceiptOrder(null);
                }}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 py-2 rounded-xl font-bold text-center transition"
              >
                ปิดย้อนกลับ
              </button>
              
              <button
                type="button"
                id="receipt-print"
                disabled={!receipt?.paid}
                onClick={() => {
                  window.print();
                  onAddAuditLog('RECEIPT_PRINTED_BY_STAFF', 'Report', selectedReceiptBooking ? selectedReceiptBooking.id : (selectedReceiptOrder?.id || ''), null, null);
                }}
                className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-2 rounded-xl text-center transition flex justify-center items-center gap-1 shadow-sm font-sans"
              >
                <Receipt className="h-3.5 w-3.5" /> พิมพ์บิล/บันทึก PDF
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </StaffPOSContext.Provider>
  );
}
