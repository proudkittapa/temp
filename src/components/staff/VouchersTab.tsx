import { useStaffPOSContext } from './useStaffPOS';

export default function VouchersTab() {
  const {
    busy,
    guarded,
    handleDispenseVoucher,
    handleLookupVoucher,
    handleUseFreeHourVoucher,
    setVoucherCode,
    voucherCode,
    voucherError,
    voucherFound
  } = useStaffPOSContext();
  return (
    <div className="max-w-lg space-y-4">
      <div>
        <h3 className="text-base font-bold text-slate-900">🎁 ตรวจรหัสแลกของรางวัล</h3>
        <p className="text-xs text-slate-500">ลูกค้าแสดงรหัส RW-XXXXXX จากหน้าแลกแต้ม ตรวจแล้วกดมอบของรางวัล (ใช้ได้ครั้งเดียว)</p>
      </div>
      <form onSubmit={e => { e.preventDefault(); handleLookupVoucher(); }} className="flex gap-2">
        <input id="voucher-code-input" value={voucherCode} onChange={e => setVoucherCode(e.target.value)} placeholder="RW-123456"
          className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono uppercase" />
        <button type="submit" className="bg-slate-900 text-white font-bold px-4 rounded-lg text-xs">ตรวจรหัส</button>
      </form>
      {voucherError && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">⚠️ {voucherError}</p>}
      {voucherFound && (
        <div id="voucher-result" className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2 text-xs">
          <p className="font-mono font-black text-sm">{voucherFound.code}</p>
          <p><span className="text-slate-500">ของรางวัล:</span> <span className="font-bold">{voucherFound.reward}</span></p>
          <p><span className="text-slate-500">ลูกค้า:</span> {voucherFound.customer}</p>
          <p><span className="text-slate-500">สถานะ:</span> <span className="font-bold">{voucherFound.status === 'ACTIVE' ? '✅ ใช้ได้' : voucherFound.status === 'REDEEMED' ? (voucherFound.freeHour ? '⛔ ใช้จองไปแล้ว' : '⛔ รับไปแล้ว') : '⌛ หมดอายุ'}</span>
            {voucherFound.expires && voucherFound.status === 'ACTIVE' ? ` (ถึง ${voucherFound.expires})` : ''}</p>
          {voucherFound.status === 'ACTIVE' && voucherFound.freeHour && (
            <>
              <button id="voucher-use-free-hour" type="button" onClick={handleUseFreeHourVoucher} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-lg">🏸 ใช้จองชั่วโมงฟรี</button>
              <p className="text-[10px] text-slate-500">เปิดฟอร์ม Walk-in พร้อมรหัสนี้ เลือกสนามและเวลา Off-Peak 1 ชั่วโมง แล้วกดยืนยัน (คูปองถูกใช้เมื่อจองสำเร็จ)</p>
            </>
          )}
          {voucherFound.status === 'ACTIVE' && !voucherFound.freeHour && (
            <button type="button" disabled={busy} onClick={guarded(handleDispenseVoucher)} className="disabled:opacity-50 w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-lg">มอบของรางวัลแล้ว</button>
          )}
        </div>
      )}
    </div>
  );
}
