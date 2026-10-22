import { CourtType } from '../../types';
import { formatBaht, lastBookableDate, getTodayDateStr } from '../../mockData';
import { Calendar, Sparkles } from 'lucide-react';
import { useCustomerPanelContext, COURT_TYPE_LABEL } from './useCustomerPanel';

export default function PickSlotsStep() {
  const {
    SLOT_LABEL,
    apiError,
    cellButton,
    chooseView,
    courts,
    currentPriceDetails,
    getAvailableSlots,
    gridLoading,
    handleCourtTypeChange,
    handleProceedToCheckout,
    loggedInUser,
    onRefreshAll,
    quickDates,
    renderCourtList,
    selectedDate,
    selectedSlots,
    selectedType,
    setSelectedDate,
    setSelectedSlots,
    slotStatus,
    viewMode
  } = useCustomerPanelContext();
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-amber-500" />
            จองสนามกีฬา & วันเวลาที่ท่านต้องการ
          </h2>
          <p className="text-xs text-slate-500">ค่าบริการจะแตกต่างกันไปตามประเภทกีฬาและช่วงเวลา Peak/Off-Peak</p>
        </div>

        {/* Court Types Switcher Tabs */}
        <div id="court-type-tabs" className="flex bg-slate-100 p-1 rounded-xl flex-wrap gap-1">
          {Object.values(CourtType).filter(type => type === selectedType || courts.some(c => c.type === type)).map(type => (
            <button
              key={type}
              type="button"
              onClick={() => handleCourtTypeChange(type)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                selectedType === type 
                  ? 'bg-white text-emerald-800 shadow-sm' 
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {/* Counted from the live court list: admins add and close courts. */}
              {COURT_TYPE_LABEL[type]} ({courts.filter(c => c.type === type).length})
            </button>
          ))}
        </div>
      </div>

      {/* Date Selection Picker - Put first */}
      <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
        <div className="max-w-md">
          <label className="block text-xs font-semibold text-slate-700 mb-2 flex items-center gap-1.5">
            <Calendar className="h-4 w-4 text-emerald-600" />
            ระบุวันที่ต้องการเล่น (กรุณาเลือกเพื่อดึงข้อมูลรอบว่าง):
          </label>
          <input
            id="input-booking-date"
            type="date"
            value={selectedDate}
            min={getTodayDateStr()}
            max={lastBookableDate()}
            onChange={(e) => {
              setSelectedDate(e.target.value);
              setSelectedSlots([]);
            }}
            className="w-full bg-white border border-slate-200 rounded-lg py-2.5 px-3 text-base sm:text-sm text-slate-800 font-bold focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 focus:outline-none"
          />
          <div id="quick-dates" className="flex gap-2 mt-2">
            {quickDates.map(q => (
              <button key={q.iso} type="button"
                onClick={() => { setSelectedDate(q.iso); setSelectedSlots([]); }}
                className={`flex-1 min-h-[40px] rounded-lg border text-sm font-bold ${selectedDate === q.iso ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white border-slate-200 text-slate-700'}`}>
                {q.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* COMPREHENSIVE CUSTOMER COURT BOOKING VISUALIZER MATRIX */}
      {selectedDate && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
            <div className="w-full sm:w-auto flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">🎾 เลือกสนามและเวลา</h3>
                <p className="text-xs text-slate-500 mt-0.5">แตะช่อง "ว่าง" เพื่อเลือก (สูงสุด 3 ชั่วโมงต่อการจอง)</p>
              </div>
              {/* Grid / list toggle (remembered on this device) */}
              <div id="view-toggle" className="flex bg-slate-100 p-1 rounded-lg shrink-0">
                {(['grid', 'list'] as const).map(v => (
                  <button key={v} type="button" onClick={() => chooseView(v)}
                    className={`px-3 min-h-[36px] rounded-md text-sm font-bold ${viewMode === v ? 'bg-white text-emerald-800 shadow-sm' : 'text-slate-600'}`}>
                    {v === 'grid' ? 'ตาราง' : 'รายการ'}
                  </button>
                ))}
              </div>
            </div>

            <div className={`${viewMode === 'grid' ? 'flex' : 'hidden'} flex-wrap items-center gap-2 text-xs font-sans`}>
              <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-rose-500 rounded" /> 🔴 จองแล้ว / เต็ม</span>
              <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-rose-200 rounded" /> ⚠️ ปิดสนาม</span>
              <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-amber-100 rounded" /> 🟡 ว่าง (Peak)</span>
              <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-slate-100 rounded" /> 🟢 ว่าง (Off-Peak / ราคาปกติ)</span>
              <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 bg-emerald-600 rounded" /> ⭐ เลือกแล้ว</span>
            </div>
          </div>

          {/* Anyone can see what's free; picking a slot asks to log in
              (handleToggleSlotInGrid). */}
          <div className="relative">
            {!loggedInUser && (
              <p id="guest-availability-hint" className="mb-2 text-xs bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg px-3 py-2">
                👀 ดูช่วงเวลาว่างได้เลย — <button type="button" className="underline font-bold"
                  onClick={() => document.getElementById('customer-auth-console')?.scrollIntoView({ behavior: 'smooth' })}>เข้าสู่ระบบหรือสมัครสมาชิก</button> เพื่อจองและดูราคาสมาชิก
              </p>
            )}

            {gridLoading && (
              <p id="grid-loading" role="status" className="text-center text-slate-500 py-10 font-bold">
                {apiError
                  ? <>โหลดตารางไม่สำเร็จ <button type="button" onClick={onRefreshAll} className="underline text-emerald-700">ลองใหม่</button></>
                  : 'กำลังโหลดตารางสนาม...'}
              </p>
            )}

            {!gridLoading && viewMode === 'list' && renderCourtList()}

            {/* Grid-based occupancy matrix */}
            {!gridLoading && viewMode === 'grid' && (
            <div className="overflow-x-auto border border-slate-200 rounded-xl bg-slate-50/50">
              <table className="w-full text-left border-collapse min-w-[1100px]">
                <thead>
                  <tr className="bg-slate-100 text-xs uppercase font-black text-slate-500 border-b border-slate-200">
                    <th className="p-3 bg-slate-100 sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] w-36">สนาม (Court Name)</th>
                    {getAvailableSlots().map((slot) => (
                      <th key={slot.start} className="p-2 text-center text-xs min-w-[75px] border-l border-slate-200">
                        {slot.start} น.
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white text-xs">
                  {courts.filter(c => c.type === selectedType).map((court) => (
                    <tr key={court.id} className="hover:bg-slate-50/55 transition-colors">
                      {/* Court Title Left sticky column */}
                      <td className="p-3 font-bold text-[#0f172a] bg-slate-50 sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] border-r border-slate-200">
                        <div className="flex flex-col">
                          <span className="text-[11px] font-black">{court.name}</span>
                          {court.offPeakOnly && (
                            <span className="text-[11px] text-emerald-800 font-bold bg-emerald-50 px-1 py-0.2 rounded w-max mt-0.5">Off-Peak เท่านั้น</span>
                          )}
                        </div>
                      </td>

                      {/* Hourly timeline slot cells */}
                      {getAvailableSlots().map((slot) => {
                        const time = slot.start;
                        const st = slotStatus(court, time, slot.hourNum);
                        const blocked = 'cursor-not-allowed select-none p-1 border-l border-slate-200 text-center min-h-[44px]';
                        switch (st.kind) {
                          case 'booked':
                            return (
                              <td key={time} className={`${blocked} bg-rose-500/10 text-rose-700 font-bold`} title={`จองแล้วโดย${st.mine ? 'ตัวคุณเอง' : 'ลูกค้าท่านอื่น'}`}>
                                <span className="block text-[11px] font-black text-rose-600">🔴 จองแล้ว</span>
                                <span className="text-[11px] opacity-75">{st.pending ? '⏳ รออนุมัติ' : '✓ ชำระแล้ว'}</span>
                              </td>
                            );
                          case 'closed':
                            return (
                              <td key={time} className={`${blocked} bg-rose-100 text-rose-800 font-bold`} title={`ซ่อมบำรุง/ปิดสนาม: ${st.reason}`}>
                                <span className="block text-[11px] font-black text-rose-700">⚠️ ปิดสนาม</span>
                                <span className="text-[11px] block leading-tight truncate max-w-[70px] text-slate-500">{st.reason}</span>
                              </td>
                            );
                          case 'started':
                          case 'peakBlocked':
                          case 'notOpen':
                            return (
                              <td key={time} className={`${blocked} bg-slate-100 text-slate-500`}
                                title={st.kind === 'started' ? 'เลยเวลาจองออนไลน์แล้ว ติดต่อเคาน์เตอร์ได้' : st.kind === 'peakBlocked' ? 'ครึ่งสนามเปิดเฉพาะเวลา Off-Peak' : 'นอกเวลาเปิดให้บริการ'}>
                                <span className="block text-[11px] font-bold">{st.kind === 'started' ? '⌛' : '🚫'} {SLOT_LABEL[st.kind]}</span>
                              </td>
                            );
                          case 'selected':
                            return (
                              <td key={time} {...cellButton(court.id, time, true)}
                                className="p-1 border-l border-slate-200 bg-emerald-600 text-white text-center font-bold cursor-pointer border-l-emerald-700">
                                <span className="block text-[11px] font-black">⭐ เลือกแล้ว</span>
                                <span className="text-xs block">{formatBaht(st.price)}฿</span>
                              </td>
                            );
                          default:
                            return (
                              <td key={time} {...cellButton(court.id, time, false)}
                                className={`p-1 border-l border-slate-200 text-center cursor-pointer transition min-h-[44px] ${
                                  st.isPeak ? 'bg-amber-50 hover:bg-amber-100 text-amber-900' : 'bg-emerald-50/15 hover:bg-emerald-500/10 text-slate-800'
                                }`}>
                                <span className="block text-[11px] font-semibold text-slate-500 leading-none">🟢 ว่าง</span>
                                <span className="text-xs font-black block mt-0.5 text-slate-800">{formatBaht(st.price)}฿</span>
                                <span className="text-[11px] text-slate-500">{st.isPeak ? '⚡ Peak' : st.isOffPeak ? 'Off-Peak' : 'ราคาปกติ'}</span>
                              </td>
                            );
                        }
                      })}
                    </tr>
                  ))}

                  {courts.filter(c => c.type === selectedType).length === 0 && (
                    <tr>
                      <td colSpan={17} className="text-center text-slate-400 py-12 font-bold">
                        ไม่มีข้อมูลสนามของประเภทกีฬา {selectedType} ในระบบเวลานี้
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            )}
          </div>

          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center text-xs text-slate-500 bg-slate-50 p-3 rounded-xl border border-slate-200 gap-2">
            <span className="font-semibold text-emerald-800 flex items-center gap-1">
              💡 คำแนะนำผู้เล่น: เลือกสล็อตที่กล่องสีเขียว/เหลืองเพื่อจอง และสำหรับสนามบาสเกตบอลครึ่งสนาม (B, C) จะอนุญาตให้กดเลือกได้เฉพาะช่วง Off-Peak (เวลานอกช่วงเร่งด่วน) เท่านั้น
            </span>
          </div>
        </div>
      )}

      {/* Selected Summary Info area */}
      {selectedSlots.length > 0 && (
        <div id="checkout-preview-card" className="flex flex-col p-4 bg-emerald-50 rounded-xl border border-emerald-100 gap-4">
          <div className="space-y-2">
            <p className="text-xs font-bold text-slate-700 flex items-center gap-1">
              <Calendar className="h-4 w-4 text-emerald-700" />
              รายการสนามและเวลาที่คุณเลือกเล่น (วันที่ {selectedDate}):
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {selectedSlots.map((s, idx) => {
                const cName = courts.find(c => c.id === s.courtId)?.name || 'สนาม';
                return (
                  <div key={idx} className="bg-white px-3 py-2 rounded-lg border border-emerald-100 flex items-center justify-between text-xs">
                    <div>
                      <p className="font-bold text-slate-800">{cName}</p>
                      <p className="text-xs text-slate-500">เวลา {s.startTime} น.</p>
                    </div>
                    <button 
                      onClick={() => {
                        setSelectedSlots(selectedSlots.filter((_, i) => i !== idx));
                      }}
                      className="text-rose-600 hover:text-rose-800 font-bold p-1 text-[11px]"
                    >
                      ลบ
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex justify-between items-center border-t border-emerald-100 pt-3">
            <div>
              <span className="text-xs text-slate-400 block font-medium">คำนวณราคาเฉลี่ยสมาชิกรวม:</span>
              <span className="text-sm font-extrabold text-emerald-800 font-mono">{formatBaht(currentPriceDetails().total)} บาท</span>
            </div>
            <button
              id="btn-customer-stage-1"
              onClick={handleProceedToCheckout}
              className="bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold py-2 px-4 rounded-lg shadow-sm transition"
            >
              ระบุข้อมูลผู้ติดต่อ & ถัดไป &rarr;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
