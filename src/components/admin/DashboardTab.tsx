import { CourtType, BookingStatus } from '../../types';
import { findClosure, isHourOffPeak, courtsConflict, openSlotHours, formatBaht } from '../../mockData';
import * as api from '../../api';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line
} from 'recharts';
import { useAdminPanelContext, hoursPerDay } from './useAdminPanel';

export default function DashboardTab() {
  const {
    PIE_COLORS,
    courts,
    dash,
    dashClosures,
    dashStats,
    dashboardSelectedDate,
    dashboardSelectedSport,
    daysOff,
    getDayCapacityChartData,
    getPieChartData,
    getRevenueChartData,
    gridBookings,
    physicalCourtCount,
    setDashboardSelectedDate,
    setDashboardSelectedSport
  } = useAdminPanelContext();
  return (
    <div className="space-y-6">

      {/* Header with Date Selection */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-slate-900 text-white p-5 rounded-2xl border border-slate-800 gap-4">
        <div>
          <h4 className="text-sm font-bold flex items-center gap-1.5 text-emerald-400">
            <span>📅 แผงสถิติรวมสนามกีฬาเจาะลึกประจำวัน</span>
          </h4>
          <p className="text-[11px] text-slate-400 mt-1">
            เลือกตรวจสอบผลการดำเนินงาน, ปริมาณคนใช้สนามกีฬา และรายรับตู้ POS ย้อนหลังได้ทุกยอดค่ำคืน
          </p>
        </div>

        <div className="flex items-center gap-2 bg-slate-800 px-3 py-1.5 rounded-xl border border-slate-700">
          <span className="text-xs font-bold text-emerald-400">เลือกวันที่ตรวจสอบ:</span>
          <input 
            type="date"
            value={dashboardSelectedDate}
            onChange={(e) => setDashboardSelectedDate(e.target.value)}
            className="bg-slate-700 px-3 py-1 rounded text-xs font-black text-white outline-none cursor-pointer focus:ring-1 focus:ring-emerald-500"
          />
        </div>
      </div>

      {/* Target Daily Metrics for selected date */}
      <div className="space-y-2">
        <span className="text-[11px] font-bold text-slate-500 block uppercase tracking-wider">📊 สถิติแบบแยกรายวัน ณ วันที่ ({dashboardSelectedDate}):</span>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-emerald-50 p-4 rounded-xl border border-emerald-200 text-xs shadow-xs">
            <span className="text-emerald-800 block font-bold text-[10px]">รายได้ค่าคอร์ทวันนี้ (Booking Revenue)</span>
            <span className="text-2xl font-extrabold text-emerald-900 mt-1 block">{formatBaht(dashStats.dailyBookingsRevenue)} บาท</span>
            <p className="text-[9px] text-emerald-700 font-bold mt-1">จำนวนจองอนุมัติสำเร็จ: {dashStats.dailyBookingsCount} รายการ</p>
          </div>

          <div className="bg-amber-50 p-4 rounded-xl border border-amber-200 text-xs shadow-xs">
            <span className="text-amber-800 block font-bold text-[10px]">รายรับสินค้า/เช่าแร็กวันนี้ (Today F&B)</span>
            <span className="text-2xl font-extrabold text-amber-900 mt-1 block">{formatBaht(dashStats.dailyOrderRevenue)} บาท</span>
            <p className="text-[9px] text-amber-700 mt-1">จากระบบ Walkin และ POS เคาเตอร์</p>
          </div>

          <div className="bg-sky-50 p-4 rounded-xl border border-sky-200 text-xs shadow-xs">
            <span className="text-sky-800 block font-bold text-[10px]">รายรับรวมสุทธิของวันนี้</span>
            <span className="text-2xl font-extrabold text-sky-950 mt-1 block">{formatBaht(dashStats.dailyTotalRevenue)} บาท</span>
            <p className="text-[9px] text-sky-700 mt-1">สรุปรวมลิ้นชักการรับเงินสองทางวันนี้</p>
          </div>

          <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-200 text-xs shadow-xs">
            <span className="text-indigo-800 block font-bold text-[10px]">อัตราเข้าใช้สนามประจำวัน (Occupancy)</span>
            <span className="text-2xl font-extrabold text-indigo-950 mt-1 block">{dashStats.occupancyRate}%</span>
            <p className="text-[9px] text-indigo-700 mt-1">ชั่วโมงสนามที่ขายได้ จาก {physicalCourtCount()} สนาม × {api.USE_BACKEND ? dash?.hoursPerDay ?? hoursPerDay() : hoursPerDay()} ชั่วโมง</p>
          </div>
        </div>
      </div>

      {/* All-Time Historical Cumulative Metrics */}
      <div className="space-y-2">
        <span className="text-[11px] font-bold text-slate-500 block uppercase tracking-wider">🌎 สรุปยอดสะสมและประวัติทางบัญชีภาพรวมทั้งหมด:</span>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs">
            <span className="text-slate-400 block font-bold text-[10px]">รายรับรวมประเวศทุกก๊วน (All-Time Revenue)</span>
            <span className="text-2xl font-extrabold text-slate-800 mt-1 block">{formatBaht(dashStats.allTimeRevenue)} บาท</span>
            <div className="flex gap-2 text-[9px] text-slate-500 mt-1.5 font-mono">
              <span>จากคอร์ท: {formatBaht(dashStats.bookingSales)}</span>
              <span>|</span>
              <span>ตู้ POS: {formatBaht(dashStats.fbSales)}</span>
            </div>
            <p className="text-[9px] text-slate-500 mt-1">รอชำระ (ยังไม่นับ): {formatBaht(dashStats.pendingRevenue)} · คืนเงินแล้ว: {formatBaht(dashStats.refunds)} บาท</p>
          </div>

          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs">
            <span className="text-slate-400 block font-bold text-[10px]">จำนวนสมาชิกจองในก๊วนคัพ (Registered Accounts)</span>
            <span className="text-2xl font-extrabold text-slate-800 mt-1 block">{dashStats.customerCount} บัญชี</span>
            <p className="text-[9px] text-slate-500 mt-1.5">ลูกค้าระดับ MOU องค์กร / สโมสร และนักซ้อมอิสระ</p>
          </div>

          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs">
            <span className="text-slate-400 block font-bold text-[10px]">รวมมูลค่าเคาน์เตอร์สะสม (Total POS Products)</span>
            <span className="text-2xl font-extrabold text-slate-800 mt-1 block">{formatBaht(dashStats.fbSales)} บาท</span>
            <p className="text-[9px] text-slate-500 mt-1.5">เครื่องดื่ม น้ำเกลือแร่ สนับเข่า ดรายไอซ์ และเช่าแร็กเก็ต</p>
          </div>
        </div>
      </div>

      {/* Graphs Row (Module 4 visual specifications) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-2">

        {/* Line graph of revenue growth */}
        <div className="col-span-1 lg:col-span-8 bg-slate-50 p-5 rounded-2xl border border-slate-200/60">
          <div className="mb-4">
            <h4 className="text-xs font-bold text-slate-800">รายรับแยกประเภท 6 เดือนล่าสุด (บาท)</h4>
            <p className="text-[10px] text-slate-400 mt-0.5">ค่าสนามที่ชำระแล้ว เทียบกับยอดขาย/เช่าที่เคาน์เตอร์ ถึงเดือนของวันที่เลือก</p>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={getRevenueChartData()}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" fontSize={11} stroke="#64748b" />
                <YAxis fontSize={11} stroke="#64748b" />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="รายได้ค่าคอร์ท" fill="#15803d" radius={[4, 4, 0, 0]} />
                <Bar dataKey="รายได้เครื่องดื่ม/เช่าแร็ก" fill="#38bdf8" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Pie graph of product shares */}
        <div className="col-span-1 lg:col-span-4 bg-slate-50 p-5 rounded-2xl border border-slate-200/60 flex flex-col justify-between">
          <div>
            <h4 className="text-xs font-bold text-slate-800">สัดส่วนรายรับจากเช่าของ / อาหาร</h4>
            <p className="text-[10px] text-slate-400 mt-0.5">ยอดขายเคาน์เตอร์สะสมทั้งหมด แยกตามประเภทสินค้า</p>
          </div>

          <div className="h-44 relative flex items-center justify-center my-4">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={getPieChartData()}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={70}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {getPieChartData().map((_, index) => (
                    <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
            {/* Total indicator overlay */}
            <div className="absolute text-center">
              <p className="text-[9px] text-slate-400 uppercase font-bold tracking-tight">รวม</p>
              <p className="font-extrabold text-slate-800 text-sm">{formatBaht(dashStats.fbSales)} บ.</p>
            </div>
          </div>

          {/* Pie legend layout */}
          <div className="space-y-1.5 text-[10px]">
            {getPieChartData().map((entry, index) => (
              <div key={index} className="flex justify-between items-center text-slate-600 font-medium">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: PIE_COLORS[index] }} />
                  {entry.name}
                </span>
                <span className="font-bold text-slate-800 font-mono">{formatBaht(entry.value)} บาท</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Peak Hours Occupancy trend chart */}
      <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200/60">
        <div className="mb-4">
          <span className="text-xs bg-amber-100 text-amber-800 font-extrabold px-2.5 py-1 rounded-full uppercase text-[9px]">Peak / Off-Peak Rate Analysis</span>
          <h4 className="text-xs font-bold text-slate-800 mt-2">อัตราการใช้สนามเฉลี่ยรายชั่วโมง (%) ช่วง 30 วันถึงวันที่เลือก</h4>
          <p className="text-[10px] text-slate-400 mt-0.5">ใช้ดูว่าช่วงไหนคนเต็ม เพื่อกำหนดช่วง Peak / Off-Peak</p>
        </div>

        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={getDayCapacityChartData()}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="hourName" fontSize={11} stroke="#64748b" />
              <YAxis fontSize={11} stroke="#64748b" />
              <Tooltip />
              <Line type="monotone" dataKey="เฉลี่ยอัตรา (%)" stroke="#eab308" strokeWidth={3} dot={{ r: 5 }} activeDot={{ r: 8 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* COMPREHENSIVE MANAGER COURT BOOKING VISUALIZER MATRIX */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4 shadow-sm text-xs">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h4 className="text-xs font-bold text-slate-800 uppercase tracking-widest flex items-center gap-1.5 font-sans">
              🎾 มอนิเตอร์ดีมานด์ภาพรวมคอร์ท (Comprehensive Court Occupancy Grid)
            </h4>
            <p className="text-[10px] text-slate-500 mt-0.5">
              ตรวจสอบช่วงเวลาสนามว่าง/เต็มทุกชั่วโมง สำหรับใช้พิจารณารับผู้เล่น Walk-in และตัดใจอัปย้ายโปรโมชั่นล่วงหน้า
            </p>
          </div>

          {/* Sub Sport Selection Tab bar */}
          <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200">
            {Object.values(CourtType).map((sport) => {
              const countActive = courts.filter(c => c.type === sport && c.isActive).length;
              return (
                <button
                  key={sport}
                  type="button"
                  onClick={() => setDashboardSelectedSport(sport)}
                  className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition flex items-center gap-1 ${
                    dashboardSelectedSport === sport 
                      ? 'bg-emerald-600 text-white shadow-xs font-black' 
                      : 'text-slate-600 hover:text-slate-950 hover:bg-slate-50'
                  }`}
                >
                  {sport === CourtType.BADMINTON ? '🏸 ' : sport === CourtType.BASKETBALL ? '🏀 ' : '⚽ '}
                  {sport} ({countActive})
                </button>
              );
            })}
          </div>
        </div>

        {/* Grid content container with horizontal scroll */}
        <div className="overflow-x-auto border border-slate-200 rounded-xl bg-slate-50/50">
          <table className="w-full text-left border-collapse min-w-[1000px]">
            <thead>
              <tr className="bg-slate-100 text-[10px] uppercase font-black text-slate-500 border-b border-slate-200">
                <th className="p-3 bg-slate-100 sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] w-36">สนาม (Court Name)</th>
                {openSlotHours().map((time) => (
                  <th key={time} className="p-2 text-center text-[9px] min-w-[70px] border-l border-slate-200">
                    {time} น.
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white text-[10px]">
              {courts.filter(c => c.type === dashboardSelectedSport && c.isActive).map((court) => (
                <tr key={court.id} className="hover:bg-slate-50 transition-colors">
                  {/* Court Name sticky column */}
                  <td className="p-3 font-semibold text-slate-800 bg-slate-50 sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] border-r border-slate-200">
                    <span className="flex items-center gap-1.5 text-[11px] text-[#0f172a]">
                      🎯 {court.name}
                    </span>
                  </td>

                  {/* Hourly timeline slot cells */}
                  {openSlotHours().map((time) => {
                    const targetH = parseInt(time.split(':')[0], 10);

                    // 1. Check for double booking - includes mutex-group
                    // conflicts (FR-1.2: the full court blocks every
                    // half-court side, but two half-court sides do NOT
                    // block each other), not just this exact court id.
                    const matchedBooking = gridBookings.find(b => {
                      // A no-show frees the court (findConflictingBooking).
                      if (b.date !== dashboardSelectedDate || b.status === BookingStatus.CANCELLED || b.status === BookingStatus.NO_SHOW) return false;
                      const bookedCourt = courts.find(c => c.id === b.courtId);
                      if (!bookedCourt || !courtsConflict(court, bookedCourt)) return false;
                      const startH = parseInt(b.startTime.split(':')[0], 10);
                      const endH = parseInt(b.endTime.split(':')[0], 10);
                      return targetH >= startH && targetH < endH;
                    });

                    // 2. Check for closure/maintenance
                    const closureItem = findClosure(api.USE_BACKEND ? dashClosures : daysOff, dashboardSelectedDate, court.id, targetH, courts);

                    // 3. Peak/Offpeak, read from the same PricingRule
                    // config the price itself uses.
                    const isPeak = !isHourOffPeak(court.type, dashboardSelectedDate, targetH);
                    const isRestrictedPeakBasketball = !!court.offPeakOnly && isPeak;

                    if (matchedBooking) {
                      const isPending = matchedBooking.status === BookingStatus.PENDING_PAYMENT;
                      return (
                        <td 
                          key={time} 
                          className={`p-1.5 border-l border-slate-200 text-center relative group select-none min-h-[44px] ${
                            isPending ? 'bg-amber-100 text-amber-900 border-l-amber-200' : 'bg-emerald-50 text-emerald-950 border-l-emerald-200 font-bold'
                          }`}
                        >
                          <div className="font-bold truncate max-w-[70px] text-[9.5px]">
                            👤 {matchedBooking.userName}
                          </div>
                          <span className="absolute bottom-0.5 right-1 text-[8px] opacity-70 font-mono scale-[0.8]">
                            {isPending ? '⏳ รอชำระ' : '✓ ชำระแล้ว'}
                          </span>
                          {/* Hover interactive tooltip */}
                          <div className="absolute hidden group-hover:block bg-slate-900 text-slate-50 text-[9.5px] p-2.5 rounded-lg shadow-md z-30 w-44 left-1/2 -translate-x-1/2 -top-16 border border-slate-700 bg-[#0f172a] text-[#f8fafc] leading-tight text-left">
                            <p className="font-bold text-emerald-400">🚨 รายละเอียดคอร์ทจอง</p>
                            <p>ผู้จอง: <span className="font-extrabold">{matchedBooking.userName}</span></p>
                            <p className="font-mono">เบอร์โทร: {matchedBooking.userPhone || 'ไม่ระบุ'}</p>
                            <p className="font-mono text-amber-300">เวลาเล่น: {matchedBooking.startTime} - {matchedBooking.endTime} น.</p>
                            <p className="font-mono text-[8.5px] text-slate-400">รหัสจอง: {matchedBooking.bookingCode}</p>
                          </div>
                        </td>
                      );
                    } else if (closureItem) {
                      return (
                        <td 
                          key={time} 
                          className="p-1 border-l border-slate-200 bg-rose-100/75 text-rose-900 text-center min-h-[44px] select-none font-bold"
                          title={`ปิดให้บริการ: ${closureItem.reason}`}
                        >
                          <span className="block text-[8px] text-rose-700">⚠️ ปิดสนาม</span>
                          <span className="text-[7.5px] text-rose-900 block max-w-[65px] truncate mx-auto">
                            {closureItem.reason}
                          </span>
                        </td>
                      );
                    } else if (isRestrictedPeakBasketball) {
                      return (
                        <td 
                          key={time} 
                          className="p-1 border-l border-slate-200 bg-slate-100 text-slate-400 text-center min-h-[44px] select-none"
                          title="เฉพาะช่วงเวลาเพื่อสุขภาพ (Off-peak) เท่านั้น"
                        >
                          <span className="block text-[8px] font-semibold text-slate-500 leading-none">🚫 ปิดช่วง Peak</span>
                          <span className="text-[7px] text-slate-400 block scale-[0.95]">ครึ่งสนาม</span>
                        </td>
                      );
                    } else {
                      return (
                        <td key={time} className="p-1.5 border-l border-slate-200 text-emerald-800 text-center bg-emerald-50/5 hover:bg-emerald-100/10 transition cursor-default">
                          <span className="font-mono text-[9px] font-bold block text-emerald-600">🟢 ว่าง</span>
                          <span className="text-[8px] text-slate-400 mt-0.5 block scale-90 leading-tight">ว่างเปล่า</span>
                        </td>
                      );
                    }
                  })}
                </tr>
              ))}

              {courts.filter(c => c.type === dashboardSelectedSport && c.isActive).length === 0 && (
                <tr>
                  <td colSpan={17} className="text-center text-slate-400 py-10 font-bold">
                    ยังไม่มีข้อมูลสนามของประเภทกีฬา {dashboardSelectedSport} ที่เปิดการใช้งานเวลานี้
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Informative advice for active managers */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center text-[10px] text-slate-500 bg-slate-50 p-3 rounded-xl border border-slate-200 gap-2 font-mono">
          <span className="font-semibold text-emerald-800 flex items-center gap-1">
            💡 คำแนะนำผู้บริหาร: แถบสีเขียวคือยอดชำระแล้วเรียบร้อย แถบสีเหลืองคือสัญญารอโอนเงินผ่านระบบ และสล็อตว่างสามารถจัดสรรขายหน้างานตั๋ว Walk-in ได้ทันที
          </span>
          <span className="font-bold text-slate-800 uppercase">
            ประเภทกีฬา: {dashboardSelectedSport} (จำนวนสนาม: {courts.filter(c => c.type === dashboardSelectedSport && c.isActive).length})
          </span>
        </div>
      </div>

    </div>
  );
}
