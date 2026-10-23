import { Shift } from '../../types';
import { StorageService, formatBaht, roundBaht } from '../../mockData';
import * as api from '../../api';
import { notify, ask, askText } from '../Dialog';
import { can } from '../../permissions';
import type { StaffPOSCore } from './useStaffPOS';


// Cash-drawer shift: open, count and close; the cash-without-shift prompt.
export function useShiftActions(deps: StaffPOSCore) {
  const {
    actingUser,
    blindCount,
    countLocked,
    lastShiftCount,
    onAddAuditLog,
    onRefreshAll,
    setActivePosTab,
    setClosedShift,
    setCountLocked,
    setShift,
    setShiftCountInput,
    setShiftFloatInput,
    setShiftNote,
    setShiftOpenNote,
    shift,
    shiftCountInput,
    shiftFloatInput,
    shiftNote,
    shiftOpenNote
  } = deps;
  // Cash only with a drawer shift open (owner decision 2026-10-21): cash
  // taken outside a shift is in no shift's count, so the drawer never adds
  // up. The server refuses it too. Offers to go and open the shift.
  // Take staff to the shift box: switch tab, scroll it into view (on a
  // short screen it opens below the fold) and put the cursor in the float.
  const goOpenShift = () => {
    setActivePosTab('todays_total');
    setTimeout(() => {
      document.getElementById('shift-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      document.getElementById('shift-float')?.focus({ preventScroll: true });
    }, 50);
  };
  const confirmCashWithoutShift = async (): Promise<boolean> => {
    if (shift) return true;
    // A role without "shifts" can't see the drawer: the server decides
    // (it refuses cash with no shift open).
    if (api.USE_BACKEND && !can(actingUser, 'shifts')) return true;
    if (await ask('ต้องเปิดกะลิ้นชักก่อนรับเงินสด\nนับเงินทอนในลิ้นชัก แล้วกด "เปิดกะ" ที่แท็บ "ยอดลิ้นชักวันนี้"',
      { title: '⚠️ ยังไม่ได้เปิดกะ', okLabel: 'ไปเปิดกะ', cancelLabel: 'ปิด' })) {
      goOpenShift();
    }
    return false;
  };

  // Calculate Ledger parameters (Module 3 Specification). Booking money is
  // counted when it was received: in API mode from the server's day summary
  // (payments approved today by method, refunds recorded today); in
  // browser-only mode from localStorage. Completed and no-show hours count
  // as paid like confirmed ones.
  // Open the drawer shift with the counted float (FR-6.1).
  const handleOpenShift = () => {
    const float = Number(shiftFloatInput);
    if (shiftFloatInput.trim() === '' || !(float >= 0)) {
      notify('กรุณากรอกเงินทอนตั้งต้นในลิ้นชัก (บาท)');
      return;
    }
    // A float other than the last close's count (cash taken to the bank,
    // another drawer) is explained - the server refuses it otherwise.
    const note = shiftOpenNote.trim();
    if (lastShiftCount !== null && roundBaht(float) !== lastShiftCount && !note) {
      notify(`เงินทอนตั้งต้นไม่ตรงกับยอดที่นับได้ตอนปิดกะล่าสุด (${formatBaht(lastShiftCount)} บาท)\nกรุณาใส่หมายเหตุว่าทำไมไม่เท่ากัน เช่น นำเงินฝากธนาคาร`);
      return;
    }
    setClosedShift(null);
    const done = () => { setShiftFloatInput(''); setShiftOpenNote(''); onRefreshAll(); };
    if (api.USE_BACKEND) {
      return api.openShift(float, note).then(done).catch(err => notify(`เปิดกะไม่สำเร็จ: ${err.message}`));
    }
    const list = StorageService.get<Shift[]>('shifts', []);
    if (list.some(sh => !sh.closedAt)) { notify('มีกะที่เปิดอยู่แล้ว ปิดกะก่อน'); return; }
    const sh: Shift = { id: 'shf-' + Date.now(), staffId: 'u-staff-1', staffName: 'คุณ กิตติ (เดโม)', openedAt: new Date().toISOString(), openingFloat: roundBaht(float), openingNote: note || undefined };
    StorageService.set('shifts', [...list, sh]);
    onAddAuditLog('SHIFT_OPENED', 'Shift', sh.id, null, { openingFloat: sh.openingFloat, lastCount: lastShiftCount, note: note || undefined });
    done();
  };

  // Close it with the counted cash: expected vs counted = over/short (FR-6.2).
  const handleCloseShift = async () => {
    if (!shift) return;
    const counted = Number(shiftCountInput);
    if (shiftCountInput.trim() === '' || !(counted >= 0)) {
      notify('กรุณากรอกยอดเงินสดที่นับได้จริง');
      return;
    }
    if (blindCount) {
      // The count is committed before the expected amount is known; a
      // difference then needs a note, but the count stays as counted.
      if (!countLocked && !(await ask(`ยืนยันยอดเงินสดที่นับได้ ${formatBaht(counted)} บาท?\nหลังยืนยันจะแก้ยอดนับไม่ได้`, { title: 'ปิดกะ', okLabel: 'ยืนยันยอดนับ' }))) return;
      setCountLocked(true);
      return closeShiftWith(counted, shiftNote.trim());
    }
    // Managers see the expected amount. The one from the last load may be
    // stale (another counter took cash since) - confirm against the current one.
    let current = shift;
    if (api.USE_BACKEND) {
      try {
        const fresh = await api.currentShift();
        if (!fresh) { notify('กะนี้ถูกปิดไปแล้ว'); onRefreshAll(); return; }
        current = fresh;
        setShift(fresh);
      } catch (err) {
        notify(`โหลดยอดกะล่าสุดไม่สำเร็จ: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }
    const variance = roundBaht(counted - current.expected);
    if (variance !== 0 && !shiftNote.trim()) {
      notify(`ยอดนับ${variance > 0 ? 'เกิน' : 'ขาด'} ${formatBaht(Math.abs(variance))} บาท กรุณาใส่หมายเหตุอธิบาย`);
      return;
    }
    if (!(await ask(`ปิดกะ: คาดว่ามีเงินสด ${formatBaht(current.expected)} บาท นับได้ ${formatBaht(counted)} บาท (${variance === 0 ? 'ตรง' : variance > 0 ? `เกิน ${formatBaht(variance)}` : `ขาด ${formatBaht(-variance)}`})`, { okLabel: 'ปิดกะ' }))) return;
    return closeShiftWith(counted, shiftNote.trim());
  };

  // Closes with this count; a count that is off without a note asks for
  // the note (showing the difference) and tries again with the same count.
  const closeShiftWith = async (counted: number, note: string): Promise<void> => {
    if (!shift) return;
    const askNote = async (message: string) => {
      const n = await askText(`${message}\n(ยอดนับ ${formatBaht(counted)} บาท แก้ไม่ได้แล้ว)`, { title: 'ยอดนับไม่ตรง', okLabel: 'บันทึกและปิดกะ' });
      return n ? closeShiftWith(counted, n) : undefined;
    };
    const done = (closed: api.ShiftView) => {
      setClosedShift(closed);
      setShiftCountInput('');
      setShiftNote('');
      setCountLocked(false);
      onRefreshAll();
    };
    if (api.USE_BACKEND) {
      try {
        done(await api.closeShift(counted, note));
      } catch (err) {
        // Managers get the difference, blind staff only "doesn't match".
        if (err instanceof api.ApiError && /the count is .* off|the count doesn't match/i.test(err.serverMessage)) return askNote(err.message);
        notify(`ปิดกะไม่สำเร็จ: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }
    const variance = roundBaht(counted - shift.expected);
    if (variance !== 0 && !note) {
      // Blind staff aren't told by how much (as the server answers them):
      // the figure gives the expected cash away.
      return askNote(blindCount
        ? 'ยอดเงินที่นับไม่ตรง — ใส่หมายเหตุอธิบายส่วนต่าง'
        : `ยอดนับ${variance > 0 ? 'เกิน' : 'ขาด'} ${formatBaht(Math.abs(variance))} บาท กรุณาใส่หมายเหตุอธิบาย`);
    }
    const closedAt = new Date().toISOString();
    const closed: Shift = { ...shift, closedAt, countedCash: roundBaht(counted), expectedCash: shift.expected, varianceCash: variance, notes: note || undefined, closedByName: 'คุณ กิตติ (เดโม)' };
    StorageService.set('shifts', StorageService.get<Shift[]>('shifts', []).map(sh => sh.id === shift.id ? closed : sh));
    onAddAuditLog('SHIFT_CLOSED', 'Shift', shift.id, null, { expected: shift.expected, counted, variance });
    done({ ...shift, ...closed });
  };
  return {
    goOpenShift,
    confirmCashWithoutShift,
    handleOpenShift,
    handleCloseShift,
    closeShiftWith
  };
}
