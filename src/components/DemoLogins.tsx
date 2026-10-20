// One-click logins for the seeded demo accounts (mockData.ts DEFAULT_USERS,
// and the backend's SEED_DEMO_USERS), so local testing doesn't mean typing
// credentials or registering. Only rendered by the Vite dev server
// (`npm run dev` / `npm run dev:api`); production builds never show it.

export interface DemoAccount {
  label: string;
  phone: string;
}

export const DEMO_PASSWORD = '123456';

export const DEMO_CUSTOMERS: DemoAccount[] = [
  { label: 'นักเรียน (Student)', phone: '0856789012' },
  { label: 'สมาชิก (Member)', phone: '0845678901' }
];
export const DEMO_STAFF: DemoAccount[] = [{ label: 'สตาฟ (Staff)', phone: '0834567890' }];
export const DEMO_ADMINS: DemoAccount[] = [
  { label: 'ผู้บริหาร (Admin)', phone: '0812345678' },
  { label: 'ผู้จัดการ (Manager)', phone: '0823456789' }
];

export default function DemoLogins({ accounts, onPick, dark = false }: {
  accounts: DemoAccount[];
  onPick: (phone: string, password: string) => void;
  dark?: boolean;
}) {
  if (!import.meta.env.DEV) return null;
  return (
    <div className={`rounded-lg border border-dashed p-2 space-y-1.5 ${dark ? 'border-slate-700' : 'border-slate-300'}`}>
      <p className={`text-[10px] font-bold ${dark ? 'text-slate-400' : 'text-slate-500'}`}>⚡ ทดสอบด่วน (dev only) — เข้าสู่ระบบด้วยบัญชีตัวอย่าง:</p>
      <div className="flex flex-wrap gap-1.5">
        {accounts.map(a => (
          <button
            key={a.phone}
            type="button"
            onClick={() => onPick(a.phone, DEMO_PASSWORD)}
            className={`text-[10px] font-bold px-2.5 py-1 rounded-md transition ${dark ? 'bg-slate-800 hover:bg-slate-700 text-emerald-300' : 'bg-slate-100 hover:bg-slate-200 text-emerald-800'}`}
          >
            {a.label} · {a.phone}
          </button>
        ))}
      </div>
    </div>
  );
}
