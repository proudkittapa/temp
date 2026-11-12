import { MemberType } from '../../types';
import { calculatePrice, memberTierLabel, formatBaht, formatDate } from '../../mockData';
import { useCustomerPanelContext } from './useCustomerPanel';

// Step 2: check what is about to be booked and confirm. Name and phone come
// from the account and can't be changed here, so they aren't asked again;
// the price is the server's (the payment step shows the amount it set).
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
  const { total, original } = currentPriceDetails();
  const member = loggedInUser?.memberType && loggedInUser.memberType !== MemberType.NORMAL;
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-5 sm:p-6 shadow-sm space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">ตรวจสอบการจอง</h2>
          <p className="text-xs text-slate-500 mt-0.5">วันที่ {formatDate(selectedDate)} · จองในชื่อ {loggedInUser?.name} ({loggedInUser?.phone})</p>
        </div>
        <button type="button" onClick={() => setActiveStep(1)} className="shrink-0 text-slate-500 hover:text-slate-800 text-xs font-semibold min-h-[40px]">
          ← แก้เวลา
        </button>
      </div>

      <form onSubmit={e => { e.preventDefault(); void guarded(handleBookingSubmit)(e); }} className="space-y-5">
        <div id="price-calculations" className="rounded-xl border border-slate-200 divide-y divide-slate-100 text-sm">
          {selectedSlots.map((s, idx) => {
            const court = courts.find(c => c.id === s.courtId);
            const end = `${String(parseInt(s.startTime, 10) + 1).padStart(2, '0')}:00`;
            const detail = calculatePrice(selectedType, selectedDate, s.startTime, loggedInUser?.memberType || MemberType.NORMAL, court);
            const before = calculatePrice(selectedType, selectedDate, s.startTime, MemberType.NORMAL, court).total;
            return (
              <div key={idx} className="flex justify-between gap-3 px-4 py-3">
                <span className="text-slate-700">{court?.name || 'สนาม'} · {s.startTime}-{end} น.</span>
                <span className="font-bold text-slate-800 whitespace-nowrap">
                  {before > detail.total && <span className="text-xs text-slate-400 font-normal line-through mr-1">{formatBaht(before)}</span>}
                  {formatBaht(detail.total)} บาท
                </span>
              </div>
            );
          })}
          <div className="flex justify-between gap-3 px-4 py-3 bg-slate-50 rounded-b-xl">
            <span className="font-bold text-slate-800">
              ยอดชำระ
              {member && original > total && <span className="block text-xs font-normal text-emerald-700">ส่วนลด{memberTierLabel(loggedInUser?.memberType)} -{formatBaht(original - total)} บาท</span>}
            </span>
            <span className="font-extrabold text-emerald-700 text-lg whitespace-nowrap">{formatBaht(total)} บาท</span>
          </div>
        </div>

        <p className="text-xs text-slate-500">กดยืนยันแล้วจะได้ QR พร้อมเพย์สำหรับโอน กรุณาโอนและส่งสลิปภายใน 30 นาที</p>

        <div className="flex gap-3">
          <button type="button" onClick={() => setActiveStep(1)}
            className="bg-slate-100 hover:bg-slate-200 text-sm font-semibold min-h-[48px] px-5 rounded-xl text-slate-700 transition">
            ย้อนกลับ
          </button>
          <button id="btn-customer-booking-confirm" type="submit" disabled={busy}
            className="flex-1 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-bold min-h-[48px] px-6 rounded-xl shadow-sm transition">
            {busy ? 'กำลังจอง...' : 'ยืนยันและชำระเงิน →'}
          </button>
        </div>
      </form>
    </div>
  );
}
