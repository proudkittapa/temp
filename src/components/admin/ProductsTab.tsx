import { ProductCat } from '../../types';
import { formatBaht } from '../../mockData';
import { FileDown } from 'lucide-react';
import { useAdminPanelContext } from './useAdminPanel';

export default function ProductsTab() {
  const {
    busy,
    guarded,
    handleCreateProduct,
    handleDownloadTemplate,
    handleExcelUpload,
    handleSetDeposit,
    handleUpdateStockValue,
    newProductCat,
    newProductDeposit,
    newProductIsRental,
    newProductName,
    newProductPrice,
    newProductStock,
    products,
    setNewProductCat,
    setNewProductDeposit,
    setNewProductIsRental,
    setNewProductName,
    setNewProductPrice,
    setNewProductStock,
    setStockVariantSel,
    stockVariantSel
  } = useAdminPanelContext();
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-base font-bold text-slate-900">คุมสต๊อกตู้เย็น F&B และอุปกรณ์สนาม (Stock Inventory System)</h3>
          <p className="text-xs text-slate-500">จัดการราคาสินค้าน้ำ และจำลองสต๊อกขวดแบ่งขาย สรรหาสตาฟตรวจสอบเวลาเบิกปิดยอด</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Product creator & Excel (Col-4) */}
        <div className="col-span-1 lg:col-span-4 space-y-4">
          <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200">
            <span className="text-xs font-bold text-slate-800 block mb-4 text-sky-900">🥤 เพิ่มรายการสินค้าในตู้ POS</span>

            <form onSubmit={e => { e.preventDefault(); void guarded(handleCreateProduct)(e); }} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-700 font-semibold mb-1.5">ชื่อผลิตภัณฑ์:</label>
                <input 
                  type="text"
                  required
                  placeholder="เช่น น้ำแร่ธรรมชาติ 1.5L, ยาริสเบียร์"
                  value={newProductName}
                  onChange={(e) => setNewProductName(e.target.value)}
                  className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1.5">ประเภท:</label>
                  <select 
                    value={newProductCat}
                    onChange={(e) => setNewProductCat(e.target.value as ProductCat)}
                    className="w-full bg-white border border-slate-200 py-1.5 px-3 rounded-lg"
                  >
                    <option value={ProductCat.FB}>F&B ทานตู้เย็น</option>
                    <option value={ProductCat.EQUIPMENT}>เช่าอุปกรณ์เล่น</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1.5">ราคาขาย/ชม (บ.):</label>
                  <input 
                    type="number"
                    min={1} required
                    value={newProductPrice}
                    onChange={(e) => setNewProductPrice(Number(e.target.value))}
                    className="w-full bg-white border border-slate-200 py-1 px-3 rounded-lg font-bold text-slate-800"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1.5">ยอดเปิดคลังครั้งแรก:</label>
                <input 
                  type="number"
                  min={0}
                  value={newProductStock}
                  onChange={(e) => setNewProductStock(Number(e.target.value))}
                  className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg"
                />
              </div>

              {newProductCat === ProductCat.EQUIPMENT && (
                <label className="flex items-center gap-2 text-slate-700">
                  <input type="checkbox" checked={newProductIsRental} onChange={e => setNewProductIsRental(e.target.checked)} />
                  ให้เช่า (คืนเข้าคลังหลังใช้) — ไม่ติ๊ก = ขายขาด เช่น ลูกแบด
                </label>
              )}
              {newProductCat === ProductCat.EQUIPMENT && newProductIsRental && (
                <label className="block text-slate-700">มัดจำต่อชิ้น (บาท, 0 = ไม่เก็บ)
                  <input type="number" min={0} max={100000} value={newProductDeposit} onChange={e => setNewProductDeposit(Number(e.target.value))}
                    className="mt-1 w-full bg-white border border-slate-200 py-2 px-3 rounded-lg" />
                </label>
              )}

              <button 
                type="submit" disabled={busy} 
                className="w-full bg-slate-900 hover:bg-slate-800 py-2 rounded text-white font-bold transition"
              >
                แอดนำเข้าแคตตาล็อกสินค้า
              </button>
            </form>
          </div>

          {/* Excel Importer Card */}
          <div className="bg-emerald-50/50 p-5 rounded-2xl border border-emerald-200 text-xs space-y-4 shadow-sm">
            <div>
              <span className="text-xs font-bold text-emerald-800 block mb-1">📊 นำเข้ารายการสินค้าด่วนด้วย Excel</span>
              <p className="text-[10px] text-slate-500 leading-normal">คุณสามารถอัปโหลดไฟล์สเปรดชีต Excel (.xlsx, .xls) เพื่อดาวน์โหลดหรือตั้งแคตตาล็อกหลายรายการได้ทีเดียว</p>
            </div>

            <div className="space-y-2.5">
              <button
                type="button"
                onClick={handleDownloadTemplate}
                className="w-full bg-white hover:bg-slate-100 text-slate-700 font-bold border border-slate-200 py-2 rounded text-[11px] transition flex items-center justify-center gap-1.5 shadow-sm"
              >
                <FileDown className="h-4 w-4 text-emerald-600" /> โหลดเทมเพลตสเปรดชีต Excel (.xlsx)
              </button>

              <div className="bg-white p-3 rounded-lg border border-slate-200 space-y-2">
                <label className="block text-[10px] text-slate-600 font-bold">เลือกไฟล์เทมเพลตที่กรอกข้อมูลแล้ว:</label>
                <input
                  type="file"
                  id="excel-file-upload-input"
                  accept=".xlsx, .xls"
                  onChange={handleExcelUpload}
                  className="w-full text-[10.5px] cursor-pointer"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Product Inventory tracker table */}
        <div className="col-span-1 lg:col-span-8 space-y-4">
          <span className="text-xs font-bold text-slate-700 block">สต๊อกรายการเครื่องดื่ม/บริการสนามปัจจุบัน (Realtime Stock Ledger):</span>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {products.map((p) => (
              <div key={p.id} className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-center justify-between text-xs hover:border-slate-300 transition">
                <div>
                  <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${p.isRental ? 'bg-[#93c5fd] text-sky-950' : 'bg-amber-100 text-amber-800'}`}>
                    {p.isRental ? 'ปล่อยเช่าเก็บคืน' : 'กระปุกแบ่งขายขาด'}
                  </span>
                  <p className="font-bold text-slate-800 mt-1">{p.name || 'สินค้า'}</p>
                  <p className="text-[10px] text-slate-500">มูลค่าต่อหน่วย: <span className="font-bold text-slate-700">{formatBaht(p.price)} บาท</span>{!p.isActive && <span className="ml-1 text-rose-600 font-bold">(ปิดขาย)</span>}</p>
                  {p.isRental && (
                    <p className="text-[10px] text-slate-500">มัดจำ: <span className="font-bold text-slate-700">{p.deposit ? `${formatBaht(p.deposit)} บาท` : 'ไม่เก็บ'}</span>
                      <button type="button" disabled={busy} onClick={guarded(() => handleSetDeposit(p))} className="ml-2 text-sky-700 underline disabled:opacity-50">ตั้งมัดจำ</button></p>
                  )}
                </div>

                {/* Stock adjustments levers */}
                <div className="flex flex-col items-end gap-1.5">
                  <span className={`text-xs font-black font-mono ${p.stock > 10 ? 'text-emerald-700' : 'text-rose-600 bg-rose-50 px-2 py-0.5 rounded'}`}>
                    คลังเหลือ: {p.stock} ชิ้น
                  </span>
                  {!!p.variants?.length && (
                    <select
                      value={stockVariantSel[p.id] || ''}
                      onChange={e => setStockVariantSel(sel => ({ ...sel, [p.id]: e.target.value }))}
                      className="text-[10px] border border-slate-300 rounded px-1 py-0.5 bg-white"
                    >
                      <option value="">เลือกเบอร์</option>
                      {p.variants.map(v => (
                        <option key={v.id} value={v.id}>{v.label}{v.gender ? ` ${v.gender}` : ''} (เหลือ {v.stock})</option>
                      ))}
                    </select>
                  )}

                  <div className="flex gap-1">
                    <button 
                      disabled={busy} onClick={guarded(() => handleUpdateStockValue(p.id, -5))} 
                      className="bg-slate-200 h-6 w-9 rounded bg-slate-200 border border-slate-300 hover:bg-slate-200 text-[10px] font-bold text-slate-800 text-center"
                    >
                      -5
                    </button>
                    <button 
                      disabled={busy} onClick={guarded(() => handleUpdateStockValue(p.id, 10))} 
                      className="h-6 w-9 rounded bg-[#dcfce7] border border-emerald-300 hover:bg-emerald-100 text-[10px] font-bold text-emerald-800 text-center"
                    >
                      +10
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
