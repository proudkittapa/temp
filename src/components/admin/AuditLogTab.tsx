import { formatDateTime } from '../../mockData';
import { Search, ShieldCheck } from 'lucide-react';
import { useAdminPanelContext } from './useAdminPanel';

export default function AuditLogTab() {
  const {
    auditSearch,
    auditTypeFilter,
    filteredAuditLogs,
    setAuditSearch,
    setAuditTypeFilter
  } = useAdminPanelContext();
  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-1">
            <ShieldCheck className="h-5 w-5 text-rose-600 animate-pulse" />
            ระบบบันทึกความปลอดภัยต้านทุจริตภายใน (System Audit Database)
          </h3>
          <p className="text-xs text-slate-500">บันทึกทุกพฤติกรรมการแก้ไขยอดเงิน, การสลับเกณฑ์ราคา หรือการเปลี่ยนสถานะโอนความถี่สูตรสลับ</p>
        </div>

        {/* Real-time filters (Module 4 spec) */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold text-slate-500 whitespace-nowrap">กรองตามประเภท:</span>
            <select
              value={auditTypeFilter}
              onChange={(e) => setAuditTypeFilter(e.target.value)}
              className="bg-slate-50 border border-slate-200 text-xs py-1.5 px-3 rounded-xl text-slate-800 font-bold focus:bg-white focus:outline-none"
            >
              <option value="ALL">🔍 ค้นหาประเภททั้งหมด (All Resources)</option>
              <option value="User">👥 ฐานข้อมูลสิทธิ์และบทบาทสมาชิก (User/Member)</option>
              <option value="Booking">📅 งานจองคอร์ทและสนาม (Booking Arena)</option>
              <option value="PricingRule">💰 เกณฑ์อัตราดอกเบี้ยและกฎราคา (Pricing Rules)</option>
              <option value="Court">🏸 ตั้งค่าระเบียบและสนามแข่งขัน (Courts Config)</option>
              <option value="DayOff">🚫 สล็อตวันหยุดปิดบริการและจองสนาม (Day Off)</option>
              <option value="Product">🥤 ระบบสต็อกสินค้า POS และ F&B (Products/Rentals)</option>
              <option value="Report">📊 งานส่งออกชุดบันทึกสถิติ (Reports Export)</option>
            </select>
          </div>

          <div className="relative w-full sm:w-auto">
            <input
              type="text"
              placeholder="ค้นหายูสเซอร์, การกระทำ หรือ ID..."
              value={auditSearch}
              onChange={(e) => setAuditSearch(e.target.value)}
              className="bg-slate-50 border border-slate-200 outline-none text-xs py-1.5 pl-8 pr-4 rounded-xl w-full sm:w-56 text-slate-800 focus:bg-white"
            />
            <Search className="h-4 w-4 text-slate-400 absolute left-2.5 top-2" />
          </div>
        </div>
      </div>

      {/* Logs loop */}
      <p className="text-xs text-slate-500">{filteredAuditLogs.length} รายการ (ล่าสุดอยู่บนสุด)</p>
      <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1 text-xs">
        {filteredAuditLogs.length === 0 ? (
          <p className="text-slate-400 text-center py-10">ไม่พบประวัติพฤติกรรมในฐานสลักสำหรับเกณฑ์ค่าดึงค้นหานี้</p>
        ) : (
          filteredAuditLogs.map((log) => {
              const meta = (() => {
                switch (log.targetType) {
                  case 'User':
                    return {
                      label: '👥 ฐานข้อมูลสิทธิ์และบทบาทสมาชิก (Users / Members)',
                      badgeStyle: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
                      cardBorder: 'border-l-4 border-l-amber-500'
                    };
                  case 'Booking':
                    return {
                      label: '📅 งานจองคอร์ทและสนามแข่งขัน (Booking Arena)',
                      badgeStyle: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
                      cardBorder: 'border-l-4 border-l-emerald-500'
                    };
                  case 'PricingRule':
                    return {
                      label: '💰 เกณฑ์อัตราดอกเบี้ยและกฎราคา (Pricing Rules)',
                      badgeStyle: 'bg-sky-500/20 text-sky-300 border border-sky-500/30',
                      cardBorder: 'border-l-4 border-l-sky-500'
                    };
                  case 'Court':
                    return {
                      label: '🏸 ตั้งค่าระเบียบและสนามแข่งขัน (Courts Config)',
                      badgeStyle: 'bg-purple-500/20 text-purple-300 border border-purple-500/30',
                      cardBorder: 'border-l-4 border-l-purple-500'
                    };
                  case 'DayOff':
                    return {
                      label: '🚫 สล็อตวันหยุดปิดบริการและจองสนาม (Day Off)',
                      badgeStyle: 'bg-rose-500/20 text-rose-300 border border-rose-500/30',
                      cardBorder: 'border-l-4 border-l-rose-500'
                    };
                  case 'Product':
                    return {
                      label: '🥤 ระบบสต็อกสินค้า POS และ F&B (Products & Rentals)',
                      badgeStyle: 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30',
                      cardBorder: 'border-l-4 border-l-indigo-500'
                    };
                  case 'Report':
                    return {
                      label: '📊 งานส่งออกชุดบันทึกสถิติ (Reports Export)',
                      badgeStyle: 'bg-teal-500/20 text-teal-300 border border-teal-500/30',
                      cardBorder: 'border-l-4 border-l-teal-500'
                    };
                  default:
                    return {
                      label: `🛡️ ทรัพยากรความปลอดภัยทั่วไป (${log.targetType})`,
                      badgeStyle: 'bg-slate-500/20 text-slate-300 border border-slate-500/30',
                      cardBorder: 'border-l-4 border-l-slate-500'
                    };
                }
              })();

              // Parse properties that changed
              const changedProperties = (() => {
                try {
                  const beforeObj = log.before && typeof log.before === 'object' ? log.before : {};
                  const afterObj = log.after && typeof log.after === 'object' ? log.after : {};
                  const unionKeys = Array.from(new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]));
                  return unionKeys.filter(k => JSON.stringify(beforeObj[k]) !== JSON.stringify(afterObj[k]));
                } catch {
                  return [];
                }
              })();

              return (
                <div 
                  key={log.id} 
                  className={`bg-slate-900 text-slate-100 p-4 rounded-xl border border-slate-800 space-y-3 font-mono transition shadow-lg ${meta.cardBorder}`}
                >
                  {/* Audit Category Header */}
                  <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-950/45 p-2 rounded-lg border border-slate-800/60">
                    <span className="text-[10.5px] font-bold text-slate-300 flex items-center gap-1.5">
                      {meta.label}
                    </span>
                    <span className="text-[10px] text-slate-400/90 font-sans">
                      🕒 {formatDateTime(log.createdAt, true)} น.
                    </span>
                  </div>

                  {/* Event action description row */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] bg-rose-600/20 text-rose-300 font-black px-2 py-0.5 rounded border border-rose-500/30 tracking-wider">
                        {log.action}
                      </span>
                      <span className="text-slate-400 text-[10px] font-bold">
                        (Target ID: <span className="text-slate-200 select-all font-sans">{log.targetId}</span>)
                      </span>
                    </div>

                    <div className="text-[11px] font-sans text-slate-300">
                      👤 ผู้ทำรายการ: <span className="bg-slate-800 px-2 py-0.5 rounded text-white font-mono font-bold">{log.userName}</span>
                    </div>
                  </div>

                  {/* Details fold away: a sale lists a dozen fields, which
                      used to fill the whole box with one entry. */}
                  {(changedProperties.length > 0 || log.before || log.after) && (
                  <details className="group/d">
                    <summary className="text-[10px] text-sky-300 hover:text-sky-200 cursor-pointer select-none font-bold font-sans">
                      ดูรายละเอียด{changedProperties.length > 0 ? ` (${changedProperties.length} ค่า)` : ''}
                    </summary>
                    <div className="space-y-3 mt-2">
                  {changedProperties.length > 0 && (
                    <div className="bg-slate-950/70 p-2.5 rounded-lg border border-slate-800 text-[10.5px] space-y-1.5 font-sans">
                      <span className="text-[9.5px] font-black text-amber-400 uppercase tracking-widest flex items-center gap-1">
                        🔍 ตรวจทุจริตเปลี่ยนค่าที่แสตมป์ (Property Changes):
                      </span>
                      <div className="divide-y divide-slate-800">
                        {changedProperties.map(key => {
                          const beforeVal = log.before?.[key];
                          const afterVal = log.after?.[key];
                          return (
                            <div key={key} className="py-1 flex flex-col md:flex-row md:items-center justify-between gap-1 text-slate-300">
                              <span className="font-extrabold text-slate-400 text-[11px] bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">{key}</span>
                              <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
                                <span className="line-through text-rose-400 bg-rose-950/40 px-1.5 py-0.5 rounded font-mono">
                                  {beforeVal === null || beforeVal === undefined ? 'ว่าง' : JSON.stringify(beforeVal)}
                                </span>
                                <span className="text-slate-500">➔</span>
                                <span className="text-emerald-400 bg-emerald-950/40 px-1.5 py-0.5 rounded font-mono font-bold">
                                  {afterVal === null || afterVal === undefined ? 'ว่าง' : JSON.stringify(afterVal)}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Raw snap expander details */}
                  {(log.before || log.after) && (
                    <details className="group">
                      <summary className="text-[9px] text-slate-500 hover:text-slate-400 cursor-pointer select-none font-bold uppercase tracking-wider flex items-center gap-1 focus:outline-none">
                        <span>📁 คลิกเพื่อดูฐานข้อมูลดิบ (Toggle Raw Snapshot Metadata)</span>
                      </summary>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2 bg-slate-950 p-2.5 rounded border border-slate-900 text-[9px] group-open:animate-fadeIn">
                        <div>
                          <p className="text-slate-500 font-extrabold mb-1">📋 SNAPSHOT [ก่อนหน้า] (BEFORE):</p>
                          <pre className="text-rose-400 bg-rose-950/10 p-1.5 rounded border border-rose-950/30 max-h-32 overflow-y-auto pr-1">{JSON.stringify(log.before || {}, null, 1)}</pre>
                        </div>
                        <div>
                          <p className="text-slate-500 font-extrabold mb-1">📋 SNAPSHOT [ล่าสุด] (AFTER):</p>
                          <pre className="text-emerald-400 bg-emerald-950/10 p-1.5 rounded border border-emerald-950/30 max-h-32 overflow-y-auto pr-1">{JSON.stringify(log.after || {}, null, 1)}</pre>
                        </div>
                      </div>
                    </details>
                  )}
                    </div>
                  </details>
                  )}
                </div>
              );
            })
        )}
      </div>
    </div>
  );
}
