import React, { useState } from 'react';
import * as api from '../api';
import { PERMISSIONS } from '../permissions';
import { UserRole } from '../types';
import { notify, ask } from './Dialog';

// Settings tab "สิทธิ์และบทบาท": roles are named permission sets. The four
// built-in roles start with the rights they always had; the admin can edit
// them (except that ADMIN keeps "manage roles") and create custom ones such
// as a cashier who only sells. The server enforces every rule here too.
export default function RolesTab({ roles, editable, onChanged, onAddAuditLog }: {
  roles: api.RoleView[];
  editable: boolean; // false in browser-only mode: built-in roles only
  onChanged: () => void;
  onAddAuditLog: (action: string, targetType: string, targetId: string, before?: any, after?: any) => void;
}) {
  const [editing, setEditing] = useState<{ id?: string; name: string; permissions: string[]; isBuiltin: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const startEdit = (r: api.RoleView) => setEditing({ id: r.id, name: r.name, permissions: [...r.permissions], isBuiltin: r.isBuiltin });
  const startNew = () => setEditing({ name: '', permissions: [], isBuiltin: false });
  const lockedPermission = (perm: string) => editing?.id === UserRole.ADMIN && perm === 'manage_roles';

  const toggle = (perm: string) => setEditing(e => e && ({
    ...e,
    permissions: e.permissions.includes(perm) ? e.permissions.filter(p => p !== perm) : [...e.permissions, perm]
  }));

  const save = async () => {
    if (!editing || saving) return;
    if (!editing.name.trim()) { notify('กรุณาตั้งชื่อบทบาท'); return; }
    setSaving(true);
    try {
      const saved = await api.saveRole({ id: editing.id, name: editing.name.trim(), permissions: editing.permissions });
      onAddAuditLog(editing.id ? 'ROLE_UPDATED' : 'ROLE_CREATED', 'Role', saved.id, null, { name: saved.name, permissions: saved.permissions });
      setEditing(null);
      onChanged();
      notify(`บันทึกบทบาท "${saved.name}" แล้ว - มีผลกับทุกบัญชีที่ใช้บทบาทนี้ทันที`);
    } catch (err) {
      notify(`บันทึกไม่สำเร็จ: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: api.RoleView) => {
    if (!(await ask(`ลบบทบาท "${r.name}"?`, { okLabel: 'ลบบทบาท', danger: true }))) return;
    try {
      await api.deleteRole(r.id);
      onAddAuditLog('ROLE_DELETED', 'Role', r.id, { name: r.name }, null);
      if (editing?.id === r.id) setEditing(null);
      onChanged();
    } catch (err) {
      notify(`ลบไม่สำเร็จ: ${(err as Error).message}`);
    }
  };

  return (
    <div id="roles-tab" className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-bold text-slate-900">🔐 สิทธิ์และบทบาท</h3>
          <p className="text-slate-500">บทบาทคือชุดสิทธิ์ - กำหนดบทบาทให้แต่ละบัญชีได้ที่แท็บ "บัญชีสตาฟเวร"</p>
        </div>
        {editable && (
          <button type="button" onClick={startNew} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg px-3 py-2">
            ➕ บทบาทใหม่
          </button>
        )}
      </div>
      {!editable && (
        <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          โหมดสาธิต (ไม่มีเซิร์ฟเวอร์): แสดงบทบาทพื้นฐานเท่านั้น สร้าง/แก้ไขบทบาทได้ในโหมด API
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-2">
          {roles.map(r => (
            <div key={r.id} className={`border rounded-xl p-3 flex items-start justify-between gap-2 ${editing?.id === r.id ? 'border-emerald-500 bg-emerald-50/40' : 'border-slate-200'}`}>
              <div className="min-w-0">
                <p className="font-bold text-slate-800">
                  {r.name} {r.isBuiltin && <span className="ml-1 text-[10px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">พื้นฐาน</span>}
                </p>
                <p className="text-[11px] text-slate-500">{r.permissions.length} สิทธิ์{editable ? ` · ${r.userCount} บัญชี` : ''}</p>
              </div>
              {editable && (
                <div className="flex gap-1 shrink-0">
                  <button type="button" onClick={() => startEdit(r)} className="text-sky-700 hover:text-sky-900 font-bold px-2 py-1">แก้ไข</button>
                  <button
                    type="button"
                    onClick={() => remove(r)}
                    disabled={r.isBuiltin || r.userCount > 0}
                    title={r.isBuiltin ? 'ลบบทบาทพื้นฐานไม่ได้' : r.userCount > 0 ? 'ยังมีบัญชีใช้บทบาทนี้อยู่' : undefined}
                    className="text-rose-700 hover:text-rose-900 font-bold px-2 py-1 disabled:text-slate-300"
                  >
                    ลบ
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {editing && (
          <div className="border border-slate-200 rounded-xl p-4 space-y-3">
            <p className="font-bold text-slate-800">{editing.id ? 'แก้ไขบทบาท' : 'บทบาทใหม่'}</p>
            <input
              value={editing.name}
              onChange={e => setEditing({ ...editing, name: e.target.value })}
              placeholder="ชื่อบทบาท เช่น แคชเชียร์"
              className="w-full border border-slate-300 rounded-lg px-3 py-2"
            />
            <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
              {PERMISSIONS.map(p => (
                <label key={p.id} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 ${lockedPermission(p.id) ? 'opacity-60' : 'hover:bg-slate-50 cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={editing.permissions.includes(p.id)}
                    disabled={lockedPermission(p.id)}
                    onChange={() => toggle(p.id)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-bold text-slate-800">{p.label}</span>
                    <span className="block text-[11px] text-slate-500">{lockedPermission(p.id) ? 'บทบาท Admin ต้องมีสิทธิ์นี้เสมอ' : p.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={save} disabled={saving} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg px-4 py-2 disabled:opacity-60">
                บันทึก
              </button>
              <button type="button" onClick={() => setEditing(null)} className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg px-4 py-2">
                ยกเลิก
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
