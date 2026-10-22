import React from 'react';
import {
  Court, BookingStatus, DayOff
} from '../../types';
import { StorageService, formatBaht } from '../../mockData';
import * as api from '../../api';
import { notify, ask, askText } from '../Dialog';
import type { AdminPanelCore } from './useAdminPanel';


// Courts and days off (closures).
export function useCourtActions(deps: AdminPanelCore) {
  const {
    courts,
    newCourtAllowHalf,
    newCourtHalfOf,
    newCourtName,
    newCourtType,
    newDayOffCourtId,
    newDayOffDate,
    newDayOffEndHour,
    newDayOffIsFullDay,
    newDayOffReason,
    newDayOffStartHour,
    onAddAuditLog,
    onRefreshAll,
    setCourts,
    setDaysOff,
    setNewCourtAllowHalf,
    setNewCourtHalfOf,
    setNewCourtName,
    setNewDayOffDate,
    setNewDayOffEndHour,
    setNewDayOffIsFullDay,
    setNewDayOffReason,
    setNewDayOffStartHour
  } = deps;
  // Court Management functions
  const handleCreateCourt = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCourtName) return;
    // A half court shares a full court's floor: it must name that court, so
    // booking one blocks the other (as on the server).
    const fullCourt = newCourtAllowHalf ? courts.find(c => c.id === newCourtHalfOf && c.type === newCourtType && c.shareOfGroup >= 1) : undefined;
    if (newCourtAllowHalf && !fullCourt) {
      notify('ครึ่งสนามต้องเลือกว่าเป็นครึ่งของสนามเต็มสนามใด (ประเภทเดียวกัน)');
      return;
    }
    if (api.USE_BACKEND) {
      return api.createCourt({ name: newCourtName, type: newCourtType, halfCourt: newCourtAllowHalf, halfOf: fullCourt?.id })
        .then(c => {
          onAddAuditLog('COURT_CREATED', 'Court', c.id, null, c);
          setNewCourtName('');
          setNewCourtAllowHalf(false);
          setNewCourtHalfOf('');
          onRefreshAll();
          notify(`เพิ่มสนาม "${c.name}" แล้ว ลูกค้าและพนักงานจองได้ทันที`);
        })
        .catch(err => notify(`เพิ่มสนามไม่สำเร็จ: ${err.message}`));
    }
    const current = StorageService.get<Court[]>('courts', []);
    const cId = newCourtType.toLowerCase().substring(0, 3) + '-' + (current.length + 1) + '-' + Math.floor(100 + Math.random() * 900);
    const newC: Court = {
      id: cId,
      name: newCourtName,
      type: newCourtType,
      // A half court joins its full court's group (made on the spot if the
      // full court had none), priced at the half-court rate.
      shareOfGroup: newCourtAllowHalf ? 0.5 : 1,
      mutexGroupId: fullCourt ? (fullCourt.mutexGroupId || `grp-${fullCourt.id}`) : undefined,
      isActive: true,
      createdAt: new Date().toISOString()
    };
    const updated = [...current.map(c => fullCourt && c.id === fullCourt.id && !c.mutexGroupId ? { ...c, mutexGroupId: newC.mutexGroupId } : c), newC];
    StorageService.set('courts', updated);
    setCourts(updated);
    onAddAuditLog('COURT_CREATED', 'Court', newC.id, null, newC);
    setNewCourtName('');
    setNewCourtAllowHalf(false);
    setNewCourtHalfOf('');
    onRefreshAll();
    notify(`เพิ่มสนามกีฬา "${newC.name}" เข้าสู่คอมเพล็กซ์สำเร็จเรียบร้อยค่ะ!`);
  };

  // Rename a court (e.g. to match the signs on site). The id - which
  // bookings point at - never changes, so existing bookings keep working.
  const handleRenameCourt = async (id: string) => {
    const court = courts.find(c => c.id === id);
    if (!court) return;
    const name = (await askText(`ชื่อใหม่ของ "${court.name}"`, { title: 'เปลี่ยนชื่อสนาม', defaultValue: court.name, required: true, okLabel: 'บันทึกชื่อ' }))?.trim();
    if (!name || name === court.name) return;
    if (courts.some(c => c.id !== id && c.name.trim().toLowerCase() === name.toLowerCase())) {
      notify(`มีสนามชื่อ "${name}" อยู่แล้ว กรุณาใช้ชื่ออื่น`);
      return;
    }
    if (api.USE_BACKEND) {
      return api.updateCourt(id, { name })
        .then(r => {
          onAddAuditLog('COURT_RENAMED', 'Court', id, { name: court.name }, { name: r.court.name });
          onRefreshAll();
          notify(`เปลี่ยนชื่อเป็น "${r.court.name}" แล้ว`);
        })
        .catch(err => notify(`เปลี่ยนชื่อไม่สำเร็จ: ${err.message}`));
    }
    const updated = StorageService.get<Court[]>('courts', []).map(c => c.id === id ? { ...c, name } : c);
    StorageService.set('courts', updated);
    setCourts(updated);
    onAddAuditLog('COURT_RENAMED', 'Court', id, { name: court.name }, { name });
    onRefreshAll();
  };

  // Open/close a court for new bookings. Courts are never deleted: old
  // bookings and reports point at them.
  const handleToggleCourtActive = async (id: string) => {
    if (api.USE_BACKEND) {
      const court = courts.find(c => c.id === id);
      if (!court) return;
      if (court.isActive && !(await ask(`ปิด "${court.name}" ไม่ให้จองใหม่?\n(การจองที่มีอยู่แล้วจะถามต่อว่าจะยกเลิกหรือไม่)`, { okLabel: 'ปิดสนาม', danger: true }))) return;
      return api.updateCourt(id, { isActive: !court.isActive })
        .then(async r => {
          onAddAuditLog('COURT_TOGGLED_ACTIVE', 'Court', id, { active: court.isActive }, { active: r.court.isActive });
          onRefreshAll();
          if (r.upcoming.length > 0) {
            // The court takes no new bookings; offer to cancel the ones it
            // still has (FR-6.3), recording a refund for paid hours.
            const list = r.upcoming.map(b => `- ${b.date} ${b.startTime}–${b.endTime} ${b.userName} (${b.bookingCode})${b.status === BookingStatus.PENDING_PAYMENT ? ' ยังไม่ชำระ' : ''}`).join('\n');
            if (!(await ask(`ปิด "${r.court.name}" แล้ว แต่ยังมีการจอง ${r.upcoming.length} รายการ:\n${list}\n\nยกเลิกทั้งหมดเลยไหม? รายการที่ชำระแล้ว (หรือส่งสลิปแล้ว) จะถูกบันทึกว่าคืนเงิน (โอนคืนลูกค้าเอง)`, { title: 'การจองบนสนามที่ปิด', okLabel: 'ยกเลิกทั้งหมด', cancelLabel: 'เก็บไว้ ติดต่อลูกค้าเอง', danger: true }))) return;
            return (async () => {
              let refunded = 0, failed = 0;
              for (const b of r.upcoming) {
                try {
                  // refund=true: the server records a refund only of money it received
                  // (paid hours, or a slip still waiting), and ignores it otherwise.
                  const res = await api.cancelBooking(b.id, `ปิดสนาม ${r.court.name}`, true, [b.id], 'admin');
                  refunded += res.refundAmount;
                } catch {
                  failed++;
                }
              }
              onAddAuditLog('COURT_CLOSED_BOOKINGS_CANCELLED', 'Court', id, null, { cancelled: r.upcoming.length - failed, refunded });
              onRefreshAll();
              notify(`ยกเลิก ${r.upcoming.length - failed} รายการแล้ว${refunded ? ` · ต้องโอนคืนลูกค้ารวม ${formatBaht(refunded)} บาท` : ''}${failed ? ` · ไม่สำเร็จ ${failed} รายการ` : ''}`);
            })();
          }
        })
        .catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }
    const current = StorageService.get<Court[]>('courts', []);
    const updated = current.map(c => {
      if (c.id === id) {
        const nextState = !c.isActive;
        onAddAuditLog('COURT_TOGGLED_ACTIVE', 'Court', id, { active: c.isActive }, { active: nextState });
        return { ...c, isActive: nextState };
      }
      return c;
    });
    StorageService.set('courts', updated);
    setCourts(updated);
    onRefreshAll();
  };

  // DayOff / Special Holidays Settings functions
  const handleSaveDayOff = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDayOffDate || !newDayOffReason) return;
    
    if (!newDayOffIsFullDay && newDayOffStartHour >= newDayOffEndHour) {
      notify('⚠️ เวลาเริ่มต้นจะต้องน้อยกว่าเวลาสิ้นสุดการปิดบริการค่ะ กรุณากรอกใหม่');
      return;
    }

    if (api.USE_BACKEND) {
      return api.createDayOff({
        date: newDayOffDate,
        courtId: newDayOffCourtId,
        reason: newDayOffReason,
        isFullDay: newDayOffIsFullDay,
        startHour: newDayOffIsFullDay ? undefined : newDayOffStartHour,
        endHour: newDayOffIsFullDay ? undefined : newDayOffEndHour
      })
        .then(async ({ dayOff, affectedBookings }) => {
          onAddAuditLog('DAY_OFF_CREATED', 'DayOff', dayOff.id, null, dayOff);
          setNewDayOffDate('');
          setNewDayOffReason('');
          setNewDayOffIsFullDay(true);
          setNewDayOffStartHour(7);
          setNewDayOffEndHour(22);
          onRefreshAll();
          // A closure blocks new bookings only; existing ones still stand.
          const affectedNote = affectedBookings.length > 0
            ? `\n\n⚠️ มีการจองเดิม ${affectedBookings.length} รายการในช่วงเวลาที่ปิด (ยังไม่ถูกยกเลิก) กรุณาติดต่อลูกค้า:\n` +
              affectedBookings.map(b => `- ${courts.find(c => c.id === b.courtId)?.name || b.courtId} ${b.startTime}–${b.endTime} (${b.bookingCode})`).join('\n')
            : '';
          notify('บันทึกปิดบริการ/ระงับการจองวันหยุดพิเศษเรียบร้อยแล้วค่ะ!' + affectedNote);
          // Offer to cancel the overlapped bookings right away (FR-6.3),
          // recording a refund for hours that were already paid.
          const active = affectedBookings.filter(b => b.status === BookingStatus.CONFIRMED || b.status === BookingStatus.PENDING_PAYMENT);
          if (active.length > 0 && await ask(`ยกเลิกการจองที่ได้รับผลกระทบ ${active.length} รายการเลยไหม?\nรายการที่ชำระแล้ว (หรือส่งสลิปแล้ว) จะถูกบันทึกว่าคืนเงิน (โอนคืนลูกค้าเอง)`, { okLabel: 'ยกเลิกทั้งหมด', cancelLabel: 'เก็บไว้', danger: true })) {
            return (async () => {
              let refunded = 0, failed = 0;
              for (const b of active) {
                try {
                  // refund=true: the server records a refund only of money it received
                  // (paid hours, or a slip still waiting), and ignores it otherwise.
                  const res = await api.cancelBooking(b.id, `ปิดสนาม: ${dayOff.reason}`, true, [b.id], 'admin');
                  refunded += res.refundAmount;
                } catch {
                  failed++;
                }
              }
              onAddAuditLog('DAY_OFF_BOOKINGS_CANCELLED', 'DayOff', dayOff.id, null, { cancelled: active.length - failed, refunded });
              onRefreshAll();
              notify(`ยกเลิก ${active.length - failed} รายการแล้ว${refunded ? ` · ต้องโอนคืนลูกค้ารวม ${formatBaht(refunded)} บาท` : ''}${failed ? ` · ไม่สำเร็จ ${failed} รายการ` : ''}`);
            })();
          }
        })
        .catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }

    const current = StorageService.get<DayOff[]>('days_off', []);
    const newDay: DayOff = {
      id: 'do-' + Date.now(),
      date: newDayOffDate,
      courtId: newDayOffCourtId,
      reason: newDayOffReason,
      isFullDay: newDayOffIsFullDay,
      startHour: newDayOffIsFullDay ? undefined : newDayOffStartHour,
      endHour: newDayOffIsFullDay ? undefined : newDayOffEndHour
    };
    const updated = [...current, newDay];
    StorageService.set('days_off', updated);
    setDaysOff(updated);
    onAddAuditLog('DAY_OFF_CREATED', 'DayOff', newDay.id, null, newDay);
    
    setNewDayOffDate('');
    setNewDayOffReason('');
    setNewDayOffIsFullDay(true);
    setNewDayOffStartHour(7);
    setNewDayOffEndHour(22);
    onRefreshAll();
    notify('บันทึกปิดบริการ/ระงับการจองวันหยุดพิเศษเรียบร้อยแล้วค่ะ!');
  };

  const handleDeleteDayOff = async (id: string) => {
    if (!(await ask('ลบวันปิดนี้ และเปิดให้จองตามปกติ?', { okLabel: 'ลบวันปิด' }))) return;
    if (api.USE_BACKEND) {
      return api.deleteDayOff(id)
        .then(() => {
          onAddAuditLog('DAY_OFF_DELETED', 'DayOff', id, null, null);
          onRefreshAll();
          notify('ปลดบล็อกช่วงวันหยุดพิเศษและเปิดให้บริการปกติแล้วค่ะ');
        })
        .catch(err => notify(`ลบไม่สำเร็จ: ${err.message}`));
    }
    const current = StorageService.get<DayOff[]>('days_off', []);
    const updated = current.filter(item => item.id !== id);
    StorageService.set('days_off', updated);
    setDaysOff(updated);
    onAddAuditLog('DAY_OFF_DELETED', 'DayOff', id, null, null);
    onRefreshAll();
    notify('ปลดบล็อกช่วงวันหยุดพิเศษและเปิดให้บริการปกติแล้วค่ะ');
  };
  return {
    handleCreateCourt,
    handleRenameCourt,
    handleToggleCourtActive,
    handleSaveDayOff,
    handleDeleteDayOff
  };
}
