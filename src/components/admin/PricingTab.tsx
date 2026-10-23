import { CourtType, DayType, PriceType } from '../../types';
import { formatBaht } from '../../mockData';
import { useAdminPanelContext, SettingChevron } from './useAdminPanel';

export default function PricingTab() {
  const {
    business,
    busy,
    closeHourSetting,
    editingRuleId,
    filterCourtType,
    filterDayType,
    filterLabel,
    filterPriceType,
    filteredPricingRules,
    guarded,
    handleDeletePricingRule,
    handleSaveBusiness,
    handleSaveMaxAdvanceDays,
    handleSaveOpeningHours,
    handleSavePricingRule,
    maxAdvanceDays,
    openHourSetting,
    ruleCourtType,
    ruleDayType,
    ruleEndHour,
    ruleLabel,
    rulePrice,
    rulePriceType,
    ruleStartHour,
    setBusiness,
    setCloseHourSetting,
    setEditingRuleId,
    setFilterCourtType,
    setFilterDayType,
    setFilterLabel,
    setFilterPriceType,
    setMaxAdvanceDays,
    setOpenHourSetting,
    setRuleCourtType,
    setRuleDayType,
    setRuleEndHour,
    setRuleLabel,
    setRulePrice,
    setRulePriceType,
    setRuleStartHour
  } = useAdminPanelContext();
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-bold text-slate-900">ตัวเครื่องมือตั้งและปรับราคาล่วงหน้า (Pricing Engine Configurator)</h3>
        <div id="max-advance-days-setting" className="mt-2 flex flex-wrap items-center gap-2 text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 w-fit">
          <span className="text-slate-600">ลูกค้าจองออนไลน์ล่วงหน้าได้</span>
          <input type="number" min={1} max={365} value={maxAdvanceDays} onChange={e => setMaxAdvanceDays(Number(e.target.value))}
            className="w-20 border border-slate-300 rounded px-2 py-1" />
          <span className="text-slate-600">วัน (พนักงานจองที่เคาน์เตอร์ได้ไม่จำกัด)</span>
          <button type="button" disabled={busy} onClick={guarded(handleSaveMaxAdvanceDays)} className="disabled:opacity-50 bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-3 py-1 rounded">บันทึก</button>
        </div>
        <div id="opening-hours-setting" className="mt-2 flex flex-wrap items-center gap-2 text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 w-fit">
          <span className="text-slate-600">เวลาเปิดให้จอง</span>
          <select value={openHourSetting} onChange={e => setOpenHourSetting(Number(e.target.value))} className="border border-slate-300 rounded px-2 py-1">
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
          </select>
          <span className="text-slate-600">ถึง</span>
          <select value={closeHourSetting} onChange={e => setCloseHourSetting(Number(e.target.value))} className="border border-slate-300 rounded px-2 py-1">
            {Array.from({ length: 24 }, (_, i) => i + 1).map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
          </select>
          <button type="button" disabled={busy} onClick={guarded(handleSaveOpeningHours)} className="disabled:opacity-50 bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-3 py-1 rounded">บันทึก</button>
          <span className="text-[10px] text-slate-500 w-full">ในช่วงนี้ ชั่วโมงที่มีกฎราคาเท่านั้นที่จองได้ (เช่น ไม่มีเรท 06:00 = กีฬานั้นยังไม่เปิด 06:00)</span>
        </div>
        <div id="business-setting" className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 max-w-2xl">
          <span className="text-slate-600 font-bold sm:col-span-2">ข้อมูลร้าน (พิมพ์บนใบเสร็จ และแสดงเป็นชื่อบัญชีผู้รับตอนลูกค้าโอน)</span>
          <label className="flex flex-col gap-1"><span className="text-slate-600">ชื่อร้าน / ชื่อบัญชีรับเงิน</span>
            <input maxLength={200} value={business.name} onChange={e => setBusiness({ ...business, name: e.target.value })} className="border border-slate-300 rounded px-2 py-1" /></label>
          <label className="flex flex-col gap-1"><span className="text-slate-600">เบอร์โทร</span>
            <input maxLength={50} value={business.phone} onChange={e => setBusiness({ ...business, phone: e.target.value })} className="border border-slate-300 rounded px-2 py-1" /></label>
          <label className="flex flex-col gap-1 sm:col-span-2"><span className="text-slate-600">ที่อยู่</span>
            <input maxLength={500} value={business.address} onChange={e => setBusiness({ ...business, address: e.target.value })} className="border border-slate-300 rounded px-2 py-1" /></label>
          <label className="flex flex-col gap-1"><span className="text-slate-600">เลขประจำตัวผู้เสียภาษี (13 หลัก)</span>
            <input inputMode="numeric" maxLength={17} value={business.taxId} onChange={e => setBusiness({ ...business, taxId: e.target.value })} className="border border-slate-300 rounded px-2 py-1" /></label>
          <label className="flex items-center gap-2 self-end pb-1"><input type="checkbox" checked={business.vatRegistered} onChange={e => setBusiness({ ...business, vatRegistered: e.target.checked })} />
            <span className="text-slate-600">จดทะเบียน VAT (ใบเสร็จแสดงภาษี 7%)</span></label>
          <div className="sm:col-span-2"><button type="button" disabled={busy} onClick={guarded(handleSaveBusiness)} className="disabled:opacity-50 bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-3 py-1 rounded">บันทึกข้อมูลร้าน</button></div>
        </div>
        <p className="text-xs text-slate-500">คุณสามารถกำหนดค่า ราคาปกติ, ราคา Peak ยิ่งเร่งด่วนตามเงื่อนไขช่วงชั่วโมง, และชนิดวันธรรมดา/เสาร์อาทิตย์</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* Rule Creator form (Left side) */}
        <div className="col-span-1 lg:col-span-4 bg-slate-50 p-5 rounded-2xl border border-slate-200">
          <p className="text-xs font-bold text-slate-800 flex items-center gap-1.5 mb-4 text-emerald-800">
            <SettingChevron className="h-4 w-4 shrink-0" />
            {editingRuleId ? '🔧 แก้ไขสูตรกฎการตั้งราคา' : '➕ เพิ่มมิติสูตรกฎการตั้งราคา'}
          </p>

          <form onSubmit={e => { e.preventDefault(); void guarded(handleSavePricingRule)(e); }} className="space-y-4 text-xs">
            <div>
              <label className="block text-slate-700 font-semibold mb-1.5">1. ชนิดของกีฬาหน้าสนาม</label>
              <select 
                value={ruleCourtType}
                onChange={(e) => setRuleCourtType(e.target.value as CourtType)}
                className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg"
              >
                {Object.values(CourtType).map(v => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-700 font-semibold mb-1.5">2. มิติชนิดวันในสัปดาห์</label>
                <select 
                  value={ruleDayType}
                  onChange={(e) => setRuleDayType(e.target.value as DayType)}
                  className="w-full bg-white border border-slate-200 py-1.5 px-3 rounded-lg"
                >
                  {Object.values(DayType).map(v => (
                    <option key={v} value={v}>{v === DayType.WEEKDAY ? 'วันธรรมดา' : 'เสาร์ - อาทิตย์'}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1.5">3. มิติระดับสิทธิ์เร่งด่วน</label>
                <select 
                  value={rulePriceType}
                  onChange={(e) => setRulePriceType(e.target.value as PriceType)}
                  className="w-full bg-white border border-slate-200 py-1.5 px-3 rounded-lg"
                >
                  {Object.values(PriceType).map(v => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-700 font-semibold mb-1.5">4. ช่วงชั่วโมงเวลา เริ่ม (0-23)</label>
                <input 
                  type="number"
                  min={0} max={23}
                  value={ruleStartHour}
                  onChange={(e) => setRuleStartHour(Number(e.target.value))}
                  className="w-full bg-white border border-slate-200 py-1.5 px-3 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-slate-700 font-semibold mb-1.5">5. ชั่วโมง สิ้นสุด (1-24)</label>
                <input 
                  type="number"
                  min={1} max={24}
                  value={ruleEndHour}
                  onChange={(e) => setRuleEndHour(Number(e.target.value))}
                  className="w-full bg-white border border-slate-200 py-1.5 px-3 rounded-lg"
                />
              </div>
            </div>

            <div>
              <label className="block text-slate-700 font-semibold mb-1.5">6. ป้ายชื่อแสดงหน้าร้าน (Label):</label>
              <input 
                type="text"
                required
                placeholder="เช่น แบดมินตัน พีคเย็นจันทร์ถึงศุกร์"
                value={ruleLabel}
                onChange={(e) => setRuleLabel(e.target.value)}
                className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-slate-700 font-semibold mb-1.5">7. ค่าบริการ (บาท ต่อชั่วโมงการเล่น):</label>
              <input 
                type="number"
                required min={0}
                value={rulePrice}
                onChange={(e) => setRulePrice(Number(e.target.value))}
                className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg font-bold text-slate-800"
              />
            </div>

            <div className="flex gap-2">
              <button
                type="submit" disabled={busy}
                className="flex-1 bg-emerald-700 hover:bg-emerald-600 font-bold py-2 rounded text-white text-xs transition"
              >
                {editingRuleId ? 'ปรับสูตรประเมิน' : 'สลักสิทธิ์กฎใหม่'}
              </button>
              {editingRuleId && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingRuleId(null);
                    setRuleLabel('');
                    setRulePrice(200);
                  }}
                  className="bg-slate-300 py-2 px-3 text-slate-700 rounded hover:bg-slate-400"
                >
                  ยกเลิก
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Rules interactive table (Right side) */}
        <div className="col-span-1 lg:col-span-8 space-y-4">
          <div className="flex justify-between items-center">
            <span className="text-xs font-bold text-slate-700 block">ตารางเกณฑ์คำนวณราคาปัจจุบันทั้งหมด (Active Engine Table):</span>
            {(filterCourtType || filterDayType || filterPriceType || filterLabel) && (
              <button 
                type="button"
                onClick={() => {
                  setFilterCourtType('');
                  setFilterDayType('');
                  setFilterPriceType('');
                  setFilterLabel('');
                }} 
                className="text-[10px] text-emerald-700 font-bold hover:underline transition"
              >
                ล้างตัวกรองทั้งหมด [Reset]
              </button>
            )}
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-xs text-left text-slate-500">
              <thead className="text-[10px] text-slate-700 bg-slate-50 border-b border-slate-100 uppercase font-bold">
                <tr>
                  <th className="px-4 py-3">ประเภทกีฬา</th>
                  <th className="px-4 py-3">ช่วงชั่วโมง</th>
                  <th className="px-4 py-3">วัน</th>
                  <th className="px-4 py-3">ประเภทราคา</th>
                  <th className="px-4 py-3 text-right">ค่าเช่า / ชม.</th>
                  <th className="px-4 py-3 text-center">จัดการคำสั่ง</th>
                </tr>
                {/* Search & Filter Controls per Column Row */}
                <tr className="bg-slate-100/60 border-b border-slate-200">
                  <th className="p-2">
                    <input 
                      type="text"
                      placeholder="ค้นหากีฬา..."
                      value={filterCourtType}
                      onChange={(e) => setFilterCourtType(e.target.value)}
                      className="w-full bg-white border border-slate-200 font-normal py-1 px-2 rounded text-[10px] text-slate-700"
                    />
                  </th>
                  <th className="p-2">
                    <input
                      type="text"
                      placeholder="ค้นหาป้ายชื่อ..."
                      value={filterLabel}
                      onChange={(e) => setFilterLabel(e.target.value)}
                      className="w-full bg-white border border-slate-200 font-normal py-1 px-2 rounded text-[10px] text-slate-700"
                    />
                  </th>
                  <th className="p-2">
                    <select
                      value={filterDayType}
                      onChange={(e) => setFilterDayType(e.target.value)}
                      className="w-full bg-white border border-slate-200 font-normal py-1 px-1.5 rounded text-[10px] text-slate-700"
                    >
                      <option value="">ทั้งหมด</option>
                      <option value="WEEKDAY">วันธรรมดา</option>
                      <option value="WEEKEND">วันหยุด</option>
                    </select>
                  </th>
                  <th className="p-2">
                    <input 
                      type="text"
                      placeholder="PEAK / OFFPEAK..."
                      value={filterPriceType}
                      onChange={(e) => setFilterPriceType(e.target.value)}
                      className="w-full bg-white border border-slate-200 font-normal py-1 px-2 rounded text-[10px] text-slate-700"
                    />
                  </th>
                  <th className="p-2"></th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredPricingRules.map((rule) => (
                  <tr key={rule.id} className="hover:bg-slate-50 transition">
                    <td className="px-4 py-3 font-bold text-slate-800">
                      {rule.courtType}
                      {rule.label && <span className="block text-[10px] font-normal text-slate-500">{rule.label}</span>}
                    </td>
                    <td className="px-4 py-3 font-mono">{rule.startHour.toString().padStart(2, '0')}:00 - {rule.endHour.toString().padStart(2, '0')}:00 น.</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap ${
                        rule.dayType === DayType.WEEKDAY ? 'bg-slate-100 text-slate-700' : 'bg-emerald-100 text-emerald-800'
                      }`}>
                        {rule.dayType === DayType.WEEKDAY ? 'วันธรรมดา จ-ศ' : 'เสาร์ - อาทิตย์'}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-semibold">{rule.priceType}</td>
                    <td className="px-4 py-3 text-right font-black text-slate-950 whitespace-nowrap">{formatBaht(rule.pricePerHour)} บาท</td>
                    <td className="px-4 py-3 text-center flex justify-center gap-1.5">
                      <button
                        onClick={() => {
                          setEditingRuleId(rule.id);
                          setRuleCourtType(rule.courtType);
                          setRuleDayType(rule.dayType);
                          setRuleStartHour(rule.startHour);
                          setRuleEndHour(rule.endHour);
                          setRulePrice(rule.pricePerHour);
                          setRulePriceType(rule.priceType);
                          setRuleLabel(rule.label);
                        }}
                        className="text-sky-600 hover:text-sky-800 font-bold"
                      >
                        แก้ไข
                      </button>
                      <button
                        disabled={busy} onClick={guarded(() => handleDeletePricingRule(rule.id))}
                        className="text-rose-600 hover:text-rose-800 font-bold"
                      >
                        ลบ
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
