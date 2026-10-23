import { OrderType } from '../../types';
import { getTodayDateStr, formatBaht, isPaidBooking, formatDateTime, roundBaht } from '../../mockData';
import { AlertTriangle, Receipt } from 'lucide-react';
import { useStaffPOSContext } from './useStaffPOS';

export default function DayTotalTab() {
  const {
    blindCount,
    busy,
    calculateLedger,
    canManageBookings,
    closedShift,
    countLocked,
    courts,
    guarded,
    handleCloseShift,
    handleOpenShift,
    handleVoidOrder,
    lastShiftCount,
    setSelectedReceiptBooking,
    setSelectedReceiptOrder,
    setShiftCountInput,
    setShiftBankedInput,
    setShiftFloatInput,
    setShiftNote,
    setShiftOpenNote,
    shift,
    shiftCountInput,
    shiftBankedInput,
    shiftFloatInput,
    shiftHistory,
    shiftNote,
    shiftOpenNote,
    todayBookingList,
    todaysOrders
  } = useStaffPOSContext();
  // A float other than the last close's count needs a note (server rule).
  const floatDiffers = lastShiftCount !== null && shiftFloatInput.trim() !== '' && roundBaht(Number(shiftFloatInput)) !== lastShiftCount;
  return (
    <div className="space-y-6">
      {/* Cash drawer shift (FR-6.1/6.2) */}
      <div id="shift-panel" className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 shadow-sm text-xs">
        <h4 className="text-sm font-bold text-slate-800">💰 กะลิ้นชักเงินสด</h4>
        {!shift ? (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-slate-600 mb-1">เงินทอนตั้งต้นในลิ้นชัก (บาท)</label>
              <input id="shift-float" type="number" min={0} value={shiftFloatInput} onChange={e => setShiftFloatInput(e.target.value)}
                className="w-40 border border-slate-300 rounded-lg px-3 py-2" placeholder="เช่น 2000" />
            </div>
            {floatDiffers && (
              <div className="flex-1 min-w-[12rem]">
                <label className="block text-rose-700 mb-1">หมายเหตุ (ยอดไม่ตรงกับตอนปิดกะล่าสุด)</label>
                <input id="shift-open-note" value={shiftOpenNote} onChange={e => setShiftOpenNote(e.target.value)} maxLength={500}
                  className="w-full border border-rose-300 rounded-lg px-3 py-2" placeholder="เช่น นำเงิน 3,000 บาทฝากธนาคาร" />
              </div>
            )}
            <button type="button" disabled={busy} onClick={guarded(handleOpenShift)} className="disabled:opacity-50 bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-4 py-2 rounded-lg">เปิดกะ</button>
            {lastShiftCount !== null && (
              <p id="shift-last-count" className="text-slate-600 w-full">
                เงินที่เหลือในลิ้นชักจากกะล่าสุด <b>{formatBaht(lastShiftCount)}</b> บาท{' '}
                <button type="button" onClick={() => setShiftFloatInput(String(lastShiftCount))} className="text-emerald-700 font-bold underline">ใช้ยอดนี้</button>
                {' '}· ถ้าเงินในลิ้นชักไม่เท่านี้ ต้องใส่หมายเหตุ
              </p>
            )}
            <p className="text-slate-500 w-full">นับเงินทอนในลิ้นชักก่อนเริ่มขาย แล้วกดเปิดกะ ระบบจะรวมเงินสดที่รับระหว่างกะให้อัตโนมัติ</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-slate-600">เปิดกะโดย <b>{shift.staffName}</b> เมื่อ {formatDateTime(shift.openedAt)}</p>
            {blindCount ? (
              <p id="shift-blind-note" className="bg-slate-50 rounded-lg p-2 text-slate-600">
                เงินทอนตั้งต้น <b>{formatBaht(shift.openingFloat)}</b> บาท · นับเงินสดทั้งหมดในลิ้นชักแล้วกรอกยอด
                (ระบบไม่แสดงยอดที่ควรมีจนกว่าจะยืนยันยอดนับ)
              </p>
            ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div className="bg-slate-50 rounded-lg p-2"><span className="text-slate-500 block">เงินทอนตั้งต้น</span><b>{formatBaht(shift.openingFloat)}</b></div>
              <div className="bg-slate-50 rounded-lg p-2"><span className="text-slate-500 block">+ เงินสดค่าสนาม</span><b>{formatBaht(shift.cashBookings)}</b></div>
              <div className="bg-slate-50 rounded-lg p-2"><span className="text-slate-500 block">+ เงินสดขายของ/เช่า</span><b>{formatBaht(shift.cashOrders)}</b></div>
              {!!shift.cashDeposits && <div className="bg-slate-50 rounded-lg p-2"><span className="text-slate-500 block">+ มัดจำค้างในลิ้นชัก</span><b>{formatBaht(shift.cashDeposits)}</b></div>}
              {!!shift.cashRefunds && <div className="bg-slate-50 rounded-lg p-2"><span className="text-slate-500 block">− คืนเงินสดจากลิ้นชัก</span><b>{formatBaht(shift.cashRefunds)}</b></div>}
              <div className="bg-emerald-50 rounded-lg p-2"><span className="text-emerald-700 block">= ควรมีในลิ้นชัก</span><b id="shift-expected">{formatBaht(shift.expected)}</b></div>
            </div>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="block text-slate-600 mb-1">เงินสดที่นับได้จริง (บาท)</label>
                <input id="shift-count" type="number" min={0} value={shiftCountInput} readOnly={countLocked} onChange={e => setShiftCountInput(e.target.value)} className="w-40 border border-slate-300 rounded-lg px-3 py-2 read-only:bg-slate-100" />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">นำเงินออก / ฝากธนาคาร (บาท)</label>
                <input id="shift-banked" type="number" min={0} value={shiftBankedInput} onChange={e => setShiftBankedInput(e.target.value)} placeholder="0" className="w-40 border border-slate-300 rounded-lg px-3 py-2" />
              </div>
              <div className="flex-1 min-w-[180px]">
                <label className="block text-slate-600 mb-1">{blindCount ? 'หมายเหตุ (ถ้ามี)' : 'หมายเหตุ (จำเป็นถ้ายอดไม่ตรง)'}</label>
                <input id="shift-note" value={shiftNote} onChange={e => setShiftNote(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2" />
              </div>
              <button type="button" disabled={busy} onClick={guarded(handleCloseShift)} className="disabled:opacity-50 bg-slate-900 hover:bg-slate-800 text-white font-bold px-4 py-2 rounded-lg">นับเงินและปิดกะ</button>
            </div>
            <p className="text-[10px] text-slate-500">คืนเงินลูกค้าแบบเงินสดจากลิ้นชักถูกหักจากยอดนี้ (โอนคืนไม่หัก) · เงินที่นำออก/ฝากธนาคารตอนปิดกะ: กะถัดไปเริ่มด้วยยอดนับลบยอดที่นำออก</p>
          </div>
        )}
        {closedShift && (
          <p id="shift-result" className={`rounded-lg px-3 py-2 font-bold ${closedShift.varianceCash === 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>
            ปิดกะแล้ว: ควรมี {formatBaht(closedShift.expectedCash ?? 0)} นับได้ {formatBaht(closedShift.countedCash ?? 0)} →{' '}
            {closedShift.varianceCash === 0 ? 'ตรง ✔' : (closedShift.varianceCash ?? 0) > 0 ? `เกิน ${formatBaht(closedShift.varianceCash ?? 0)} บาท` : `ขาด ${formatBaht(-(closedShift.varianceCash ?? 0))} บาท`}
          </p>
        )}
        {canManageBookings && shiftHistory.filter(sh => sh.closedAt).length > 0 && (
          <div>
            <p className="font-bold text-slate-700 mb-1">กะที่ปิดแล้ว (ผู้จัดการ)</p>
            <table className="w-full text-[11px]">
              <thead><tr className="text-left text-slate-500"><th>เปิด</th><th>พนักงาน</th><th className="text-right">ควรมี</th><th className="text-right">นับได้</th><th className="text-right">เกิน/ขาด</th><th>หมายเหตุ</th></tr></thead>
              <tbody>
                {shiftHistory.filter(sh => sh.closedAt).slice(0, 15).map(sh => (
                  <tr key={sh.id} className="border-t border-slate-100">
                    <td>{formatDateTime(sh.openedAt)}</td>
                    <td>{sh.staffName}{sh.closedByName && sh.closedByName !== sh.staffName ? ` → ${sh.closedByName}` : ''}</td>
                    <td className="text-right">{formatBaht(sh.expectedCash ?? sh.expected)}</td>
                    <td className="text-right">{formatBaht(sh.countedCash ?? 0)}</td>
                    <td className={`text-right font-bold ${(sh.varianceCash ?? 0) === 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{formatBaht(sh.varianceCash ?? 0)}</td>
                    <td>{[sh.openingNote && `เปิดกะ: ${sh.openingNote}`, sh.bankedCash ? `นำออก ${formatBaht(sh.bankedCash)}` : '', sh.notes].filter(Boolean).join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div>
        <h3 className="text-base font-bold text-slate-900">สรุปบัญชีเงินสด และ ยอดจราจรวันนี้ (Cash Reconciliation)</h3>
        <p className="text-xs text-slate-500">รายงานข้อมูลเรียลไทม์ ยอดในหมวดหมู่คอร์ท การจราจร F&B เพื่อกระทบยอดปิดกะพนักงานประจำวันวันนี้ ({getTodayDateStr()})</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
          <span className="text-[10px] font-semibold text-slate-500 block uppercase">ชั่วโมงสนามที่เล่นวันนี้ (ชำระแล้ว)</span>
          <span className="font-extrabold text-slate-800 text-3xl mt-1 block">{calculateLedger().bookingCount} ชม.</span>
          <p className="text-[10px] text-slate-400 mt-2">ในนี้เป็น Walk-in: {calculateLedger().walkinCount}</p>
        </div>

        <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
          <span className="text-[10px] font-semibold text-slate-500 block uppercase">เงินที่รับวันนี้ทั้งหมด</span>
          <span className="font-extrabold text-emerald-700 text-3xl mt-1 block">{blindCount ? '—' : `${formatBaht(calculateLedger().totalExpected)} บาท`}</span>
          {blindCount
            ? <p id="day-report-blind" className="text-[10px] text-slate-400 mt-2">ยอดเงินแสดงให้ผู้จัดการเท่านั้น (นับลิ้นชักแบบไม่เห็นยอด)</p>
            : <p className="text-[10px] text-slate-400 mt-2">ค่าสนาม: {formatBaht(calculateLedger().bookingIncome)} (รวมเงินจองล่วงหน้าของวันอื่น) | ขายของ: {formatBaht(calculateLedger().fbIncome)} | ค่าเช่า: {formatBaht(calculateLedger().rentalIncome)}{calculateLedger().keptDeposits > 0 ? ` (รวมมัดจำที่ยึด ${formatBaht(calculateLedger().keptDeposits)})` : ''}</p>}
          {(() => {
            const l = calculateLedger();
            return (<>
              {l.refunded > 0 && (
                <p id="day-refunds" className="text-[10px] text-sky-700 font-bold mt-1">
                  💸 คืนเงินวันนี้: {formatBaht(l.refunded)} บาท
                  <span className="font-normal"> (ที่รับเป็นเงินสด {formatBaht(l.refundedCash)} · ที่รับเป็นเงินโอน {formatBaht(l.refundedQr)}{l.refundedFromDrawer > 0 ? ` · จ่ายเป็นเงินสดจากลิ้นชัก ${formatBaht(l.refundedFromDrawer)}` : ''})</span>
                </p>
              )}
              {l.refundedNotReceived > 0 && (
                <p id="day-refunds-not-received" className="text-[10px] text-slate-500 mt-0.5">
                  + คืนเงินโอนที่ยังไม่ได้อนุมัติสลิป {formatBaht(l.refundedNotReceived)} บาท (ไม่ได้นับเป็นเงินรับ)
                </p>
              )}
            </>);
          })()}
        </div>

        <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
          <span className="text-[10px] font-semibold text-slate-500 block uppercase">แยกตามช่องทางรับเงิน (วันนี้)</span>
          <div className="mt-2 space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-500">💵 เงินสดที่รับวันนี้:</span>
              <span id="ledger-cash" className="font-bold text-slate-800">{blindCount ? '—' : `${formatBaht(calculateLedger().cashExpected)} บาท`}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">📲 โอน / พร้อมเพย์:</span>
              <span id="ledger-qr" className="font-bold text-slate-800 text-slate-800">{formatBaht(calculateLedger().qrExpected)} บาท</span>
            </div>
          </div>
        </div>
      </div>

      {/* List of Recent POS Receipts orders & Walk-in Bookings */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4 shadow-sm">
        <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
          🧾 ระบบพิมพ์ใบเสร็จรับเงินด่วน (Recent Invoices & Receipts)
        </h4>
        <p className="text-[10px] text-slate-500">
          รายชื่อสล็อตและ F&B ทั้งหมดที่ได้รับการโอนชำระเสร็จในวันนี้ กดเพื่อเปิดหน้าต่างพิมพ์ใบสำคัญรับเงินได้ทันที
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Bookings with confirmed status */}
          <div className="space-y-2.5">
            <span className="text-[10.5px] font-bold text-slate-700 block">🥇 การจองที่เล่นวันนี้ (ชำระแล้ว):</span>
            <div className="space-y-2 max-h-[250px] overflow-y-auto border border-slate-100 rounded-lg p-2.5 bg-slate-50/30">
              {todayBookingList.filter(isPaidBooking).map(b => (
                <div key={b.id} className="bg-white p-2.5 rounded-lg border border-slate-200 text-[10.5px] flex items-center justify-between hover:bg-slate-50 transition">
                  <div>
                    <p className="font-bold text-slate-800">{courts.find(c => c.id === b.courtId)?.name || 'สนามกีฬาทั่วไป'}</p>
                    <p className="text-[11px] text-slate-500">ผู้จอง: {b.userName} | ยอด: {formatBaht(b.totalAmount)} บ.</p>
                    <p className="text-[11px] text-[#475569]">เวลา: {b.startTime} น. | รหัส {b.bookingCode}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedReceiptBooking(b);
                      setSelectedReceiptOrder(null);
                    }}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1 px-2.5 rounded text-[11px] shadow-xs flex items-center gap-1 shrink-0"
                  >
                    <Receipt className="h-3 w-3" /> ใบเสร็จ
                  </button>
                </div>
              ))}
              {todayBookingList.filter(isPaidBooking).length === 0 && (
                <p className="text-[11px] text-slate-400 text-center py-6">ไม่มีรายการจองสนามเวลานี้</p>
              )}
            </div>
          </div>

          {/* Orders (F&B and Rentals) */}
          <div className="space-y-2.5">
            <span className="text-[10.5px] font-bold text-slate-700 block">🥤 สินค้าขาย F&B & เช่าไม้นอกตู้อัตโนมัติ:</span>
            <div className="space-y-2 max-h-[250px] overflow-y-auto border border-slate-100 rounded-lg p-2.5 bg-slate-50/30">
              {todaysOrders().map(o => (
                <div key={o.id} className="bg-white p-2.5 rounded-lg border border-slate-200 text-[10.5px] flex items-center justify-between hover:bg-slate-50 transition">
                  <div>
                    <p className="font-bold text-slate-800">
                      {o.type === OrderType.FB ? '🥤 ออเดอร์ F&B' : o.type === OrderType.EQUIPMENT_SALE ? '🏸 ขายอุปกรณ์กีฬา' : '👟 เช่ารองเท้า/ไม้เล่น'}
                    </p>
                    <p className="text-[11px] text-slate-500">ลูกค้า: {o.customerName} | ยอด: {formatBaht(o.totalAmount)} บ.</p>
                    <p className="text-[11px] text-[#475569]">รหัสธุรกรรม (Order): {o.orderCode}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedReceiptOrder(o);
                      setSelectedReceiptBooking(null);
                    }}
                    className="bg-sky-600 hover:bg-sky-500 text-white font-bold py-1 px-2.5 rounded text-[11px] shadow-xs flex items-center gap-1 shrink-0"
                  >
                    <Receipt className="h-3 w-3" /> ใบเสร็จ
                  </button>
                  {canManageBookings && (
                    <button
                      type="button"
                      disabled={busy} onClick={guarded(() => handleVoidOrder(o))}
                      className="bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-bold py-1 px-2 rounded text-[11px] shrink-0 ml-1"
                    >
                      ✖ ยกเลิกบิล
                    </button>
                  )}
                </div>
              ))}
              {todaysOrders().length === 0 && (
                <p className="text-[11px] text-slate-400 text-center py-6">ยังไม่มีผลงานออเดอร์ F&B วันนี้</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="p-4 bg-amber-50 rounded-xl text-xs flex gap-2 border border-amber-200 text-amber-800">
        <AlertTriangle className="h-5 w-5 text-amber-700 shrink-0" />
        <div>
          <p className="font-bold">นโยบายห้ามแก้ไขรายการเงินสำมะคัญ (Anti-Price Tampering):</p>
          <p className="text-[10px] leading-relaxed mt-1">
            ทุกรายการแก้ไขยอดเงิน สล็อตที่ถูกกด หรือสินค้าตัดสต๊อกจะถูกสลักชื่อแอดมิน คุณกิตติ ลงในแผงบิล Audit Log ถาวร 
            การลบหรือสลับยกเลิก (Cancel) สล็อตและจ่ายคืนเคลม (Refund) จะต้องยื่นให้สิทธิ์ ผู้จัดการ (Manager) หรือ ผู้บริหารระบบ (Admin) ดำเนิการผ่านรหัสล็อคเกอร์พาสเท่านั้น
          </p>
        </div>
      </div>
    </div>
  );
}
