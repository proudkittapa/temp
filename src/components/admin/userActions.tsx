import React from 'react';
import {
  User, UserRole, MemberType, LedgerEntryType
} from '../../types';
import { StorageService, memberTierLabel } from '../../mockData';
import * as api from '../../api';
import { notify, ask, askText } from '../Dialog';
import type { AdminPanelCore } from './useAdminPanel';


// Staff and customer accounts: roles, member tier, active, points.
export function useUserActions(deps: AdminPanelCore) {
  const {
    adminUser,
    newUserRole,
    onAddAuditLog,
    onRefreshAll,
    setUserIdToPromote,
    setUserPendingChanges,
    setUsers,
    userIdToPromote,
    userPendingChanges,
    users
  } = deps;
  // User Management actions (Promote existing registered users to staff operator role)
  const handlePromoteUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userIdToPromote) {
      notify('🔒 กรุณาเลือกผู้ใช้ที่มีในระบบเพื่อใช้ลากเลื่อนระดับสิทธิ์ปฏิบัติงานเวร!');
      return;
    }

    if (api.USE_BACKEND) {
      const before = users.find(u => u.id === userIdToPromote);
      await api.setUserRole(userIdToPromote, newUserRole)
        .then(updated => {
          setUsers(prev => prev.map(u => (u.id === updated.id ? updated : u)));
          onAddAuditLog('USER_PROMOTED_TO_OPERATOR_BY_ADMIN', 'User', updated.id, before ?? null, updated);
          setUserIdToPromote('');
          onRefreshAll();
          notify(`🎉 เลื่อนสิทธิ์ให้คุณ "${updated.name}" เป็น "${updated.role}" เรียบร้อยแล้วค่ะ!`);
        })
        .catch(err => notify(`เลื่อนสิทธิ์ไม่สำเร็จ: ${err.message}`));
      return;
    }

    const currentUsers = StorageService.get<User[]>('users', []);
    const foundIdx = currentUsers.findIndex(u => u.id === userIdToPromote);
    
    if (foundIdx === -1) {
      notify('ไม่พบผู้ใช้ที่ท่านระบุในสารบบ!');
      return;
    }

    const userToPromote = currentUsers[foundIdx];
    const beforeUser = { ...userToPromote };
    
    // Promote user role
    userToPromote.role = newUserRole;
    currentUsers[foundIdx] = userToPromote;
    
    StorageService.set('users', currentUsers);
    setUsers(currentUsers);

    onAddAuditLog('USER_PROMOTED_TO_OPERATOR_BY_ADMIN', 'User', userIdToPromote, beforeUser, userToPromote);
    
    setUserIdToPromote('');
    onRefreshAll();
    notify(`🎉 เลื่อนสิทธิ์ให้คุณ "${userToPromote.name}" ขึ้นสู่ตำแหน่ง "${newUserRole}" ในสังกัดของคลับเรียบร้อยแล้วค่ะ!`);
  };

  const handleDeleteUserByAdmin = async (id: string, name: string) => {
    const confirmDelete = await ask(`ลบบัญชี "${name}" ถาวร?\nสิทธิ์และส่วนลดของบัญชีนี้จะหายไป (โหมดสาธิต)`, { title: '⚠️ ลบบัญชี', okLabel: 'ลบบัญชี', danger: true });
    if (!confirmDelete) return;

    const currentUsers = StorageService.get<User[]>('users', []);
    const filtered = currentUsers.filter(u => u.id !== id);

    StorageService.set('users', filtered);
    setUsers(filtered);

    onAddAuditLog('USER_DELETED_BY_ADMIN', 'User', id, { name }, null);
    onRefreshAll();
    notify('ลบบัญชีและทำลายสิทธิ์ของผู้ใช้งานเรียบร้อยแล้วค่ะ');
  };

  // Stage memberType (discount tier) modifications locally
  const handleStageUserMemberType = (id: string, type: MemberType) => {
    const userObj = users.find(u => u.id === id);
    if (!userObj) return;
    setUserPendingChanges(prev => ({
      ...prev,
      [id]: {
        role: prev[id]?.role ?? userObj.role,
        memberType: type
      }
    }));
  };

  // Stage userRole modifications locally
  const handleStageUserRole = (id: string, role: UserRole) => {
    const userObj = users.find(u => u.id === id);
    if (!userObj) return;
    setUserPendingChanges(prev => ({
      ...prev,
      [id]: {
        role: role,
        memberType: prev[id]?.memberType ?? userObj.memberType ?? MemberType.NORMAL
      }
    }));
  };

  // Commit and write modified permissions/roles to the database with detailed Audit Logging
  const handleSaveUserPermissions = (id: string) => {
    const target = userPendingChanges[id];
    if (!target) return;

    if (api.USE_BACKEND) {
      // The server prices bookings with the tier stored there, so it must
      // be changed there. Roles can't be changed from the panel yet.
      const before = users.find(u => u.id === id);
      if (!before) return;
      // Role first (admin only), then the tier (only customers have one).
      const roleStep = target.role !== before.role
        ? api.setUserRole(id, target.role)
        : Promise.resolve(before);
      roleStep
        .then(afterRole => (target.memberType !== (afterRole.memberType ?? MemberType.NORMAL) && afterRole.role === UserRole.CUSTOMER
          ? api.setMemberType(id, target.memberType)
          : afterRole))
        .then(updated => {
          setUsers(prev => prev.map(u => (u.id === id ? updated : u)));
          onAddAuditLog('USER_PERMISSIONS_SAVED_BY_ADMIN', 'User', id,
            { name: before.name, role: before.role, memberType: before.memberType },
            { name: updated.name, role: updated.role, memberType: updated.memberType });
          setUserPendingChanges(prev => {
            const copy = { ...prev };
            delete copy[id];
            return copy;
          });
          onRefreshAll();
          notify(`💾 บันทึกสิทธิ์ของ "${updated.name}" แล้ว: ${updated.role} · ${memberTierLabel(updated.memberType)}`);
        })
        .catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
      return;
    }

    const currentUsers = StorageService.get<User[]>('users', []);
    const foundIdx = currentUsers.findIndex(u => u.id === id);
    if (foundIdx === -1) {
      notify('ไม่พบบัญชีผู้ใช้เป้าหมาย!');
      return;
    }

    const beforeUser = { ...currentUsers[foundIdx] };
    const afterUser = { 
      ...beforeUser, 
      role: target.role, 
      memberType: target.memberType 
    };

    currentUsers[foundIdx] = afterUser;
    StorageService.set('users', currentUsers);
    setUsers(currentUsers);

    // Save customized audit log with specific targetType 'User'
    // Log the before and after state as JSON snapshot for verification
    onAddAuditLog(
      'USER_PERMISSIONS_SAVED_BY_ADMIN', 
      'User', 
      id, 
      { 
        name: beforeUser.name, 
        role: beforeUser.role, 
        memberType: beforeUser.memberType || MemberType.NORMAL 
      }, 
      { 
        name: afterUser.name, 
        role: afterUser.role, 
        memberType: afterUser.memberType 
      }
    );

    // Remove from pending cache list
    setUserPendingChanges(prev => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });

    onRefreshAll();
    notify(`บันทึกสิทธิ์ของ "${afterUser.name}" เรียบร้อยแล้ว\n\n• ระดับสมาชิก: ${beforeUser.memberType || 'NORMAL'} ➔ ${afterUser.memberType}\n• บทบาท: ${beforeUser.role} ➔ ${afterUser.role}`);
  };

  // Discard pending changes
  const handleCancelUserStage = (id: string) => {
    setUserPendingChanges(prev => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
  };

  const handleToggleUserActive = async (id: string, currentlyActive: boolean) => {
    if (api.USE_BACKEND) {
      await api.setUserActive(id, !currentlyActive)
        .then(updated => {
          setUsers(prev => prev.map(u => (u.id === id ? updated : u)));
          onAddAuditLog('USER_STATUS_TOGGLED', 'User', id, { isActive: currentlyActive }, { isActive: updated.isActive });
          onRefreshAll();
        })
        .catch(err => notify(`เปลี่ยนสถานะไม่สำเร็จ: ${err.message}`));
      return;
    }
    const currentUsers = StorageService.get<User[]>('users', []);
    const updated = currentUsers.map(u => u.id === id ? { ...u, isActive: !currentlyActive } : u);

    StorageService.set('users', updated);
    setUsers(updated);

    onAddAuditLog('USER_STATUS_TOGGLED', 'User', id, { isActive: currentlyActive }, { isActive: !currentlyActive });
    onRefreshAll();
  };

  const handleAdjustPoints = async (userId: string, diff: number) => {
    if (api.USE_BACKEND) {
      // Points live in the backend's ledger; a manual change needs a reason
      // (it is audit-logged with it).
      const reason = await askText(`เหตุผลในการ${diff > 0 ? 'เพิ่ม' : 'ลด'}แต้ม ${Math.abs(diff)} แต้ม (จำเป็น):`, { title: 'ปรับแต้ม' });
      if (!reason) return;
      return api.adjustPoints(userId, diff, reason)
        .then(balance => {
          setUsers(prev => prev.map(u => (u.id === userId ? { ...u, points: balance } : u)));
          onAddAuditLog('USER_POINTS_ADJUSTED_BY_ADMIN', 'User', userId, null, { diff, reason });
          onRefreshAll();
        })
        .catch(err => notify(`ปรับแต้มไม่สำเร็จ: ${err.message}`));
    }
    // Through the points ledger, so the change is in the customer's points
    // history like every other one.
    const reason = await askText(`เหตุผลในการ${diff > 0 ? 'เพิ่ม' : 'ลด'}แต้ม ${Math.abs(diff)} แต้ม (จำเป็น):`, { title: 'ปรับแต้ม' });
    if (!reason) return;
    const applied = StorageService.addLedgerEntry(userId, LedgerEntryType.ADJUST_MANUAL, diff, adminUser?.id || 'admin', { note: reason });
    setUsers(StorageService.get<User[]>('users', []));
    // Points never go below 0: a cut on an empty balance changes nothing,
    // so nothing is logged.
    if (applied === 0) { notify('แต้มเป็น 0 อยู่แล้ว ไม่มีอะไรเปลี่ยน'); return; }

    onAddAuditLog('USER_POINTS_ADJUSTED_BY_ADMIN', 'User', userId, null, { diff: applied, reason });
    onRefreshAll();
  };
  return {
    handlePromoteUser,
    handleDeleteUserByAdmin,
    handleStageUserMemberType,
    handleStageUserRole,
    handleSaveUserPermissions,
    handleCancelUserStage,
    handleToggleUserActive,
    handleAdjustPoints
  };
}
