import { useState, useEffect, Suspense } from 'react';
import { UserRole, AuditLog, AddAuditLog } from './types';
import { initializeState, StorageService, formatDateTime } from './mockData';
import CustomerPanel from './components/CustomerPanel';
// The counter and settings screens load on demand (customers' phones don't
// download them), fetched before they are shown - see screens.ts.
import { StaffPOS, AdminPanel, preloadScreen, roleFromHash, hashForRole } from './screens';
import { DialogHost } from './components/Dialog';
import { Shield, Sparkles, User, Users, Briefcase, Clock } from 'lucide-react';
import * as api from './api';
import { canUseCounter, canUseSettings } from './permissions';
import { User as SessionUser } from './types';

// One login per browser: keep one of the per-screen sessions stored before
// that (see api.migrateLegacySessions), before anything reads the session.
if (api.USE_BACKEND) api.migrateLegacySessions();


// The role switcher is a demo tool: shown in the browser-only demo and in
// dev, never to customers of a real (backend) deployment.
const SHOW_ROLE_SWITCHER = !(import.meta.env.PROD && api.USE_BACKEND);

// The header clock ticks on its own, so the panels below don't re-render
// (and re-price every grid cell) every second.
function LiveClock() {
  const [now, setNow] = useState<string>(() => formatDateTime(Date.now(), true));
  useEffect(() => {
    const t = setInterval(() => setNow(formatDateTime(Date.now(), true)), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{now}</>;
}

// Browser-only mode keeps the audit log in localStorage; cap it so a long
// demo can't fill the storage quota (which would silently drop new data).
const MAX_LOCAL_AUDIT_LOGS = 2000;

export default function App() {
  const [currentRole, setCurrentRole] = useState<UserRole>(roleFromHash);
  const [refreshTrigger, setRefreshTrigger] = useState<number>(0);
  // API mode: the one signed-in account; its permissions decide which
  // screens the nav bar offers (the server checks every call regardless).
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(() => api.USE_BACKEND ? api.getSession()?.user ?? null : null);
  useEffect(() => {
    if (api.USE_BACKEND) setSessionUser(api.getSession()?.user ?? null);
  }, [refreshTrigger]);

  // The screen's code is fetched first, so it shows at once (screens.ts).
  const openScreen = (role: UserRole) => {
    preloadScreen(role).then(() => {
      setCurrentRole(role);
      window.history.replaceState(null, '', role === UserRole.CUSTOMER ? window.location.pathname : hashForRole(role));
      triggerCompleteRefresh();
    });
  };
  // A staff/admin account signed in on the customer page goes to the
  // screen its role may use: the counter first, otherwise settings.
  const handleStaffSignIn = (user: SessionUser) => {
    setSessionUser(user);
    openScreen(canUseCounter(user) ? UserRole.STAFF : UserRole.ADMIN);
  };
  const handleSignOut = () => {
    api.logout();
    setSessionUser(null);
    openScreen(UserRole.CUSTOMER);
  };

  // Auto-initialize standard seed databases to localStorage on startup
  useEffect(() => {
    initializeState();
    triggerCompleteRefresh();
    const onHash = () => {
      const role = roleFromHash();
      preloadScreen(role).then(() => { setCurrentRole(role); triggerCompleteRefresh(); });
    };
    window.addEventListener('hashchange', onHash);
    // Signed in or out in another tab: reload this tab's data under the
    // session that is now stored, instead of showing the old person.
    const offSession = api.onSessionChangedElsewhere(() => triggerCompleteRefresh());
    return () => { window.removeEventListener('hashchange', onHash); offSession(); };
  }, []);

  const triggerCompleteRefresh = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  // Helper function to append to Audit Log (Module 6 Anti-Fraud Compliance)
  const handleAddNewAuditLog: AddAuditLog = (action, targetType, targetId, before, after, reason) => {
    const currentLogs = StorageService.get<AuditLog[]>('audit_logs', []);
    const sessionUser = api.USE_BACKEND
      ? api.getSession(currentRole === UserRole.CUSTOMER ? 'customer' : currentRole === UserRole.ADMIN ? 'admin' : 'staff')?.user
      : undefined;
    const newLog: AuditLog = {
      // Unique even for two entries in the same millisecond.
      id: 'al-' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
      // With the backend, name whoever is actually signed in to this panel.
      userId: sessionUser?.id ?? (currentRole === UserRole.CUSTOMER ? 'guest-customer' : 'current-user'),
      userName: sessionUser ? `${sessionUser.name} (${sessionUser.role})` :
                currentRole === UserRole.CUSTOMER ? 'ลูกค้าภายนอก (Customer)' :
                currentRole === UserRole.STAFF ? 'คุณ กิตติ (Staff)' :
                currentRole === UserRole.MANAGER ? 'คุณ วิชัย (Manager)' : 'คุณ สมชาย (Admin)',
      action,
      targetType,
      targetId,
      // Snapshots are plain objects, stored as records.
      before: (before ?? undefined) as Record<string, unknown> | undefined,
      after: (after ?? undefined) as Record<string, unknown> | undefined,
      reason,
      createdAt: new Date().toISOString()
    };

    // With the backend the server writes the audit log itself.
    if (!api.USE_BACKEND) StorageService.set('audit_logs', [newLog, ...currentLogs].slice(0, MAX_LOCAL_AUDIT_LOGS));
    triggerCompleteRefresh();
  };

  // Switcher bar roles list configuration
  const ROLES_LIST = [
    { role: UserRole.CUSTOMER, label: 'ลูกค้า (Customer WebApp)', icon: User, desc: 'เลือกกีฬา, เช็กคาบเวลา, สแกน QR & อัพสลิป' },
    { role: UserRole.STAFF, label: 'พนักงานเคาน์เตอร์ (Staff POS)', icon: Briefcase, desc: 'รับวอล์คอิน, แสตมป์สลิปโอน, เช่าแร็กเกต, ขายเครื่องดื่ม' },
    { role: UserRole.MANAGER, label: 'ผู้จัดการ (Manager)', icon: Users, desc: 'อนุญาตตัดยอดเงินคืน, ยกเลิกคอร์ท, เช็กยอด Ledger ปิดกล่อง' },
    { role: UserRole.ADMIN, label: 'ผู้บริหารสูงสุด (Admin Settings)', icon: Shield, desc: 'ตั้งค่า Engine เรทราคา Peak/วันธรรมดา, คุมสิทธิ์สตาฟ, ตรวจโกง' }
  ];

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800">
      
      {/* Prime Top Header */}
      <header className="bg-white border-b border-slate-100 sticky top-0 z-50 shadow-xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-col md:flex-row justify-between items-center gap-3">
          
          {/* Logo Brand */}
          <div className="flex items-center gap-2.5">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-emerald-800 to-emerald-600 flex items-center justify-center text-white shadow-md shadow-emerald-700/10 shrink-0">
              <span className="font-sans font-black text-sm tracking-widest leading-none">SC</span>
            </div>
            <div>
              <h1 id="brand-title" className="text-sm font-black text-slate-900 tracking-tight flex items-center gap-1 leading-none">
                SPORTS COMPLEX THAILAND
                <Sparkles className="h-4 w-4 text-amber-500 fill-amber-500" />
              </h1>
              <p className="text-[10px] text-slate-500 font-medium mt-0.5">จองสนามแบดมินตัน • บาสเกตบอล • พิกเคิลบอล • ห้องประชุม</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 text-xs font-semibold text-slate-600 select-none">
            <span className="flex items-center gap-1 font-mono text-slate-500 text-[11px] bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200">
              <Clock className="h-3.5 w-3.5 text-emerald-800" />
              เวลาประเทศไทย: <LiveClock />
            </span>
          </div>
        </div>
      </header>

      {/* Role switcher (demo / dev only - see SHOW_ROLE_SWITCHER) */}
      {SHOW_ROLE_SWITCHER && (
      <div className="bg-slate-900 text-white py-3 sm:py-6 border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-4">
          <div className="flex items-center gap-2 border-b border-slate-800 pb-2.5">
            <span className="bg-emerald-600 text-[11px] font-black tracking-widest px-2.5 py-1 rounded-md uppercase">Simulator Controls</span>
            <p className="hidden sm:block text-xs text-slate-400 font-semibold">คุณกำลังอยู่ในการจำลองระบบ คุณสามารถกดสลับบทบาทด้านล่างเพื่อทดสอบระบบหน้า-หลังได้อย่างอิสระ:</p>
          </div>

          {/* Interactive Role Toggle Grid */}
          <div id="role-switcher-grid" className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
            {ROLES_LIST.map((roleObj) => {
              const IconComp = roleObj.icon;
              const isSelected = currentRole === roleObj.role;
              return (
                <div
                  key={roleObj.role}
                  onClick={() => openScreen(roleObj.role)}
                  className={`p-2.5 sm:p-3.5 rounded-xl border text-left cursor-pointer transition select-none ${
                    isSelected 
                      ? 'bg-slate-800 border-emerald-600 ring-2 ring-emerald-600 text-white' 
                      : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <IconComp className={`h-4.5 w-4.5 shrink-0 ${isSelected ? 'text-emerald-400' : 'text-slate-500'}`} />
                    <span className={`text-xs font-bold ${isSelected ? 'text-white' : 'text-slate-300'}`}>{roleObj.label}</span>
                  </div>
                  <p className="hidden sm:block text-[10px] text-slate-500 mt-0.5 leading-snug">{roleObj.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      )}

      {/* API mode: one nav bar for everyone - booking, plus the counter and
          settings when the signed-in role may use them. */}
      {api.USE_BACKEND && (
        <nav id="main-nav" className="bg-white border-b border-slate-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex flex-wrap items-center gap-2 text-xs font-bold">
            <button type="button" onClick={() => openScreen(UserRole.CUSTOMER)} className={`px-3 py-1.5 rounded-lg ${currentRole === UserRole.CUSTOMER ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>🏸 จองสนาม</button>
            {canUseCounter(sessionUser) && (
              <button type="button" onClick={() => openScreen(UserRole.STAFF)} className={`px-3 py-1.5 rounded-lg ${currentRole === UserRole.STAFF || currentRole === UserRole.MANAGER ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>🧾 หน้าเคาน์เตอร์</button>
            )}
            {canUseSettings(sessionUser) && (
              <button type="button" onClick={() => openScreen(UserRole.ADMIN)} className={`px-3 py-1.5 rounded-lg ${currentRole === UserRole.ADMIN ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>⚙️ ตั้งค่า</button>
            )}
            <span className="ml-auto flex items-center gap-2 text-slate-500 font-semibold">
              {sessionUser ? (
                <>
                  <span>👤 {sessionUser.name}</span>
                  <button type="button" onClick={handleSignOut} className="text-slate-500 hover:text-slate-800 underline">ออกจากระบบ</button>
                </>
              ) : (
                <span>ยังไม่ได้เข้าสู่ระบบ</span>
              )}
            </span>
          </div>
        </nav>
      )}

      {/* Main Dynamic View Area */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        
        {/* Render Customer App */}
        {currentRole === UserRole.CUSTOMER && (
          <CustomerPanel 
            onAddAuditLog={handleAddNewAuditLog}
            triggerRefresh={refreshTrigger}
            onRefreshAll={triggerCompleteRefresh}
            onStaffSignIn={handleStaffSignIn}
          />
        )}

        <Suspense fallback={<p id="panel-loading" className="text-center text-sm text-slate-400 py-16">กำลังโหลด...</p>}>
        {/* Render Staff POS View */}
        {(currentRole === UserRole.STAFF || currentRole === UserRole.MANAGER) && (
          <StaffPOS
            currentUserRole={currentRole}
            onAddAuditLog={handleAddNewAuditLog}
            triggerRefresh={refreshTrigger}
            onRefreshAll={triggerCompleteRefresh}
          />
        )}

        {/* Render Admin Panel settings */}
        {currentRole === UserRole.ADMIN && (
          <AdminPanel
            onAddAuditLog={handleAddNewAuditLog}
            triggerRefresh={refreshTrigger}
            onRefreshAll={triggerCompleteRefresh}
          />
        )}
        </Suspense>

      </main>

      <DialogHost />

      {/* Footer Branding */}
      <footer className="bg-white border-t border-slate-100 py-6 text-center text-xs text-slate-400 text-slate-500">
        <p className="font-semibold text-slate-800">Sports Complex Management Thailand</p>
        <p className="text-[10px] mt-1 text-slate-400">{api.USE_BACKEND ? 'เชื่อมต่อเซิร์ฟเวอร์' : 'โหมดสาธิต: ข้อมูลเก็บในเบราว์เซอร์นี้เท่านั้น'}</p>
      </footer>

    </div>
  );
}
