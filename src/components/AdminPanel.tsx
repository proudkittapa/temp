import * as api from '../api';
import { notify } from './Dialog';
import DemoLogins, { DEMO_ADMINS } from './DemoLogins';
import RolesTab from './RolesTab';
import { Settings } from 'lucide-react';
import { useAdminPanel, AdminPanelContext, AdminPanelProps, ADMIN_TABS } from './admin/useAdminPanel';
import { Suspense } from 'react';
// The dashboard's chart library loads on demand, fetched together with this
// panel so it shows at once (screens.ts).
import { DashboardTab } from '../screens';
import PricingTab from './admin/PricingTab';
import CourtsTab from './admin/CourtsTab';
import ProductsTab from './admin/ProductsTab';
import UsersTab from './admin/UsersTab';
import ReportsTab from './admin/ReportsTab';
import AuditLogTab from './admin/AuditLogTab';
import MemberDiscountsTab from './admin/MemberDiscountsTab';

export default function AdminPanel(props: AdminPanelProps) {
  const s = useAdminPanel(props);
  const {
    activeAdminTab,
    adminApiError,
    adminIdentity,
    adminLoginWith,
    adminPassword,
    adminTabAllowed,
    adminUser,
    busy,
    handleAdminLogin,
    handleAdminLogout,
    onAddAuditLog,
    onRefreshAll,
    roleName,
    roles,
    setActiveAdminTab,
    setAdminIdentity,
    setAdminPassword,
    setRoles
  } = s;
  // API mode: the settings here act as a manager/admin, so sign in first
  // (separately from the customer and staff logins in the same browser).
  if (api.USE_BACKEND && !adminUser) {
    return (
      <div className="max-w-sm mx-auto my-10 bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <form onSubmit={handleAdminLogin} className="space-y-3 text-xs">
          <p className="text-sm font-bold text-slate-800">เข้าสู่ระบบผู้จัดการ / ผู้บริหาร</p>
          {adminApiError && (
            <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">⚠️ {adminApiError}</p>
          )}
          <input value={adminIdentity} onChange={e => setAdminIdentity(e.target.value)} placeholder="เบอร์โทร หรือ อีเมลผู้จัดการ" className="w-full border border-slate-300 rounded-lg px-3 py-2" required />
          <input type="password" value={adminPassword} onChange={e => setAdminPassword(e.target.value)} placeholder="รหัสผ่าน" className="w-full border border-slate-300 rounded-lg px-3 py-2" required />
          <button type="submit" disabled={busy} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg py-2">เข้าสู่ระบบ</button>
          <DemoLogins accounts={DEMO_ADMINS} onPick={adminLoginWith} />
        </form>
      </div>
    );
  }

  return (
    <AdminPanelContext.Provider value={s}>
    <div className="space-y-6">
      {/* A failed load leaves older data on screen - say so on every tab. */}
      {api.USE_BACKEND && adminApiError && (
        <p id="admin-load-error" role="alert" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-2">
          ⚠️ โหลดข้อมูลล่าสุดไม่สำเร็จ ข้อมูลที่เห็นอาจไม่เป็นปัจจุบัน: {adminApiError}{' '}
          <button type="button" onClick={onRefreshAll} className="underline font-bold">ลองใหม่</button>
        </p>
      )}

      {/* Admin header layout with visual privilege banner */}
      <div className="bg-slate-900 text-white p-5 rounded-2xl flex flex-wrap items-center justify-between gap-4 shadow-md border border-slate-800">
        <div>
          <h2 className="text-sm font-bold flex items-center gap-1.5 text-emerald-400">
            <Settings className="h-5 w-5 animate-spin-slow text-emerald-400" />
            บอร์ดบริหารคอมเพล็กซ์ระบบอัจฉริยะ (Manager & Administrator Console)
          </h2>
          <p className="text-[10px] text-slate-400 mt-1">ผู้เข้าใช้ระดับพรีเมียม: ยินดีต้อนรับกลับสิทธิ์บริหารระดับสูงสุดของคุณ</p>
          {/* API mode: who is signed in, and a way to switch accounts (e.g.
              from the manager to the admin account) - there was none. */}
          {api.USE_BACKEND && adminUser && (
            <p className="text-[11px] text-slate-300 mt-1">
              เข้าสู่ระบบในนาม <span className="font-bold text-white">{adminUser.name}</span> ({roleName(adminUser.role)})
              <button type="button" onClick={handleAdminLogout} className="ml-2 underline text-slate-400 hover:text-white">ออกจากระบบ</button>
            </p>
          )}
        </div>

        {/* Dashboard quick navigation links */}
        <div id="admin-navbar" className="flex flex-wrap gap-1 bg-slate-800 p-1.5 rounded-xl border border-slate-700 text-xs">
          {ADMIN_TABS.filter(t => adminTabAllowed(t.id)).map(t => (
            <button
              key={t.id}
              onClick={() => setActiveAdminTab(t.id)}
              className={`px-3 py-1.5 rounded-lg ${activeAdminTab === t.id ? 'bg-emerald-600 text-white font-bold' : 'text-slate-300 hover:text-white'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Container workspace */}
      <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm min-h-[400px]">
        
        {/* Sub Module 1: Main Dashboard (Recharts Visuals) */}
        {activeAdminTab === 'dashboard' && adminTabAllowed('dashboard') && (
          <Suspense fallback={<p className="text-center text-sm text-slate-400 py-16">กำลังโหลดแดชบอร์ด...</p>}><DashboardTab /></Suspense>
        )}

        {/* Sub Module 2: Pricing Engine configurations */}
        {activeAdminTab === 'pricing' && adminTabAllowed('pricing') && <PricingTab />}

        {/* Sub Module 2.5: Manage Courts and Special Holidays */}
        {activeAdminTab === 'courts' && adminTabAllowed('courts') && <CourtsTab />}

        {/* Sub Module 3: Product catalogue & inventory management */}
        {activeAdminTab === 'products' && adminTabAllowed('products') && <ProductsTab />}

        {/* Sub Module 4: Users accounts roles */}
        {activeAdminTab === 'users' && adminTabAllowed('users') && <UsersTab />}

        {/* Sub Module 5: Consolidated reports downloadable excel simulated CSV */}
        {activeAdminTab === 'reports' && adminTabAllowed('reports') && <ReportsTab />}

        {/* Sub Module 6: Anti-Fraud Audit LOG interactive system (Anti-Fraud and DB track specifications) */}
        {activeAdminTab === 'roles' && adminTabAllowed('roles') && (
          <RolesTab
            roles={roles}
            editable={api.USE_BACKEND}
            onChanged={() => api.listRoles().then(setRoles).catch(err => notify(`โหลดบทบาทไม่สำเร็จ: ${err.message}`))}
            onAddAuditLog={onAddAuditLog}
          />
        )}

        {activeAdminTab === 'audit_logs' && adminTabAllowed('audit_logs') && <AuditLogTab />}

        {/* Sub Module: Membership Tiers & Discounts (dynamic management of privileges) */}
        {activeAdminTab === 'member_discounts' && adminTabAllowed('member_discounts') && <MemberDiscountsTab />}

      </div>
    </div>
    </AdminPanelContext.Provider>
  );
}
