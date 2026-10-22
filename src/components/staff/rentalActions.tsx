import React from 'react';
import {
  PaymentMethod, Product, Order, OrderStatus, OrderType, UserRole
} from '../../types';
import { StorageService, getTodayDateStr, normalizePhone, formatBaht, roundBaht } from '../../mockData';
import * as api from '../../api';
import { notify, askText } from '../Dialog';
import type { StaffPOSCore } from './useStaffPOS';
import type { useShiftActions } from './shiftActions';

// Equipment rentals: rent out, return (deposit back or kept).
export function useRentalActions(deps: StaffPOSCore & ReturnType<typeof useShiftActions>) {
  const {
    activeRentalOrders,
    confirmCashWithoutShift,
    onAddAuditLog,
    onRefreshAll,
    products,
    rentalActionId,
    rentalCourtId,
    rentalCustomerPhone,
    rentalVariantId,
    selectedProductId,
    setRentalCourtId,
    setRentalCustomerPhone,
    setRentalMember,
    setRentalVariantId,
    users
  } = deps;
  // Equipment rental (FR-5.3): the catalog price, one item; shoes by size.
  const handleRentalRentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProductId) {
      notify('กรุณาเลือกชนิดอุปกรณ์กีฬา');
      return;
    }
    const prodObj = products.find(p => p.id === selectedProductId);
    if (!prodObj || prodObj.stock <= 0) {
      notify('ของเช่าชิ้นนี้หมดชั่วคราว กรุณาติดต่อฝั่งสนาม');
      return;
    }
    const variant = prodObj.variants?.find(v => v.id === rentalVariantId);
    if (prodObj.variants?.length && !variant) {
      notify('กรุณาเลือกเบอร์รองเท้า');
      return;
    }
    if (variant && variant.stock <= 0) {
      notify(`ขออภัยค่ะ! รองเท้า${variant.gender === 'F' ? 'หญิง' : 'ชาย'} เบอร์ ${variant.label} ถูกยืมหมดแล้ว`);
      return;
    }
    if (!(await confirmCashWithoutShift())) return; // rentals are paid in cash
    const sizeNote = variant ? ` (รองเท้า${variant.gender === 'F' ? 'หญิง' : 'ชาย'} เบอร์ ${variant.label})` : '';
    // Fee and deposit as recorded (the server's, in API mode).
    const done = (orderCode: string, fee = prodObj.price, dep = roundBaht(prodObj.deposit ?? 0)) => {
      setRentalCourtId('');
      setRentalCustomerPhone('');
      setRentalMember(null);
      setRentalVariantId('');
      onRefreshAll();
      notify(`ปล่อยเช่าสำเร็จ! รหัสทำรายการเช่า ${orderCode}${sizeNote}${dep > 0 ? `\nเก็บเงินสด ${formatBaht(fee + dep)} บาท (ค่าเช่า ${formatBaht(fee)} + มัดจำ ${formatBaht(dep)} คืนตอนคืนของ)` : ''}`);
    };

    if (api.USE_BACKEND) {
      rentalActionId.current ||= api.newActionId();
      return api.checkout({
        type: OrderType.EQUIPMENT_RENT, paymentMethod: PaymentMethod.CASH, customerName: '', // the server uses the member's name, or "walk-in"
        customerPhone: rentalCustomerPhone, courtId: rentalCourtId || undefined,
        items: [{ productId: prodObj.id, variantId: variant?.id, qty: 1 }],
        idempotencyKey: rentalActionId.current
      })
        .then(r => {
          rentalActionId.current = '';
          onAddAuditLog('RENTAL_CREATED_BY_STAFF', 'Order', r.order.id, null, { orderCode: r.order.orderCode });
          done(r.order.orderCode, r.order.totalAmount, r.order.depositAmount ?? 0);
        })
        .catch(err => { notify(`ปล่อยเช่าไม่สำเร็จ: ${err.message}`); onRefreshAll(); });
    }

    const orderId = 'o-rental-' + Date.now();
    const orderCode = `OD-RENT-${getTodayDateStr().replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;
    const customer = rentalCustomerPhone.trim()
      ? users.find(u => u.role === UserRole.CUSTOMER && normalizePhone(u.phone) === normalizePhone(rentalCustomerPhone))
      : undefined;
    const newOrder: Order = {
      id: orderId,
      orderCode,
      userId: customer?.id,
      customerName: customer?.name ?? 'ลูกค้าทั่วไป (Walk-in)',
      courtId: rentalCourtId || undefined,
      type: OrderType.EQUIPMENT_RENT,
      status: OrderStatus.PREPARING, // out on rent until returned
      totalAmount: prodObj.price,
      paidAmount: prodObj.price,
      depositAmount: prodObj.deposit ?? 0,
      paymentMethod: PaymentMethod.CASH,
      createdAt: new Date().toISOString(),
      createdBy: 'u-staff-1',
      items: [{
        id: 'oi-rent-' + Math.random().toString(36).substring(7),
        orderId,
        productId: prodObj.id,
        variantId: variant?.id,
        qty: 1,
        unitPrice: prodObj.price,
        shoeSize: variant?.label,
        shoeGender: variant?.gender === 'U' ? undefined : variant?.gender
      }]
    };
    StorageService.set('products', StorageService.get<Product[]>('products', []).map(p => p.id !== prodObj.id ? p : {
      ...p,
      stock: p.stock - 1,
      variants: p.variants?.map(v => v.id === variant?.id ? { ...v, stock: v.stock - 1 } : v)
    }));
    StorageService.set('orders', [...StorageService.get<Order[]>('orders', []), newOrder]);
    onAddAuditLog('RENTAL_CREATED_BY_STAFF', 'Order', orderId, null, newOrder);
    done(orderCode);
  };

  // A rented item is back: restock it (its size, for shoes); the rental
  // closes once every item is back.
  // The last item back settles the deposit: given back, or partly/fully
  // kept for damage or loss (with a reason).
  const handleReturnItem = async (orderId: string, itemId: string) => {
    const ord = api.USE_BACKEND ? activeRentalOrders.find(o => o.id === orderId)
      : StorageService.get<Order[]>('orders', []).find(o => o.id === orderId);
    const deposit = ord?.depositAmount ?? 0;
    const settles = !!ord && deposit > 0 && !ord.depositSettledAt && ord.items.every(it => it.id === itemId || it.returnedAt);
    let keep = 0, note = '';
    if (settles) {
      const raw = await askText(`คืนมัดจำ ${formatBaht(deposit)} บาท ให้ลูกค้า\nถ้าของเสียหาย/สูญหาย ใส่ยอดที่หักไว้ (0 = คืนเต็ม)`,
        { title: 'คืนมัดจำ', defaultValue: '0', required: true, okLabel: 'ต่อไป' });
      if (raw === null) return;
      keep = Number(raw.trim());
      if (!Number.isFinite(keep) || keep < 0 || keep > deposit) {
        notify(`ยอดที่หักต้องอยู่ระหว่าง 0 - ${formatBaht(deposit)} บาท`);
        return;
      }
      if (keep > 0) {
        const r = await askText(`เหตุผลที่หักมัดจำ ${formatBaht(keep)} บาท (จำเป็น):`, { title: 'หักมัดจำ', required: true, okLabel: 'บันทึก' });
        if (!r?.trim()) return;
        note = r.trim();
      }
    }
    const back = roundBaht(deposit - keep);
    if (settles && back > 0 && !(await confirmCashWithoutShift())) return; // the deposit comes out of the drawer
    const doneMsg = settles
      ? `บันทึกคืนอุปกรณ์แล้ว — คืนมัดจำ ${formatBaht(back)} บาท${keep > 0 ? ` (หักไว้ ${formatBaht(keep)} บาท: ${note})` : ''}`
      : 'บันทึกการส่งคืนอุปกรณ์เข้าคลังเรียบร้อย';
    if (api.USE_BACKEND) {
      return api.returnRentalItem(itemId, keep, note)
        .then(o => {
          onAddAuditLog('RENTAL_RETURNED_BY_STAFF', 'Order', o.id, null, { item: itemId, status: o.status, depositReturned: o.depositReturned, depositKept: o.depositKept });
          onRefreshAll();
          // What the server recorded - another counter may have returned
          // the other items, so this return can settle the deposit even
          // when this screen didn't expect it.
          const settledNow = !!o.depositAmount && !!o.depositSettledAt && !ord?.depositSettledAt;
          notify(settledNow
            ? `บันทึกคืนอุปกรณ์แล้ว — คืนมัดจำ ${formatBaht(o.depositReturned ?? 0)} บาทให้ลูกค้า${o.depositKept ? ` (หักไว้ ${formatBaht(o.depositKept)} บาท${o.depositNote ? `: ${o.depositNote}` : ''})` : ''}`
            : doneMsg);
        })
        .catch(err => { notify(`บันทึกคืนไม่สำเร็จ: ${err.message}`); onRefreshAll(); });
    }
    const rawOrders = StorageService.get<Order[]>('orders', []);
    const orderObj = rawOrders.find(o => o.id === orderId);
    const itemRef = orderObj?.items.find(it => it.id === itemId);
    if (!orderObj || !itemRef || itemRef.returnedAt) return;
    const now = new Date().toISOString();
    StorageService.set('orders', rawOrders.map(o => {
      if (o.id !== orderId) return o;
      const items = o.items.map(it => it.id === itemId ? { ...it, returnedAt: now } : it);
      return { ...o, items, status: items.every(it => it.returnedAt) ? OrderStatus.DELIVERED : o.status,
        ...(settles ? { depositReturned: back, depositKept: keep, depositNote: note || undefined, depositSettledAt: now } : {}) };
    }));
    StorageService.set('products', StorageService.get<Product[]>('products', []).map(p => p.id !== itemRef.productId ? p : {
      ...p,
      stock: p.stock + itemRef.qty,
      variants: p.variants?.map(v => v.id === itemRef.variantId ? { ...v, stock: v.stock + itemRef.qty } : v)
    }));
    onAddAuditLog('RENTAL_RETURNED_BY_STAFF', 'Order', orderId, { item: itemId, returned: false }, { item: itemId, returned: true, depositReturned: back, depositKept: keep });
    onRefreshAll();
    notify(doneMsg);
  };
  return {
    handleRentalRentSubmit,
    handleReturnItem
  };
}
