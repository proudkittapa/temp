import { CourtType, MemberType } from '../../types';
import { calculatePrice, memberTierLabel, formatBaht } from '../../mockData';
import { ToggleRight, UserCheck } from 'lucide-react';
import { useCustomerPanelContext } from './useCustomerPanel';

export default function ConfirmStep() {
  const {
    busy,
    courts,
    currentPriceDetails,
    guarded,
    handleBookingSubmit,
    loggedInUser,
    selectedDate,
    selectedSlots,
    selectedType,
    setActiveStep
  } = useCustomerPanelContext();
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900">กรอกข้อมูลผู้จองสนาม</h2>
          <p className="text-xs text-slate-500">กรุณาระบุข้อมูลตามความเป็นจริง เพื่อรับข้อความแจ้งเตือนสำคัญทาง LINE OA</p>
        </div>
        <button 
          onClick={() => setActiveStep(1)} 
          className="text-slate-500 hover:text-slate-800 text-xs font-semibold"
        >
          &larr; ย้อนกลับไปเลือกเวลาใหม่
        </button>
      </div>

      <form onSubmit={e => { e.preventDefault(); void guarded(handleBookingSubmit)(e); }} className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-2">ชื่อผู้ติดต่อหลัก (ดึงข้อมูลอัตโนมัติ)</label>
            <input
              id="input-customer-name"
              type="text"
              disabled
              value={loggedInUser ? loggedInUser.name : ''}
              className="w-full bg-slate-100 border border-slate-200 rounded-lg py-2 px-3 text-xs text-slate-600 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-2">เบอร์โทรศัพท์ประจำตัวผู้เล่น</label>
            <input
              id="input-customer-phone"
              type="tel"
              disabled
              value={loggedInUser ? loggedInUser.phone : ''}
              className="w-full bg-slate-100 border border-slate-200 rounded-lg py-2 px-3 text-xs text-slate-600 focus:outline-none"
            />
          </div>
        </div>

        {/* Read Only Member Type Display (Injected via LoggedInUser Profile) */}
        <div className="bg-emerald-50/50 p-4 rounded-xl border border-emerald-100 space-y-3">
          <p className="text-xs font-bold text-emerald-900 flex items-center gap-1.5">
            <UserCheck className="h-4 w-4 text-emerald-700" />
            สิทธิ์ผู้จอง & อัตราส่วนลดของคุณ (ล็อกสิทธิ์ผ่านระบบตรวจสอบบัญชีหลักเพื่อความปลอดภัย)
          </p>

          <div className="bg-white border border-emerald-200 rounded-lg p-3 text-xs space-y-1">
            <div className="flex justify-between items-center font-bold">
              <span className="text-slate-700">สิทธิ์ส่วนลดปัจจุบัน:</span>
              <span className="text-emerald-700 text-sm">
                {memberTierLabel(loggedInUser?.memberType)}
                {loggedInUser?.memberType === MemberType.CORPORATE && loggedInUser.orgName ? ` [${loggedInUser.orgName}]` : ''}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-2 leading-normal">
              * ลูกค้าไม่สามารถกดแก้ไขประเภทส่วนลดด้วยตนเองได้ในหน้านี้ เพื่อป้องกันการแอบอ้างสิทธิ์ของ พนง. ลูกค้าสามารถเปลี่ยนสลับบทบาทหรือติดต่อฝ่ายเคาน์เตอร์แคชเชียร์สตาฟเพื่ออัปเกรดสถานะบัตรของท่านได้ ตลอด 24 ชม.
            </p>
          </div>
        </div>

        {/* Half-court is chosen by picking court B or C, not by a toggle:
            the price follows the court, as on the server. */}
        {selectedType === CourtType.BASKETBALL && (
          <div className="bg-amber-50 p-4 rounded-xl border border-amber-100 space-y-1">
            <p className="text-xs font-bold text-amber-900 flex items-center gap-1.5">
              <ToggleRight className="h-5 w-5 text-amber-700" />
              เช่าแบบครึ่งสนาม (สำหรับสตรีทบาสเกตบอล 3x3)
            </p>
            <p className="text-xs text-amber-700">เลือกสนาม B หรือ C ในตารางเพื่อเช่าครึ่งสนาม ราคาครึ่งหนึ่งของเต็มสนาม เปิดจองเฉพาะช่วง Off-Peak</p>
          </div>
        )}

        {/* Price Breakdown Calculation */}
        <div className="border-t border-slate-100 pt-5 space-y-3">
          <h3 className="text-xs font-bold text-slate-800">สรุปรายละเอียดและค่าบริการ (Server-Side Calculation):</h3>

          <div id="price-calculations" className="p-4 bg-slate-50 rounded-xl space-y-2 border border-slate-100 text-xs">
            <div className="space-y-2 bg-white p-3.5 rounded-xl border border-slate-200/50 mb-3">
              <p className="font-bold text-slate-800 text-[11px]">รายการสล็อตเวลาที่ทำจอง ({selectedSlots.length} สล็อต):</p>
              {selectedSlots.map((s, idx) => {
                const cName = courts.find(c => c.id === s.courtId)?.name || 'สนาม';
                // The account's tier, as the server prices it (the
                // memberType field is only the editable form copy).
                const court = courts.find(c => c.id === s.courtId);
                const detail = calculatePrice(selectedType, selectedDate, s.startTime, loggedInUser?.memberType || MemberType.NORMAL, court);
                const before = calculatePrice(selectedType, selectedDate, s.startTime, MemberType.NORMAL, court).total;
                return (
                  <div key={idx} className="flex justify-between text-slate-600 border-b border-slate-100 pb-1.5 last:border-0 last:pb-0 font-medium font-sans">
                    <span>{idx + 1}. {cName} - เวลา {s.startTime} น.</span>
                    <span className="font-bold text-slate-800">{formatBaht(detail.total)} บาท {before > detail.total && <span className="text-xs text-slate-400 font-normal line-through">({formatBaht(before)}.-)</span>}</span>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-between">
              <span className="text-slate-500">ราคาก่อนส่วนลดสมาชิก:</span>
              <span className="font-bold text-slate-700">{formatBaht(currentPriceDetails().original)} บาท</span>
            </div>

            <div className="h-px bg-slate-200 my-2" />

            <div className="flex justify-between text-sm">
              <span className="font-bold text-slate-800">ยอดรวมทั้งสิ้นที่ต้องชำระ (100% Upfront):</span>
              <span className="font-extrabold text-emerald-700 text-base">{formatBaht(currentPriceDetails().total)} บาท</span>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => setActiveStep(1)}
            className="bg-slate-100 hover:bg-slate-200 text-xs font-semibold py-2.5 px-5 rounded-lg text-slate-700 transition"
          >
            ย้อนกลับ
          </button>
          <button
            id="btn-customer-booking-confirm"
            type="submit"
            disabled={busy}
            className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-bold py-2.5 px-6 rounded-lg shadow-sm transition"
          >
            {busy ? 'กำลังจอง...' : <>ยืนยันการจอง และสลับรับ QR Code &rarr;</>}
          </button>
        </div>
      </form>
    </div>
  );
}
