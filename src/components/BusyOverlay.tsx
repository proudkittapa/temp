import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { useBusyState, blockingActions, dismissRunningActions } from '../busy';

// Shown while a server action is running (busy.ts). The page underneath is
// blocked at once; the box itself appears only after SHOW_AFTER_MS, so a
// quick save doesn't flash it. After SLOW_AFTER_MS without an answer it
// says so and can be closed - the action continues in the background.
const SHOW_AFTER_MS = 300;
const SLOW_AFTER_MS = 20000;

export default function BusyOverlay() {
  const running = blockingActions(useBusyState());
  const since = running.length ? Math.min(...running.map(a => a.at)) : 0;
  const [now, setNow] = useState(() => Date.now());

  // Re-render when the box should appear and when it turns "slow".
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const timers = [SHOW_AFTER_MS, SLOW_AFTER_MS].map(ms => setTimeout(() => setNow(Date.now()), Math.max(0, since + ms - Date.now())));
    return () => timers.forEach(clearTimeout);
  }, [since]);

  if (!since) return null;
  const elapsed = now - since;
  return createPortal(
    // Covers everything (dialogs are z-100); the page below is inert.
    <div id="busy-overlay" aria-busy="true" className="fixed inset-0 z-[200] cursor-progress flex items-center justify-center p-4"
      style={{ background: elapsed >= SHOW_AFTER_MS ? 'rgba(15, 23, 42, 0.35)' : 'transparent' }}>
      {elapsed >= SHOW_AFTER_MS && (
        <div role="status" aria-live="polite" className="bg-white rounded-2xl shadow-xl border border-slate-200 px-6 py-5 max-w-sm w-full text-center cursor-default">
          <Loader2 className="h-7 w-7 text-emerald-600 animate-spin mx-auto" aria-hidden="true" />
          <p className="mt-3 text-sm font-bold text-slate-800">กำลังดำเนินการ...</p>
          <p className="text-xs text-slate-500 mt-1">กรุณารอสักครู่ อย่าปิดหรือรีเฟรชหน้านี้</p>
          {elapsed >= SLOW_AFTER_MS && (
            <div id="busy-slow" className="mt-4 pt-3 border-t border-slate-100 space-y-2">
              <p className="text-xs text-amber-700">ยังไม่ได้รับคำตอบจากเซิร์ฟเวอร์ (อินเทอร์เน็ตอาจช้าหรือหลุด) — รายการยังทำต่อเบื้องหลัง ตรวจผลก่อนทำซ้ำ</p>
              <button type="button" id="busy-dismiss" onClick={dismissRunningActions}
                className="w-full text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 py-2 rounded-lg">
                ปิดหน้าต่างนี้
              </button>
            </div>
          )}
        </div>
      )}
    </div>,
    document.body
  );
}
