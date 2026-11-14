import { useEffect, useState } from 'react';
import * as api from '../../api';

// This month's LINE messages against the plan (owner decision: start on
// the free plan, ~300 messages a month, and watch this count). Shown only
// when the server sends LINE messages.
const FREE_PLAN = 300;

export default function LineUsageCard() {
  const [u, setU] = useState<api.LineUsage | null>(null);
  useEffect(() => {
    if (api.USE_BACKEND) void api.lineUsage().then(setU);
  }, []);
  if (!u?.enabled) return null;
  const used = u.lineUsed ?? u.sentThisMonth;
  const limit = u.lineLimit ?? FREE_PLAN;
  const near = used >= limit * 0.8;
  return (
    <div id="line-usage" className={`p-4 rounded-xl border text-xs ${near ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200'}`}>
      <span className="text-slate-500 block font-bold text-[10px]">ข้อความ LINE เดือนนี้</span>
      <span className="text-2xl font-extrabold text-slate-800 mt-1 block">{used.toLocaleString()} / {limit.toLocaleString()}</span>
      <p className="text-[11px] text-slate-500 mt-1">
        {u.lineLimit === undefined ? `แผนฟรีส่งได้ประมาณ ${FREE_PLAN} ข้อความต่อเดือน` : 'ตามแผน LINE ของร้าน'}
        {u.pending > 0 && ` · รอส่ง ${u.pending}`}
        {u.failedThisMonth > 0 && ` · ส่งไม่สำเร็จ ${u.failedThisMonth}`}
      </p>
      {near && <p className="text-[11px] font-bold text-amber-800 mt-1">ใกล้ครบโควตาแล้ว — พิจารณาอัปเกรดแผน LINE (เช่น Basic)</p>}
    </div>
  );
}
