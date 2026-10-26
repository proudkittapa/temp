import React from 'react';
import { MemberType, User, UserRole } from '../../types';
import { StorageService, normalizePhone, getTodayDateStr } from '../../mockData';
import * as api from '../../api';
import { canUseCounter, canUseSettings } from '../../permissions';
import { notify, ask } from '../Dialog';
import type { CustomerPanelCore } from './useCustomerPanel';


// Customer account: sign in, register, forgot password, sign out, delete account.
export function useAccountActions(deps: CustomerPanelCore) {
  const {
    authEmail,
    authName,
    authPassword,
    authPhone,
    clearCustomerScreen,
    loggedInUser,
    onAddAuditLog,
    onRefreshAll,
    onStaffSignIn,
    setActiveStep,
    setAuthEmail,
    setAuthError,
    setAuthName,
    setAuthPassword,
    setAuthPhone,
    setForgotResult,
    setLoggedInUser
  } = deps;
  // Customer Auth Function Handlers
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    return loginWith(authEmail, authPassword);
  };

  // Shared by the login form and the dev-only demo account buttons.
  const loginWith = async (identity: string, password: string) => {
    setAuthError(null);
    setForgotResult(null);

    if (api.USE_BACKEND) {
      await api.login('customer', identity, password)
        .then(user => {
          setAuthEmail('');
          setAuthPassword('');
          if (onStaffSignIn && (canUseCounter(user) || canUseSettings(user))) {
            onStaffSignIn(user);
            return;
          }
          setLoggedInUser(user);
          onAddAuditLog('CUSTOMER_LOGIN_SUCCESS', 'User', user.id, null, { name: user.name, role: user.role });
          setAuthEmail('');
          setAuthPassword('');
          onRefreshAll();
        })
        .catch(err => setAuthError(`❌ ${err.message}`));
      return;
    }

    const allUsers = StorageService.get<User[]>('users', []);
    const foundUser = allUsers.find(
      u => (u.email?.toLowerCase() === identity.toLowerCase() || (!identity.includes('@') && normalizePhone(u.phone) === normalizePhone(identity))) && u.role === UserRole.CUSTOMER
    );

    if (!foundUser) {
      setAuthError('❌ ไม่พบบัญชีผู้ใช้งานที่ระบุ หรือรหัสผ่านไม่ถูกต้อง (กรุณาใช้เบอร์โทร หรือ อีเมลที่สมัครในระบบ)');
      return;
    }

    if (foundUser.password !== password) {
      setAuthError('❌ รหัสผ่านไม่ถูกต้อง กรุณากรอกใหม่อีกครั้ง');
      return;
    }

    if (!foundUser.isActive) {
      setAuthError('❌ บัญชีสิทธิ์นี้ถูกระงับติดต่อสตาฟร้านเพื่อเปิดใช้งานอีกครั้ง');
      return;
    }

    // Success login
    StorageService.set('current_logged_in_customer', foundUser);
    onAddAuditLog('CUSTOMER_LOGIN_SUCCESS', 'User', foundUser.id, null, { name: foundUser.name, role: foundUser.role });
    
    // reset form states
    setAuthEmail('');
    setAuthPassword('');
    setAuthError(null);
    onRefreshAll();
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setForgotResult(null);

    if (!authName || !authPhone || !authPassword) {
      setAuthError('❌ กรุณาใส่ชื่อ เบอร์โทร และรหัสผ่าน');
      return;
    }
    if (authPassword.length < 6) {
      setAuthError('❌ รหัสผ่านต้องมีอย่างน้อย 6 ตัว');
      return;
    }

    if (api.USE_BACKEND) {
      await api.register({ name: authName, email: authEmail.trim(), phone: authPhone, password: authPassword })
        .then(user => {
          setLoggedInUser(user);
          setAuthEmail('');
          setAuthPassword('');
          setAuthName('');
          setAuthPhone('');
          onRefreshAll();
          notify('🎉 สมัครสมาชิกและเข้าสู่ระบบสำเร็จ! ระดับบัญชีของคุณเริ่มต้นที่ "ลูกค้าทั่วไป" 🌟');
        })
        .catch(err => setAuthError(`❌ ${err.message}`));
      return;
    }

    const allUsers = StorageService.get<User[]>('users', []);
    const emailExists = !!authEmail.trim() && allUsers.some(u => u.email?.toLowerCase() === authEmail.trim().toLowerCase());
    const phoneExists = allUsers.some(u => normalizePhone(u.phone) === normalizePhone(authPhone));

    if (emailExists) {
      setAuthError('❌ อีเมลนี้มีอยู่ในระบบแล้ว กรุณาเข้าสู่ระบบแทน');
      return;
    }
    if (phoneExists) {
      setAuthError('❌ เบอร์โทรศัพท์นี้ถูกลงทะเบียนไว้แล้ว กรุณาใช้เบอร์อื่นหรือกู้รหัสผ่าน');
      return;
    }

    // Create custom student/member metadata based on preference (Always default to NORMAL as requested, admin must promote/assign discount tier)
    const newId = 'u-cust-' + Date.now();
    const newUserObj: User = {
      id: newId,
      name: authName,
      email: authEmail,
      phone: authPhone,
      role: UserRole.CUSTOMER,
      memberType: MemberType.NORMAL,
      isActive: true,
      createdAt: getTodayDateStr(),
      password: authPassword
    };

    const updatedUsersList = [...allUsers, newUserObj];
    StorageService.set('users', updatedUsersList);
    StorageService.set('current_logged_in_customer', newUserObj);

    onAddAuditLog('CUSTOMER_REGISTER_SUCCESS', 'User', newId, null, { name: authName, memberType: MemberType.NORMAL });

    // reset forms
    setAuthEmail('');
    setAuthPassword('');
    setAuthName('');
    setAuthPhone('');
    
    onRefreshAll();
    notify('🎉 สมัครสมาชิกก๊วนและเข้าสู่ระบบสำเร็จ! ระดับบัญชีของคุณเริ่มต้นที่ "ลูกค้าทั่วไป" (สามารถติดต่อเจ้าหน้าที่สตาฟ ณ ร้านเพื่อยืนยันหลักฐานรับสิทธิ์ส่วนลดพิเศษได้ภายหลังค่ะ) 🌟');
  };

  const handleForgotPassword = (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setForgotResult(null);

    if (!authEmail) {
      setAuthError('❌ กรุณากรอกเบอร์โทรหรืออีเมลเพื่อยืนยันสิทธิ์ค้นหา');
      return;
    }

    // The backend only stores password hashes, so there is nothing to look
    // up - and revealing a password on screen was only ever a demo shortcut.
    if (api.USE_BACKEND) {
      setForgotResult('ℹ️ ระบบไม่สามารถแสดงรหัสผ่านเดิมได้ กรุณาติดต่อเจ้าหน้าที่ที่เคาน์เตอร์เพื่อรีเซ็ตรหัสผ่านค่ะ');
      return;
    }

    const allUsers = StorageService.get<User[]>('users', []);
    const foundUser = allUsers.find(
      u => (u.email?.toLowerCase() === authEmail.toLowerCase() || u.phone === authEmail) && u.role === UserRole.CUSTOMER
    );

    if (!foundUser) {
      setAuthError('❌ ไม่พบบัญชีผู้ใช้งานทีมีเบอร์โทรหรืออีเมลนี้ในสารบบของเราค่ะ');
      return;
    }

    // Output password successfully to bypass mock limits!
    setForgotResult(`✅ ค้นหาสำเร็จ! บัญชีของคุณ "${foundUser.name}" มีรหัสผ่านคือ "${foundUser.password}" และมีสิทธิ์ระดับ "${foundUser.memberType || 'ทั่วไป'}" \nกรุณาใช้รหัสนี้เข้าสู่ระบบได้ทันทีค่ะ`);
    onAddAuditLog('CUSTOMER_PASSWORD_RECOVERY_TRIGGERED', 'User', foundUser.id, null, null);
  };

  const handleLogout = () => {
    onAddAuditLog('CUSTOMER_LOGOUT', 'User', loggedInUser?.id || '', null, null);
    localStorage.removeItem('sports_complex_current_logged_in_customer');
    api.logout('customer');
    setLoggedInUser(null);
    clearCustomerScreen();
    onRefreshAll();
  };

  const handleDeleteAccount = async () => {
    if (!loggedInUser) return;
    if (api.USE_BACKEND) {
      notify('การลบบัญชีผ่านระบบยังไม่เปิดให้บริการ กรุณาติดต่อเจ้าหน้าที่ค่ะ');
      return;
    }
    if (!(await ask(`ลบบัญชี "${loggedInUser.name}" ถาวร?\nแต้ม สิทธิ์ส่วนลด และประวัติของคุณจะหายไป และกู้คืนไม่ได้`, { title: '⚠️ ลบบัญชี', okLabel: 'ลบบัญชีถาวร', cancelLabel: 'ไม่ลบ', danger: true }))) return;

    // Perform permanent removal
    const allUsers = StorageService.get<User[]>('users', []);
    const filteredUsers = allUsers.filter(u => u.id !== loggedInUser.id);
    StorageService.set('users', filteredUsers);
    
    // Add audit log for compliance
    onAddAuditLog('CUSTOMER_ACCOUNT_DELETED_BY_SELF', 'User', loggedInUser.id, loggedInUser, null);

    // Logout
    localStorage.removeItem('sports_complex_current_logged_in_customer');
    setLoggedInUser(null);
    setActiveStep(1);
    onRefreshAll();
    notify('🗑️ ดำเนินการลบบัญชีของคุณออกจากเซิร์ฟเวอร์เรียบร้อยแล้วค่ะ หวังว่าจะมีโอกาสได้กลับมาบริการท่านอีกครั้งนะคะ ขอบคุณค่ะ');
  };
  return {
    handleLogin,
    loginWith,
    handleRegister,
    handleForgotPassword,
    handleLogout,
    handleDeleteAccount
  };
}
