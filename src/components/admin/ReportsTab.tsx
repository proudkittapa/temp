import { getTodayDateStr } from '../../mockData';
import { FileDown } from 'lucide-react';
import { useAdminPanelContext } from './useAdminPanel';

export default function ReportsTab() {
  const {
    handleDownloadCSVReport,
    reportsMonth,
    reportsYear,
    setReportsMonth,
    setReportsYear
  } = useAdminPanelContext();
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-bold text-slate-900">สรุปพิมพ์ดาวน์โหลดรายงานรายได้ (Exporter Console)</h3>
        <p className="text-xs text-slate-500">ข้อมูลจะรี่เรียงออกมาจัดรูปตามมติบัญชี สำหรับยื่นปิดงบดุลประจำปีกับสำนักบัญชีสัญญารุ่นไทย</p>
      </div>

      <div className="bg-slate-50 p-6 rounded-2xl border border-slate-200 max-w-4xl space-y-4">
        <span className="text-xs font-bold text-slate-700 block flex items-center gap-1.5"><FileDown className="h-4 w-4 text-emerald-600" /> ตัวกรองสร้างลิ้งก์ดาวน์โหลดรายงานรายชั่วโมงกิจกรรม:</span>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div>
            <label className="block text-slate-500 mb-1.5">คาบเลือกเดือนปิดบิล:</label>
            <select 
              value={reportsMonth} 
              onChange={(e) => setReportsMonth(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded p-2 text-xs"
            >
              <option value="01">มกราคม (Jan)</option>
              <option value="02">กุมภาพันธ์ (Feb)</option>
              <option value="03">มีนาคม (Mar)</option>
              <option value="04">เมษายน (Apr)</option>
              <option value="05">พฤษภาคม (May)</option>
              <option value="06">มิถุนายน (Jun)</option>
              <option value="07">กรกฎาคม (Jul)</option>
              <option value="08">สิงหาคม (Aug)</option>
              <option value="09">กันยายน (Sep)</option>
              <option value="10">ตุลาคม (Oct)</option>
              <option value="11">พฤศจิกายน (Nov)</option>
              <option value="12">ธันวาคม (Dec)</option>
            </select>
          </div>

          <div>
            <label className="block text-slate-500 mb-1.5">ปีปฏิทิน:</label>
            <select 
              value={reportsYear} 
              onChange={(e) => setReportsYear(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded p-2 text-xs"
            >
              {/* next year down to 5 years back */}
              {Array.from({ length: 7 }, (_, i) => Number(getTodayDateStr().slice(0, 4)) + 1 - i).map(y => (
                <option key={y} value={String(y)}>{y}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col justify-end gap-2">
            <button
              id="report-csv-bookings"
              onClick={() => handleDownloadCSVReport('bookings')}
              className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-2.5 rounded text-xs flex items-center justify-center gap-2 transition shadow-sm"
            >
              <FileDown className="h-4 w-4" /> การจองสนาม .CSV
            </button>
            <button
              id="report-csv-orders"
              onClick={() => handleDownloadCSVReport('orders')}
              className="w-full bg-white hover:bg-slate-100 text-slate-900 border border-slate-300 font-bold py-2.5 rounded text-xs flex items-center justify-center gap-2 transition shadow-sm"
            >
              <FileDown className="h-4 w-4" /> ยอดขาย/เช่าที่เคาน์เตอร์ .CSV
            </button>
          </div>
        </div>

        <div className="p-4 bg-emerald-50 rounded-xl text-[10.5px] border border-emerald-200 text-emerald-800 space-y-1">
          <p className="font-bold">✨ ระบบอำนวยความสะดวกบัญชีปิดกานต์อัตโนมัติ:</p>
          <p>รายงานรูปแบบ CSV นี้สามารถดับเบิ้ลคลิกเปิดด้วย Microsoft Excel หรือทำการดึงเข้า Google Sheets ได้ทันประกอบสมบูรณ์ 100%</p>
        </div>
      </div>
    </div>
  );
}
