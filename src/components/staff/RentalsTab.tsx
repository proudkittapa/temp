import { formatBaht, formatDateTime } from '../../mockData';
import MemberPhoneInput from '../MemberPhoneInput';
import { useStaffPOSContext } from './useStaffPOS';

export default function RentalsTab() {
  const {
    activeRentalOrders,
    busy,
    courts,
    guarded,
    handleRentalRentSubmit,
    handleReturnItem,
    memberPhoneHandlers,
    products,
    rentalCourtId,
    rentalCustomerPhone,
    rentalMember,
    rentalShoeGender,
    rentalVariantId,
    selectedProductId,
    setRentalCourtId,
    setRentalCustomerPhone,
    setRentalMember,
    setRentalShoeGender,
    setRentalVariantId,
    setSelectedProductId
  } = useStaffPOSContext();
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Rent Equipment form */}
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-bold text-slate-900">บันทึกจ่ายปล่อยเช่าแร็กเก็ตและอุปกรณ์กีฬา</h3>
            <p className="text-xs text-slate-500">เลือกอุปกรณ์ ใส่เบอร์สมาชิกถ้ามี แล้วเก็บค่าเช่าเป็นเงินสด (ค่าเช่าไม่ได้แต้ม)</p>
          </div>

          <form onSubmit={e => { e.preventDefault(); void guarded(handleRentalRentSubmit)(e); }} className="space-y-4 text-xs">
            <div>
              <label className="block text-amber-600 font-bold mb-1.5">👤 เบอร์โทรสมาชิก (เว้นได้):</label>
              <MemberPhoneInput
                id="rental-member-phone"
                value={rentalCustomerPhone}
                {...memberPhoneHandlers(rentalMember, setRentalMember, setRentalCustomerPhone, () => {})}
                placeholder="พิมพ์เบอร์หรือชื่อ เช่น 0812345678"
                className="w-full bg-slate-50 border border-slate-200 py-2.5 px-3 rounded-lg text-xs"
              />
            </div>


            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-700 font-semibold mb-1.5">1. เลือกแร็กเกต/อุปกรณ์เช่า:</label>
                <select
                  value={selectedProductId}
                  onChange={(e) => { setSelectedProductId(e.target.value); setRentalVariantId(''); }}
                  className="w-full bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-xs"
                >
                  {products.filter(p => p.isRental).map(p => (
                    <option key={p.id} value={p.id}>{p.name} (เหลือ {p.stock})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1.5">2. ค่าบริการเช่า (บาท):</label>
                <p className="w-full bg-slate-100 border border-slate-200 py-1.5 px-3 rounded-lg font-bold text-xs">
                  {formatBaht(products.find(p => p.id === selectedProductId)?.price ?? 0)} บาท
                  <span className="font-normal text-slate-500"> (ราคาตั้งในหน้า Admin)</span>
                </p>
                {!!products.find(p => p.id === selectedProductId)?.deposit && (() => {
                  const p = products.find(x => x.id === selectedProductId)!;
                  return <p id="rental-deposit" className="mt-1 text-[11px] text-amber-700 font-bold">+ มัดจำ {formatBaht(p.deposit!)} บาท (คืนตอนคืนของ) → เก็บเงินสดรวม {formatBaht(p.price + p.deposit!)} บาท</p>;
                })()}
              </div>
            </div>

            {/* Shoes: pick gender and size; each size has its own stock (FR-5.3) */}
            {!!products.find(p => p.id === selectedProductId)?.variants?.length && (
              <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 space-y-3">
                <p className="font-bold text-indigo-900 text-[11px] flex items-center gap-1">
                  👟 เลือกเบอร์รองเท้า (เพศ ชาย/หญิง):
                </p>
                <div className="grid grid-cols-2 gap-3 text-[11px]">
                  <div>
                    <label className="block text-slate-500 mb-1">เพศ:</label>
                    <div className="flex gap-1">
                      {(['M', 'F'] as const).map(g => (
                        <button
                          key={g}
                          type="button"
                          onClick={() => { setRentalShoeGender(g); setRentalVariantId(''); }}
                          className={`flex-1 py-1 px-2 rounded text-[10px] font-bold transition border ${rentalShoeGender === g ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-slate-200 text-slate-700'}`}
                        >
                          {g === 'M' ? 'ชาย (M)' : 'หญิง (F)'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-slate-500 mb-1">เบอร์ (EU):</label>
                    <select
                      id="rental-shoe-size"
                      value={rentalVariantId}
                      onChange={(e) => setRentalVariantId(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded py-1 px-1.5 text-[11px] text-slate-800 focus:outline-none"
                    >
                      <option value="">-- เลือกเบอร์ --</option>
                      {(products.find(p => p.id === selectedProductId)?.variants || [])
                        .filter(v => v.gender === rentalShoeGender || v.gender === 'U')
                        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
                        .map(v => (
                          <option key={v.id} value={v.id} disabled={v.stock <= 0}>เบอร์ {v.label} (เหลือ {v.stock} คู่)</option>
                        ))}
                    </select>
                  </div>
                </div>
              </div>
            )}

            <div>
              <label className="block text-slate-700 font-semibold mb-1.5">3. จองคอร์ทที่ใช้อ้างอิงเช่า (ระบุได้):</label>
              <select
                value={rentalCourtId}
                onChange={(e) => setRentalCourtId(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-xs"
              >
                <option value="">-- ไม่ระบุคอร์ท --</option>
                {courts.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-bold py-2.5 rounded text-xs transition"
            >
              บันทึกปล่อยเช่าอุปกรณ์กีฬา & ถอนคลังสำรอง
            </button>
          </form>
        </div>

        {/* Active Rental items tracking ledger with Return buttons */}
        <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200 space-y-4">
          <div>
            <span className="text-xs font-bold text-slate-700 block mb-1">รายการอุปกรณ์เล่นรอนำส่งคืนสต๊อก ({activeRentalOrders.reduce((n, o) => n + o.items.filter(it => !it.returnedAt).length, 0)} ชิ้น):</span>
            <span className="text-[10px] text-slate-400 block mb-3">เมื่อผู้เล่นคืนอุปกรณ์ กด "บันทึกคืน" เพื่อนำของกลับเข้าคลัง</span>
          </div>

          <div id="active-rentals" className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
            {activeRentalOrders.flatMap(order => order.items.filter(it => !it.returnedAt).map(item => (
              <div key={item.id} className="bg-white p-3.5 rounded-xl border border-slate-300 flex justify-between items-center text-xs">
                <div>
                  <span className="text-[11px] bg-sky-100 text-sky-800 font-bold px-1.5 rounded uppercase font-mono">{order.orderCode}</span>
                  <p className="font-bold text-slate-800 mt-1">{order.customerName}</p>
                  <p className="text-[10px] text-slate-400">
                    อุปกรณ์: {item.productName || products.find(p => p.id === item.productId)?.name || 'อุปกรณ์เช่า'}
                    {item.shoeSize && ` (เบอร์ ${item.shoeSize} ${item.shoeGender === 'F' ? 'หญิง' : 'ชาย'})`}
                    {` · ตั้งแต่ ${formatDateTime(order.createdAt)}`}
                  </p>
                  {!!order.depositAmount && !order.depositSettledAt && (
                    <p className="text-[10px] text-amber-700 font-bold">มัดจำ {formatBaht(order.depositAmount)} บาท (คืนเมื่อคืนครบ)</p>
                  )}
                </div>

                <button
                  disabled={busy} onClick={guarded(() => handleReturnItem(order.id, item.id))}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1.5 px-3 rounded text-[10px] shadow-sm transition"
                >
                  📬 บันทึกคืน
                </button>
              </div>
            )))}

            {activeRentalOrders.length === 0 && (
              <p className="text-[10px] text-slate-400 text-center py-10">ยังไม่มีผู้เช่าไม้แร็กเก็ตหรือรองเท้ากีฬาออกไปเล่น ณ ขณะนี้</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
