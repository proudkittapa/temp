import {
  PaymentMethod, ProductCat
} from '../../types';
import { formatBaht, formatDate } from '../../mockData';
import MemberPhoneInput from '../MemberPhoneInput';
import { ShoppingCart, Plus, Minus } from 'lucide-react';
import { useStaffPOSContext } from './useStaffPOS';

export default function ShopTab() {
  const {
    busy,
    cartCourtId,
    cartCustomerName,
    cartCustomerPhone,
    cartItems,
    cartMember,
    cartPayMethod,
    cartSuccessAlert,
    courts,
    guarded,
    handleAddToCart,
    handleCartCheckout,
    handleUpdateCartQty,
    memberPhoneHandlers,
    products,
    setCartCourtId,
    setCartCustomerName,
    setCartCustomerPhone,
    setCartMember,
    setCartPayMethod,
    setCartSuccessAlert
  } = useStaffPOSContext();
  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-6">

      {/* Products Selector Grid (Left-Side) */}
      <div className="col-span-1 md:col-span-7 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-slate-700 block">อาหาร เครื่องดื่ม และอุปกรณ์ (ขายขาด):</span>
          <span className="text-[10px] text-slate-400 font-medium">กดเลือกอาหาร/เครื่องดื่มเพื่อเพิ่มลงในตะกร้า</span>
        </div>

        {cartSuccessAlert && (
          <div className="bg-emerald-50 text-emerald-800 text-xs p-3.5 rounded-xl border border-emerald-200 flex justify-between">
            <span>{cartSuccessAlert}</span>
            <button onClick={() => setCartSuccessAlert(null)} className="font-bold underline text-[10px]">ตกลง</button>
          </div>
        )}

        <div id="products-pos-grid" className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {products.filter(p => p.isActive && !p.isRental).map((prod) => (
            <div 
              key={prod.id} 
              onClick={() => handleAddToCart(prod)}
              className="bg-slate-50 border border-slate-200 hover:border-slate-300 hover:bg-slate-100/50 p-3.5 rounded-xl text-left flex flex-col justify-between cursor-pointer transition select-none h-32"
            >
              <div className="space-y-1">
                <span className={`inline-block text-[8px] font-bold px-1.5 py-0.5 rounded ${prod.category === ProductCat.EQUIPMENT ? 'bg-sky-100 text-sky-800' : 'bg-amber-100 text-amber-800'}`}>
                  {prod.category === ProductCat.EQUIPMENT ? 'อุปกรณ์กีฬา' : 'อาหารและเครื่องดื่ม'}
                </span>
                <p className="font-bold text-slate-800 text-xs line-clamp-2 leading-snug">{prod.name}</p>
              </div>

              <div className="flex justify-between items-center border-t border-slate-200/50 pt-2">
                <p className="font-extrabold text-slate-900 text-xs">{formatBaht(prod.price)} บาท</p>
                <p className={`text-[9.5px] font-semibold ${prod.stock > 10 ? 'text-slate-500' : 'text-rose-600 font-bold'}`}>
                  คลัง: {prod.stock}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Billing Cart Receipt Workspace Sidebar */}
      <div className="col-span-1 md:col-span-5 md:sticky md:top-4 md:self-start bg-slate-900 text-white rounded-2xl p-5 flex flex-col justify-between border border-slate-800 shadow-md">
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <span className="text-xs font-bold flex items-center gap-1"><ShoppingCart className="h-4 w-4 text-emerald-400" /> ตะกร้าใบเสร็จรับเงิน F&B</span>
            <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full">วันที่: {formatDate(Date.now())}</span>
          </div>

          {/* Cart Loop */}
          <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
            {cartItems.map((item) => (
              <div key={item.product.id} className="bg-slate-800/80 p-3 rounded-lg flex items-center justify-between text-xs border border-slate-700/50">
                <div>
                  <p className="font-bold text-slate-100">{item.product.name}</p>
                  <p className="text-[9.5px] text-slate-400">{formatBaht(item.product.price)} บาท / หน่วย</p>
                </div>

                {/* Qty edit actions */}
                <div className="flex items-center gap-3">
                  <button 
                    onClick={() => handleUpdateCartQty(item.product.id, -1)}
                    className="h-5 w-5 rounded bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white"
                  >
                    <Minus className="h-3 w-3" />
                  </button>
                  <span className="font-bold font-mono w-4 text-center text-slate-200">{item.qty}</span>
                  <button 
                    onClick={() => handleUpdateCartQty(item.product.id, 1)}
                    className="h-5 w-5 rounded bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}

            {cartItems.length === 0 && (
              <p className="text-xs text-slate-500 text-center py-10 font-medium">ตะกร้าว่างเปล่า กดเลือกสินค้าเพื่อเปิดบิลคีย์!</p>
            )}
          </div>

          {/* Bill client credentials */}
          {cartItems.length > 0 && (
            <div className="space-y-3 pt-3 border-t border-slate-800 text-xs">
              <div>
                <label className="block text-[10px] text-amber-400 font-bold mb-1">👤 เบอร์โทรสมาชิก (เว้นได้ — ผูกบิลกับสมาชิก ไม่ได้แต้ม):</label>
                <MemberPhoneInput
                  id="cart-member-phone"
                  dark
                  value={cartCustomerPhone}
                  {...memberPhoneHandlers(cartMember, setCartMember, setCartCustomerPhone, setCartCustomerName)}
                  placeholder="พิมพ์เบอร์หรือชื่อ เช่น 0812345678"
                  className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-xs text-white"
                />
              </div>

              <div>
                <label className="block text-[10px] text-slate-400 mb-1">ระบุชื่อลูกค้า (สำหรับอ้างอิงส่งออเดอร์):</label>
                <input 
                  type="text" 
                  value={cartCustomerName}
                  onChange={(e) => setCartCustomerName(e.target.value)}
                  placeholder="เช่น โต๊ะแบดสนาม 3, พี่แดงซอย 5"
                  readOnly={!!cartMember}
                  title={cartMember ? 'ชื่อจากข้อมูลสมาชิก (แก้ไม่ได้)' : undefined}
                  className={`w-full bg-slate-800 border border-slate-700 rounded p-2 text-xs text-white${cartMember ? ' opacity-70 cursor-not-allowed' : ''}`}
                />
              </div>

              <div>
                <label className="block text-[10px] text-slate-400 mb-1">อ้างอิงเลขสนามที่มาซื้อ (เว้นได้):</label>
                <select 
                  value={cartCourtId} 
                  onChange={(e) => setCartCourtId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-xs text-white"
                >
                  <option value="">-- ไม่เชื่อมสนาม --</option>
                  {courts.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] text-slate-400 mb-1.5">เลือกรูปแบบการชำระเงิน F&B:</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setCartPayMethod(PaymentMethod.CASH)}
                    className={`p-2 rounded text-[11px] font-bold text-center transition ${
                      cartPayMethod === PaymentMethod.CASH 
                        ? 'bg-emerald-600 text-white' 
                        : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    💵 เงินสด
                  </button>
                  <button
                    type="button"
                    onClick={() => setCartPayMethod(PaymentMethod.PROMPTPAY)}
                    className={`p-2 rounded text-[11px] font-bold text-center transition ${
                      cartPayMethod === PaymentMethod.PROMPTPAY 
                        ? 'bg-emerald-600 text-white' 
                        : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    📲 โอน/พร้อมเพย์
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Submit Checkout button */}
        {cartItems.length > 0 && (
          <div className="pt-4 border-t border-slate-800 mt-4 space-y-3">
            <div className="flex justify-between items-center text-xs">
              <span className="text-slate-400 font-medium">รวมราคาสุทธิใบเสร็จ:</span>
              <span className="font-extrabold text-emerald-400 text-lg">
                {formatBaht(cartItems.reduce((acc, c) => acc + (c.product.price * c.qty), 0))} บาท
              </span>
            </div>

            <button
              disabled={busy} onClick={guarded(handleCartCheckout)}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded text-xs transition"
            >
              ยืนยันการรับเงินสด/โอน และตัดตู้สต๊อกคลัง
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
