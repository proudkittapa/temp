import { MemberType, UserRole } from '../../types';
import * as api from '../../api';
import { Settings, Users } from 'lucide-react';
import { useAdminPanelContext } from './useAdminPanel';

export default function MemberDiscountsTab() {
  const {
    busy,
    editingDiscounts,
    guarded,
    handleSaveDiscountTier,
    handleStageDiscountField,
    memberDiscounts,
    setEditingDiscounts,
    userSearchQuery,
    users,
    usersHasMore
  } = useAdminPanelContext();
  // API mode loads one page of users (searched on the server), so the
  // counts are of that page: "N+" when more exist, none while a search
  // narrows the list.
  const countsPartial = api.USE_BACKEND && usersHasMore;
  const countsHidden = api.USE_BACKEND && !!userSearchQuery.trim();
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
          <Settings className="h-5 w-5 text-emerald-600 animate-pulse" />
          ระบบจัดการระดับสิทธิ์สมาชิกอัจฉริยะ (Membership & Privilege Engine)
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          กำหนดระดับสิทธิ์สมาชิก (Membership Tiers) และสัดส่วนค่าเปอร์เซ็นต์ส่วนลดในการใช้บริการสนามและห้องประชุม 
          เมื่อมีลูกค้าที่ครอบครองสิทธิ์ประเภทนั้นทำการจอง ระบบคำนวณราคา Price Engine จะใช้อัตรานี้โดยอัตโนมัติ
        </p>
      </div>

      <div className="bg-slate-50 rounded-2xl border border-slate-200/60 p-4 space-y-4">
        <h4 className="text-xs font-black text-slate-600 flex items-center gap-2 uppercase tracking-wider">
          💡 คำแนะนำสิทธิ์การลดราคานักกีฬา:
        </h4>
        <ul className="list-disc list-inside text-[11px] text-slate-600 space-y-1.5 pl-1 leading-relaxed">
          <li>
            <span className="font-bold text-slate-800">ลูกค้าทั่วไป (NORMAL):</span> โดยปกติจะตั้งเป็น 0% เพื่อเป็นจุดตั้งต้นในการคิดราคามาตรฐาน (เปลี่ยนชื่อตามต้องการได้)
          </li>
          <li>
            <span className="font-bold text-slate-800">การยกเลิกสิทธิ์ชั่วคราว:</span> หากท่านสลับสถานะเป็น <b>"ระงับใช้งานสิทธิ์"</b> ลูกค้าที่มีเกณฑ์สิทธิ์ดังกล่าวจะไม่ได้รับส่วนลดใดๆ (คิดอ้างอิงเป็นราคาลูกค้าระดับทั่วไปแทน)
          </li>
          <li>
            <span className="font-bold text-slate-800">การคำนวณราคาขั้นสูง:</span> ระบบตรวจจับทุจริตแบบเรียลไทม์จะตรวจสอบมูลค่าส่วนลดและพฤติกรรมการแก้ไข เปรียบเทียบย้อนหลังในตะกร้า Audit Log ทันทีที่กดเซฟสล็อตสิทธิ์
          </li>
        </ul>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-xs">
        <div className="p-4 bg-slate-900 text-white flex justify-between items-center">
          <span className="text-xs font-bold font-mono">🌟 บูธปรับแต่งระดับสิทธิ์ (Privilege Tier Configuration)</span>
          <span className="text-[10px] bg-emerald-600 text-white font-extrabold px-2 py-0.5 rounded uppercase font-sans">
            Engine: Active
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-100 border-b border-slate-200 text-slate-600 font-extrabold text-[10.5px]">
                <th className="p-3.5">🔑 ID รหัสระบบ</th>
                <th className="p-3.5">🏷️ ชื่อเรียกสิทธิ์ระดับสมาชิก (Display Title)</th>
                <th className="p-3.5 w-1/5">💰 ส่วนลดเป็นเปอร์เซ็นต์ (%)</th>
                <th className="p-3.5 text-center">🎯 สถานะเปิดใช้</th>
                <th className="p-3.5 text-center">👥 จำนวนบัญชีที่ครองสิทธิ์</th>
                <th className="p-3.5 text-center w-[150px]">⚙️ เซฟบันทึก</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {memberDiscounts.map((tier) => {
                const staged = editingDiscounts[tier.id];
                const currentName = staged?.name ?? tier.name;
                const currentPercent = staged?.discountPercent ?? tier.discountPercent;
                const currentIsActive = staged?.isActive ?? tier.isActive;

                const isStaged = staged !== undefined && (
                  staged.name !== tier.name ||
                  staged.discountPercent !== tier.discountPercent ||
                  staged.isActive !== tier.isActive
                );

                // Calculate how many users currently belong to this Membership Type
                // Customers only: staff accounts have no tier.
                const userCount = users.filter(u => u.role === UserRole.CUSTOMER).filter(u => {
                  if (tier.id === MemberType.NORMAL) {
                    return !u.memberType || u.memberType === MemberType.NORMAL;
                  }
                  return u.memberType === tier.id;
                }).length;

                return (
                  <tr 
                    key={tier.id} 
                    className={`hover:bg-slate-50/55 transition duration-155 ${
                      isStaged ? 'bg-amber-50/30' : ''
                    }`}
                  >
                    {/* ID Code Badge */}
                    <td className="p-3.5 font-mono">
                      <span className="bg-slate-200 text-slate-800 text-[10px] font-black px-2 py-0.5 rounded-lg">
                        {tier.id}
                      </span>
                    </td>

                    {/* Editable Display Name */}
                    <td className="p-3.5">
                      <input 
                        type="text"
                        value={currentName}
                        onChange={(e) => handleStageDiscountField(tier.id, 'name', e.target.value)}
                        className={`w-full max-w-xs border rounded px-2 py-1 text-xs outline-none transition focus:border-emerald-500 ${
                          isStaged ? 'border-amber-400 bg-amber-50 font-bold' : 'border-slate-200 bg-white'
                        }`}
                        placeholder="เช่น ลูกค้าทัวร์นาเมนต์ VIP"
                      />
                      {isStaged && staged.name !== tier.name && (
                        <span className="block text-[11px] text-amber-600 font-bold mt-1">
                          (เดิม: {tier.name})
                        </span>
                      )}
                    </td>

                    {/* Editable Percent Discount */}
                    <td className="p-3.5">
                      <div className="flex items-center gap-1.5">
                        <input 
                          type="number"
                          min="0"
                          max="100"
                          value={currentPercent}
                          onChange={(e) => handleStageDiscountField(tier.id, 'discountPercent', e.target.value)}
                          className={`w-16 border rounded px-2 py-1 text-xs outline-none transition font-bold font-mono text-center focus:border-emerald-500 ${
                            isStaged ? 'border-amber-400 bg-amber-50 font-extrabold focus:bg-amber-100' : 'border-slate-200 bg-white'
                          }`}
                        />
                        <span className="text-slate-500 font-bold">%</span>
                      </div>
                      {isStaged && staged.discountPercent !== tier.discountPercent && (
                        <span className="block text-[11px] text-amber-600 font-bold mt-1">
                          (เดิม: {tier.discountPercent}%)
                        </span>
                      )}
                    </td>

                    {/* Toggle Active status */}
                    <td className="p-3.5 text-center">
                      <select
                        value={currentIsActive ? 'ACTIVE' : 'INACTIVE'}
                        onChange={(e) => handleStageDiscountField(tier.id, 'isActive', e.target.value === 'ACTIVE')}
                        className={`border rounded py-1 px-2 text-[10.5px] font-bold outline-none transition ${
                          currentIsActive 
                            ? 'bg-emerald-50 border-emerald-300 text-emerald-800' 
                            : 'bg-rose-50 border-rose-300 text-rose-800'
                        } ${isStaged ? 'ring-2 ring-amber-100' : ''}`}
                      >
                        <option value="ACTIVE">🟢 เปิดใช้งาน</option>
                        <option value="INACTIVE">🔴 ปิดระงับสิทธิ์</option>
                      </select>
                    </td>

                    {/* Active Occupants stats */}
                    <td className="p-3.5 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <Users className="h-3.5 w-3.5 text-slate-400" />
                        <span className="font-extrabold text-slate-800 font-mono">
                          {countsHidden ? '—' : `${userCount}${countsPartial ? '+' : ''}`} บัญชี
                        </span>
                      </div>
                    </td>

                    {/* Save operations */}
                    <td className="p-3.5 text-center">
                      {isStaged ? (
                        <div className="flex flex-col gap-1 items-center">
                          <button
                            disabled={busy} onClick={guarded(() => handleSaveDiscountTier(tier.id))}
                            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black py-1 px-2.5 rounded-lg text-[11px] shadow-sm transition flex items-center justify-center gap-1"
                          >
                            💾 เซฟส่วนลดใหม่
                          </button>
                          <button
                            onClick={() => {
                              setEditingDiscounts(prev => {
                                const copy = { ...prev };
                                delete copy[tier.id];
                                return copy;
                              });
                            }}
                            className="text-[10px] text-slate-500 hover:underline block"
                          >
                            ยกเลิก
                          </button>
                        </div>
                      ) : (
                        <span className="text-[10px] text-slate-400 font-medium">บันทึกเรียบร้อย</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
