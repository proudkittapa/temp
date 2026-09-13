import React, { useState, useEffect } from 'react';
import { UserRole, AuditLog } from './types';
import { initializeState, StorageService } from './mockData';
import CustomerPanel from './components/CustomerPanel';
import StaffPOS from './components/StaffPOS';
import AdminPanel from './components/AdminPanel';
import { Shield, Sparkles, User, Users, Briefcase, Star, Clock, Download } from 'lucide-react';

export default function App() {
  const [currentRole, setCurrentRole] = useState<UserRole>(UserRole.CUSTOMER);
  const [refreshTrigger, setRefreshTrigger] = useState<number>(0);
  const [currentUtcTime, setCurrentUtcTime] = useState<string>('');

  // Auto-initialize standard seed databases to localStorage on startup
  useEffect(() => {
    initializeState();
    triggerCompleteRefresh();
    
    // Aesthetic live clock showing current UTC time
    const updateTime = () => {
      const now = new Date();
      setCurrentUtcTime(now.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }));
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const triggerCompleteRefresh = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  // Helper function to append to Audit Log (Module 6 Anti-Fraud Compliance)
  const handleAddNewAuditLog = (action: string, targetType: AuditLog['targetType'], targetId: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null, reason?: string) => {
    const currentLogs = StorageService.get<AuditLog[]>('audit_logs', []);
    const newLog: AuditLog = {
      id: 'al-' + Date.now(),
      userId: currentRole === UserRole.CUSTOMER ? 'guest-customer' : 'current-user',
      userName: currentRole === UserRole.CUSTOMER ? 'ลูกค้าภายนอก (Customer)' : 
                currentRole === UserRole.STAFF ? 'คุณ กิตติ (Staff)' :
                currentRole === UserRole.MANAGER ? 'คุณ วิชัย (Manager)' : 'คุณ สมชาย (Admin)',
      action,
      targetType,
      targetId,
      before: before ?? undefined,
      after: after ?? undefined,
      reason,
      createdAt: new Date().toISOString()
    };

    StorageService.set('audit_logs', [newLog, ...currentLogs]);
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
              <p className="text-[10px] text-slate-500 font-medium mt-0.5">ระบบจัดการสนามแบด 12 • บาส 1 • พิคเคิล 3 • ห้องประชุม 1</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 text-xs font-semibold text-slate-600 select-none">
            <span className="flex items-center gap-1 font-mono text-slate-500 text-[11px] bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200">
              <Clock className="h-3.5 w-3.5 text-emerald-800" />
              เวลาเซิร์ฟเวอร์ประเทศไทย: {currentUtcTime || 'กำลังดึงเวลา...'}
            </span>
            <a
              href="/sports-complex-management-system.zip"
              download="sports-complex-management-system.zip"
              id="btn-download-project-zip"
              className="inline-flex items-center gap-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-[11px] font-bold px-3 py-1.5 rounded-lg shadow-xs hover:shadow transition duration-150 cursor-pointer"
              title="ดาวน์โหลดไฟล์โปรเจกต์ทั้งหมดเป็น .ZIP (Download Complete Project ZIP)"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download ZIP</span>
            </a>
          </div>
        </div>
      </header>

      {/* Interactive Role Switcher Segment (AI Studio reviewer testbed) */}
      <div className="bg-slate-900 text-white py-6 border-b border-slate-850">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-4">
          <div className="flex items-center gap-2 border-b border-slate-800 pb-2.5">
            <span className="bg-emerald-600 text-[9px] font-black tracking-widest px-2.5 py-1 rounded-md uppercase">Simulator Controls</span>
            <p className="text-xs text-slate-400 font-semibold">คุณกำลังอยู่ในการจำลองระบบ คุณสามารถกดสลับบทบาทด้านล่างเพื่อทดสอบระบบหน้า-หลังได้อย่างอิสระ:</p>
          </div>

          {/* Interactive Role Toggle Grid */}
          <div id="role-switcher-grid" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {ROLES_LIST.map((roleObj) => {
              const IconComp = roleObj.icon;
              const isSelected = currentRole === roleObj.role;
              return (
                <div
                  key={roleObj.role}
                  onClick={() => {
                    setCurrentRole(roleObj.role);
                    triggerCompleteRefresh();
                  }}
                  className={`p-3.5 rounded-xl border text-left cursor-pointer transition select-none ${
                    isSelected 
                      ? 'bg-slate-800 border-emerald-600 ring-2 ring-emerald-600 text-white' 
                      : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <IconComp className={`h-4.5 w-4.5 shrink-0 ${isSelected ? 'text-emerald-400' : 'text-slate-500'}`} />
                    <span className={`text-xs font-bold ${isSelected ? 'text-white' : 'text-slate-350'}`}>{roleObj.label}</span>
                  </div>
                  <p className="text-[10px] text-slate-500 mt-0.5 leading-snug">{roleObj.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Dynamic View Area */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        
        {/* Render Customer App */}
        {currentRole === UserRole.CUSTOMER && (
          <CustomerPanel 
            onAddAuditLog={handleAddNewAuditLog}
            triggerRefresh={refreshTrigger}
            onRefreshAll={triggerCompleteRefresh}
          />
        )}

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
            currentUserRole={currentRole}
            onAddAuditLog={handleAddNewAuditLog}
            triggerRefresh={refreshTrigger}
            onRefreshAll={triggerCompleteRefresh}
          />
        )}

      </main>

      {/* Footer Branding */}
      <footer className="bg-white border-t border-slate-100 py-6 text-center text-xs text-slate-405 text-slate-500">
        <p className="font-semibold text-slate-800">Sports Complex Management Thailand — 100% Client-Side Persistent Sandbox Execution</p>
        <p className="text-[10px] mt-1 text-slate-400">พัฒนาตรงเป้าตามรายละเอียดคู่มือความมั่นคงระบบ คลุมด้วยความมั่นคงต้านโกงสลิปสเตจและทรูอัลกอริทึมปิดกล่อง</p>
      </footer>

    </div>
  );
}
