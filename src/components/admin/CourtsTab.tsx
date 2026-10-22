import { CourtType } from '../../types';
import { openSlotHours } from '../../mockData';
import { useAdminPanelContext } from './useAdminPanel';

export default function CourtsTab() {
  const {
    busy,
    canManageCourts,
    courts,
    daysOff,
    guarded,
    handleCreateCourt,
    handleDeleteDayOff,
    handleRenameCourt,
    handleSaveDayOff,
    handleToggleCourtActive,
    newCourtAllowHalf,
    newCourtHalfOf,
    newCourtName,
    newCourtType,
    newDayOffCourtId,
    newDayOffDate,
    newDayOffEndHour,
    newDayOffIsFullDay,
    newDayOffReason,
    newDayOffStartHour,
    setNewCourtAllowHalf,
    setNewCourtHalfOf,
    setNewCourtName,
    setNewCourtType,
    setNewDayOffCourtId,
    setNewDayOffDate,
    setNewDayOffEndHour,
    setNewDayOffIsFullDay,
    setNewDayOffReason,
    setNewDayOffStartHour
  } = useAdminPanelContext();
  return (
    <div className="space-y-6 animate-fade-in text-xs">
      <div>
        <h3 className="text-base font-bold text-slate-900">ระบบบริหารสนามกีฬาและตั้งเกณฑ์วันปิดบริการพิเศษ (Complex Facility & Holiday Manager)</h3>
        <p className="text-xs text-slate-500">คุณสามารถควบคุมสนามแต่ละเลข เพิ่มสนามกีฬาเมื่อขยายธุรกิจ หรือบล็อกระงับวันหยุดพิเศษไม่ให้ลูกค้าจอง</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Creator Forms (Col 4) */}
        <div className="col-span-1 lg:col-span-4 space-y-6">

          {/* 1. Add Court Form (admins) */}
          {canManageCourts && (
          <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200">
            <span className="text-xs font-bold text-slate-800 block mb-4 text-emerald-950">🏟️ เพิ่มรายสนามกีฬาในระบบ</span>

            <form onSubmit={e => { e.preventDefault(); void guarded(handleCreateCourt)(e); }} className="space-y-4 text-xs font-sans">
              <div>
                <label className="block text-slate-700 font-semibold mb-1.5 font-sans">ชื่อหรือเลขที่สนาม:</label>
                <input 
                  type="text"
                  required
                  placeholder="เช่น สนามแบดมินตัน 13"
                  value={newCourtName}
                  onChange={(e) => setNewCourtName(e.target.value)}
                  className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg text-slate-800 text-xs font-sans"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1.5">ประเภทกีฬา:</label>
                  <select 
                    value={newCourtType}
                    onChange={(e) => setNewCourtType(e.target.value as CourtType)}
                    className="w-full bg-white border border-slate-200 py-1.5 px-2 rounded-lg text-xs"
                  >
                    {Object.values(CourtType).map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center pt-5">
                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-700 font-bold text-[11px]">
                    <input 
                      type="checkbox"
                      checked={newCourtAllowHalf}
                      onChange={(e) => setNewCourtAllowHalf(e.target.checked)}
                      className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    เป็นครึ่งสนาม (คิดราคาครึ่งสนาม)
                  </label>
                </div>
              </div>

              {newCourtAllowHalf && (
                <div>
                  <label htmlFor="new-court-half-of" className="block text-slate-700 font-semibold mb-1.5">เป็นครึ่งหนึ่งของสนาม:</label>
                  <select id="new-court-half-of" value={newCourtHalfOf} onChange={e => setNewCourtHalfOf(e.target.value)}
                    className="w-full bg-white border border-slate-200 py-1.5 px-2 rounded-lg text-xs">
                    <option value="">-- เลือกสนามเต็มสนาม --</option>
                    {courts.filter(c => c.type === newCourtType && c.shareOfGroup >= 1).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <p className="text-[10px] text-slate-500 mt-1">จองครึ่งสนามแล้ว สนามเต็มจะจองช่วงนั้นไม่ได้ (และกลับกัน)</p>
                </div>
              )}

              <button 
                type="submit" disabled={busy} 
                className="w-full bg-slate-900 hover:bg-slate-800 py-2.5 rounded text-white font-bold transition text-xs shadow-sm font-sans"
              >
                เพิ่มสนาม
              </button>
            </form>
          </div>
          )}

          {/* 2. Add Special Closed Day / Holiday */}
          <div className="bg-rose-50/50 p-5 rounded-2xl border border-rose-200 text-xs space-y-4 shadow-sm">
            <div>
              <span className="text-xs font-bold text-rose-900 block mb-1">📅 กำหนดวันปิดหยุดบริการพิเศษ</span>
              <p className="text-[10px] text-slate-500 leading-normal">บล็อกช่วงวันไม่ให้ทำรายการจองล่วงหน้าเพื่อปิดบำรุงรักษาคอมเพล็กซ์</p>
            </div>

            <form onSubmit={e => { e.preventDefault(); void guarded(handleSaveDayOff)(e); }} className="space-y-3 font-sans">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">เลือกวันที่ปิดระงับบริการ:</label>
                <input 
                  type="date"
                  required
                  value={newDayOffDate}
                  onChange={(e) => setNewDayOffDate(e.target.value)}
                  className="w-full bg-white border border-slate-200 py-1.5 px-3 rounded-lg text-xs font-bold text-slate-800"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">เป้าหมายสนามที่ปิด:</label>
                <select 
                  value={newDayOffCourtId}
                  onChange={(e) => setNewDayOffCourtId(e.target.value)}
                  className="w-full bg-white border border-slate-200 py-1.5 px-2 rounded-lg text-xs text-slate-800 font-bold"
                >
                  <option value="all">-- ปิดบริการทุกสนาม (บำรุงทั้งคลับ) --</option>
                  {courts.map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">ขอบเขตระยะเวลา:</label>
                <div className="flex gap-4 mb-2 py-0.5">
                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-700 font-medium">
                    <input 
                      type="radio" 
                      name="newDayOffIsFullDay" 
                      checked={newDayOffIsFullDay} 
                      onChange={() => setNewDayOffIsFullDay(true)} 
                    />
                    <span>ปิดเต็มวัน</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-700 font-medium">
                    <input 
                      type="radio" 
                      name="newDayOffIsFullDay" 
                      checked={!newDayOffIsFullDay} 
                      onChange={() => setNewDayOffIsFullDay(false)} 
                    />
                    <span>ระบุช่วงเวลาชั่วโมง</span>
                  </label>
                </div>
              </div>

              {!newDayOffIsFullDay && (
                <div className="grid grid-cols-2 gap-2 bg-rose-100/30 p-2 rounded-lg border border-rose-200/50">
                  <div>
                    <label className="block text-slate-700 font-bold mb-1 text-[10px]">ตั้งแต่ (Start):</label>
                    <select
                      value={newDayOffStartHour}
                      onChange={(e) => setNewDayOffStartHour(Number(e.target.value))}
                      className="w-full bg-white border border-slate-200 py-1 px-1.5 rounded text-xs font-bold text-slate-800"
                    >
                      {openSlotHours().map(t => parseInt(t, 10)).map(h => (
                        <option key={h} value={h}>{String(h).padStart(2, '0')}:00 น.</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-700 font-bold mb-1 text-[10px]">ถึงเวลา (End):</label>
                    <select
                      value={newDayOffEndHour}
                      onChange={(e) => setNewDayOffEndHour(Number(e.target.value))}
                      className="w-full bg-white border border-slate-200 py-1 px-1.5 rounded text-xs font-bold text-slate-800"
                    >
                      {openSlotHours().map(t => parseInt(t, 10) + 1).map(h => (
                        <option key={h} value={h}>{String(h).padStart(2, '0')}:00 น.</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-slate-700 font-semibold mb-1">เหตุผลหรือหมายเหตุ (ขยายหน้าร้าน):</label>
                <input 
                  type="text"
                  required
                  placeholder="เช่น งานบำรุงรักษาพื้นผิวทาสีขาวใหม่"
                  value={newDayOffReason}
                  onChange={(e) => setNewDayOffReason(e.target.value)}
                  className="w-full bg-white border border-slate-200 py-1.5 px-3 rounded-lg text-xs text-slate-800"
                />
              </div>

              <button 
                type="submit" disabled={busy} 
                className="w-full bg-rose-700 hover:bg-rose-800 py-2.5 rounded text-white font-bold transition text-xs shadow-sm font-sans"
              >
                บันทึกวันปิดบริการ
              </button>
            </form>
          </div>

        </div>

        {/* Data Lists Table (Col 8) */}
        <div className="col-span-1 lg:col-span-8 space-y-6">

          {/* A. Active Courts Management */}
          <div className="space-y-3">
            <span className="text-xs font-bold text-slate-700 block">สนามกีฬาและห้องประชุมคอมเพล็กซ์ทั้งหมด ({courts.length} สนาม):</span>
            <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white shadow-sm">
              <table className="w-full text-xs text-left text-slate-500">
                <thead className="text-[10px] text-slate-700 bg-slate-50 border-b border-slate-100 uppercase font-bold">
                  <tr>
                    <th className="px-4 py-3">รหัสสนาม</th>
                    <th className="px-4 py-3">ชื่อเรียกสนามกีฬา</th>
                    <th className="px-4 py-3 font-sans">ประเภท</th>
                    <th className="px-4 py-3 font-sans">เงื่อนไขครึ่งสนาม</th>
                    <th className="px-4 py-3 text-center font-sans">สถานะบริการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-sans">
                  {courts.map((court) => (
                    <tr key={court.id} className="hover:bg-slate-50 transition">
                      <td className="px-4 py-3 font-mono text-[10px] text-slate-400">{court.id}</td>
                      <td className="px-4 py-3 font-bold text-slate-800">
                        <span>{court.name}</span>
                        <button
                          type="button"
                          disabled={!canManageCourts || busy}
                          title={canManageCourts ? 'เปลี่ยนชื่อสนาม' : 'เฉพาะ Admin'}
                          onClick={guarded(() => handleRenameCourt(court.id))}
                          className="ml-2 text-[10px] font-bold text-sky-700 hover:text-sky-900 disabled:text-slate-300"
                        >
                          ✏️ เปลี่ยนชื่อ
                        </button>
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-600">{court.type}</td>
                      <td className="px-4 py-3">
                        {court.shareOfGroup < 1 ? (
                          <span className="bg-emerald-50 text-emerald-700 text-[10px] font-bold px-2 py-0.5 rounded-full">
                            ครึ่งสนาม (ราคาครึ่งสนาม)
                          </span>
                        ) : (
                          <span className="bg-slate-100 text-slate-500 text-[10px] px-2 py-0.5 rounded-full font-sans">
                            เต็มสนามเท่านั้น
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          type="button"
                          disabled={!canManageCourts || busy}
                          title={canManageCourts ? 'กดเพื่อเปิด/ปิดรับจอง' : 'เฉพาะ Admin (ปิดชั่วคราวใช้ "วันปิดบริการ")'}
                          onClick={guarded(() => handleToggleCourtActive(court.id))}
                          className={`px-2.5 py-1 rounded-full text-[10px] font-black transition ${
                            court.isActive 
                              ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200' 
                              : 'bg-rose-100 text-rose-800 hover:bg-rose-200'
                          }`}
                        >
                          {court.isActive ? '● กำลังเปิด' : '○ ปิดระงับบริการ'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* B. Special Closed Days Management */}
          <div className="space-y-3">
            <span className="text-xs font-bold text-slate-700 block">ปฏิทินเวลาหยุด/ระงับจองพิเศษล่วงหน้า ({daysOff.length} รายการ):</span>
            <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white shadow-sm">
              <table className="w-full text-xs text-left text-slate-500 font-sans">
                <thead className="text-[10px] text-slate-700 bg-rose-50 border-b border-rose-100 uppercase font-bold">
                  <tr>
                    <th className="px-4 py-3">วันที่ปิดระงับ</th>
                    <th className="px-4 py-3">สนามกีฬาที่ปิดบล็อก</th>
                    <th className="px-4 py-3">ระวางเวลา</th>
                    <th className="px-4 py-3">เหตุผลในระบบ</th>
                    <th className="px-4 py-3 text-center">ปลดการบล็อกสนาม</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {daysOff.map((day) => {
                    const targetCourt = day.courtId === 'all' ? 'ทุกสนาม (บำรุงทั้งคลับ)' : (courts.find(c => c.id === day.courtId)?.name || 'สนามเฉพาะกิจ');
                    const rangeStr = (day.isFullDay || day.isFullDay === undefined) 
                      ? '🔴 ตลอดทั้งวัน' 
                      : `⏳ ${String(day.startHour).padStart(2, '0')}:00 - ${String(day.endHour).padStart(2, '0')}:00 น.`;
                    return (
                      <tr key={day.id} className="hover:bg-slate-50 transition">
                        <td className="px-4 py-3 font-mono font-bold text-rose-700">{day.date}</td>
                        <td className="px-4 py-3 font-semibold text-slate-800 font-sans">{targetCourt}</td>
                        <td className="px-4 py-3 font-bold text-slate-700">{rangeStr}</td>
                        <td className="px-4 py-3 text-slate-500 italic font-sans font-medium">"{day.reason}"</td>
                        <td className="px-4 py-3 text-center">
                          <button
                            type="button"
                            disabled={busy} onClick={guarded(() => handleDeleteDayOff(day.id))}
                            className="text-emerald-700 hover:text-emerald-950 font-bold text-[10.5px] hover:underline"
                          >
                            🔓 เปิดให้บริการหน้าร้านปกติ
                          </button>
                        </td>
                      </tr>
                    );
                  })}

                  {daysOff.length === 0 && (
                    <tr>
                      <td colSpan={5} className="text-center py-10 text-slate-400 text-[10px]">
                        ยังไม่มีการตั้งวันหยุด/บล็อกระงับจองล่วงหน้าในคอมเพล็กซ์แห่งนี้ 🎉 ทุกวันเปิดตามตารางปกติ
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
