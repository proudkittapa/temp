import React from 'react';
import * as api from '../../api';
import { canUseSettings } from '../../permissions';
import type { AdminPanelCore } from './useAdminPanel';


// Admin sign-in and sign-out.
export function useAdminSession(deps: AdminPanelCore) {
  const {
    adminIdentity,
    adminPassword,
    setActiveAdminTab,
    setAdminApiError,
    setAdminIdentity,
    setAdminPassword,
    setAdminUser
  } = deps;
  const handleAdminLogout = () => {
    api.logout('admin');
    setAdminUser(null);
    setActiveAdminTab('dashboard');
  };

  const handleAdminLogin = (e: React.FormEvent) => {
    e.preventDefault();
    adminLoginWith(adminIdentity, adminPassword);
  };

  const adminLoginWith = (identity: string, password: string) => {
    setAdminApiError(null);
    api.login('admin', identity, password)
      .then(user => {
        if (!canUseSettings(user)) {
          setAdminApiError('บัญชีนี้ไม่มีสิทธิ์ใช้หน้าตั้งค่า - เข้าสู่ระบบด้วยบัญชีผู้จัดการหรือผู้บริหาร');
          return;
        }
        setAdminUser(user);
        setAdminIdentity('');
        setAdminPassword('');
      })
      .catch(err => setAdminApiError(err.message));
  };
  return {
    handleAdminLogout,
    handleAdminLogin,
    adminLoginWith
  };
}
