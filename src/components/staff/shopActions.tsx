import {
  PaymentMethod, Product, ProductCat, Order, OrderStatus, OrderType, UserRole, User, LedgerEntryType, Shift
} from '../../types';
import { StorageService, getTodayDateStr, normalizePhone, formatBaht, roundBaht, localDateOf } from '../../mockData';
import * as api from '../../api';
import { notify, askText } from '../Dialog';
import type { StaffPOSCore } from './useStaffPOS';
import { LocalVoucher } from './shared';
import type { useShiftActions } from './shiftActions';

// Counter sales (F&B and equipment): cart, checkout, void.
export function useShopActions(deps: StaffPOSCore & ReturnType<typeof useShiftActions>) {
  const {
    cartActionId,
    cartCourtId,
    cartCustomerName,
    cartCustomerPhone,
    cartItems,
    cartPayMethod,
    confirmCashWithoutShift,
    onAddAuditLog,
    onRefreshAll,
    setCartCourtId,
    setCartCustomerName,
    setCartCustomerPhone,
    setCartItems,
    setCartMember,
    setCartSuccessAlert,
    users
  } = deps;
  // F&B Add to Receipt Cart
  const handleAddToCart = (product: Product) => {
    if (product.stock <= 0) {
      notify('ขออภัยค่ะ! สินค้าชิ้นนี้หมดคลังชั่วคราว ขัดข้องการเช็กเอาท์');
      return;
    }

    const exists = cartItems.find(item => item.product.id === product.id);
    if (exists) {
      if (exists.qty >= product.stock) {
        notify('ไม่สามารถเพิ่มได้เกินจำนวนสินค้าที่มีอยู่ในระบบคลัง');
        return;
      }
      setCartItems(cartItems.map(item => 
        item.product.id === product.id ? { ...item, qty: item.qty + 1 } : item
      ));
    } else {
      setCartItems([...cartItems, { product, qty: 1 }]);
    }
  };

  const handleUpdateCartQty = (productId: string, val: number) => {
    const matched = cartItems.find(item => item.product.id === productId);
    if (!matched) return;
    
    const newQty = matched.qty + val;
    if (newQty <= 0) {
      setCartItems(cartItems.filter(item => item.product.id !== productId));
    } else {
      if (newQty > matched.product.stock) {
        notify('จำนวนเกินสินค้าที่มีในตู้แช่/คลัง');
        return;
      }
      setCartItems(cartItems.map(item => 
        item.product.id === productId ? { ...item, qty: newQty } : item
      ));
    }
  };

  // Checkout of the cart (F&B and/or equipment for sale). An all-equipment
  // cart is recorded as an equipment sale, anything else as F&B.
  const handleCartCheckout = async () => {
    if (cartItems.length === 0) {
      notify('รถเข็นใบเสร็จว่างเปล่า! กรุณากดสินค้าเติมตระกร้า');
      return;
    }
    if (cartPayMethod === PaymentMethod.CASH && !(await confirmCashWithoutShift())) return;
    const type = cartItems.every(i => i.product.category === ProductCat.EQUIPMENT) ? OrderType.EQUIPMENT_SALE : OrderType.FB;
    const done = (orderCode: string, total: number) => {
      setCartItems([]);
      setCartCustomerName('');
      setCartCourtId('');
      setCartCustomerPhone('');
      setCartMember(null);
      setCartSuccessAlert(`ใบเสร็จ ${orderCode} ตัดสต๊อกเรียบร้อย! ชำระผ่าน ${cartPayMethod === PaymentMethod.CASH ? 'เงินสด' : 'โอน/พร้อมเพย์'} ยอดเงิน ${formatBaht(total)} บาท`);
      onRefreshAll();
    };

    if (api.USE_BACKEND) {
      // The server prices the items, checks and takes the stock, and
      // credits the customer with this phone.
      cartActionId.current ||= api.newActionId();
      return api.checkout({
        type, paymentMethod: cartPayMethod, customerName: cartCustomerName, customerPhone: cartCustomerPhone,
        courtId: cartCourtId || undefined, items: cartItems.map(i => ({ productId: i.product.id, qty: i.qty })),
        idempotencyKey: cartActionId.current
      })
        .then(r => {
          cartActionId.current = '';
          onAddAuditLog('ORDER_CREATED_BY_STAFF', 'Order', r.order.id, null, { orderCode: r.order.orderCode, total: r.order.totalAmount });
          done(r.order.orderCode, r.order.totalAmount);
        })
        .catch(err => { notify(`ขายไม่สำเร็จ: ${err.message}`); onRefreshAll(); });
    }

    // Browser-only mode: same rules on localStorage, with fresh stock.
    const rawProducts = StorageService.get<Product[]>('products', []);
    for (const item of cartItems) {
      const live = rawProducts.find(p => p.id === item.product.id);
      if (!live || live.stock < item.qty) {
        notify(`${item.product.name}: เหลือในคลัง ${live?.stock ?? 0} ชิ้น`);
        return;
      }
    }
    const totalAmount = roundBaht(cartItems.reduce((acc, current) => acc + (current.product.price * current.qty), 0));
    const orderId = 'o-' + Date.now();
    const orderCode = `OD${getTodayDateStr().replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;
    const customer = cartCustomerPhone.trim()
      ? users.find(u => u.role === UserRole.CUSTOMER && normalizePhone(u.phone) === normalizePhone(cartCustomerPhone))
      : undefined;

    const newOrder: Order = {
      id: orderId,
      orderCode,
      userId: customer?.id,
      customerName: cartCustomerName || customer?.name || 'ลูกค้าทั่วไป (Walk-in)',
      courtId: cartCourtId || undefined,
      type,
      status: OrderStatus.DELIVERED,
      totalAmount,
      paidAmount: totalAmount,
      paymentMethod: cartPayMethod,
      createdAt: new Date().toISOString(),
      createdBy: 'u-staff-1',
      items: cartItems.map(item => ({
        id: 'oi-' + Math.random().toString(36).substring(7),
        orderId,
        productId: item.product.id,
        qty: item.qty,
        unitPrice: item.product.price
      }))
    };
    StorageService.set('products', rawProducts.map(p => {
      const match = cartItems.find(item => item.product.id === p.id);
      return match ? { ...p, stock: p.stock - match.qty } : p;
    }));
    StorageService.set('orders', [...StorageService.get<Order[]>('orders', []), newOrder]);
    onAddAuditLog('ORDER_CREATED_BY_STAFF', 'Order', orderId, null, newOrder);
    done(orderCode, totalAmount);
  };

  // Manager: void today's counter sale - stock and points back, out of the
  // drawer. Reason required.
  const handleVoidOrder = async (order: Order) => {
    const reason = await askText(`เหตุผลการยกเลิกบิล ${order.orderCode} (${formatBaht(order.totalAmount)} บาท)\nคืนเงินลูกค้าแล้วค่อยยืนยัน`, { title: '✖ ยกเลิกบิล', okLabel: 'ยกเลิกบิล' });
    if (!reason) return;
    if (api.USE_BACKEND) {
      return api.voidOrder(order.id, reason)
        .then(r => {
          onRefreshAll();
          notify(`ยกเลิกบิล ${order.orderCode} แล้ว (คืนสต๊อกและแต้ม)${r.cancelledVouchers.length ? `\nยกเลิกคูปองของรางวัลที่แลกด้วยแต้มจากบิลนี้: ${r.cancelledVouchers.join(', ')}` : ''}`);
        })
        .catch(err => notify(`ยกเลิกบิลไม่สำเร็จ: ${err.message}`));
    }
    if (localDateOf(order.createdAt) !== getTodayDateStr()) { notify('ยกเลิกได้เฉพาะบิลของวันนี้'); return; }
    // A cash sale counted in an already-closed shift can't leave that count.
    if (order.paymentMethod === PaymentMethod.CASH && StorageService.get<Shift[]>('shifts', []).some(sh =>
      sh.closedAt && order.createdAt >= sh.openedAt && order.createdAt <= sh.closedAt)) {
      notify('บิลเงินสดนี้อยู่ในกะที่ปิดไปแล้ว ยกเลิกไม่ได้');
      return;
    }
    const pts = Math.floor(order.totalAmount / 100);
    const cancelledCodes: string[] = [];
    if (order.userId && pts > 0) {
      // Points already spent: cancel unused rewards (newest first) to cover
      // them, as on the server; a reward already handed over blocks the void.
      const balance = StorageService.get<User[]>('users', []).find(u => u.id === order.userId)?.points ?? 0;
      let short = pts - balance;
      if (short > 0) {
        const vouchers = StorageService.get<LocalVoucher[]>('redemptions', []);
        const usable = vouchers.filter(v => v.userId === order.userId && (v.status || 'ACTIVE') === 'ACTIVE').reverse();
        const cancelIds = new Set<string>();
        for (const v of usable) {
          if (short <= 0) break;
          cancelIds.add(v.id);
          cancelledCodes.push(v.claimCode);
          short -= v.pointsSpent || 0;
        }
        if (short > 0) {
          notify('ลูกค้านำแต้มจากบิลนี้ไปแลกของรางวัลและรับของไปแล้ว — ยกเลิกบิลไม่ได้');
          return;
        }
        StorageService.set('redemptions', vouchers.map(v => cancelIds.has(v.id) ? { ...v, status: 'CANCELLED' } : v));
        for (const v of usable.filter(x => cancelIds.has(x.id))) {
          StorageService.addLedgerEntry(order.userId, LedgerEntryType.VOUCHER_CANCELLED, v.pointsSpent || 0, 'manager', { refType: 'Voucher', refId: v.id, note: `Voucher ${v.claimCode} cancelled: sale ${order.orderCode} voided` });
        }
      }
      StorageService.addLedgerEntry(order.userId, LedgerEntryType.REVERSE_PURCHASE, -pts, 'manager', { note: `Sale ${order.orderCode} voided: ${reason}` });
    }
    StorageService.set('products', StorageService.get<Product[]>('products', []).map(p => {
      const lines = order.items.filter(it => it.productId === p.id && !it.returnedAt);
      if (!lines.length) return p;
      return {
        ...p,
        stock: p.stock + lines.reduce((n, it) => n + it.qty, 0),
        variants: p.variants?.map(v => ({ ...v, stock: v.stock + lines.filter(it => it.variantId === v.id).reduce((n, it) => n + it.qty, 0) }))
      };
    }));
    StorageService.set('orders', StorageService.get<Order[]>('orders', []).map(o => o.id === order.id
      ? { ...o, status: OrderStatus.CANCELLED, voidedAt: new Date().toISOString(), voidReason: reason,
          // A voided rental gives its deposit back (as the server does).
          ...(o.depositAmount && !o.depositSettledAt
            ? { depositReturned: o.depositAmount, depositSettledAt: new Date().toISOString(), depositNote: 'voided' } : {}) } : o));
    onAddAuditLog('ORDER_VOIDED', 'Order', order.id, { status: order.status }, { status: OrderStatus.CANCELLED, reason });
    onRefreshAll();
    notify(`ยกเลิกบิล ${order.orderCode} แล้ว (คืนสต๊อกและแต้ม)${cancelledCodes.length ? `\nยกเลิกคูปองของรางวัลที่แลกด้วยแต้มจากบิลนี้: ${cancelledCodes.join(', ')}` : ''}`);
  };
  return {
    handleAddToCart,
    handleUpdateCartQty,
    handleCartCheckout,
    handleVoidOrder
  };
}
