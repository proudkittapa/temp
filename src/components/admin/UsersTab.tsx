import { UserRole, MemberType } from '../../types';
import { memberTierLabel } from '../../mockData';
import * as api from '../../api';
import { useAdminPanelContext } from './useAdminPanel';

export default function UsersTab() {
  const {
    adminUser,
    busy,
    canManageAccounts,
    guarded,
    handleAdjustPoints,
    handleCancelUserStage,
    handleDeleteUserByAdmin,
    handlePromoteUser,
    handleSaveUserPermissions,
    handleStageUserMemberType,
    handleStageUserRole,
    handleToggleUserActive,
    newUserRole,
    roles,
    setNewUserRole,
    setUserIdToPromote,
    setUserRoleFilter,
    setUserSearchQuery,
    setUserTierFilter,
    userIdToPromote,
    userPendingChanges,
    userRoleFilter,
    userSearchQuery,
    userTierFilter,
    users
  } = useAdminPanelContext();
  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-bold text-slate-900">แผงพนักงานเวร และระดับสิทธิ์สมาชิก (Staff & User Membership management)</h3>
          <p className="text-xs text-slate-500">แต่งตั้งสตาฟคุมคอร์ทจากรายชื่อผู้จอง ปรับสิทธิ์ส่วนลดพิเศษ และควบคุมเสถียรภาพระบบ</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Creator with promote logic */}
        <div className="col-span-1 lg:col-span-4 bg-slate-50 p-5 rounded-2xl border border-slate-200 h-fit space-y-4">
          <span className="text-xs font-black text-slate-800 block text-emerald-800 uppercase tracking-wider">👥 แต่งตั้งสตาฟ/เวรปฏิบัติการ</span>

          <p className="text-[11px] text-slate-500 leading-normal">
            เลือกผู้ใช้งานทั่วไปที่เคยลงทะเบียนเข้ามาร่วมก๊วน เพื่อเลื่อนสิทธิ์เป็นพนักงานปฏิบัติการ (Staff) หรือผู้บริหารระบบ โดยไม่ต้องสร้างข้อมูลซ้ำซ้อน
          </p>

          {!canManageAccounts ? (
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
              การแต่งตั้งพนักงาน เปลี่ยนบทบาท และระงับบัญชี ทำได้เฉพาะผู้ดูแลระบบ (Admin) ส่วนระดับสมาชิก (ส่วนลด) และแต้มสะสมแก้ไขได้ในตารางด้านขวา
            </p>
          ) : (
          <form onSubmit={e => { e.preventDefault(); void guarded(handlePromoteUser)(e); }} className="space-y-4 text-xs">
            <div>
              <label className="block text-slate-700 font-bold mb-1.5">ค้นหาเลือกจากผู้เล่นที่ลงไว้ในก๊วน:</label>
              {users.filter(u => u.role === UserRole.CUSTOMER).length === 0 ? (
                <div className="p-3 bg-slate-100 rounded-lg text-[10.5px] font-sans text-slate-600 border border-slate-200">
                  ⚠️ ขณะนี้ไม่มีลูกค้าที่เป็นบทบาท CUSTOMER ว่างเลย กรุณาลงทะเบียนที่หน้าสมัครแท็บลูกค้าก่อนค่ะ เพื่อนำมาเลื่อนระดับงาน
                </div>
              ) : (
                <select 
                  required
                  value={userIdToPromote}
                  onChange={(e) => setUserIdToPromote(e.target.value)}
                  className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg text-slate-800 font-medium"
                >
                  <option value="">-- กรุณาเลือกบัญชีผู้ใช้จริง --</option>
                  {users.filter(u => u.role === UserRole.CUSTOMER).map(u => (
                    <option key={u.id} value={u.id}>
                      👤 {u.name} (โทร {u.phone || 'ไม่ระบุ'}) - สิทธิ์ {u.memberType || 'NORMAL'}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label className="block text-slate-700 font-bold mb-1.5">ยศตำแหน่งเวรทำงานที่จะแต่งตั้ง (Assigned Role):</label>
              <select 
                value={newUserRole}
                onChange={(e) => setNewUserRole(e.target.value as UserRole)}
                className="w-full bg-white border border-slate-200 py-2 px-3 rounded-lg text-slate-800"
              >
                {roles.filter(r => r.id !== UserRole.CUSTOMER).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>

            <button 
              type="submit" 
              disabled={!userIdToPromote}
              className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-300 py-2.5 rounded-lg text-white font-bold transition shadow-sm"
            >
              🚀 ยืนยันสลับระดับแต่งตั้งพนักงาน
            </button>
          </form>
          )}
        </div>

        {/* Comprehensive Users list & management search */}
        <div className="col-span-1 lg:col-span-8 space-y-4">
          <span className="text-xs font-black text-slate-800 block uppercase tracking-wider">🗄️ ระบบบริหารสมุดรายชื่อสิทธิ์สมาชิกพอร์ทัล ({users.length} รายการ)</span>

          {/* Search Bar filter controls */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200">
            <div>
              <label className="block text-[10px] font-bold text-slate-500 mb-1">ค้นหาด่วนตามชื่อ/เบอร์/เมลล์:</label>
              <input
                type="text"
                placeholder="เช่น สมศักดิ์, 085..."
                value={userSearchQuery}
                onChange={(e) => setUserSearchQuery(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-lg py-1.5 px-2.5 text-xs text-slate-800 focus:outline-none focus:border-emerald-600"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-500 mb-1">คัดกรอง ยศบทบาทงาน:</label>
              <select
                value={userRoleFilter}
                onChange={(e) => setUserRoleFilter(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-lg py-1.5 px-2 text-xs text-slate-800"
              >
                <option value="">ทั้งหมด</option>
                <option value={UserRole.CUSTOMER}>CUSTOMER (ผู้ลงจองเอง)</option>
                <option value={UserRole.STAFF}>STAFF (สตาฟเวร)</option>
                <option value={UserRole.MANAGER}>MANAGER (ผู้จัดการ)</option>
                <option value={UserRole.ADMIN}>ADMIN (แอดมิน)</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-500 mb-1">สิทธิ์ระดับสมาชิก (MemberType):</label>
              <select
                value={userTierFilter}
                onChange={(e) => setUserTierFilter(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-lg py-1.5 px-2 text-xs text-slate-800"
              >
                <option value="">ทุกระดับ</option>
                {Object.values(MemberType).map(t => <option key={t} value={t}>{memberTierLabel(t)}</option>)}
              </select>
            </div>
          </div>

          <div className="border border-slate-200 rounded-xl overflow-hidden text-xs bg-white shadow-sm overflow-x-auto">
            <table className="w-full text-left text-slate-600 min-w-[700px]">
              <thead className="bg-slate-50 font-bold border-b border-slate-100 text-slate-800 text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="p-3">ข้อมูลโปรไฟล์หลัก / ล็อกอิน</th>
                  <th className="p-3">ระดับสิทธิ์และส่วนลด</th>
                  <th className="p-3">ยศเวรทำงาน (Role)</th>
                  <th className="p-3 text-center">🏆 แต้มสะสม CRM</th>
                  <th className="p-3 text-center">ปฏิบัติการและมาตรการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-sans">
                {users
                  .filter(item => {
                    const matchesSearch = !userSearchQuery || 
                      item.name.toLowerCase().includes(userSearchQuery.toLowerCase()) ||
                      (item.phone || '').includes(userSearchQuery) ||
                      (item.email || '').toLowerCase().includes(userSearchQuery.toLowerCase());

                    const matchesRole = !userRoleFilter || item.role === userRoleFilter;
                    // Tiers apply to customers; an account with none is NORMAL.
                    const matchesTier = !userTierFilter || (item.role === UserRole.CUSTOMER && (item.memberType ?? MemberType.NORMAL) === userTierFilter);
                    return matchesSearch && matchesRole && matchesTier;
                  })
                  .map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50/50 transition duration-150">
                      {/* Profile card column */}
                      <td className="p-3">
                        <div className="font-bold text-slate-900 text-xs">{item.name}</div>
                        <div className="text-[10px] text-slate-500 font-mono mt-0.5">เบอร์: {item.phone || 'ไม่ระบุ'}</div>
                        <div className="text-[9px] text-slate-400 mt-0.5">{item.email || 'ไม่มีอีเมล'}</div>
                      </td>

                      {/* Member type dropdown */}
                      <td className="p-3">
                        <select 
                          value={userPendingChanges[item.id]?.memberType ?? item.memberType ?? MemberType.NORMAL}
                          onChange={(e) => handleStageUserMemberType(item.id, e.target.value as MemberType)}
                          className={`border rounded py-1 px-1.5 text-[11px] font-medium text-slate-800 focus:outline-none focus:border-emerald-600 transition duration-150 ${
                            userPendingChanges[item.id]?.memberType !== undefined && userPendingChanges[item.id]?.memberType !== (item.memberType ?? MemberType.NORMAL)
                              ? 'bg-amber-50 border-amber-300 font-bold text-amber-900 ring-2 ring-amber-100'
                              : 'bg-slate-50 border-slate-200'
                          }`}
                        >
                          {[MemberType.NORMAL, MemberType.MEMBER, MemberType.STUDENT, MemberType.CORPORATE].map(t => (
                            <option key={t} value={t}>{memberTierLabel(t)}</option>
                          ))}
                        </select>
                        {userPendingChanges[item.id]?.memberType !== undefined && userPendingChanges[item.id]?.memberType !== (item.memberType ?? MemberType.NORMAL) && (
                          <span className="block text-[8px] font-black text-amber-700 mt-1 uppercase animate-pulse">⚠️ รอยืนยันเซฟ</span>
                        )}
                      </td>

                      {/* Role modifier selection */}
                      <td className="p-3">
                        <select 
                          value={userPendingChanges[item.id]?.role ?? item.role}
                          onChange={(e) => handleStageUserRole(item.id, e.target.value as UserRole)}
                          disabled={!canManageAccounts || item.id === adminUser?.id}
                          title={!canManageAccounts ? 'เปลี่ยนบทบาทได้เฉพาะผู้ดูแลระบบ (Admin)' : item.id === adminUser?.id ? 'เปลี่ยนบทบาทของตัวเองไม่ได้' : undefined}
                          className={`border rounded py-1 px-1.5 text-[11px] font-mono font-bold transition duration-150 ${
                            userPendingChanges[item.id]?.role !== undefined && userPendingChanges[item.id]?.role !== item.role
                              ? 'bg-amber-50 border-amber-300 text-amber-900 ring-2 ring-amber-100'
                              : 'bg-slate-50 border-slate-200 text-slate-800'
                          }`}
                        >
                          {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                          {!roles.some(r => r.id === item.role) && <option value={item.role}>{item.role}</option>}
                        </select>
                        {userPendingChanges[item.id]?.role !== undefined && userPendingChanges[item.id]?.role !== item.role && (
                          <span className="block text-[8px] font-black text-amber-700 mt-1 uppercase animate-pulse">⚠️ รอยืนยันเซฟ</span>
                        )}
                      </td>

                       {/* Points balance cell */}
                       <td className="p-3 text-center bg-amber-50/10 font-bold text-amber-600 font-mono text-xs">
                         {item.role === UserRole.CUSTOMER ? (
                           <div className="flex items-center justify-center gap-1.5 min-w-[110px]">
                             <button 
                               disabled={busy} onClick={guarded(() => handleAdjustPoints(item.id, -1))}
                               className="h-5 w-6 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded font-black text-xs flex items-center justify-center active:scale-90"
                               title="ลด 1 คะแนน"
                             >
                               -1
                             </button>
                             <span className="min-w-[40px] font-black text-amber-700">🏆 {item.points || 0}</span>
                             <button 
                               disabled={busy} onClick={guarded(() => handleAdjustPoints(item.id, 1))}
                               className="h-5 w-6 bg-[#fef3c7] hover:bg-amber-200 text-amber-800 rounded font-black text-xs flex items-center justify-center active:scale-90"
                               title="เพิ่ม 1 คะแนน"
                             >
                               +1
                             </button>
                           </div>
                         ) : (
                           <span className="text-slate-400 font-medium text-[10px]">- (เฉพาะผู้เล่น)</span>
                         )}
                       </td>

                      {/* Action Operations */}
                      <td className="p-3 flex flex-col items-center justify-center gap-1.5 min-w-[120px]">
                        {userPendingChanges[item.id] && (
                          userPendingChanges[item.id].role !== item.role || 
                          // an account with no tier is NORMAL - not a change
                          userPendingChanges[item.id].memberType !== (item.memberType ?? MemberType.NORMAL)
                        ) ? (
                          <div className="flex flex-col gap-1 w-full p-1 bg-amber-50/50 rounded border border-amber-200 shadow-xs">
                            <button
                              disabled={busy} onClick={guarded(() => handleSaveUserPermissions(item.id))}
                              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black py-1 px-2 rounded text-[9px] shadow-sm transition duration-150 flex items-center justify-center gap-1 active:scale-95"
                            >
                              💾 เซฟบันทึกสิทธิ์
                            </button>
                            <button
                              onClick={() => handleCancelUserStage(item.id)}
                              className="w-full bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold py-0.5 px-2 rounded text-[8px] transition duration-150 text-center"
                            >
                              ยกเลิก
                            </button>
                          </div>
                        ) : api.USE_BACKEND ? (
                          // No delete through the API: suspending keeps the
                          // account's bookings and points history.
                          canManageAccounts && item.id !== adminUser?.id ? (
                            <button
                              disabled={busy} onClick={guarded(() => handleToggleUserActive(item.id, item.isActive))}
                              className={`px-2.5 py-1 text-[9px] rounded-lg font-bold shadow-xs transition ${
                                item.isActive ? 'bg-emerald-100 text-emerald-800 hover:bg-amber-100 hover:text-amber-800' : 'bg-rose-100 text-rose-800 hover:bg-slate-200'
                              }`}
                            >
                              {item.isActive ? 'ใช้งาน' : 'ระงับชั่วคราว'}
                            </button>
                          ) : (
                            <span className="text-[9px] text-slate-400">{item.isActive ? 'ใช้งาน' : 'ระงับ'}</span>
                          )
                        ) : (
                          <div className="flex items-center gap-1">
                            <button
                              disabled={busy} onClick={guarded(() => handleToggleUserActive(item.id, item.isActive))}
                              className={`px-2.5 py-1 text-[9px] rounded-lg font-bold shadow-xs transition ${
                                item.isActive ? 'bg-emerald-100 text-emerald-800 hover:bg-amber-100 hover:text-amber-800' : 'bg-rose-100 text-rose-800 hover:bg-slate-200'
                              }`}
                            >
                              {item.isActive ? 'ใช้งาน' : 'ระงับชั่วคราว'}
                            </button>

                            {/* With the backend accounts are suspended, never deleted
                                (their bookings and payments must stay on record). */}
                            {!api.USE_BACKEND && <button
                              disabled={busy} onClick={guarded(() => handleDeleteUserByAdmin(item.id, item.name))}
                              className="bg-rose-50 hover:bg-rose-600 hover:text-white text-rose-700 font-bold p-1 rounded transition text-[10px]"
                              title="ลบข้อมูลถาวร"
                            >
                              🗑️ ลบไอดี
                            </button>}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
