import React from 'react';
import { CourtType, PricingRule, DayType, MemberType, PricingConfig } from '../../types';
import { StorageService, lastBookableDate, noShowRules } from '../../mockData';
import * as api from '../../api';
import { notify, ask } from '../Dialog';
import type { AdminPanelCore } from './useAdminPanel';


// Pricing: rules, opening hours, booking window, business details, member-tier discounts.
export function usePricingActions(deps: AdminPanelCore) {
  const {
    business,
    businessFrom,
    closeHourSetting,
    editingDiscounts,
    editingRuleId,
    filterCourtType,
    filterDayType,
    filterLabel,
    filterPriceType,
    maxAdvanceDays,
    noShowGraceSetting,
    noShowResaleSetting,
    memberDiscounts,
    onAddAuditLog,
    onRefreshAll,
    openHourSetting,
    pricingRules,
    ruleCourtType,
    ruleDayType,
    ruleEndHour,
    ruleLabel,
    rulePrice,
    rulePriceType,
    ruleStartHour,
    setBusiness,
    setEditingDiscounts,
    setEditingRuleId,
    setMemberDiscounts,
    setPricingRules,
    setRuleLabel,
    setRulePrice
  } = deps;
  const handleStageDiscountField = (id: string, field: 'name' | 'discountPercent' | 'isActive', value: string | boolean) => {
    setEditingDiscounts(prev => {
      const current = prev[id] || {
        name: memberDiscounts.find(d => d.id === id)?.name || '',
        discountPercent: memberDiscounts.find(d => d.id === id)?.discountPercent || 0,
        isActive: memberDiscounts.find(d => d.id === id)?.isActive ?? true
      };
      
      let processedVal: string | number | boolean = value;
      if (field === 'discountPercent') {
        // Below 100%: a free booking would need a 0.00 THB PromptPay QR,
        // which banking apps reject (the server enforces the same limit).
        processedVal = Math.min(99, Math.max(0, parseInt(String(value), 10) || 0));
      }
      
      return {
        ...prev,
        [id]: {
          ...current,
          [field]: processedVal
        }
      };
    });
  };

  const handleSaveDiscountTier = async (id: MemberType) => {
    const staged = editingDiscounts[id];
    if (!staged) return;

    const original = memberDiscounts.find(d => d.id === id);
    if (!original) return;

    if (api.USE_BACKEND) {
      await api.updateMemberDiscount({ ...original, name: staged.name, discountPercent: staged.discountPercent, isActive: staged.isActive })
        .then(() => {
          setEditingDiscounts(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          onAddAuditLog('MEMBER_DISCOUNT_PERCENT_MODIFIED', 'PricingRule', id,
            { name: original.name, discountPercent: original.discountPercent, isActive: original.isActive },
            { name: staged.name, discountPercent: staged.discountPercent, isActive: staged.isActive });
          onRefreshAll(); // reloads pricing from the server
          notify(`บันทึกการตั้งราคา/เปอร์เซ็นต์ส่วนลดสำหรับ '${staged.name}' เรียบร้อยแล้วค่ะ!`);
        })
        .catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
      return;
    }

    const updatedList = memberDiscounts.map(d => {
      if (d.id === id) {
        return {
          ...d,
          name: staged.name,
          discountPercent: staged.discountPercent,
          isActive: staged.isActive
        };
      }
      return d;
    });

    StorageService.set('member_discounts', updatedList);
    setMemberDiscounts(updatedList);
    setEditingDiscounts(prev => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });

    onAddAuditLog(
      'MEMBER_DISCOUNT_PERCENT_MODIFIED',
      'PricingRule',
      id,
      { name: original.name, discountPercent: original.discountPercent, isActive: original.isActive },
      { name: staged.name, discountPercent: staged.discountPercent, isActive: staged.isActive }
    );
    onRefreshAll();
    notify(`บันทึกการตั้งราคา/เปอร์เซ็นต์ส่วนลดสำหรับ '${staged.name}' เรียบร้อยแล้วค่ะ!`);
  };

  // Hours inside [open, close) that some sport has no price for on weekdays
  // or weekends - those can't be booked for that sport.
  const unpricedHours = (open: number, close: number) => {
    const gaps: string[] = [];
    for (const type of Object.values(CourtType)) {
      for (const day of [DayType.WEEKDAY, DayType.WEEKEND]) {
        const missing: number[] = [];
        for (let h = open; h < close; h++) {
          if (!pricingRules.some(r => r.isActive && r.courtType === type && r.dayType === day && h >= r.startHour && h < r.endHour)) missing.push(h);
        }
        if (missing.length) gaps.push(`${type} ${day === DayType.WEEKDAY ? 'วันธรรมดา' : 'เสาร์-อาทิตย์'}: ${missing.map(h => `${String(h).padStart(2, '0')}:00`).join(', ')}`);
      }
    }
    return gaps;
  };

  const handleSaveOpeningHours = async () => {
    const open = Number(openHourSetting), close = Number(closeHourSetting);
    if (!(open >= 0 && close <= 24 && open < close)) {
      notify('เวลาเปิดต้องน้อยกว่าเวลาปิด (0:00 - 24:00)');
      return;
    }
    const gaps = unpricedHours(open, close);
    if (gaps.length && !(await ask(`ชั่วโมงต่อไปนี้ยังไม่มีเรทราคา จะยังจองไม่ได้จนกว่าจะเพิ่มกฎราคา:\n${gaps.join('\n')}\n\nบันทึกเวลาเปิด-ปิดต่อไหม?`, { title: 'เวลาเปิด-ปิด', okLabel: 'บันทึก' }))) return;
    const done = () => {
      onAddAuditLog('OPENING_HOURS_UPDATED', 'PricingConfig', 'global', null, { openHour: open, closeHour: close });
      onRefreshAll();
      notify(`บันทึกเวลาเปิด-ปิด ${String(open).padStart(2, '0')}:00 - ${String(close).padStart(2, '0')}:00 แล้ว`);
    };
    if (api.USE_BACKEND) {
      return api.setOpeningHours(open, close).then(() => api.syncPricingCache()).then(done).catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
    }
    StorageService.set('pricing_config', { ...StorageService.get<PricingConfig>('pricing_config', { id: 'global', halfCourtRatePercent: 50 }), openHour: open, closeHour: close });
    done();
  };
  const handleSaveMaxAdvanceDays = async () => {
    const days = Math.round(Number(maxAdvanceDays));
    if (!(days >= 1 && days <= 365)) {
      notify('กรุณาระบุ 1–365 วัน');
      return;
    }
    const before = StorageService.get<{ maxAdvanceDays?: number }>('pricing_config', {}).maxAdvanceDays;
    const done = () => {
      onAddAuditLog('PRICING_CONFIG_UPDATED', 'PricingConfig', 'global', { maxAdvanceDays: before }, { maxAdvanceDays: days });
      onRefreshAll();
      notify(`ตั้งค่าแล้ว: ลูกค้าจองออนไลน์ล่วงหน้าได้ ${days} วัน (ถึง ${lastBookableDate()})`);
    };
    if (api.USE_BACKEND) {
      await api.setMaxAdvanceDays(days).then(() => api.syncPricingCache()).then(done).catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
      return;
    }
    StorageService.set('pricing_config', { ...StorageService.get('pricing_config', {}), maxAdvanceDays: days });
    done();
  };
  // No-show rules: the re-sale price of a no-show hour (% of the normal
  // price) and how long after the start staff may mark it (owner setting).
  const handleSaveNoShowRules = async () => {
    const resale = Math.round(Number(noShowResaleSetting));
    const grace = Math.round(Number(noShowGraceSetting));
    if (!(resale >= 1 && resale <= 100) || !(grace >= 0 && grace <= 120)) {
      notify('ราคาขายต่อ 1–100% และเวลารอ 0–120 นาที');
      return;
    }
    const before = noShowRules();
    const done = () => {
      onAddAuditLog('PRICING_CONFIG_UPDATED', 'PricingConfig', 'global', { noShowResalePercent: before.resalePercent, noShowGraceMinutes: before.graceMinutes },
        { noShowResalePercent: resale, noShowGraceMinutes: grace });
      onRefreshAll();
      notify(`ตั้งค่าแล้ว: ไม่มาใช้สนาม — กดบันทึกได้หลังเริ่ม ${grace} นาที, ขายต่อในราคา ${resale}% ของราคาปกติ`);
    };
    if (api.USE_BACKEND) {
      await api.setNoShowRules(resale, grace).then(() => api.syncPricingCache()).then(done).catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
      return;
    }
    StorageService.set('pricing_config', { ...StorageService.get('pricing_config', {}), noShowResalePercent: resale, noShowGraceMinutes: grace });
    done();
  };
  const handleSaveBusiness = async () => {
    const b = { name: business.name.trim(), address: business.address.trim(), phone: business.phone.trim(),
      taxId: business.taxId.replace(/\D/g, ''), vatRegistered: business.vatRegistered };
    if (b.taxId && b.taxId.length !== 13) {
      notify('เลขประจำตัวผู้เสียภาษีต้องมี 13 หลัก');
      return;
    }
    if (b.vatRegistered && (!b.name || !b.address || !b.taxId)) {
      notify('ถ้าจด VAT ต้องใส่ชื่อ ที่อยู่ และเลขประจำตัวผู้เสียภาษี');
      return;
    }
    const before = businessFrom(StorageService.get<Partial<PricingConfig>>('pricing_config', {}));
    const done = () => {
      onAddAuditLog('BUSINESS_INFO_UPDATED', 'PricingConfig', 'global', before, b);
      setBusiness(b);
      onRefreshAll();
      notify('บันทึกข้อมูลร้านแล้ว');
    };
    if (api.USE_BACKEND) {
      await api.updateBusiness(b).then(() => api.syncPricingCache()).then(done).catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
      return;
    }
    StorageService.set('pricing_config', { ...StorageService.get('pricing_config', {}), businessName: b.name, businessAddress: b.address,
      businessPhone: b.phone, businessTaxId: b.taxId, vatRegistered: b.vatRegistered });
    done();
  };

  // Pricing CRUD functions
  const handleSavePricingRule = async (e: React.FormEvent) => {
    e.preventDefault();

    // Same limits as the server: a rule covers part of 00:00-24:00 (only
    // the part inside the opening hours can be booked), and a free hour
    // can't be paid by PromptPay.
    if (ruleStartHour < 0 || ruleEndHour > 24 || ruleStartHour >= ruleEndHour) {
      notify('ช่วงเวลาต้องอยู่ระหว่าง 0:00 - 24:00 และเวลาเริ่มต้องน้อยกว่าเวลาสิ้นสุด');
      return;
    }
    if (!(Number(rulePrice) > 0)) {
      notify('ราคาต่อชั่วโมงต้องมากกว่า 0 บาท');
      return;
    }

    const ruleId = editingRuleId || 'rule-' + Date.now();
    
    const newRule: PricingRule = {
      id: ruleId,
      courtType: ruleCourtType,
      dayType: ruleDayType,
      startHour: Number(ruleStartHour),
      endHour: Number(ruleEndHour),
      pricePerHour: Number(rulePrice),
      priceType: rulePriceType,
      label: ruleLabel || `${ruleCourtType} (${rulePriceType})`,
      isActive: true
    };

    if (api.USE_BACKEND) {
      const existing = editingRuleId ? pricingRules.find(r => r.id === editingRuleId) : undefined;
      await api.savePricingRule({ ...newRule, id: editingRuleId || '', isActive: existing ? existing.isActive : true })
        .then(saved => {
          onAddAuditLog(editingRuleId ? 'PRICING_UPDATED' : 'PRICING_CREATED', 'PricingRule', saved.id, existing ?? null, saved);
          setEditingRuleId(null);
          setRuleLabel('');
          setRulePrice(200);
          onRefreshAll(); // reloads pricing from the server
          notify('บันทึกกติกาตั้งราคาเรียบร้อย! มีผลทันทีในกลไกเซิร์ฟเวอร์');
        })
        .catch(err => notify(`บันทึกไม่สำเร็จ: ${err.message}`));
      return;
    }

    const currentRules = StorageService.get<PricingRule[]>('pricing_rules', []);
    const prevRule = editingRuleId ? currentRules.find(r => r.id === editingRuleId) : undefined;
    newRule.isActive = prevRule ? prevRule.isActive : true; // editing doesn't re-enable a rule
    // Two active rules for the same hour would make the price depend on
    // which one is found first; the server refuses this too.
    const clash = newRule.isActive && currentRules.find(r =>
      r.id !== editingRuleId && r.isActive && r.courtType === newRule.courtType && r.dayType === newRule.dayType &&
      r.startHour < newRule.endHour && newRule.startHour < r.endHour);
    if (clash) {
      notify(`ช่วงเวลาซ้อนกับกติกา "${clash.label}" (${clash.startHour}:00-${clash.endHour}:00) กรุณาแก้ไขหรือปิดกติกานั้นก่อน`);
      return;
    }
    let updated = [];
    
    if (editingRuleId) {
      updated = currentRules.map(r => r.id === editingRuleId ? newRule : r);
      onAddAuditLog('PRICING_UPDATED', 'PricingRule', ruleId, currentRules.find(r => r.id === editingRuleId), newRule);
    } else {
      updated = [...currentRules, newRule];
      onAddAuditLog('PRICING_CREATED', 'PricingRule', ruleId, null, newRule);
    }

    StorageService.set('pricing_rules', updated);
    setPricingRules(updated);

    // reset Form
    setEditingRuleId(null);
    setRuleLabel('');
    setRulePrice(200);
    onRefreshAll();
    notify('บันทึกกติกาตั้งราคาเรียบร้อย! มีผลทันทีในกลไกเซิร์ฟเวอร์');
  };

  const handleDeletePricingRule = async (id: string) => {
    if (!(await ask('ลบกฎราคานี้? ชั่วโมงที่กฎนี้ครอบคลุมจะจองไม่ได้จนกว่าจะมีกฎใหม่', { okLabel: 'ลบกฎราคา', danger: true }))) return;
    if (api.USE_BACKEND) {
      const ruleToDelete = pricingRules.find(r => r.id === id);
      return api.deletePricingRule(id)
        .then(() => {
          onAddAuditLog('PRICING_DELETED', 'PricingRule', id, ruleToDelete, null);
          onRefreshAll();
        })
        .catch(err => notify(`ลบไม่สำเร็จ: ${err.message}`));
    }
    const currentRules = StorageService.get<PricingRule[]>('pricing_rules', []);
    const ruleToDelete = currentRules.find(r => r.id === id);
    const updated = currentRules.filter(r => r.id !== id);

    StorageService.set('pricing_rules', updated);
    setPricingRules(updated);

    onAddAuditLog('PRICING_DELETED', 'PricingRule', id, ruleToDelete, null);
    onRefreshAll();
  };

  // Column-by-column filtering for Pricing Rules (Active Engine Table)
  const filteredPricingRules = pricingRules.filter(rule => {
    const matchCourt = !filterCourtType || rule.courtType.toLowerCase().includes(filterCourtType.toLowerCase());
    const matchPrice = !filterPriceType || rule.priceType.toLowerCase().includes(filterPriceType.toLowerCase());
    const matchDay = !filterDayType || rule.dayType.toLowerCase().includes(filterDayType.toLowerCase());
    const matchLabel = !filterLabel || rule.label.toLowerCase().includes(filterLabel.toLowerCase());
    return matchCourt && matchPrice && matchDay && matchLabel;
  });
  return {
    handleStageDiscountField,
    handleSaveDiscountTier,
    unpricedHours,
    handleSaveOpeningHours,
    handleSaveMaxAdvanceDays,
    handleSaveNoShowRules,
    handleSaveBusiness,
    handleSavePricingRule,
    handleDeletePricingRule,
    filteredPricingRules
  };
}
