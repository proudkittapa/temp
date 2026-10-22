import React from 'react';
import * as api from '../../api';
import { canUseCounter } from '../../permissions';
import type { StaffPOSCore } from './useStaffPOS';


// Staff sign-in and sign-out at the counter.
export function useStaffSession(deps: StaffPOSCore) {
  const {
    setCartItems,
    setCartSuccessAlert,
    setClosedShift,
    setCountLocked,
    setDaySummary,
    setGridError,
    setPendingWalkin,
    setRejectId,
    setRejectReason,
    setReviewQueue,
    setSeenSlip,
    setSelectedReceiptBooking,
    setSelectedReceiptOrder,
    setShift,
    setShiftHistory,
    setStaffApiError,
    setStaffIdentity,
    setStaffPassword,
    setStaffUser,
    setTodayBookingsApi,
    setVoucherCode,
    setVoucherError,
    setVoucherFound,
    setWalkinSuccessAlert,
    staffIdentity,
    staffPassword
  } = deps;
  const handleStaffLogin = (e: React.FormEvent) => {
    e.preventDefault();
    staffLoginWith(staffIdentity, staffPassword);
  };

  const staffLoginWith = (identity: string, password: string) => {
    setStaffApiError(null);
    api.login('staff', identity, password)
      .then(user => {
        if (!canUseCounter(user)) {
          setStaffApiError('บัญชีนี้ไม่มีสิทธิ์ใช้หน้าเคาน์เตอร์ - เข้าสู่ระบบด้วยบัญชีพนักงาน');
          return;
        }
        setStaffUser(user);
        setStaffIdentity('');
        setStaffPassword('');
      })
      .catch(err => setStaffApiError(err.message));
  };

  // Nothing of the last staff member's session is left on screen for the
  // next one.
  const handleStaffLogout = () => {
    api.logout('staff');
    setStaffUser(null);
    setReviewQueue([]);
    setSeenSlip({});
    setGridError(null);
    setStaffApiError(null);
    setDaySummary(null);
    setTodayBookingsApi([]);
    setShift(null);
    setShiftHistory([]);
    setClosedShift(null);
    setCountLocked(false);
    setPendingWalkin(null);
    setSelectedReceiptBooking(null);
    setSelectedReceiptOrder(null);
    setCartItems([]);
    setVoucherCode('');
    setVoucherFound(null);
    setVoucherError(null);
    setRejectId(null);
    setRejectReason('');
    setWalkinSuccessAlert(null);
    setCartSuccessAlert(null);
  };
  return {
    handleStaffLogin,
    staffLoginWith,
    handleStaffLogout
  };
}
