import React, { useState, useEffect } from 'react';
import { 
  Court, CourtType, Booking, BookingStatus, Payment, PaymentStatus,
  PaymentMethod, Product, ProductCat, Order, OrderStatus, OrderType, UserRole, PriceType, DayOff, User, MemberType, LedgerEntryType
} from '../types';
import { StorageService, getTodayDateStr, calculatePrice, isHourOffPeak, FREE_HOUR_REWARD_IDS, isCourtSlotAvailable, findConflictingBooking, bookingGroupOf, normalizePhone, slotTiming, generatePromptPayPayload, LOCAL_PROMPTPAY_ID, OPENING_HOUR, CLOSING_HOUR, formatBaht, roundBaht, isPaidBooking } from '../mockData';
import { QRCodeSVG } from 'qrcode.react';
import * as api from '../api';
import DemoLogins, { DEMO_STAFF } from './DemoLogins';
import { Check, X, ShoppingCart, Activity, RefreshCw, AlertTriangle, Coffee, ShieldCheck, Dumbbell, Receipt, Plus, Minus, CheckCircle2, UserCheck, AlertOctagon } from 'lucide-react';

interface StaffPOSProps {
  currentUserRole: UserRole;
  onAddAuditLog: (action: string, targetType: string, targetId: string, before?: any, after?: any) => void;
  triggerRefresh: number;
  onRefreshAll: () => void;
}

// Browser-only mode keeps reward vouchers in localStorage ("redemptions").
interface LocalVoucher { id: string; claimCode: string; rewardId: string; rewardName: string; userId: string; userName: string; status?: string; bookingId?: string; dispensedAt?: string }

export default function StaffPOS({ currentUserRole, onAddAuditLog, triggerRefresh, onRefreshAll }: StaffPOSProps) {
  // Master states
  const [courts, setCourts] = useState<Court[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [daysOff, setDaysOff] = useState<DayOff[]>([]);
  const [users, setUsers] = useState<User[]>([]);

  // Sub Module tab state
  const [activePosTab, setActivePosTab] = useState<'walkin' | 'slips' | 'fb' | 'rentals' | 'todays_total' | 'vouchers'>('walkin');

  // Walk-in booking state
  const [posGridSportType, setPosGridSportType] = useState<CourtType>(CourtType.BADMINTON);
  const [walkinCourtId, setWalkinCourtId] = useState<string>('');
  const [walkinDate, setWalkinDate] = useState<string>('');
  const [walkinSlot, setWalkinSlot] = useState<string>('');
  const [walkinName, setWalkinName] = useState<string>('');
  const [walkinPhone, setWalkinPhone] = useState<string>('');
  const [walkinPayMethod, setWalkinPayMethod] = useState<PaymentMethod>(PaymentMethod.PROMPTPAY);
  // RW-XXXXXX code of a free off-peak hour reward, when paying with one
  const [walkinVoucherCode, setWalkinVoucherCode] = useState<string>('');
  const [walkinSuccessAlert, setWalkinSuccessAlert] = useState<string | null>(null);
  // A PromptPay walk-in is created awaiting payment: staff show this QR
  // (with the price the server actually charges, member discount included)
  // and confirm only once the transfer has arrived.
  const [pendingWalkin, setPendingWalkin] = useState<{
    paymentId: string; bookingCode: string; amount: number; qrPayload: string; label: string;
  } | null>(null);

  // Receipt printed preview overlay target states
  const [selectedReceiptBooking, setSelectedReceiptBooking] = useState<Booking | null>(null);
  const [selectedReceiptOrder, setSelectedReceiptOrder] = useState<Order | null>(null);

  // F&B & Product cart state
  const [cartItems, setCartItems] = useState<{ product: Product; qty: number }[]>([]);
  const [cartCustomerName, setCartCustomerName] = useState<string>('');
  const [cartCourtId, setCartCourtId] = useState<string>('');
  const [cartPayMethod, setCartPayMethod] = useState<PaymentMethod>(PaymentMethod.PROMPTPAY);
  const [cartSuccessAlert, setCartSuccessAlert] = useState<string | null>(null);
  const [cartUserId, setCartUserId] = useState<string>('');

  // Rental items list
  const [rentalRenterName, setRentalRenterName] = useState<string>('');
  const [rentalCourtId, setRentalCourtId] = useState<string>('');
  const [rentalItemPrice, setRentalItemPrice] = useState<number>(50); // initial
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [rentalUserId, setRentalUserId] = useState<string>('');
  
  // Specific Shoe rental states
  const [rentalShoeGender, setRentalShoeGender] = useState<'M' | 'F'>('M');
  const [rentalShoeSize, setRentalShoeSize] = useState<string>('40');
  const [shoeInventory, setShoeInventory] = useState<{ id: string; size: string; gender: 'M' | 'F'; totalStock: number; rentedCount: number; }[]>([]);

  // Reject slip state
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<string>('');

  // API mode: slip review queue comes from the backend and needs a staff login
  const [staffUser, setStaffUser] = useState<User | null>(() => api.USE_BACKEND ? api.getSession('staff')?.user ?? null : null);
  const [staffIdentity, setStaffIdentity] = useState<string>('');
  const [staffPassword, setStaffPassword] = useState<string>('');
  const [staffApiError, setStaffApiError] = useState<string | null>(null);
  const [reviewQueue, setReviewQueue] = useState<api.PaymentForReview[]>([]);
  // API mode: today's booking money by method, for the cash-drawer report.
  const [daySummary, setDaySummary] = useState<api.DaySummary | null>(null);
  // Reward voucher check at the counter (FR-4.3).
  const [voucherCode, setVoucherCode] = useState<string>('');
  const [voucherFound, setVoucherFound] = useState<{ code: string; reward: string; customer: string; name: string; phone: string; freeHour: boolean; status: string; expires?: string } | null>(null);
  const [voucherError, setVoucherError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.USE_BACKEND || !staffUser) return;
    let cancelled = false;
    Promise.all([api.listPaymentsForReview(), api.daySummary(getTodayDateStr())])
      .then(([queue, summary]) => {
        if (cancelled) return;
        setReviewQueue(queue);
        setDaySummary(summary);
        setStaffApiError(null);
      })
      .catch(err => {
        if (cancelled) return;
        if (err instanceof api.ApiError && err.status === 401) setStaffUser(null);
        setStaffApiError(err.message);
      });
    return () => { cancelled = true; };
  }, [triggerRefresh, staffUser]);

  // API mode: the walk-in grid shows the backend's bookings for the chosen
  // date (online + walk-in), so the counter can't sell a slot that was
  // already booked online. Also re-validates the staff session.
  useEffect(() => {
    if (!api.USE_BACKEND || !staffUser || !walkinDate) return;
    let cancelled = false;
    (async () => {
      try {
        const me = await api.refreshMe('staff');
        if (cancelled) return;
        if (!me || me.role === UserRole.CUSTOMER) {
          api.logout('staff');
          setStaffUser(null);
          setStaffApiError('เซสชันพนักงานหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
          return;
        }
        const [apiCourts, dayBookings, closures] = await Promise.all([
          api.listCourts(),
          api.listBookingsByDate(walkinDate, 'staff'),
          api.listDaysOff(walkinDate, walkinDate),
          api.syncPricingCache() // walk-in price previews read it
        ]);
        if (cancelled) return;
        setCourts(apiCourts);
        setBookings(dayBookings);
        setDaysOff(closures);
      } catch (err) {
        if (!cancelled) setStaffApiError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [triggerRefresh, staffUser, walkinDate]);

  const handleStaffLogin = (e: React.FormEvent) => {
    e.preventDefault();
    staffLoginWith(staffIdentity, staffPassword);
  };

  const staffLoginWith = (identity: string, password: string) => {
    setStaffApiError(null);
    api.login('staff', identity, password)
      .then(user => {
        if (user.role === UserRole.CUSTOMER) {
          api.logout('staff');
          setStaffApiError('บัญชีลูกค้าไม่มีสิทธิ์ตรวจสลิป');
          return;
        }
        setStaffUser(user);
        setStaffIdentity('');
        setStaffPassword('');
      })
      .catch(err => setStaffApiError(err.message));
  };

  const handleStaffLogout = () => {
    api.logout('staff');
    setStaffUser(null);
    setReviewQueue([]);
  };

  // Load everything
  useEffect(() => {
    const rawCourts = StorageService.get<Court[]>('courts', []);
    const rawBookings = StorageService.get<Booking[]>('bookings', []);
    const rawPayments = StorageService.get<Payment[]>('payments', []);
    const rawProducts = StorageService.get<Product[]>('products', []);
    const rawOrders = StorageService.get<Order[]>('orders', []);
    const rawDaysOff = StorageService.get<DayOff[]>('days_off', []);
    const rawUsers = StorageService.get<User[]>('users', []);

    // In API mode courts/bookings come from the backend (effect above).
    if (!api.USE_BACKEND) {
      setCourts(rawCourts.filter(c => c.isActive));
      setBookings(rawBookings);
    }
    setPayments(rawPayments);
    setProducts(rawProducts.filter(p => p.isActive));
    setOrders(rawOrders);
    if (!api.USE_BACKEND) setDaysOff(rawDaysOff);
    setUsers(rawUsers);

    // Default to today, but keep the date staff picked across refreshes
    // (every booking action triggers one, which used to jump back to today).
    setWalkinDate(prev => prev || getTodayDateStr());

    // Seeding shoe_inventory if not exist
    const rawShoeInv = StorageService.get<any[]>('shoe_inventory', []);
    if (rawShoeInv.length === 0) {
      const defaultInv = [
        ...[36, 37, 38, 39, 40].map(s => ({ id: `shoe-${s}-F`, size: s.toString(), gender: 'F' as const, totalStock: 3, rentedCount: 0 })),
        ...[39, 40, 41, 42, 43, 44, 45].map(s => ({ id: `shoe-${s}-M`, size: s.toString(), gender: 'M' as const, totalStock: 4, rentedCount: 0 }))
      ];
      StorageService.set('shoe_inventory', defaultInv);
      setShoeInventory(defaultInv);
    } else {
      setShoeInventory(rawShoeInv);
    }
  }, [triggerRefresh]);

  // Handle first load of selections
  useEffect(() => {
    if (courts.length > 0 && !walkinCourtId) {
      setWalkinCourtId(courts[0].id);
    }
    const rentalProducts = products.filter(p => p.isRental);
    if (rentalProducts.length > 0 && !selectedProductId) {
      setSelectedProductId(rentalProducts[0].id);
    }
  }, [courts, products]);

  // Standard line push simulation
  const pushLineMessage = (phone: string, text: string, type: "CREATED" | "CONFIRMED" | "REMINDER" | "CANCELLED") => {
    const rawLine = StorageService.get<any[]>('line_messages', []);
    const newMsg = {
      id: 'lm-' + Date.now(),
      timestamp: new Date().toISOString(),
      recipientPhone: phone,
      recipientName: 'ลูกค้า',
      type,
      text
    };
    StorageService.set('line_messages', [newMsg, ...rawLine]);
  };

  // Walk-in booking submission
  const handleWalkinBookingSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!walkinCourtId || !walkinSlot || !walkinName || !walkinPhone) {
      alert('กรุณากรอกข้อมูลและเลือกเวลาให้ครบถ้วน!');
      return;
    }
    if (pendingWalkin) {
      alert(`กรุณายืนยันหรือยกเลิกรายการ ${pendingWalkin.bookingCode} ที่รอชำระเงินก่อนค่ะ`);
      return;
    }
    if (slotTiming(walkinDate, walkinSlot).ended) {
      alert('ช่วงเวลานี้ผ่านไปแล้ว กรุณาเลือกช่วงเวลาอื่น');
      return;
    }

    // Double booking verify - checks the mutex group (FR-1.2), not just this
    // exact court id, so a walk-in half-court booking correctly blocks the
    // full court and vice versa.
    const isOccupied = !isCourtSlotAvailable(walkinCourtId, walkinDate, walkinSlot, bookings, courts);

    if (isOccupied) {
      alert('ขออภัยค่ะ! สนามและเวลาที่เลือกถูกจองไว้แล้ว กรุณาเลือกช่วงเวลาอื่น');
      return;
    }

    // Outside opening hours (no pricing rule covers it) - the server refuses these
    const slotCourt = courts.find(c => c.id === walkinCourtId);
    if (slotCourt && !calculatePrice(slotCourt.type, walkinDate, walkinSlot, MemberType.NORMAL, slotCourt).isOpen) {
      alert('ช่วงเวลานี้อยู่นอกเวลาเปิดให้บริการ กรุณาเลือกช่วงเวลาอื่น');
      return;
    }

    // Special DayOff override check
    const hourNum = parseInt(walkinSlot.split(':')[0], 10);
    const blockedReason = daysOff.find(
      d => d.date === walkinDate && 
           (d.courtId === 'all' || d.courtId === walkinCourtId) &&
           (d.isFullDay || d.isFullDay === undefined || (d.startHour !== undefined && d.endHour !== undefined && hourNum >= d.startHour && hourNum < d.endHour))
    )?.reason;

    if (blockedReason) {
      if (!window.confirm(`⚠️ คำเตือนสต๊าฟ: วันที่ทำรายการนี้ถูกบล็อกปิดหยุดพิเศษ ("${blockedReason}")\nคุณต้องการบันทึกจองกรณีพิเศษ (Override Code) ใช่หรือไม่?`)) {
        return;
      }
    }

    const useVoucher = walkinPayMethod === PaymentMethod.VOUCHER;
    const voucherCodeIn = walkinVoucherCode.trim().toUpperCase();
    if (useVoucher) {
      if (!voucherCodeIn) {
        alert('กรุณากรอกรหัสคูปองชั่วโมงฟรี (RW-XXXXXX)');
        return;
      }
      if (slotCourt && !isHourOffPeak(slotCourt.type, walkinDate, hourNum)) {
        alert('คูปองชั่วโมงฟรีใช้ได้เฉพาะช่วง Off-Peak เท่านั้น กรุณาเลือกเวลา Off-Peak');
        return;
      }
    }

    if (api.USE_BACKEND) {
      // The server re-checks availability against every booking (online
      // and walk-in), prices the slot, and credits a registered customer
      // with this phone - the checks above are just early feedback.
      api.createWalkInBooking({
        date: walkinDate,
        slots: [{ courtId: walkinCourtId, startTime: walkinSlot }],
        customerName: walkinName,
        customerPhone: walkinPhone,
        paymentMethod: walkinPayMethod,
        voucherCode: useVoucher ? voucherCodeIn : undefined,
        overrideClosure: !!blockedReason
      })
        .then(group => {
          const b = group.bookings[0];
          const courtName = courts.find(c => c.id === b.courtId)?.name || '';
          onAddAuditLog('WALKIN_BOOKING_CREATED_BY_STAFF', 'Booking', b.id, null, b);
          if (group.payment.status === PaymentStatus.VERIFIED) {
            // Cash or free-hour voucher: settled on the spot, already confirmed.
            const ptsNote = group.pointsAwarded > 0 ? `\n🎁 ได้รับแต้มสะสมเพิ่ม: +${group.pointsAwarded} แต้ม` : '';
            pushLineMessage(walkinPhone, `🎉 ยืนยันการจองแล้ว!\n📋 ${group.bookingCode} | สนาม ${courtName}\n📅 ${b.date} ${b.startTime}-${b.endTime}\nพบกันที่สนาม! (Walk-in ชำระหน้าเคาน์เตอร์สำเร็จ)${ptsNote}`, "CONFIRMED");
            setWalkinSuccessAlert(`จองสนามแบบ Walk-in รหัส ${group.bookingCode} สำเร็จแล้ว! ${useVoucher ? `ใช้คูปอง ${voucherCodeIn} (ฟรี 1 ชั่วโมง)` : `ยอด ${formatBaht(group.totalAmount)} บาท`} ${group.pointsAwarded > 0 ? `(🎁 มอบแต้มสะสมสมาชิก +${group.pointsAwarded} แต้มสำเร็จ!)` : ''}`);
          } else {
            setPendingWalkin({
              paymentId: group.payment.id,
              bookingCode: group.bookingCode,
              amount: group.totalAmount,
              qrPayload: group.promptPayPayload,
              label: `${courtName} ${b.date} ${b.startTime}-${b.endTime} (${walkinName})`
            });
          }
          setWalkinSlot('');
          setWalkinName('');
          setWalkinPhone('');
          setWalkinVoucherCode('');
          onRefreshAll();
        })
        .catch(err => {
          alert(`จองไม่สำเร็จ: ${err.message}`);
          onRefreshAll();
        });
      return;
    }

    const courtObj = courts.find(c => c.id === walkinCourtId);
    const normalizedPhone = normalizePhone(walkinPhone);
    const usersList = StorageService.get<User[]>('users', []);
    // A free-hour voucher books the hour for its owner, whatever phone was typed.
    const localVouchers = StorageService.get<LocalVoucher[]>('redemptions', []);
    const voucher = useVoucher ? localVouchers.find(r => r.claimCode === voucherCodeIn) : undefined;
    if (useVoucher && (!voucher || !FREE_HOUR_REWARD_IDS.includes(voucher.rewardId) || (voucher.status || 'ACTIVE') !== 'ACTIVE')) {
      alert(!voucher ? 'ไม่พบรหัสคูปองนี้'
        : !FREE_HOUR_REWARD_IDS.includes(voucher.rewardId) ? 'รหัสนี้ไม่ใช่คูปองชั่วโมงฟรี (ให้มอบของรางวัลที่แท็บ "รับของรางวัล")'
        : 'คูปองนี้ถูกใช้ไปแล้วหรือหมดอายุ');
      return;
    }
    const registeredUser = voucher ? usersList.find(u => u.id === voucher.userId) : usersList.find(u => normalizePhone(u.phone) === normalizedPhone);
    const resolvedUserId = registeredUser ? registeredUser.id : 'u-walkin-' + Date.now();

    // Price through the same engine the grid preview uses (FR-2), instead of
    // a flat per-sport fee that ignored peak/off-peak, half-court rate and
    // membership discount - and could silently disagree with the price the
    // staff member was just shown on screen.
    const priceDetail = calculatePrice(
      courtObj?.type || CourtType.BADMINTON,
      walkinDate,
      walkinSlot,
      registeredUser?.memberType || MemberType.NORMAL,
      courtObj
    );
    const isActuallyHalf = courtObj ? courtObj.shareOfGroup < 1 : false;
    const paidInCash = walkinPayMethod === PaymentMethod.CASH;
    const settledNow = paidInCash || useVoucher;
    const amount = useVoucher ? 0 : priceDetail.total;

    const bookingId = 'bk-walkin-' + Date.now();
    const bkCode = `BK${walkinDate.replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

    const newBooking: Booking = {
      id: bookingId,
      bookingCode: bkCode,
      courtId: walkinCourtId,
      userId: resolvedUserId,
      userName: registeredUser ? `${registeredUser.name} (${registeredUser.memberType || 'CUSTOMER'})` : `${walkinName} (Walk-in)`,
      userPhone: normalizedPhone,
      date: walkinDate,
      startTime: walkinSlot,
      endTime: (parseInt(walkinSlot.split(':')[0], 10) + 1).toString().padStart(2, '0') + ':00',
      isHalfCourt: isActuallyHalf,
      priceType: priceDetail.priceType,
      totalAmount: amount,
      // Cash is in the drawer (or a voucher paid for it), so it's confirmed
      // now; a PromptPay walk-in waits until staff see the transfer
      // (confirmPendingWalkin).
      status: settledNow ? BookingStatus.CONFIRMED : BookingStatus.PENDING_PAYMENT,
      isEventBlock: false,
      createdAt: new Date().toISOString(),
      createdBy: 'u-staff-1'
    };

    const qrPayload = settledNow ? undefined : generatePromptPayPayload(LOCAL_PROMPTPAY_ID, priceDetail.total);
    const newPayment: Payment = {
      id: 'pay-walkin-' + Date.now(),
      bookingId: bookingId,
      amount,
      method: walkinPayMethod,
      status: settledNow ? PaymentStatus.VERIFIED : PaymentStatus.PENDING,
      ...(settledNow ? { verifiedAt: new Date().toISOString(), verifiedBy: 'u-staff-1' } : { qrPayload }),
      createdAt: new Date().toISOString()
    };

    // Save
    const currentBookings = StorageService.get<Booking[]>('bookings', []);
    const currentPayments = StorageService.get<Payment[]>('payments', []);
    StorageService.set('bookings', [...currentBookings, newBooking]);
    StorageService.set('payments', [...currentPayments, newPayment]);

    // Save Log
    onAddAuditLog('WALKIN_BOOKING_CREATED_BY_STAFF', 'Booking', bookingId, null, newBooking);

    if (voucher) {
      // The voucher is used up by this booking; a free hour earns no points.
      StorageService.set('redemptions', localVouchers.map(r => r.claimCode === voucher.claimCode
        ? { ...r, status: 'REDEEMED', dispensedAt: new Date().toISOString(), bookingId } : r));
      onAddAuditLog('VOUCHER_USED_FOR_BOOKING', 'Voucher', voucher.claimCode, { status: 'ACTIVE' }, { status: 'REDEEMED', bookingId });
      pushLineMessage(walkinPhone, `🎉 ยืนยันการจองแล้ว!\n📋 ${bkCode} | สนาม ${courtObj?.name}\n📅 ${walkinDate} ${walkinSlot}-${newBooking.endTime}\n🎟️ ใช้คูปองชั่วโมงฟรี ${voucher.claimCode}`, "CONFIRMED");
      setWalkinSuccessAlert(`จองสนามแบบ Walk-in รหัส ${bkCode} สำเร็จแล้ว! ใช้คูปอง ${voucher.claimCode} (ฟรี 1 ชั่วโมง)`);
    } else if (paidInCash) {
      // Points (FR-4.1: 1 per hour) only once paid.
      const pointsAdded = registeredUser ? StorageService.addPointsHour(resolvedUserId, 1) : 0;
      const ptsNote = pointsAdded > 0 ? `\n🎁 ได้รับแต้มสะสมเพิ่ม: +${pointsAdded} แต้ม` : '';
      pushLineMessage(walkinPhone, `🎉 ยืนยันการจองแล้ว!\n📋 ${bkCode} | สนาม ${courtObj?.name}\n📅 ${walkinDate} ${walkinSlot}-${newBooking.endTime}\nพบกันที่สนาม! (Walk-in ชำระหน้าเคาน์เตอร์สำเร็จ)${ptsNote}`, "CONFIRMED");
      setWalkinSuccessAlert(`จองสนามแบบ Walk-in รหัส ${bkCode} สำเร็จแล้ว! ออกใบจองและเช็คอินได้เลย ${pointsAdded > 0 ? `(🎁 มอบแต้มสะสมสมาชิก +${pointsAdded} แต้มสำเร็จ!)` : ''}`);
    } else {
      setPendingWalkin({
        paymentId: newPayment.id,
        bookingCode: bkCode,
        amount: priceDetail.total,
        qrPayload: qrPayload || '',
        label: `${courtObj?.name || ''} ${walkinDate} ${walkinSlot}-${newBooking.endTime} (${walkinName})`
      });
    }
    
    // reset
    setWalkinSlot('');
    setWalkinName('');
    setWalkinPhone('');
    setWalkinVoucherCode('');
    onRefreshAll();
  };

  // Dynamic slots available check
  const getWalkinHours = () => {
    const list = [];
    for (let h = OPENING_HOUR; h < CLOSING_HOUR; h++) {
      list.push(h.toString().padStart(2, '0') + ':00');
    }
    return list;
  };

  // Phase 1 CORE: Approve Bank Slips (Slip Verification). Also confirms a
  // PromptPay walk-in once staff see the transfer arrive. Resolves to
  // whether it succeeded.
  const handleVerifySlip = (paymentId: string): Promise<boolean> => {
    if (api.USE_BACKEND) {
      const entry = reviewQueue.find(r => r.payment.id === paymentId);
      // Send the slip version staff were shown, so the server refuses the
      // approval if the customer swapped the slip in the meantime.
      return api.verifyPayment(paymentId, entry?.payment.slipUploadedAt)
        .then(res => {
          if (entry) {
            // One line per booked hour: a group can span courts and
            // non-adjacent hours, so a single "first start - last end"
            // range would misreport it.
            const lines = entry.bookings.map(b => {
              const courtName = courts.find(c => c.id === b.courtId)?.name || 'สนามกีฬาทั่วไป';
              return `- ${courtName} ${b.date} ${b.startTime}–${b.endTime}`;
            }).join('\n');
            const ptsNote = res.pointsAwarded > 0 ? `\n🎁 และได้รับแต้มสะสมเพิ่ม: +${res.pointsAwarded} แต้ม!` : '';
            pushLineMessage(entry.bookings[0]?.userPhone || '', `🎉 ยืนยันการจองแล้ว!\n📋 ${res.bookingCode}\n${lines}\nพบกันที่สนาม!${ptsNote}`, "CONFIRMED");
          }
          onAddAuditLog('SLIP_VERIFIED_BY_STAFF', 'Payment', paymentId, { status: entry?.payment.status ?? PaymentStatus.PENDING }, { status: PaymentStatus.VERIFIED });
          onRefreshAll();
          alert(`ยืนยันเรียบร้อยแล้ว! อนุมัติ ${res.bookingsCount} สล็อต ${res.pointsAwarded > 0 ? `(🎁 มอบคะแนนสะสมสมาชิก +${res.pointsAwarded} แต้ม)` : ''}`);
          return true;
        })
        .catch(err => {
          alert(`อนุมัติไม่สำเร็จ: ${err.message}`);
          onRefreshAll();
          return false;
        });
    }

    const allPayments = StorageService.get<Payment[]>('payments', []);
    const allBookings = StorageService.get<Booking[]>('bookings', []);

    const paymentObj = allPayments.find(p => p.id === paymentId);
    if (!paymentObj) return Promise.resolve(false);
    if (paymentObj.status !== PaymentStatus.SLIP_UPLOADED && paymentObj.status !== PaymentStatus.PENDING) {
      alert(`รายการนี้ถูกดำเนินการไปแล้ว (${paymentObj.status})`);
      onRefreshAll();
      return Promise.resolve(false);
    }

    const updatedPayments = allPayments.map(p => {
      if (p.id === paymentId) {
        return {
          ...p,
          status: PaymentStatus.VERIFIED,
          verifiedAt: new Date().toISOString(),
          verifiedBy: 'u-staff-1' // Current mock staff
        };
      }
      return p;
    });

    // The payment covers the whole booking group (up to 3 hours), so every
    // hour still awaiting payment is confirmed - not just the row the
    // payment hangs off - and points are awarded for exactly those hours
    // (FR-4.1: 1 point per hour), as the backend does.
    const rootBooking = allBookings.find(b => b.id === paymentObj.bookingId);
    const toConfirm = rootBooking
      ? bookingGroupOf(rootBooking, allBookings).filter(b => b.status === BookingStatus.PENDING_PAYMENT)
      : [];
    const confirmIds = new Set(toConfirm.map(b => b.id));

    let ptsAdded = 0;
    if (rootBooking && rootBooking.userId && toConfirm.length > 0) {
      ptsAdded = StorageService.addPointsHour(rootBooking.userId, toConfirm.length);
    }

    if (rootBooking && toConfirm.length > 0) {
      const lines = toConfirm.map(b => {
        const courtName = courts.find(c => c.id === b.courtId)?.name || 'สนามกีฬาทั่วไป';
        return `- ${courtName} ${b.date} ${b.startTime}–${b.endTime}`;
      }).join('\n');
      const ptsNote = ptsAdded > 0 ? `\n🎁 และได้รับแต้มสะสมเพิ่ม: +${ptsAdded} แต้ม!` : '';
      pushLineMessage(rootBooking.userPhone, `🎉 ยืนยันการจองแล้ว!\n📋 ${rootBooking.bookingCode}\n${lines}\nพบกันที่สนาม!${ptsNote}`, "CONFIRMED");
    }

    const updatedBookings = allBookings.map(b =>
      confirmIds.has(b.id) ? { ...b, status: BookingStatus.CONFIRMED } : b
    );

    StorageService.set('payments', updatedPayments);
    StorageService.set('bookings', updatedBookings);

    onAddAuditLog('SLIP_VERIFIED_BY_STAFF', 'Payment', paymentId, { status: paymentObj.status }, { status: PaymentStatus.VERIFIED });
    
    onRefreshAll();
    alert(`ยืนยันความถูกต้องเรียบร้อยแล้ว! อนุมัติ ${toConfirm.length} สล็อตและส่งไลน์ไปแจ้งเรียบร้อย ${ptsAdded > 0 ? `(🎁 มอบคะแนนสะสมสมาชิก +${ptsAdded} แต้ม)` : ''}`);
    return Promise.resolve(true);
  };

  // Phase 1 CORE: Reject Fraud Bank Slips (or cancel an unpaid walk-in).
  // Resolves to whether it succeeded.
  const handleRejectSlip = (paymentId: string, reason: string = rejectReason): Promise<boolean> => {
    if (!reason) {
      alert('กรุณากรอกสาเหตุการปฎิเสธสลิปด้วยค่ะ');
      return Promise.resolve(false);
    }

    if (api.USE_BACKEND) {
      const entry = reviewQueue.find(r => r.payment.id === paymentId);
      return api.rejectPayment(paymentId, reason, entry?.payment.slipUploadedAt)
        .then(res => {
          if (entry) {
            pushLineMessage(entry.bookings[0]?.userPhone || '', `❌ การจองถูกยกเลิกเนื่องจากตรวจสอบความถูกต้องสลิปไม่ผ่าน\nรหัส: ${res.bookingCode}\nเหตุผล: ${reason}\nหากมีข้อสงสัยติดต่อ LINE OA ได้นะคะ`, "CANCELLED");
          }
          onAddAuditLog('SLIP_REJECTED_BY_STAFF', 'Payment', paymentId, { status: entry?.payment.status ?? PaymentStatus.PENDING }, { status: PaymentStatus.REJECTED, reason });
          setRejectId(null);
          setRejectReason('');
          onRefreshAll();
          alert('ปฏิเสธรายการแล้ว ระบบยกเลิกเวลาที่จองไว้แล้ว');
          return true;
        })
        .catch(err => {
          alert(`ปฏิเสธไม่สำเร็จ: ${err.message}`);
          onRefreshAll();
          return false;
        });
    }

    const allPayments = StorageService.get<Payment[]>('payments', []);
    const allBookings = StorageService.get<Booking[]>('bookings', []);

    const paymentObj = allPayments.find(p => p.id === paymentId);
    if (!paymentObj) return Promise.resolve(false);
    if (paymentObj.status !== PaymentStatus.SLIP_UPLOADED && paymentObj.status !== PaymentStatus.PENDING) {
      alert(`รายการนี้ถูกดำเนินการไปแล้ว (${paymentObj.status})`);
      onRefreshAll();
      return Promise.resolve(false);
    }

    const updatedPayments = allPayments.map(p => {
      if (p.id === paymentId) {
        return { ...p, status: PaymentStatus.REJECTED, refundReason: reason };
      }
      return p;
    });

    // Cancel every hour of the group still awaiting payment, so none of
    // them is left pending - and blocking its slot - forever.
    const rootBooking = allBookings.find(b => b.id === paymentObj.bookingId);
    const cancelIds = new Set(
      (rootBooking ? bookingGroupOf(rootBooking, allBookings) : [])
        .filter(b => b.status === BookingStatus.PENDING_PAYMENT)
        .map(b => b.id)
    );
    if (rootBooking) {
      const rejectMsg = `❌ การจองถูกยกเลิกเนื่องจากตรวจสอบความถูกต้องสลิปไม่ผ่าน\nรหัส: ${rootBooking.bookingCode}\nเหตุผล: ${reason}\nหากมีข้อสงสัยติดต่อ LINE OA ได้นะคะ`;
      pushLineMessage(rootBooking.userPhone, rejectMsg, "CANCELLED");
    }

    const updatedBookings = allBookings.map(b =>
      cancelIds.has(b.id)
        ? { ...b, status: BookingStatus.CANCELLED, cancellationReason: `สลิปไม่ผ่านเกณฑ์: ${reason}` }
        : b
    );

    StorageService.set('payments', updatedPayments);
    StorageService.set('bookings', updatedBookings);

    onAddAuditLog('SLIP_REJECTED_BY_STAFF', 'Payment', paymentId, { status: paymentObj.status }, { status: PaymentStatus.REJECTED, reason });
    
    setRejectId(null);
    setRejectReason('');
    onRefreshAll();
    alert('ปฏิเสธรายการแล้ว ระบบยกเลิกเวลาที่จองไว้แล้ว');
    return Promise.resolve(true);
  };

  // Managers/admins may cancel, refund and record cash (FR-6.3); every
  // staff member may mark a no-show. API mode: the signed-in staff account's
  // role; browser-only mode: the role switcher.
  const effectiveRole = api.USE_BACKEND ? staffUser?.role : currentUserRole;
  const canManageBookings = effectiveRole === UserRole.MANAGER || effectiveRole === UserRole.ADMIN;

  const closeBookingDetail = () => {
    setSelectedReceiptBooking(null);
    setSelectedReceiptOrder(null);
  };

  // Manager/admin cancellation of a booking (this hour or the whole group),
  // optionally recording a refund of what was paid. Reason required.
  const handleCancelBooking = (booking: Booking) => {
    const reason = window.prompt(`เหตุผลการยกเลิกการจอง ${booking.bookingCode} (จำเป็น - บันทึกใน Audit Log):`)?.trim();
    if (!reason) return;
    const allBookings = api.USE_BACKEND ? bookings : StorageService.get<Booking[]>('bookings', []);
    const group = bookingGroupOf(booking, allBookings).filter(b => b.status === BookingStatus.PENDING_PAYMENT || b.status === BookingStatus.CONFIRMED);
    const wholeGroup = group.length <= 1 || window.confirm(
      `การจอง ${booking.bookingCode} มี ${group.length} ชั่วโมงที่ยังใช้งานอยู่\n\nกด OK = ยกเลิกทั้งหมด ${group.length} ชั่วโมง\nกด Cancel = ยกเลิกเฉพาะ ${booking.startTime}-${booking.endTime}`);
    const target = wholeGroup ? group : [booking];
    const paid = target.some(b => b.status === BookingStatus.CONFIRMED);
    const paidAmount = target.filter(b => b.status === BookingStatus.CONFIRMED).reduce((s, b) => s + b.totalAmount, 0);
    // Nothing to refund on a free (voucher) hour - the voucher is given back instead.
    const refund = paid && paidAmount > 0 && window.confirm(`บันทึกการคืนเงินค่าสนามที่ชำระแล้ว ${formatBaht(paidAmount)} บาทด้วยหรือไม่?\n(โอนคืนลูกค้าเองแล้วกด OK / ไม่คืนเงินกด Cancel)`);

    if (api.USE_BACKEND) {
      api.cancelBooking(booking.id, reason, refund, wholeGroup ? undefined : [booking.id])
        .then(res => {
          onAddAuditLog('BOOKING_CANCELLED_BY_MANAGER', 'Booking', booking.id, null, { ...res, reason });
          closeBookingDetail();
          onRefreshAll();
          alert(`ยกเลิก ${res.cancelled} ชั่วโมงแล้ว${res.refundAmount ? ` · บันทึกคืนเงิน ${formatBaht(res.refundAmount)} บาท` : ''}${res.pointsReversed ? ` · หักแต้มคืน ${res.pointsReversed}` : ''}`);
        })
        .catch(err => alert(`ยกเลิกไม่สำเร็จ: ${err.message}`));
      return;
    }

    // Browser-only mode: same rules on localStorage.
    const ids = new Set(target.map(b => b.id));
    const paidRows = target.filter(b => b.status === BookingStatus.CONFIRMED);
    const refundAmount = roundBaht(target.reduce((s, b) => s + b.totalAmount, 0));
    StorageService.set('bookings', allBookings.map(b => ids.has(b.id)
      ? { ...b, status: BookingStatus.CANCELLED, cancellationReason: `ยกเลิกโดยผู้จัดการ: ${reason}` } : b));
    const groupIds = new Set(bookingGroupOf(booking, allBookings).map(b => b.id));
    const remaining = group.length - target.length;
    StorageService.set('payments', StorageService.get<Payment[]>('payments', []).map(p => {
      if (!groupIds.has(p.bookingId)) return p;
      if (refund) {
        const total = roundBaht((p.refundAmount || 0) + refundAmount);
        return { ...p, refundAmount: total, refundReason: reason, refundedAt: new Date().toISOString(), refundedBy: 'manager',
          status: total >= p.amount ? PaymentStatus.REFUNDED : p.status };
      }
      if (remaining === 0 && (p.status === PaymentStatus.PENDING || p.status === PaymentStatus.SLIP_UPLOADED)) {
        return { ...p, status: PaymentStatus.REJECTED, refundReason: reason };
      }
      return p;
    }));
    // A cancelled voucher hour hands the voucher back to the customer.
    StorageService.set('redemptions', StorageService.get<LocalVoucher[]>('redemptions', []).map(r => r.bookingId && ids.has(r.bookingId)
      ? { ...r, status: 'ACTIVE', dispensedAt: undefined, bookingId: undefined } : r));
    const paidPointRows = paidRows.filter(b => b.totalAmount > 0);
    const reversed = paidPointRows.length ? StorageService.addLedgerEntry(booking.userId, LedgerEntryType.REVERSE_BOOKING, -paidPointRows.length, 'manager', { note: `${paidPointRows.length}h of ${booking.bookingCode} cancelled: ${reason}` }) : 0;
    onAddAuditLog('BOOKING_CANCELLED_BY_MANAGER', 'Booking', booking.id, null, { cancelled: target.length, refund, refundAmount: refund ? refundAmount : 0, reason });
    closeBookingDetail();
    onRefreshAll();
    alert(`ยกเลิก ${target.length} ชั่วโมงแล้ว${refund ? ` · บันทึกคืนเงิน ${formatBaht(refundAmount)} บาท` : ''}${reversed ? ` · หักแต้มคืน ${-reversed}` : ''}`);
  };

  // Manager/admin: the customer paid this unpaid booking in cash at the
  // counter - confirms it like an approved slip (counted in the cash drawer).
  const handleMarkPaidInCash = (booking: Booking) => {
    if (!window.confirm(`ยืนยันว่าได้รับเงินสดสำหรับการจอง ${booking.bookingCode} แล้ว?`)) return;
    const done = (count: number, pts: number) => {
      onAddAuditLog('PAID_IN_CASH_RECORDED', 'Booking', booking.id, null, { bookingCode: booking.bookingCode });
      closeBookingDetail();
      onRefreshAll();
      alert(`บันทึกรับเงินสดแล้ว ยืนยัน ${count} ชั่วโมง${pts ? ` (+${pts} แต้ม)` : ''}`);
    };
    if (api.USE_BACKEND) {
      api.markBookingPaidInCash(booking.id)
        .then(res => done(res.bookingsCount, res.pointsAwarded))
        .catch(err => alert(`บันทึกไม่สำเร็จ: ${err.message}`));
      return;
    }
    const allBookings = StorageService.get<Booking[]>('bookings', []);
    const group = bookingGroupOf(booking, allBookings);
    const groupIds = new Set(group.map(b => b.id));
    const pending = group.filter(b => b.status === BookingStatus.PENDING_PAYMENT);
    const pendingIds = new Set(pending.map(b => b.id));
    StorageService.set('bookings', allBookings.map(b => pendingIds.has(b.id) ? { ...b, status: BookingStatus.CONFIRMED } : b));
    StorageService.set('payments', StorageService.get<Payment[]>('payments', []).map(p => groupIds.has(p.bookingId)
      ? { ...p, method: PaymentMethod.CASH, status: PaymentStatus.VERIFIED, verifiedAt: new Date().toISOString(), verifiedBy: 'manager' } : p));
    const pts = pending.length ? StorageService.addPointsHour(booking.userId, pending.length) : 0;
    done(pending.length, pts);
  };

  // Any staff: the customer didn't come for this (already started) hour.
  // The hour's loyalty point is taken back; the payment is kept.
  const handleMarkNoShow = (booking: Booking) => {
    if (!window.confirm(`บันทึกว่าลูกค้าไม่มาใช้สนาม ${booking.startTime}-${booking.endTime} (${booking.bookingCode})?`)) return;
    const done = () => {
      onAddAuditLog('BOOKING_NO_SHOW', 'Booking', booking.id, { status: booking.status }, { status: BookingStatus.NO_SHOW });
      closeBookingDetail();
      onRefreshAll();
    };
    if (api.USE_BACKEND) {
      api.markNoShow(booking.id).then(done).catch(err => alert(`บันทึกไม่สำเร็จ: ${err.message}`));
      return;
    }
    StorageService.set('bookings', StorageService.get<Booking[]>('bookings', []).map(b => b.id === booking.id ? { ...b, status: BookingStatus.NO_SHOW } : b));
    if (booking.totalAmount > 0) { // a free (voucher) hour earned no point to take back
      StorageService.addLedgerEntry(booking.userId, LedgerEntryType.REVERSE_BOOKING, -1, 'staff', { note: `No-show ${booking.date} ${booking.startTime}` });
    }
    done();
  };

  // Manager/admin refund of a payment with no booking standing for it -
  // e.g. a late payment whose slot was taken meanwhile.
  const handleRefundPayment = (pay: Payment) => {
    const reason = window.prompt(`เหตุผลการคืนเงิน ${formatBaht(pay.amount - (pay.refundAmount || 0))} บาท (จำเป็น):`)?.trim();
    if (!reason) return;
    if (api.USE_BACKEND) {
      api.refundPayment(pay.id, reason)
        .then(p => {
          onAddAuditLog('PAYMENT_REFUNDED', 'Payment', pay.id, null, { refundAmount: p.refundAmount, reason });
          onRefreshAll();
          alert(`บันทึกคืนเงิน ${formatBaht(p.refundAmount || 0)} บาทแล้ว`);
        })
        .catch(err => alert(`คืนเงินไม่สำเร็จ: ${err.message}`));
      return;
    }
    const allBookings = StorageService.get<Booking[]>('bookings', []);
    const root = allBookings.find(b => b.id === pay.bookingId);
    const groupIds = new Set(root ? bookingGroupOf(root, allBookings).map(b => b.id) : []);
    StorageService.set('bookings', allBookings.map(b => groupIds.has(b.id) && b.status === BookingStatus.PENDING_PAYMENT
      ? { ...b, status: BookingStatus.CANCELLED, cancellationReason: `คืนเงิน: ${reason}` } : b));
    StorageService.set('payments', StorageService.get<Payment[]>('payments', []).map(p => p.id === pay.id
      ? { ...p, status: PaymentStatus.REFUNDED, refundAmount: p.amount, refundReason: reason, refundedAt: new Date().toISOString() } : p));
    onAddAuditLog('PAYMENT_REFUNDED', 'Payment', pay.id, null, { refundAmount: pay.amount, reason });
    onRefreshAll();
  };

  // Reward voucher check: look the code up, then mark it handed over.
  // Browser-only mode keeps vouchers in localStorage ("redemptions").
  const handleLookupVoucher = () => {
    setVoucherError(null);
    setVoucherFound(null);
    const code = voucherCode.trim().toUpperCase();
    if (!code) return;
    if (api.USE_BACKEND) {
      api.lookupVoucher(code)
        .then(v => setVoucherFound({ code: v.code, reward: `${v.rewardEmoji} ${v.rewardName}`, customer: `${v.userName || ''} ${v.userPhone || ''}`,
          name: v.userName || '', phone: v.userPhone || '', freeHour: v.rewardKind === 'FREE_OFFPEAK_HOUR', status: v.status,
          expires: new Date(v.expiresAt).toLocaleDateString('th-TH') }))
        .catch(err => setVoucherError(err instanceof api.ApiError && err.status === 404 ? 'ไม่พบรหัสนี้' : err.message));
      return;
    }
    const v = StorageService.get<LocalVoucher[]>('redemptions', []).find(r => r.claimCode === code);
    if (!v) { setVoucherError('ไม่พบรหัสนี้'); return; }
    const owner = StorageService.get<User[]>('users', []).find(u => u.id === v.userId);
    setVoucherFound({ code: v.claimCode, reward: v.rewardName, customer: `${v.userName} ${owner?.phone || ''}`, name: owner?.name || v.userName,
      phone: owner?.phone || '', freeHour: FREE_HOUR_REWARD_IDS.includes(v.rewardId), status: v.status || 'ACTIVE' });
  };

  // A free off-peak hour is used by booking it: open the walk-in form with
  // the voucher and the customer filled in; staff pick the court and hour.
  const handleUseFreeHourVoucher = () => {
    if (!voucherFound) return;
    setWalkinPayMethod(PaymentMethod.VOUCHER);
    setWalkinVoucherCode(voucherFound.code);
    setWalkinName(voucherFound.name);
    setWalkinPhone(voucherFound.phone);
    setActivePosTab('walkin');
  };

  const handleDispenseVoucher = () => {
    if (!voucherFound) return;
    const code = voucherFound.code;
    const done = () => {
      onAddAuditLog('VOUCHER_DISPENSED', 'Voucher', code, { status: 'ACTIVE' }, { status: 'REDEEMED' });
      setVoucherFound({ ...voucherFound, status: 'REDEEMED' });
      alert(`มอบของรางวัล ${voucherFound.reward} แล้ว`);
    };
    if (api.USE_BACKEND) {
      api.dispenseVoucher(code).then(done).catch(err => setVoucherError(err.message));
      return;
    }
    const list = StorageService.get<LocalVoucher[]>('redemptions', []);
    if (list.find(r => r.claimCode === code)?.status === 'REDEEMED') { setVoucherError('รหัสนี้รับของไปแล้ว'); return; }
    StorageService.set('redemptions', list.map(r => r.claimCode === code ? { ...r, status: 'REDEEMED', dispensedAt: new Date().toISOString() } : r));
    done();
  };

  // A PromptPay walk-in waiting for staff to see the transfer arrive.
  const confirmPendingWalkin = () => {
    if (!pendingWalkin) return;
    handleVerifySlip(pendingWalkin.paymentId).then(ok => {
      if (ok) {
        setWalkinSuccessAlert(`จองสนามแบบ Walk-in รหัส ${pendingWalkin.bookingCode} ยืนยันการรับเงิน ${pendingWalkin.amount} บาทแล้ว!`);
        setPendingWalkin(null);
      }
    });
  };

  const cancelPendingWalkin = () => {
    if (!pendingWalkin) return;
    if (!window.confirm(`ยกเลิกการจอง ${pendingWalkin.bookingCode} ที่ยังไม่ได้ชำระเงินใช่หรือไม่?`)) return;
    handleRejectSlip(pendingWalkin.paymentId, 'ยกเลิกที่เคาน์เตอร์ ยังไม่ได้ชำระเงิน').then(ok => {
      if (ok) setPendingWalkin(null);
    });
  };

  // F&B Add to Receipt Cart
  const handleAddToCart = (product: Product) => {
    if (product.stock <= 0) {
      alert('ขออภัยค่ะ! สินค้าชิ้นนี้หมดคลังชั่วคราว ขัดข้องการเช็กเอาท์');
      return;
    }

    const exists = cartItems.find(item => item.product.id === product.id);
    if (exists) {
      if (exists.qty >= product.stock) {
        alert('ไม่สามารถเพิ่มได้เกินจำนวนสินค้าที่มีอยู่ในระบบคลัง');
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
        alert('จำนวนเกินสินค้าที่มีในตู้แช่/คลัง');
        return;
      }
      setCartItems(cartItems.map(item => 
        item.product.id === productId ? { ...item, qty: newQty } : item
      ));
    }
  };

  // F&B Checkout submit
  const handleCartCheckout = () => {
    if (cartItems.length === 0) {
      alert('รถเข็นใบเสร็จว่างเปล่า! กรุณากดสินค้าเติมตระกร้า');
      return;
    }

    const totalAmount = cartItems.reduce((acc, current) => acc + (current.product.price * current.qty), 0);
    const orderId = 'o-' + Date.now();
    const orderCode = `OD${getTodayDateStr().replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;

    const newOrderItems = cartItems.map(item => ({
      id: 'oi-' + Math.random().toString(36).substring(7),
      orderId: orderId,
      productId: item.product.id,
      qty: item.qty,
      unitPrice: item.product.price
    }));

    const newOrder: Order = {
      id: orderId,
      orderCode,
      userId: cartUserId || undefined,
      customerName: cartCustomerName || 'ลูกค้าทั่วไป (Walk-in)',
      courtId: cartCourtId || undefined,
      type: OrderType.FB,
      status: OrderStatus.DELIVERED,
      totalAmount,
      paidAmount: totalAmount,
      paymentMethod: cartPayMethod,
      createdAt: new Date().toISOString(),
      createdBy: 'u-staff-1',
      items: newOrderItems
    };

    // Decrement stock inventories (Anti-fraud strict stock tracking)
    const rawProducts = StorageService.get<Product[]>('products', []);
    const updatedProducts = rawProducts.map(p => {
      const match = cartItems.find(item => item.product.id === p.id);
      if (match) {
        return { ...p, stock: p.stock - match.qty };
      }
      return p;
    });

    const currentOrders = StorageService.get<Order[]>('orders', []);
    
    StorageService.set('products', updatedProducts);
    StorageService.set('orders', [...currentOrders, newOrder]);

    // Award Points
    let ptsAdded = 0;
    if (cartUserId) {
      ptsAdded = StorageService.addPoints(cartUserId, totalAmount);
    }

    onAddAuditLog('ORDER_CREATED_FB_BY_STAFF', 'Order', orderId, null, newOrder);

    // reset
    setCartItems([]);
    setCartCustomerName('');
    setCartCourtId('');
    setCartUserId('');
    setCartSuccessAlert(`ใบเสร็จ F&B ${orderCode} ตัดสต๊อกเรียบร้อย! ชำระผ่าน ${cartPayMethod} ยอดเงิน ${totalAmount} บาท ${ptsAdded > 0 ? `(🎁 ลูกค้าสะสมแต้ม +${ptsAdded} แต้ม!)` : ''}`);
    onRefreshAll();
  };

  // Equipment Rental Rent-out Process
  const handleRentalRentSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!rentalRenterName || !selectedProductId) {
      alert('กรุณากรอกชื่อผู้ขอเช่าเล่น และ เลือกชนิดอุปกรณ์กีฬา!');
      return;
    }

    const prodObj = products.find(p => p.id === selectedProductId);
    if (!prodObj || prodObj.stock <= 0) {
      alert('ของเช่าชิ้นนี้หมดชั่วคราว กรุณาติดต่อฝั่งสนาม');
      return;
    }

    const isShoes = prodObj.subCategory === 'shoes' || prodObj.name.includes('รองเท้า');

    // Verify and deduct shoe inventory if it's a shoe rental
    if (isShoes) {
      const currentShoeInv = StorageService.get<any[]>('shoe_inventory', []);
      const foundItem = currentShoeInv.find(item => item.size === rentalShoeSize && item.gender === rentalShoeGender);
      if (foundItem) {
        if ((foundItem.totalStock - foundItem.rentedCount) <= 0) {
          alert(`ขออภัยค่ะ! รองเท้า ${rentalShoeGender === 'M' ? 'ชาย' : 'หญิง'} เบอร์ ${rentalShoeSize} ถูกยืมครบหมดคลังชั่วคราวแล้ว`);
          return;
        }
        
        // Decrement available shoe custom stock
        const updatedShoeInv = currentShoeInv.map(item => {
          if (item.id === foundItem.id) {
            return { ...item, rentedCount: item.rentedCount + 1 };
          }
          return item;
        });
        StorageService.set('shoe_inventory', updatedShoeInv);
        setShoeInventory(updatedShoeInv);
      }
    }

    const totalAmount = rentalItemPrice;
    const orderId = 'o-rental-' + Date.now();
    const orderCode = `OD-RENT-${getTodayDateStr().replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;

    const newOrderItems = [{
      id: 'oi-rent-' + Math.random().toString(36).substring(7),
      orderId: orderId,
      productId: prodObj.id,
      qty: 1,
      unitPrice: totalAmount,
      shoeSize: isShoes ? rentalShoeSize : undefined,
      shoeGender: isShoes ? rentalShoeGender : undefined
    }];

    const newOrder: Order = {
      id: orderId,
      orderCode,
      userId: rentalUserId || undefined,
      customerName: `${rentalRenterName} (เช่าอุปกรณ์)`,
      courtId: rentalCourtId || undefined,
      type: OrderType.EQUIPMENT_RENT,
      status: OrderStatus.PREPARING, // preparing/using
      totalAmount,
      paidAmount: totalAmount,
      paymentMethod: PaymentMethod.CASH,
      createdAt: new Date().toISOString(),
      createdBy: 'u-staff-1',
      items: newOrderItems
    };

    // Decrement product mock main stock
    const rawProducts = StorageService.get<Product[]>('products', []);
    const updatedProducts = rawProducts.map(p => {
      if (p.id === prodObj.id) {
        return { ...p, stock: p.stock - 1 };
      }
      return p;
    });

    const currentOrders = StorageService.get<Order[]>('orders', []);
    StorageService.set('products', updatedProducts);
    StorageService.set('orders', [...currentOrders, newOrder]);

    // Award Points
    let ptsAdded = 0;
    if (rentalUserId) {
      ptsAdded = StorageService.addPoints(rentalUserId, totalAmount);
    }

    onAddAuditLog('RENTAL_CREATED_BY_STAFF', 'Order', orderId, null, newOrder);

    // reset
    setRentalRenterName('');
    setRentalCourtId('');
    setRentalUserId('');
    onRefreshAll();
    alert(`ปล่อยเช่าสำเร็จ! รหัสทำรายการเช่า ${orderCode} ${isShoes ? `(รองเท้าเพศ ${rentalShoeGender === 'M' ? 'ชาย' : 'หญิง'} เบอร์ ${rentalShoeSize})` : ''} ${ptsAdded > 0 ? `(🎁 ลูกค้าสะสมแต้ม +${ptsAdded} แต้ม!)` : ''}`);
  };

  // Return Rental Item back to system storage
  const handleReturnItem = (orderId: string, orderItemIdx: number) => {
    const rawOrders = StorageService.get<Order[]>('orders', []);
    const rawProducts = StorageService.get<Product[]>('products', []);

    const orderObj = rawOrders.find(o => o.id === orderId);
    if (!orderObj) return;

    const updatedOrders = rawOrders.map(o => {
      if (o.id === orderId) {
        return { ...o, status: OrderStatus.DELIVERED }; // completed return
      }
      return o;
    });

    const itemRef = orderObj.items[orderItemIdx];
    const updatedProducts = rawProducts.map(p => {
      if (p.id === itemRef.productId) {
        return { ...p, stock: p.stock + 1 };
      }
      return p;
    });

    // Reclaim shoe inventory back too if it has shoe size/gender metadata
    if (itemRef.shoeSize && itemRef.shoeGender) {
      const currentShoeInv = StorageService.get<any[]>('shoe_inventory', []);
      const updatedShoeInv = currentShoeInv.map(item => {
        if (item.size === itemRef.shoeSize && item.gender === itemRef.shoeGender) {
          return { ...item, rentedCount: Math.max(0, item.rentedCount - 1) };
        }
        return item;
      });
      StorageService.set('shoe_inventory', updatedShoeInv);
      setShoeInventory(updatedShoeInv);
    }

    StorageService.set('orders', updatedOrders);
    StorageService.set('products', updatedProducts);

    onAddAuditLog('RENTAL_RETURNED_BY_STAFF', 'Order', orderId, { status: OrderStatus.PREPARING }, { status: OrderStatus.DELIVERED });
    
    onRefreshAll();
    alert('บันทึกการส่งคืนอุปกรณ์กีฬาเข้าคลังเรียบร้อย! คืนสต๊อกให้สนามเรียบร้อย');
  };

  // Calculate Ledger parameters (Module 3 Specification). Booking money is
  // counted when it was received: in API mode from the server's day summary
  // (payments approved today by method, refunds recorded today); in
  // browser-only mode from localStorage. Completed and no-show hours count
  // as paid like confirmed ones.
  const calculateLedger = () => {
    const todayStr = getTodayDateStr();
    const paidBookings = bookings.filter(b => b.date === todayStr && isPaidBooking(b));

    // Day's orders (F&B / rentals) - browser-only in both modes
    const dayOrders = orders.filter(o => o.createdAt.startsWith(todayStr) && o.status !== OrderStatus.CANCELLED);
    const fbIncome = roundBaht(dayOrders.filter(o => o.type === OrderType.FB).reduce((sum, o) => sum + Number(o.totalAmount), 0));
    const rentalIncome = roundBaht(dayOrders.filter(o => o.type === OrderType.EQUIPMENT_RENT).reduce((sum, o) => sum + Number(o.totalAmount), 0));
    const cashSumFromOrders = dayOrders.filter(o => o.paymentMethod === PaymentMethod.CASH).reduce((sum, o) => sum + Number(o.totalAmount), 0);
    const qrSumFromOrders = dayOrders.filter(o => o.paymentMethod === PaymentMethod.PROMPTPAY).reduce((sum, o) => sum + Number(o.totalAmount), 0);

    let cashFromBookings = 0, qrFromBookings = 0, refunded = 0;
    if (api.USE_BACKEND) {
      cashFromBookings = daySummary?.cashReceived ?? 0;
      qrFromBookings = daySummary?.promptpayVerified ?? 0;
      refunded = daySummary?.refunded ?? 0;
    } else {
      // The group's payment hangs off its first row: look it up per group.
      const paymentFor = (b: Booking) => {
        const ids = new Set(bookingGroupOf(b, bookings).map(x => x.id));
        return payments.find(p => ids.has(p.bookingId));
      };
      for (const b of paidBookings) {
        const method = paymentFor(b)?.method;
        if (method === PaymentMethod.CASH) cashFromBookings += b.totalAmount;
        else if (method === PaymentMethod.PROMPTPAY) qrFromBookings += b.totalAmount;
      }
      refunded = payments.filter(p => p.refundedAt?.startsWith(todayStr)).reduce((sum, p) => sum + (p.refundAmount || 0), 0);
    }
    const bookingIncome = roundBaht(cashFromBookings + qrFromBookings);

    return {
      bookingCount: paidBookings.length,
      walkinCount: paidBookings.filter(b => b.createdBy !== 'customer' && b.createdBy !== b.userId).length,
      bookingIncome,
      fbIncome,
      rentalIncome,
      cashExpected: roundBaht(cashFromBookings + cashSumFromOrders),
      qrExpected: roundBaht(qrFromBookings + qrSumFromOrders),
      refunded: roundBaht(refunded),
      totalExpected: roundBaht(bookingIncome + fbIncome + rentalIncome)
    };
  };

  // Slips verification target list
  const pendingSlipPayments = api.USE_BACKEND
    ? reviewQueue.map(r => r.payment)
    : payments.filter(p => p.status === PaymentStatus.SLIP_UPLOADED);
  // Bookings the slip queue can resolve payments against.
  const slipQueueBookings = api.USE_BACKEND ? reviewQueue.flatMap(r => r.bookings) : bookings;

  // API mode: everything on this panel acts as a staff member, so sign in
  // first (separately from any customer login in the same browser).
  if (api.USE_BACKEND && !staffUser) {
    return (
      <div className="max-w-sm mx-auto my-10 bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <form onSubmit={handleStaffLogin} className="space-y-3 text-xs">
          <p className="text-sm font-bold text-slate-800">เข้าสู่ระบบพนักงาน (Staff POS)</p>
          {staffApiError && (
            <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">⚠️ {staffApiError}</p>
          )}
          <input value={staffIdentity} onChange={e => setStaffIdentity(e.target.value)} placeholder="เบอร์โทร หรือ อีเมลพนักงาน" className="w-full border border-slate-300 rounded-lg px-3 py-2" required />
          <input type="password" value={staffPassword} onChange={e => setStaffPassword(e.target.value)} placeholder="รหัสผ่าน" className="w-full border border-slate-300 rounded-lg px-3 py-2" required />
          <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg py-2">เข้าสู่ระบบ</button>
          <DemoLogins accounts={DEMO_STAFF} onPick={staffLoginWith} />
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      
      {/* Staff Workspace Alert banner */}
      <div className="bg-slate-800 text-white p-4 rounded-2xl flex flex-wrap items-center justify-between gap-4 border border-slate-700 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 bg-emerald-950 text-emerald-400 rounded-xl flex items-center justify-center font-bold font-mono">POS</div>
          <div>
            <p className="text-xs font-bold">แผงทำงานพนักงานสปอร์ตคอมเพล็กซ์ (Staff Panel)</p>
            <p className="text-[10px] text-slate-400">ผู้ใช้งาน: {staffUser ? staffUser.name : 'คุณ กิตติ (เดโม)'} | สิทธิ์ของคุณ: <span className="text-emerald-400 font-extrabold">{effectiveRole}</span></p>
          </div>
        </div>

        {/* Quick notification queue tracker */}
        <div className="flex gap-4">
          <span className="text-xs bg-amber-500/20 text-amber-300 font-bold px-3 py-1.5 rounded-xl border border-amber-500/30 flex items-center gap-1">
            <AlertOctagon className="h-4 w-4 shrink-0 shrink-0" />
            คิวอนุมัติสลิปโอน: {pendingSlipPayments.length} รายการ
          </span>
        </div>
      </div>

      {/* POS Sub Tabs controller */}
      <div id="staff-pos-tabs" className="flex flex-wrap border-b border-slate-200 gap-1">
        <button
          onClick={() => setActivePosTab('walkin')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'walkin' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          🏸 บันทึก Walk-in ด่วน
        </button>
        <button
          onClick={() => setActivePosTab('slips')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition relative ${activePosTab === 'slips' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          📝 อนุมัติ Slip โอน ({pendingSlipPayments.length})
          {pendingSlipPayments.length > 0 && (
            <span className="absolute top-1 right-1 h-2.5 w-2.5 rounded-full bg-rose-600 animate-ping" />
          )}
        </button>
        <button
          onClick={() => setActivePosTab('fb')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'fb' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          ☕️ POS ขายอาหาร F&B / ลูกแบด
        </button>
        <button
          onClick={() => setActivePosTab('rentals')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'rentals' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          🏸 ยืม/เช่าแร็กเกต & รองเท้า
        </button>
        <button
          onClick={() => setActivePosTab('vouchers')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'vouchers' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          🎁 รับของรางวัล
        </button>
        <button
          onClick={() => setActivePosTab('todays_total')}
          className={`px-5 py-3 text-xs font-bold border-b-2 transition ${activePosTab === 'todays_total' ? 'border-emerald-700 text-emerald-800 bg-emerald-50/50' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
        >
          📊 ยอดลิ้นชักวันนี้ (Read-Only)
        </button>
      </div>

      {/* POS Contents Rendering */}
      <div id="pos-content-sections" className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm min-h-[400px]">
        
        {/* Tab 1: Walkin Booking */}
        {activePosTab === 'walkin' && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">รับจองคอร์ทหน้างาน (Walk-in Booking)</h3>
                <p className="text-xs text-slate-500">สำหรับลูกค้ายืนต่อแถวหน้าสนาม ไม่ต้องเช็คสลิปเนื่องจากพนักงานรับเงินสดหรือสแกนตรงนั้นทันที</p>
              </div>

              {walkinSuccessAlert && (
                <div className="bg-emerald-50 text-emerald-800 text-xs p-3.5 rounded-xl border border-emerald-200">
                  {walkinSuccessAlert}
                </div>
              )}

              <form onSubmit={handleWalkinBookingSubmit} className="space-y-4 text-xs">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1.5">1. เลือกสนามกีฬาที่ใช้</label>
                  <select 
                    value={walkinCourtId} 
                    onChange={(e) => setWalkinCourtId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 py-2.5 px-3 rounded-lg text-slate-800 font-medium text-xs"
                  >
                    {courts.map(c => (
                      <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">2. เลือกวันที่เล่น</label>
                    <input 
                      type="date" 
                      value={walkinDate} 
                      onChange={(e) => setWalkinDate(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-slate-800 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">3. ระบุคาบเวลา (1 ชม.)</label>
                    <select 
                      value={walkinSlot} 
                      onChange={(e) => setWalkinSlot(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 py-2.5 px-3 rounded-lg text-[11px]"
                    >
                      <option value="">--เลือกช่วงเวลา--</option>
                      {getWalkinHours().map(h => (
                        <option key={h} value={h}>{h} น. เป็นต้นไป</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">4. ชื่อย่อลูกค้าสำหรับออกบัตร</label>
                    <input 
                      type="text" 
                      required
                      placeholder="เช่น สมศักดิ์, พี่แบงค์" 
                      value={walkinName} 
                      onChange={(e) => setWalkinName(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">5. เบอร์มือถือรับ LINE แทงสถานะ</label>
                    <input 
                      type="tel" 
                      required
                      placeholder="เช่น 089xxxxxxx" 
                      value={walkinPhone} 
                      onChange={(e) => setWalkinPhone(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-xs"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1.5">6. เลือกช่องทางรับชำระ</label>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      id="walkin-pay-cash"
                      type="button"
                      onClick={() => setWalkinPayMethod(PaymentMethod.CASH)}
                      className={`p-2.5 rounded-lg border text-xs font-bold text-center transition ${walkinPayMethod === PaymentMethod.CASH ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}
                    >
                      💵 รับเงินสด
                    </button>
                    <button
                      id="walkin-pay-promptpay"
                      type="button"
                      onClick={() => setWalkinPayMethod(PaymentMethod.PROMPTPAY)}
                      className={`p-2.5 rounded-lg border text-xs font-bold text-center transition ${walkinPayMethod === PaymentMethod.PROMPTPAY ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}
                    >
                      📲 โอนผ่านธนาคาร / QR PromptPay
                    </button>
                    <button
                      id="walkin-pay-voucher"
                      type="button"
                      onClick={() => setWalkinPayMethod(PaymentMethod.VOUCHER)}
                      className={`p-2.5 rounded-lg border text-xs font-bold text-center transition ${walkinPayMethod === PaymentMethod.VOUCHER ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}
                    >
                      🎟️ คูปองชั่วโมงฟรี
                    </button>
                  </div>
                  {walkinPayMethod === PaymentMethod.VOUCHER && (
                    <input
                      id="walkin-voucher-code"
                      value={walkinVoucherCode}
                      onChange={e => setWalkinVoucherCode(e.target.value)}
                      placeholder="รหัสคูปอง RW-123456"
                      className="w-full mt-2 bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-xs font-mono uppercase"
                    />
                  )}
                  <p className="text-[10px] text-slate-500 mt-1.5">
                    {walkinPayMethod === PaymentMethod.CASH
                      ? 'เงินสด: รับเงินก่อนกดยืนยัน ระบบยืนยันการจองทันทีและนับเข้าลิ้นชักเงินสด'
                      : walkinPayMethod === PaymentMethod.VOUCHER
                        ? 'คูปอง: ฟรี 1 ชั่วโมงช่วง Off-Peak ใช้ได้ครั้งเดียว จองในชื่อเจ้าของคูปอง ไม่ได้แต้มสะสม'
                        : 'โอน: ระบบแสดง QR และยอดเงิน แล้วกดยืนยันเมื่อเห็นเงินเข้า'}
                  </p>
                </div>

                <button 
                  type="submit" 
                  className="w-full bg-[#1e293b] hover:bg-[#334155] text-white py-3 rounded-lg font-bold text-xs shadow-sm transition"
                >
                  {walkinPayMethod === PaymentMethod.CASH ? 'รับเงินสดแล้ว ออกตั๋วคอร์ท' : walkinPayMethod === PaymentMethod.VOUCHER ? 'ใช้คูปองและออกตั๋วคอร์ท' : 'สร้างรายการจองและแสดง QR รับชำระ'} &rarr;
                </button>
              </form>

              {/* PromptPay walk-in awaiting the transfer: the amount is the
                  server's price (member discount included), and the booking
                  is only confirmed - and points awarded - once staff see
                  the money arrive. */}
              {pendingWalkin && (
                <div id="walkin-pending-payment" className="mt-4 p-4 rounded-xl border-2 border-amber-300 bg-amber-50 space-y-3 text-xs">
                  <p className="font-black text-amber-900">⏳ รอลูกค้าโอนเงิน · {pendingWalkin.bookingCode}</p>
                  <p className="text-amber-800">{pendingWalkin.label}</p>
                  <div className="flex items-center gap-4">
                    {pendingWalkin.qrPayload && (
                      <div className="bg-white p-2 rounded-lg border border-amber-200">
                        <QRCodeSVG value={pendingWalkin.qrPayload} size={132} />
                      </div>
                    )}
                    <div>
                      <p className="text-slate-500">ยอดที่ต้องชำระ</p>
                      <p id="walkin-pending-amount" className="text-2xl font-black text-slate-900">{formatBaht(pendingWalkin.amount)} บาท</p>
                      <p className="text-[10px] text-slate-500 mt-1">ให้ลูกค้าสแกน QR แล้วตรวจยอดเงินเข้าก่อนกดยืนยัน</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={confirmPendingWalkin} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-lg">
                      ✅ ได้รับเงินแล้ว ยืนยันการจอง
                    </button>
                    <button type="button" onClick={cancelPendingWalkin} className="bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold py-2 rounded-lg">
                      ยกเลิกรายการ
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Interactive booked monitor table */}
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex flex-col justify-between">
              <div className="space-y-4">
                <span className="text-xs font-bold text-slate-700 flex items-center gap-1">
                  <Activity className="h-4 w-4 text-emerald-600 animate-pulse" />
                  ตารางเช็กยอดความเบียดหนาแน่นสนามวันนี้ ({getTodayDateStr()})
                </span>
                <span className="block text-[10px] text-slate-400">รายการสนามกีฬาทั้งหมด ที่ถูกยืนยันการจองเรียบร้อยแล้วของวันนี้</span>

                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                  {bookings.filter(b => b.date === walkinDate && b.status !== BookingStatus.CANCELLED).map((b) => (
                    <div key={b.id} className="bg-white p-3 rounded-xl border border-slate-200/60 text-xs flex justify-between items-center bg-slate-50/20 hover:bg-slate-50 transition">
                      <div>
                        <p className="font-bold text-slate-800">{courts.find(c => c.id === b.courtId)?.name}</p>
                        <p className="text-[10px] text-slate-500">ผู้จอง: {b.userName} | เวลา: <span className="font-bold text-slate-700">{b.startTime} - {b.endTime} น.</span></p>
                        <p className="text-[9px] text-slate-400">รหัสจอง: <span className="font-mono">{b.bookingCode}</span> | ยอด: {b.totalAmount} บ.</p>
                      </div>
                      <div className="flex flex-col gap-1 items-end">
                        {b.status === BookingStatus.PENDING_PAYMENT ? (
                          <span className="text-[9px] bg-amber-100 text-amber-800 font-extrabold px-1.5 py-0.5 rounded-md">รอชำระเงิน</span>
                        ) : (
                          <span className="text-[9px] bg-emerald-100 text-emerald-800 font-extrabold px-1.5 py-0.5 rounded-md">ยืนยันแล้ว</span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedReceiptBooking(b);
                            setSelectedReceiptOrder(null);
                          }}
                          className="text-[9px] bg-slate-800 hover:bg-slate-700 text-white font-bold py-1 px-2 rounded-md flex items-center gap-1 transition-all mt-1"
                        >
                          <Receipt className="h-3 w-3" /> ออกใบเสร็จ
                        </button>
                      </div>
                    </div>
                  ))}
                  {bookings.filter(b => b.date === walkinDate && b.status !== BookingStatus.CANCELLED).length === 0 && (
                    <p className="text-[10px] text-slate-400 text-center py-10">ยังไม่มีผู้จองสนามในวันนี้ สามารถเปิดรับตึกวอล์กอินได้ตลอดเวลา</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* DYNAMIC COURT OCCUPANCY MONITOR MATRIX FOR COUNTER STAFF */}
          <div className="mt-8 border-t border-slate-200 pt-6 space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 bg-slate-50 p-4 rounded-xl border border-slate-200">
              <div>
                <h3 className="text-sm font-black text-[#0f172a] uppercase tracking-wider flex items-center gap-1.5 font-sans">
                  🎾 แดชบอร์ดตรวจสอบมอนิเตอร์ดีมานด์ภาพรวม & จองสนามด่วน (Occupancy Grid Matrix & Pos Shortcut)
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  เลือกดูสถานะว่าง/จัดงาน/ซ่อมบำรุง ทุกสนามพร้อมกันของวันที่ <span className="font-bold underline text-slate-800">{walkinDate}</span>. 
                  (คลิกที่สล็อตช่วงเวลาว่าง เพื่อตั้งค่าและเลือกรับลงทะเบียนจองในแบบฟอร์มด้านบนได้ทันที!)
                </p>
              </div>

              {/* Sport Type Filters for Grid */}
              <div className="flex flex-wrap gap-1 bg-[#f1f5f9] p-1 rounded-lg">
                {[CourtType.BADMINTON, CourtType.BASKETBALL, CourtType.PICKLEBALL, CourtType.MEETING_ROOM].map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setPosGridSportType(type)}
                    className={`px-3 py-1.5 rounded-md text-[10px] font-bold transition-all ${
                      posGridSportType === type
                        ? 'bg-[#1e293b] text-white shadow'
                        : 'text-slate-650 hover:bg-slate-200/50'
                    }`}
                  >
                    {type === CourtType.BADMINTON ? '🏸 แบดมินตัน' : 
                     type === CourtType.BASKETBALL ? '🏀 บาสเกตบอล' : 
                     type === CourtType.PICKLEBALL ? '🏓 พิคเคิลบอล' : '🏢 ห้องประชุม'}
                  </button>
                ))}
              </div>
            </div>

            {/* Grid display table */}
            <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white shadow-inner">
              <table className="w-full text-left border-collapse min-w-[1100px]">
                <thead>
                  <tr className="bg-[#f8fafc] text-[10px] uppercase font-black text-slate-500 border-b border-slate-250">
                    <th className="p-3 bg-[#f8fafc] sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] w-36 border-r border-slate-200">สนาม</th>
                    {getWalkinHours().map((time) => (
                      <th key={time} className="p-2 text-center text-[9px] min-w-[75px] border-l border-slate-200">
                        {time} น.
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white text-[10px]" id="staff-pos-grid">
                  {courts.filter(c => c.type === posGridSportType).map((court) => (
                    <tr key={court.id} className="hover:bg-slate-50/50 transition-colors">
                      {/* Sticky Court Left Header */}
                      <td className="p-2.5 font-bold text-slate-800 bg-[#f8fafc]/95 sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] border-r border-slate-200">
                        <span className="block text-[11px] font-black">{court.name}</span>
                        {court.offPeakOnly && (
                          <span className="text-[8px] text-[#0f5132] font-semibold bg-[#d1e7dd] px-1 py-0.2 rounded w-max mt-0.5 inline-block">Off-Peak เท่านั้น</span>
                        )}
                      </td>

                      {/* Hourly slots */}
                      {getWalkinHours().map((time) => {
                        const hourNum = parseInt(time.split(':')[0], 10);

                        // 1. Is there a booking on this court OR a mutex-group
                        // sibling (FR-1.2, e.g. the full court)?
                        const bItem = findConflictingBooking(court.id, walkinDate, time, bookings, courts);

                        // 2. Is there a closure/maintenance?
                        const closureItem = daysOff.find(
                          d => d.date === walkinDate &&
                               (d.courtId === 'all' || d.courtId === court.id) &&
                               (d.isFullDay || d.isFullDay === undefined || (d.startHour !== undefined && d.endHour !== undefined && hourNum >= d.startHour && hourNum < d.endHour))
                        );

                        // 3. Peak/Offpeak, read from the same PricingRule config
                        // the price itself uses.
                        const isPeak = !isHourOffPeak(court.type, walkinDate, hourNum);

                        // 4. Half-court offpeak-only rule (FR-1.2)
                        const isBasketballHalfCourt = !!court.offPeakOnly;
                        const isRestrictedPeakBasketball = isBasketballHalfCourt && isPeak;

                        // 5. Is it the currently selected slot on the POS left panel?
                        const isActiveSelection = walkinCourtId === court.id && walkinSlot === time;

                        if (bItem) {
                          const isPending = bItem.status === BookingStatus.PENDING_PAYMENT;
                          return (
                            <td 
                              key={time} 
                              onClick={() => {
                                setSelectedReceiptBooking(bItem);
                                setSelectedReceiptOrder(null);
                              }}
                              className="p-1 border-l border-slate-200 text-center bg-rose-50 hover:bg-rose-100 text-rose-800 font-bold min-h-[44px] cursor-pointer"
                              title="คลิกเพื่อออกใบเสร็จภาษี"
                            >
                              <span className="block text-[8px] font-black text-rose-600">🔴 จองแล้ว</span>
                              <span className="block text-[9px] text-[#0f172a] whitespace-nowrap overflow-hidden text-ellipsis max-w-[70px] mx-auto font-black" title={bItem.userName}>
                                {bItem.userName}
                              </span>
                              <span className="text-[7.5px] text-slate-500 font-mono scale-[0.9]">
                                {isPending ? '⏳ ค้างVerify'
                                  : bItem.status === BookingStatus.COMPLETED ? '🏁 เล่นแล้ว'
                                  : bItem.status === BookingStatus.NO_SHOW ? '🚫 ไม่มา'
                                  : '✓ ชำระแล้ว'}
                              </span>
                            </td>
                          );
                        }

                        if (closureItem) {
                          return (
                            <td 
                              key={time} 
                              className="p-1 border-l border-slate-200 bg-rose-100/70 text-rose-800 text-center min-h-[44px] cursor-not-allowed select-none font-medium"
                              title={`ปิดให้บริการ: ${closureItem.reason}`}
                            >
                              <span className="block text-[8px] font-black text-rose-700">⚠️ ปิดสนาม</span>
                              <span className="text-[7px] text-rose-900 block max-w-[65px] truncate mx-auto">
                                {closureItem.reason}
                              </span>
                            </td>
                          );
                        }

                        // Over: nobody can book it (an hour in progress still can be,
                        // at the counter).
                        if (slotTiming(walkinDate, time).ended) {
                          return (
                            <td 
                              key={time} 
                              className="p-1 border-l border-slate-200 bg-slate-100 text-slate-400 text-center min-h-[44px] cursor-not-allowed select-none"
                              title="ช่วงเวลานี้ผ่านไปแล้ว"
                            >
                              <span className="block text-[8px] font-semibold text-slate-500">⌛ ผ่านไปแล้ว</span>
                            </td>
                          );
                        }

                        if (isRestrictedPeakBasketball) {
                          return (
                            <td 
                              key={time} 
                              className="p-1 border-l border-slate-200 bg-slate-100 text-slate-400 text-center min-h-[44px] cursor-not-allowed select-none"
                              title="เฉพาะช่วงนิกาเพื่อสุขภาพ (Off-peak) เท่านั้น"
                            >
                              <span className="block text-[8px] font-semibold text-slate-500">🚫 ปิดช่วง Peak</span>
                              <span className="text-[7px] text-slate-400 block">บาสเกตบอลครึ่งสนาม</span>
                            </td>
                          );
                        }

                        const priceBase = calculatePrice(
                          posGridSportType, 
                          walkinDate, 
                          time, 
                          MemberType.NORMAL, 
                          court
                        );

                        // No pricing rule covers this hour: the server treats it
                        // as outside opening hours and refuses the booking.
                        if (!priceBase.isOpen) {
                          return (
                            <td 
                              key={time} 
                              className="p-1 border-l border-slate-200 bg-slate-100 text-slate-400 text-center min-h-[44px] cursor-not-allowed select-none"
                              title="นอกเวลาเปิดให้บริการ"
                            >
                              <span className="block text-[8px] font-semibold text-slate-500">🚫 ปิดบริการ</span>
                              <span className="text-[7px] text-slate-400 block">นอกเวลาทำการ</span>
                            </td>
                          );
                        }

                        if (isActiveSelection) {
                          return (
                            <td 
                              key={time} 
                              className="p-1 border-l border-slate-200 bg-[#3b82f6] text-white text-center font-bold relative cursor-pointer ring-2 ring-[#93c5fd] animate-pulse"
                              title="เลือกช่องสนามและชั่วโมงเวลานี้อยู่!"
                            >
                              <span className="block text-[8.5px] font-black uppercase text-white">⭐ จะจองคิว</span>
                              <span className="block text-[9px] font-mono leading-none">{priceBase.total}฿</span>
                            </td>
                          );
                        }

                        // Vacant cell clickable
                        return (
                          <td 
                            key={time} 
                            onClick={() => {
                              setWalkinCourtId(court.id);
                              setWalkinSlot(time);
                            }}
                            className={`p-1 border-l border-slate-200 text-center cursor-pointer transition min-h-[44px] ${
                              isPeak 
                                ? 'bg-amber-100/50 hover:bg-amber-100 text-amber-900' 
                                : 'bg-emerald-50/15 hover:bg-[#34d399]/20 text-slate-700'
                            }`}
                          >
                            <span className="block text-[8px] font-bold text-slate-500">🟢 ว่าง</span>
                            <span className="block text-[9.5px] font-mono font-black text-[#1e293b]">{priceBase.total}฿</span>
                            <span className="text-[7.5px] text-slate-400 italic block font-mono">
                              {isPeak ? '⚡ Peak' : 'Off-Peak'}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {courts.filter(c => c.type === posGridSportType).length === 0 && (
                    <tr>
                      <td colSpan={17} className="text-center text-slate-400 py-12 font-bold bg-slate-50">
                        ไม่มีข้อมูลประเภทกีฬา {posGridSportType} เพื่อตรวจสอบกริดระบบนี้
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-[10.5px] bg-[#f8fafc] px-3 py-2.5 rounded-lg border border-slate-200 font-mono text-slate-600">
              <span className="font-bold text-slate-700">📌 ทิปเคาน์เตอร์:</span>
              <span>1. คลิกช่อง "🟢 ว่าง" เพื่อเลือกรหัสสนามและเวลาลงฟอร์มออกตั๋วทันที</span>
              <span>2. คลิกช่อง "🔴 จองแล้ว" เพื่อดูรายละเอียดสลิป และพ่นพิมพ์ใบเสร็จ (ภาษีมูลค่าเพิ่ม 7%) ย้อนหลังได้</span>
            </div>
          </div>
          </>
        )}

        {/* Tab 2: Approve Slips */}
        {activePosTab === 'slips' && (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
                <ShieldCheck className="h-5 w-5 text-emerald-600" />
                คิวตรวจสอบสลิปโอนเงินลูกค้าออนไลน์ (Line Slip Verify Stage)
              </h3>
              <p className="text-xs text-slate-500">กรุณากดตรวจเช็กรายละเอียด รูปสลิปผู้เข้าใช้บริการก่อนการยืนยันจอง ป้องกันความคลาดเคลื่อนและสลิปปลอมแปลง</p>
            </div>

            {api.USE_BACKEND && staffApiError && (
              <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">⚠️ {staffApiError}</p>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {api.USE_BACKEND && staffUser && (
                <p className="md:col-span-2 text-[11px] text-slate-500">
                  ตรวจสลิปในนาม <span className="font-bold text-slate-700">{staffUser.name}</span>
                  <button type="button" onClick={handleStaffLogout} className="ml-2 underline text-slate-500 hover:text-slate-700">ออกจากระบบ</button>
                </p>
              )}

              {/* Slip list queue */}
              <div className="space-y-3">
                <span className="text-xs font-bold text-slate-700 block">สลิปที่รอสต๊าฟเวอริฟายเดลิเวอร์รี ({pendingSlipPayments.length} รายการ):</span>
                
                <div className="space-y-3 max-h-[400px] overflow-y-auto pr-1">
                  {pendingSlipPayments.map((pay) => {
                    const bookingObj = slipQueueBookings.find(b => b.id === pay.bookingId);
                    if (!bookingObj) return null;
                    const groupHours = slipQueueBookings.filter(b => b.bookingCode === bookingObj.bookingCode).length;
                    const courtName = courts.find(c => c.id === bookingObj.courtId)?.name || 'สนาม';

                    return (
                      <div key={pay.id} className="bg-slate-50 hover:bg-slate-100 p-4 rounded-xl border border-slate-200 text-xs space-y-2 relative transition">
                        <div className="flex justify-between items-start">
                          <div>
                            <span className="text-[10px] bg-[#1e293b] text-white px-2 py-0.5 rounded font-mono font-bold">{bookingObj.bookingCode}</span>
                            <p className="font-black text-slate-800 mt-1.5">{courtName}</p>
                            <p className="text-[10px] text-slate-500">ผู้จอง: <span className="text-slate-800 font-semibold">{bookingObj.userName}</span> | โทร: {bookingObj.userPhone}</p>
                            <p className="text-[10px] text-slate-500">จองเล่นวันที่: {bookingObj.date} | เวลา: {bookingObj.startTime} - {bookingObj.endTime} น.{groupHours > 1 ? ` (+${groupHours - 1} ชั่วโมงในกลุ่มเดียวกัน)` : ''}</p>
                          </div>
                          
                          <div className="text-right">
                            {pay.expiredAt && (
                              <p className="text-[9.5px] font-black text-rose-700 bg-rose-50 border border-rose-200 rounded px-1.5 py-0.5 mb-1">⚠️ ส่งสลิปหลังหมดเวลา</p>
                            )}
                            <p className="font-extrabold text-emerald-700 text-sm">{formatBaht(pay.amount)} บาท</p>
                            <p className="text-[9px] text-slate-400">อัพโหลดเมื่อ: {pay.slipUploadedAt ? pay.slipUploadedAt.split('T')[1].slice(0, 5) : 'ไม่ระบุ'}</p>
                          </div>
                        </div>

                        {/* Interactive check actions */}
                        <div className="flex items-center gap-2 pt-2 border-t border-slate-200">
                          {pay.slipUrl && (
                            <a 
                              href={pay.slipUrl} 
                              target="_blank" 
                              rel="noreferrer" 
                              className="text-xs text-sky-800 font-bold bg-sky-50 px-3 py-1.5 rounded hover:bg-sky-100 mr-auto text-center"
                            >
                              👀 ดึงดูสลิปโอนจริง
                            </a>
                          )}
                          
                          {canManageBookings && (
                            <button
                              type="button"
                              onClick={() => handleRefundPayment(pay)}
                              title="ลูกค้าโอนแล้วแต่ยืนยันการจองไม่ได้ (เช่น ส่งสลิปช้าและมีผู้อื่นจองไปแล้ว) - บันทึกการคืนเงิน"
                              className="bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-200 py-1.5 px-3 rounded text-[11px] font-bold transition"
                            >
                              💸 คืนเงิน
                            </button>
                          )}

                          <button
                            onClick={() => {
                              setRejectId(pay.id);
                              setRejectReason('');
                            }}
                            className="bg-slate-200 hover:bg-slate-300 text-slate-700 py-1.5 px-3 rounded text-[11px] font-bold transition"
                          >
                            ❌ ปฏิเสธ
                          </button>
                          
                          <button
                            type="button"
                            onClick={() => { void handleVerifySlip(pay.id); }}
                            className="bg-emerald-600 hover:bg-emerald-500 text-white py-1.5 px-4 rounded text-[11px] font-bold flex items-center gap-1 shadow-sm transition"
                          >
                            <Check className="h-3.5 w-3.5" /> อนุมัติสล็อตจอง
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  {pendingSlipPayments.length === 0 && (
                    <div className="text-center py-16 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                      <p className="text-xs text-slate-500 font-bold">ไม่มีรายการสลิปรอการยืนยันในตู้ทำงานขณะนี้ 🎉</p>
                      <p className="text-[10px] text-slate-400 mt-1">คิวเป็นระเบียบเรียบร้อยทั้งหมด</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Reject / Slip Reject dialogue drawer simulation */}
              <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200 flex flex-col justify-between">
                {rejectId ? (
                  <div className="space-y-4 text-xs">
                    <p className="font-bold text-slate-800 flex items-center gap-1 text-rose-700">
                      <AlertTriangle className="h-4 w-4" /> ปฏิเสธหลักฐานรูปสลิปลูกค้า
                    </p>
                    <p className="text-slate-500 text-[10px]">ระบบจะยิงแจ้งเตือนยกเลิกการสลักเวลา และยิง Push message คัดสิทธิ์ คืนเงิน ผ่านทางพอร์ท LINE OA ลูกค้าทันที</p>
                    
                    <div>
                      <label className="block text-slate-700 font-semibold mb-1.5">ระบุเหตุผลการปฏิเสธยอดสลิป:</label>
                      <textarea
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="เช่น มียอดเบี่ยงเบนเล็กน้อย, สลิปซ้ำซ้อนรอบบ่าย, ตรวจสอบเงินไม่เข้าธนาคารกสิกร"
                        className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs focus:outline-none"
                        rows={3}
                      />
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => { void handleRejectSlip(rejectId); }}
                        className="bg-rose-600 hover:bg-rose-500 text-white font-bold py-2 px-4 rounded"
                      >
                        ยืนยันการปฎิเสธ (Cancel Booking)
                      </button>
                      <button
                        onClick={() => setRejectId(null)}
                        className="bg-slate-200 hover:bg-slate-300 text-slate-700 py-2 px-4 rounded"
                      >
                        ยกเลิก
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-20 text-slate-400 font-sans space-y-2">
                    <CheckCircle2 className="h-10 w-10 text-slate-300 mx-auto" />
                    <p className="text-xs font-bold">ไม่มีการปฎิเสธรายการโอนคาคีย์</p>
                    <p className="text-[9.5px] text-slate-400">เลือกกด 'ปฏิเสธ (Reject)' เพื่อเปิดแผงสาเหตุที่นี่</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {activePosTab === 'fb' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            
            {/* Products Selector Grid (Left-Side) */}
            <div className="col-span-1 lg:col-span-7 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700 block">เมนูอาหารและเครื่องดื่ม (F&B Only):</span>
                <span className="text-[10px] text-slate-400 font-medium">กดเลือกอาหาร/เครื่องดื่มเพื่อเพิ่มลงในตะกร้า</span>
              </div>

              {cartSuccessAlert && (
                <div className="bg-emerald-50 text-emerald-800 text-xs p-3.5 rounded-xl border border-emerald-200 flex justify-between">
                  <span>{cartSuccessAlert}</span>
                  <button onClick={() => setCartSuccessAlert(null)} className="font-bold underline text-[10px]">ตกลง</button>
                </div>
              )}

              <div id="products-pos-grid" className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {products.filter(p => p.isActive && p.category === ProductCat.FB && !p.isRental).map((prod) => (
                  <div 
                    key={prod.id} 
                    onClick={() => handleAddToCart(prod)}
                    className="bg-slate-50 border border-slate-200 hover:border-slate-300 hover:bg-slate-100/50 p-3.5 rounded-xl text-left flex flex-col justify-between cursor-pointer transition select-none h-32"
                  >
                    <div className="space-y-1">
                      <span className="inline-block text-[8px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                        อาหารและเครื่องดื่ม
                      </span>
                      <p className="font-bold text-slate-800 text-xs line-clamp-2 leading-snug">{prod.name}</p>
                    </div>

                    <div className="flex justify-between items-center border-t border-slate-200/50 pt-2">
                      <p className="font-extrabold text-slate-900 text-xs">{prod.price} บาท</p>
                      <p className={`text-[9.5px] font-semibold ${prod.stock > 10 ? 'text-slate-500' : 'text-rose-600 font-bold'}`}>
                        คลัง: {prod.stock}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Billing Cart Receipt Workspace Sidebar */}
            <div className="col-span-1 lg:col-span-5 bg-slate-900 text-white rounded-2xl p-5 flex flex-col justify-between border border-slate-800 shadow-md">
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <span className="text-xs font-bold flex items-center gap-1"><ShoppingCart className="h-4 w-4 text-emerald-400" /> ตะกร้าใบเสร็จรับเงิน F&B</span>
                  <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full">เวลายื่น: {getTodayDateStr()}</span>
                </div>

                {/* Cart Loop */}
                <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                  {cartItems.map((item) => (
                    <div key={item.product.id} className="bg-slate-800/80 p-3 rounded-lg flex items-center justify-between text-xs border border-slate-700/50">
                      <div>
                        <p className="font-bold text-slate-100">{item.product.name}</p>
                        <p className="text-[9.5px] text-slate-400">{item.product.price} บาท / หน่วย</p>
                      </div>

                      {/* Qty edit actions */}
                      <div className="flex items-center gap-3">
                        <button 
                          onClick={() => handleUpdateCartQty(item.product.id, -1)}
                          className="h-5 w-5 rounded bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <span className="font-bold font-mono w-4 text-center text-slate-200">{item.qty}</span>
                        <button 
                          onClick={() => handleUpdateCartQty(item.product.id, 1)}
                          className="h-5 w-5 rounded bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}

                  {cartItems.length === 0 && (
                    <p className="text-xs text-slate-500 text-center py-10 font-medium">ตะกร้าว่างเปล่า กดเลือกสินค้าเพื่อเปิดบิลคีย์!</p>
                  )}
                </div>

                {/* Bill client credentials */}
                {cartItems.length > 0 && (
                  <div className="space-y-3 pt-3 border-t border-slate-800 text-xs">
                    <div>
                      <label className="block text-[10px] text-amber-400 font-bold mb-1">🎁 สะสมแต้มให้สมาชิกก๊วน (เลือกเพื่อสะสมแต้ม):</label>
                      <select 
                        value={cartUserId} 
                        onChange={(e) => {
                          const val = e.target.value;
                          setCartUserId(val);
                          const matchedUser = users.find(u => u.id === val);
                          if (matchedUser) {
                            setCartCustomerName(matchedUser.name);
                          }
                        }}
                        className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-xs text-white"
                      >
                        <option value="">-- ไม่สะสมแต้ม (ลูกค้าทั่วไป/Walk-In) --</option>
                        {users.filter(u => u.role === UserRole.CUSTOMER).map(u => (
                          <option key={u.id} value={u.id}>
                            👤 {u.name} | โทร: {u.phone || 'ไม่ระบุ'} [แต้มสะสมปัจจุบัน: {u.points || 0}]
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">ระบุชื่อลูกค้า (สำหรับอ้างอิงส่งออเดอร์):</label>
                      <input 
                        type="text" 
                        value={cartCustomerName}
                        onChange={(e) => setCartCustomerName(e.target.value)}
                        placeholder="เช่น โต๊ะแบดสนาม 3, พี่แดงซอย 5"
                        className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-xs text-white"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">อ้างอิงเลขสนามที่มาซื้อ (เว้นได้):</label>
                      <select 
                        value={cartCourtId} 
                        onChange={(e) => setCartCourtId(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-xs text-white"
                      >
                        <option value="">-- ไม่เชื่อมสนาม --</option>
                        {courts.map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1.5">เลือกรูปแบบการชำระเงิน F&B:</label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setCartPayMethod(PaymentMethod.CASH)}
                          className={`p-2 rounded text-[11px] font-bold text-center transition ${
                            cartPayMethod === PaymentMethod.CASH 
                              ? 'bg-emerald-600 text-white' 
                              : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          💵 เงินสด
                        </button>
                        <button
                          type="button"
                          onClick={() => setCartPayMethod(PaymentMethod.PROMPTPAY)}
                          className={`p-2 rounded text-[11px] font-bold text-center transition ${
                            cartPayMethod === PaymentMethod.PROMPTPAY 
                              ? 'bg-emerald-600 text-white' 
                              : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          📲 โอน/พร้อมเพย์
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Submit Checkout button */}
              {cartItems.length > 0 && (
                <div className="pt-4 border-t border-slate-800 mt-4 space-y-3">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-400 font-medium">รวมราคาสุทธิใบเสร็จ:</span>
                    <span className="font-extrabold text-emerald-400 text-lg">
                      {cartItems.reduce((acc, c) => acc + (c.product.price * c.qty), 0)} บาท
                    </span>
                  </div>

                  <button
                    onClick={handleCartCheckout}
                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded text-xs transition"
                  >
                    ยืนยันการรับเงินสด/โอน และตัดตู้สต๊อกคลัง
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 3.5: Sports Equipment Sales POS */}
        {activePosTab === 'equip_sales' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            
            {/* Products Selector Grid (Left-Side) */}
            <div className="col-span-1 lg:col-span-7 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700 block">ขายอุปกรณ์กีฬา / ลูกแบดมินตัน:</span>
                <span className="text-[10px] text-slate-400 font-medium">กดสินค้าเพื่อเพิ่มลงในตะกร้าบิล</span>
              </div>

              {cartSuccessAlert && (
                <div className="bg-emerald-50 text-emerald-800 text-xs p-3.5 rounded-xl border border-emerald-200 flex justify-between">
                  <span>{cartSuccessAlert}</span>
                  <button onClick={() => setCartSuccessAlert(null)} className="font-bold underline text-[10px]">ตกลง</button>
                </div>
              )}

              <div id="equip-pos-grid" className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {products.filter(p => p.isActive && p.category === ProductCat.EQUIPMENT && !p.isRental).map((prod) => (
                  <div 
                    key={prod.id} 
                    onClick={() => handleAddToCart(prod)}
                    className="bg-slate-50 border border-slate-200 hover:border-slate-300 hover:bg-slate-100/50 p-3.5 rounded-xl text-left flex flex-col justify-between cursor-pointer transition select-none h-32"
                  >
                    <div className="space-y-1">
                      <span className="inline-block text-[8px] font-bold px-1.5 py-0.5 rounded bg-sky-100 text-sky-800">
                        อุปกรณ์กีฬาฝั่งคลัง
                      </span>
                      <p className="font-bold text-slate-800 text-xs line-clamp-2 leading-snug">{prod.name}</p>
                    </div>

                    <div className="flex justify-between items-center border-t border-slate-200/50 pt-2">
                      <p className="font-extrabold text-slate-900 text-xs">{prod.price} บาท</p>
                      <p className={`text-[9.5px] font-semibold ${prod.stock > 5 ? 'text-slate-500' : 'text-rose-600 font-bold'}`}>
                        คลัง: {prod.stock}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Re-use the Receipt sidebar (same cartItems) */}
            <div className="col-span-1 lg:col-span-5 bg-slate-900 text-white rounded-2xl p-5 flex flex-col justify-between border border-slate-800 shadow-md">
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <span className="text-xs font-bold flex items-center gap-1"><ShoppingCart className="h-4 w-4 text-emerald-400" /> ตะกร้าอุปกรณ์กีฬา</span>
                  <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full">เวลายื่น: {getTodayDateStr()}</span>
                </div>

                {/* Cart Loop */}
                <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                  {cartItems.map((item) => (
                    <div key={item.product.id} className="bg-slate-800/80 p-3 rounded-lg flex items-center justify-between text-xs border border-slate-700/50">
                      <div>
                        <p className="font-bold text-slate-100">{item.product.name}</p>
                        <p className="text-[9.5px] text-slate-400">{item.product.price} บาท / หน่วย</p>
                      </div>

                      <div className="flex items-center gap-3">
                        <button 
                          onClick={() => handleUpdateCartQty(item.product.id, -1)}
                          className="h-5 w-5 rounded bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <span className="font-bold font-mono w-4 text-center text-slate-200">{item.qty}</span>
                        <button 
                          onClick={() => handleUpdateCartQty(item.product.id, 1)}
                          className="h-5 w-5 rounded bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}

                  {cartItems.length === 0 && (
                    <p className="text-xs text-slate-500 text-center py-10 font-medium">ตะกร้าว่างเปล่า กดอัพเดตแอดสินค้าที่ต้องการครับ</p>
                  )}
                </div>

                {cartItems.length > 0 && (
                  <div className="space-y-3 pt-3 border-t border-slate-800 text-xs">
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">ระบุชื่อลูกค้า (สำหรับอ้างอิงส่งออเดอร์):</label>
                      <input 
                        type="text" 
                        value={cartCustomerName}
                        onChange={(e) => setCartCustomerName(e.target.value)}
                        placeholder="เช่น โต๊ะแบดสนาม 3, พี่แดงซอย 5"
                        className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-xs text-white"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">อ้างอิงเลขสนามที่มาซื้อ (เว้นได้):</label>
                      <select 
                        value={cartCourtId} 
                        onChange={(e) => setCartCourtId(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-xs text-white"
                      >
                        <option value="">-- ไม่เชื่อมสนาม --</option>
                        {courts.map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1.5">ช่องทางจ่ายเงิน:</label>
                      <div className="grid grid-cols-2 gap-2">
                        <button 
                          disabled
                          className="py-2 px-3 rounded text-left border text-[11px] font-bold bg-slate-900/40 border-slate-800 text-slate-600 cursor-not-allowed flex items-center justify-between"
                        >
                          💸 เงินสด (งดรับเงินสดทุกกรณี)
                        </button>
                        <button 
                          type="button"
                          onClick={() => setCartPayMethod(PaymentMethod.PROMPTPAY)}
                          className={`py-2 px-3 rounded text-left border text-[11px] font-bold transition flex items-center justify-between ${
                            cartPayMethod === PaymentMethod.PROMPTPAY 
                              ? 'bg-emerald-950/40 border-emerald-500 text-emerald-400' 
                              : 'bg-slate-850 border-slate-700 text-slate-400 hover:bg-slate-800'
                          }`}
                        >
                          📱 สแกน QR / โอน {cartPayMethod === PaymentMethod.PROMPTPAY && <Check className="h-3.5 w-3.5 text-emerald-400" />}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {cartItems.length > 0 && (
                <div className="pt-4 border-t border-slate-800 space-y-4 text-xs mt-4">
                  <div className="flex justify-between items-center bg-slate-850 p-2.5 rounded border border-slate-800">
                    <span className="text-slate-400 text-[10px] font-semibold">ราคารวมออเดอร์:</span>
                    <span className="font-extrabold text-amber-400 text-sm">
                      {cartItems.reduce((acc, c) => acc + (c.product.price * c.qty), 0)} บาท
                    </span>
                  </div>

                  <button 
                    onClick={handleCartCheckout}
                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded text-xs transition"
                  >
                    ยืนยันการขายอุปกรณ์กีฬาและตัดสต๊อก
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 4: Equipment Rental */}
        {activePosTab === 'rentals' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              
              {/* Rent Equipment form */}
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-bold text-slate-900">บันทึกจ่ายปล่อยเช่าแร็กเก็ตและอุปกรณ์กีฬา</h3>
                  <p className="text-xs text-slate-500">กรุณากรอกชื่อผู้ประกันแร็กเก็ต สต๊าฟจะเก็บค่าค้ำหรือค่าบริการล่วงหน้าและบันทึกสต๊อก</p>
                </div>

                <form onSubmit={handleRentalRentSubmit} className="space-y-4 text-xs">
                  <div>
                    <label className="block text-amber-600 font-bold mb-1.5">🎁 มอบแต้มสะสมให้สมาชิกก๊วน (ทางเลือก):</label>
                    <select
                      value={rentalUserId}
                      onChange={(e) => {
                        const val = e.target.value;
                        setRentalUserId(val);
                        const matchedUser = users.find(u => u.id === val);
                        if (matchedUser) {
                          setRentalRenterName(matchedUser.name);
                        }
                      }}
                      className="w-full bg-slate-50 border border-slate-200 py-2.5 px-3 rounded-lg text-xs"
                    >
                      <option value="">-- ไม่สะสมแต้ม (ลูกค้าทั่วไป/Walk-In) --</option>
                      {users.filter(u => u.role === UserRole.CUSTOMER).map(u => (
                        <option key={u.id} value={u.id}>
                          👤 {u.name} | โทร: {u.phone || 'ไม่ระบุ'} [แต้มสะสมปัจจุบัน: {u.points || 0}]
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">1. คืน/คีย์ชื่อก๊วน หรือ ชื่อผู้ติดต่อค้ำประกัน:</label>
                    <input 
                      type="text" 
                      required
                      placeholder="เช่น คุณเอก แบดกบฏ เช่า 2 ไม้"
                      value={rentalRenterName}
                      onChange={(e) => setRentalRenterName(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 py-2.5 px-3 rounded-lg text-slate-800"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-700 font-semibold mb-1.5">2. เลือกแร็กเกต/อุปกรณ์เช่า:</label>
                      <select
                        value={selectedProductId}
                        onChange={(e) => setSelectedProductId(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-xs"
                      >
                        {products.filter(p => p.isRental).map(p => (
                          <option key={p.id} value={p.id}>{p.name} (คลังหลัก: {p.stock})</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-slate-700 font-semibold mb-1.5">3. ค่าบริการเช่า (บาท):</label>
                      <input 
                        type="number"
                        min={0}
                        value={rentalItemPrice}
                        onChange={(e) => setRentalItemPrice(Number(e.target.value))}
                        className="w-full bg-slate-50 border border-slate-200 py-1.5 px-3 rounded-lg font-bold text-xs"
                      />
                    </div>
                  </div>

                  {/* Inline shoe size and gender control wrapper if racket item is shoe */}
                  {selectedProductId && (products.find(p => p.id === selectedProductId)?.subCategory === 'shoes' || products.find(p => p.id === selectedProductId)?.name.includes('รองเท้า')) && (
                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 space-y-3">
                      <p className="font-bold text-indigo-900 text-[11px] flex items-center gap-1">
                        👟 ควบคุมสต็อกลงลึกประเภทรองเท้า (เบอร์ขนาด & เพศ ชาย/หญิง):
                      </p>
                      
                      <div className="grid grid-cols-2 gap-3 text-[11px]">
                        <div>
                          <label className="block text-slate-500 mb-1">หมวดเพศรองเท้า:</label>
                          <div className="flex gap-1">
                            <button 
                              type="button"
                              onClick={() => setRentalShoeGender('M')}
                              className={`flex-1 py-1 px-2 rounded text-[10px] font-bold transition border ${rentalShoeGender === 'M' ? 'bg-indigo-600 border-indigo-650 text-white' : 'bg-white border-slate-200 text-slate-700'}`}
                            >
                              ชาย (M)
                            </button>
                            <button 
                              type="button"
                              onClick={() => setRentalShoeGender('F')}
                              className={`flex-1 py-1 px-2 rounded text-[10px] font-bold transition border ${rentalShoeGender === 'F' ? 'bg-indigo-600 border-indigo-655 text-white' : 'bg-white border-slate-200 text-slate-700'}`}
                            >
                              หญิง (F)
                            </button>
                          </div>
                        </div>

                        <div>
                          <label className="block text-slate-500 mb-1">เบอร์รองเท้าค่ายสโมสร:</label>
                          <select
                            value={rentalShoeSize}
                            onChange={(e) => setRentalShoeSize(e.target.value)}
                            className="w-full bg-white border border-slate-200 rounded py-1 px-1.5 text-[11px] text-slate-800 focus:outline-none"
                          >
                            {rentalShoeGender === 'F' 
                              ? ['36', '37', '38', '39', '40'].map(sz => {
                                  const stockItem = shoeInventory.find(item => item.size === sz && item.gender === 'F');
                                  const av = stockItem ? (stockItem.totalStock - stockItem.rentedCount) : 0;
                                  return <option key={sz} value={sz}>ไซส์ {sz} (เหลือเช่า: {av} คู่)</option>;
                                })
                              : ['39', '40', '41', '42', '43', '44', '45'].map(sz => {
                                  const stockItem = shoeInventory.find(item => item.size === sz && item.gender === 'M');
                                  const av = stockItem ? (stockItem.totalStock - stockItem.rentedCount) : 0;
                                  return <option key={sz} value={sz}>ไซส์ {sz} (เหลือเช่า: {av} คู่)</option>;
                                })
                            }
                          </select>
                        </div>
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1.5">4. จองคอร์ทที่ใช้อ้างอิงเช่า (ระบุได้):</label>
                    <select
                      value={rentalCourtId}
                      onChange={(e) => setRentalCourtId(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-xs"
                    >
                      <option value="">-- ไม่ระบุคอร์ท --</option>
                      {courts.map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>

                  <button
                    type="submit"
                    className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-2.5 rounded text-xs transition animate-pulse"
                  >
                    บันทึกปล่อยเช่าอุปกรณ์กีฬา & ถอนคลังสำรอง
                  </button>
                </form>
              </div>

              {/* Active Rental items tracking ledger with Return buttons */}
              <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200 space-y-4">
                <div>
                  <span className="text-xs font-bold text-slate-700 block mb-1">รายการอุปกรณ์เล่นรอนำส่งคืนสต๊อก ({orders.filter(o => o.type === OrderType.EQUIPMENT_RENT && o.status === OrderStatus.PREPARING).length} รายการ):</span>
                  <span className="text-[10px] text-slate-400 block mb-3">เมื่อผู้เล่นใช้คาบแร็กเก็ตเสร็จเรียบร้อย กด "รับสินค้าคืนสต๊อก (Return)" เพื่อนำของกลับเข้าตู้อัตโนมัติ</span>
                </div>

                <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
                  {orders.filter(o => o.type === OrderType.EQUIPMENT_RENT && o.status === OrderStatus.PREPARING).map((order) => {
                    const item = order.items[0];
                    return (
                      <div key={order.id} className="bg-white p-3.5 rounded-xl border border-slate-300 flex justify-between items-center text-xs">
                        <div>
                          <span className="text-[9px] bg-sky-100 text-sky-800 font-bold px-1.5 rounded uppercase font-mono">{order.orderCode}</span>
                          <p className="font-bold text-slate-800 mt-1">{order.customerName}</p>
                          <p className="text-[10px] text-slate-400">
                            อุปกรณ์: {products.find(p => p.id === item?.productId)?.name || 'แร็กเก็ตเล่น'}
                            {item?.shoeSize && ` (เบอร์: ${item.shoeSize} - เพศ ${item.shoeGender === 'M' ? 'ชาย' : 'หญิง'})`}
                          </p>
                        </div>

                        <button
                          onClick={() => handleReturnItem(order.id, 0)}
                          className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1.5 px-3 rounded text-[10px] shadow-sm transition"
                        >
                          📬 บันทึกคุณส่งคืน
                        </button>
                      </div>
                    );
                  })}

                  {orders.filter(o => o.type === OrderType.EQUIPMENT_RENT && o.status === OrderStatus.PREPARING).length === 0 && (
                    <p className="text-[10px] text-slate-400 text-center py-10">ยังไม่มีผู้เช่าไม้แร็กเก็ตหรือรองเท้ากีฬาออกไปเล่น ณ ขณะนี้</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Reward vouchers: staff check an RW-XXXXXX claim code and hand the
            reward over (FR-4.3). */}
        {activePosTab === 'vouchers' && (
          <div className="max-w-lg space-y-4">
            <div>
              <h3 className="text-base font-bold text-slate-900">🎁 ตรวจรหัสแลกของรางวัล</h3>
              <p className="text-xs text-slate-500">ลูกค้าแสดงรหัส RW-XXXXXX จากหน้าแลกแต้ม ตรวจแล้วกดมอบของรางวัล (ใช้ได้ครั้งเดียว)</p>
            </div>
            <form onSubmit={e => { e.preventDefault(); handleLookupVoucher(); }} className="flex gap-2">
              <input id="voucher-code-input" value={voucherCode} onChange={e => setVoucherCode(e.target.value)} placeholder="RW-123456"
                className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono uppercase" />
              <button type="submit" className="bg-slate-900 text-white font-bold px-4 rounded-lg text-xs">ตรวจรหัส</button>
            </form>
            {voucherError && <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">⚠️ {voucherError}</p>}
            {voucherFound && (
              <div id="voucher-result" className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2 text-xs">
                <p className="font-mono font-black text-sm">{voucherFound.code}</p>
                <p><span className="text-slate-500">ของรางวัล:</span> <span className="font-bold">{voucherFound.reward}</span></p>
                <p><span className="text-slate-500">ลูกค้า:</span> {voucherFound.customer}</p>
                <p><span className="text-slate-500">สถานะ:</span> <span className="font-bold">{voucherFound.status === 'ACTIVE' ? '✅ ใช้ได้' : voucherFound.status === 'REDEEMED' ? (voucherFound.freeHour ? '⛔ ใช้จองไปแล้ว' : '⛔ รับไปแล้ว') : '⌛ หมดอายุ'}</span>
                  {voucherFound.expires && voucherFound.status === 'ACTIVE' ? ` (ถึง ${voucherFound.expires})` : ''}</p>
                {voucherFound.status === 'ACTIVE' && voucherFound.freeHour && (
                  <>
                    <button id="voucher-use-free-hour" type="button" onClick={handleUseFreeHourVoucher} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-lg">🏸 ใช้จองชั่วโมงฟรี</button>
                    <p className="text-[10px] text-slate-500">เปิดฟอร์ม Walk-in พร้อมรหัสนี้ เลือกสนามและเวลา Off-Peak 1 ชั่วโมง แล้วกดยืนยัน (คูปองถูกใช้เมื่อจองสำเร็จ)</p>
                  </>
                )}
                {voucherFound.status === 'ACTIVE' && !voucherFound.freeHour && (
                  <button type="button" onClick={handleDispenseVoucher} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-lg">มอบของรางวัลแล้ว</button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tab 5: Today's consolidate accounting summary (Read only block for staff) */}
        {activePosTab === 'todays_total' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-base font-bold text-slate-900">สรุปบัญชีเงินสด และ ยอดจราจรวันนี้ (Cash Reconciliation)</h3>
              <p className="text-xs text-slate-500">รายงานข้อมูลเรียลไทม์ ยอดในหมวดหมู่คอร์ท การจราจร F&B เพื่อกระทบยอดปิดกะพนักงานประจำวันวันนี้ ({getTodayDateStr()})</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                <span className="text-[10px] font-semibold text-slate-500 block uppercase">คอร์ทที่ยืนยันการเล่นแล้ว</span>
                <span className="font-extrabold text-slate-800 text-3xl mt-1 block">{calculateLedger().bookingCount} สล็อต</span>
                <p className="text-[10px] text-slate-400 mt-2">จองแบบวอล์คอินขอบิล: {calculateLedger().walkinCount}</p>
              </div>

              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                <span className="text-[10px] font-semibold text-slate-500 block uppercase">รวมประมาณการล่วงหน้าที่ต้องปิดกล่อง</span>
                <span className="font-extrabold text-emerald-700 text-3xl mt-1 block">{formatBaht(calculateLedger().totalExpected)} บาท</span>
                <p className="text-[10px] text-slate-400 mt-2">ยอดสนาม: {formatBaht(calculateLedger().bookingIncome)} | F&B: {formatBaht(calculateLedger().fbIncome)} | ของเครื่อง: {formatBaht(calculateLedger().rentalIncome)}</p>
                {calculateLedger().refunded > 0 && (
                  <p className="text-[10px] text-sky-700 font-bold mt-1">💸 คืนเงินวันนี้: {formatBaht(calculateLedger().refunded)} บาท</p>
                )}
              </div>

              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                <span className="text-[10px] font-semibold text-slate-500 block uppercase">ความต่าง Ledger การเงิน (CASH vs พร้อมเพย์)</span>
                <div className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-500">💵 รวมคาดยอดเงินสด (ในลิ้นชัก):</span>
                    <span id="ledger-cash" className="font-bold text-slate-800">{formatBaht(calculateLedger().cashExpected)} บาท</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">📲 รวมสลิปผ่าน QR:</span>
                    <span id="ledger-qr" className="font-bold text-slate-800 text-slate-800">{formatBaht(calculateLedger().qrExpected)} บาท</span>
                  </div>
                </div>
              </div>
            </div>

            {/* List of Recent POS Receipts orders & Walk-in Bookings */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4 shadow-sm">
              <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                🧾 ระบบพิมพ์ใบเสร็จรับเงินด่วน (Recent Invoices & Receipts)
              </h4>
              <p className="text-[10px] text-slate-500">
                รายชื่อสล็อตและ F&B ทั้งหมดที่ได้รับการโอนชำระเสร็จในวันนี้ กดเพื่อเปิดหน้าต่างพิมพ์ใบสำคัญรับเงินได้ทันที
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Bookings with confirmed status */}
                <div className="space-y-2.5">
                  <span className="text-[10.5px] font-bold text-slate-700 block">🥇 รายการจองสนามวันนี้ (Verified Court Bookings):</span>
                  <div className="space-y-2 max-h-[250px] overflow-y-auto border border-slate-100 rounded-lg p-2.5 bg-slate-50/30">
                    {bookings.filter(b => b.date === getTodayDateStr() && isPaidBooking(b)).map(b => (
                      <div key={b.id} className="bg-white p-2.5 rounded-lg border border-slate-200 text-[10.5px] flex items-center justify-between hover:bg-slate-50 transition">
                        <div>
                          <p className="font-bold text-slate-800">{courts.find(c => c.id === b.courtId)?.name || 'สนามกีฬาทั่วไป'}</p>
                          <p className="text-[9.5px] text-slate-500">ผู้จอง: {b.userName} | ยอด: {b.totalAmount} บ.</p>
                          <p className="text-[9px] text-[#475569]">เวลา: {b.startTime} น. | รหัส {b.bookingCode}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedReceiptBooking(b);
                            setSelectedReceiptOrder(null);
                          }}
                          className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-1 px-2.5 rounded text-[9.5px] shadow-xs flex items-center gap-1 shrink-0"
                        >
                          <Receipt className="h-3 w-3" /> ใบเสร็จ
                        </button>
                      </div>
                    ))}
                    {bookings.filter(b => b.date === getTodayDateStr() && b.status === BookingStatus.CONFIRMED).length === 0 && (
                      <p className="text-[9.5px] text-slate-400 text-center py-6">ไม่มีรายการจองสนามเวลานี้</p>
                    )}
                  </div>
                </div>

                {/* Orders (F&B and Rentals) */}
                <div className="space-y-2.5">
                  <span className="text-[10.5px] font-bold text-slate-700 block">🥤 สินค้าขาย F&B & เช่าไม้นอกตู้อัตโนมัติ:</span>
                  <div className="space-y-2 max-h-[250px] overflow-y-auto border border-slate-100 rounded-lg p-2.5 bg-slate-50/30">
                    {orders.filter(o => o.createdAt.startsWith(getTodayDateStr()) && o.status !== OrderStatus.CANCELLED).map(o => (
                      <div key={o.id} className="bg-white p-2.5 rounded-lg border border-slate-200 text-[10.5px] flex items-center justify-between hover:bg-slate-50 transition">
                        <div>
                          <p className="font-bold text-slate-800">
                            {o.type === OrderType.FB ? '🥤 ออเดอร์ F&B' : '🏸 เช่ารองเท้า/ไม้เล่น'}
                          </p>
                          <p className="text-[9.5px] text-slate-500">ลูกค้า: {o.customerName} | ยอด: {o.totalAmount} บ.</p>
                          <p className="text-[9.5px] text-[#475569]">รหัสธุรกรรม (Order): {o.orderCode}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedReceiptOrder(o);
                            setSelectedReceiptBooking(null);
                          }}
                          className="bg-sky-600 hover:bg-sky-500 text-white font-bold py-1 px-2.5 rounded text-[9.5px] shadow-xs flex items-center gap-1 shrink-0"
                        >
                          <Receipt className="h-3 w-3" /> ใบเสร็จ
                        </button>
                      </div>
                    ))}
                    {orders.filter(o => o.createdAt.startsWith(getTodayDateStr()) && o.status !== OrderStatus.CANCELLED).length === 0 && (
                      <p className="text-[9.5px] text-slate-400 text-center py-6">ยังไม่มีผลงานออเดอร์ F&B วันนี้</p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4 bg-amber-50 rounded-xl text-xs flex gap-2 border border-amber-200 text-amber-850">
              <AlertTriangle className="h-5 w-5 text-amber-700 shrink-0" />
              <div>
                <p className="font-bold">นโยบายห้ามแก้ไขรายการเงินสำมะคัญ (Anti-Price Tampering):</p>
                <p className="text-[10px] leading-relaxed mt-1">
                  ทุกรายการแก้ไขยอดเงิน สล็อตที่ถูกกด หรือสินค้าตัดสต๊อกจะถูกสลักชื่อแอดมิน คุณกิตติ ลงในแผงบิล Audit Log ถาวร 
                  การลบหรือสลับยกเลิก (Cancel) สล็อตและจ่ายคืนเคลม (Refund) จะต้องยื่นให้สิทธิ์ ผู้จัดการ (Manager) หรือ ผู้บริหารระบบ (Admin) ดำเนิการผ่านรหัสล็อคเกอร์พาสเท่านั้น
                </p>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Printable Receipt Overlay Modal (ออกใบเสร็จรับเงินอย่างเป็นทางการ) */}
      {(selectedReceiptBooking || selectedReceiptOrder) && (
        <div className="fixed inset-0 bg-slate-900/65 flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-white rounded-2xl max-w-sm w-full p-5 shadow-2xl border border-slate-300 relative space-y-4">
            
            {/* Close button */}
            <button
              onClick={() => {
                setSelectedReceiptBooking(null);
                setSelectedReceiptOrder(null);
              }}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 transition"
              type="button"
            >
              <X className="h-4 w-4" />
            </button>

            {/* Printable Frame Area */}
            <div id="invoice-receipt-print" className="p-4 bg-slate-50 rounded-xl border border-dashed border-slate-300 font-sans text-[11px] text-slate-800 space-y-3.5 shadow-inner">
              
              {/* Receipt Header logo */}
              <div className="text-center space-y-1 pb-3 border-b border-slate-200">
                <h2 className="text-xs font-black tracking-tight text-slate-900 uppercase">🏆 SMART SPORT COMPLEX CLUB</h2>
                <p className="text-[8.5px] text-slate-500 font-mono">168 Ramkhamhaeng Rd, Bang Kapi, Bangkok 10240</p>
                <p className="text-[8.5px] text-slate-500">เลขประจำตัวผู้เสียภาษี (TAX ID): 0-1055-59092-49-0 </p>
                <p className="text-[10px] font-bold text-slate-800 underline uppercase mt-2">ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ</p>
                <p className="text-[9px] font-semibold text-slate-600 bg-slate-200/60 inline-block px-1.5 py-0.5 rounded mt-0.5 font-mono">RECEIPT / TAX INVOICE (ABB.)</p>
              </div>

              {/* Receipt metadata info */}
              <div className="space-y-1 text-[9.5px] text-slate-600 bg-white p-2 rounded border border-slate-150">
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-500">เลขที่ใบเสร็จ (No.):</span>
                  <span className="font-mono font-bold text-slate-800">
                    {selectedReceiptBooking ? `REC-${selectedReceiptBooking.bookingCode}` : `REC-${selectedReceiptOrder?.orderCode}`}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-500">วันที่ออก (Date):</span>
                  <span className="font-mono">
                    {new Date().toLocaleDateString('th-TH')} {new Date().toTimeString().split(' ')[0].substring(0, 5)} น.
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-500">ชื่อผู้ซื้อ (Customer):</span>
                  <span className="font-bold text-slate-800">
                    {selectedReceiptBooking ? selectedReceiptBooking.userName : selectedReceiptOrder?.customerName}
                  </span>
                </div>
                {selectedReceiptBooking?.userPhone && (
                  <div className="flex justify-between">
                    <span className="font-semibold text-slate-500">เบอร์โทรศัพท์:</span>
                    <span className="font-mono">{selectedReceiptBooking.userPhone}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-500">ผู้รับชำระ (Cashier):</span>
                  <span className="italic">Kitti Counter Desk</span>
                </div>
              </div>

              {/* Items detail list */}
              <div className="border-t border-b border-slate-200 py-2">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[8.5px] font-black text-slate-500 uppercase tracking-wide border-b border-slate-200 pb-1">
                      <th className="pb-1">รายการ (Item)</th>
                      <th className="pb-1 text-center">จํานวน</th>
                      <th className="pb-1 text-right">สุทธิ (บ.)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-[10px]">
                    {selectedReceiptBooking && (() => {
                      const courtName = courts.find(c => c.id === selectedReceiptBooking.courtId)?.name || 'สนามหลักคอมเพล็กซ์';
                      return (
                        <tr>
                          <td className="py-1">
                            <span className="font-medium text-slate-800">{courtName}</span>
                            <div className="text-[8.5px] text-slate-400 font-mono">
                              วันที่เล่น {selectedReceiptBooking.date} ({selectedReceiptBooking.startTime} - {selectedReceiptBooking.endTime} น.)
                            </div>
                          </td>
                          <td className="py-1 text-center font-mono">1 คาบ</td>
                          <td className="py-1 text-right font-mono font-bold text-slate-800">{selectedReceiptBooking.totalAmount}.00</td>
                        </tr>
                      );
                    })()}

                    {selectedReceiptOrder && selectedReceiptOrder.items.map((it, idx) => {
                      const prodName = products.find(p => p.id === it.productId)?.name || 'สินค้า F&B / อุปกรณ์กีฬา';
                      return (
                        <tr key={idx}>
                          <td className="py-1">
                            <span className="font-medium text-slate-800">{prodName}</span>
                            {it.shoeSize && (
                              <span className="text-[8px] text-indigo-700 bg-indigo-50 border border-indigo-100 px-1 rounded ml-1">
                                Size {it.shoeSize} ({it.shoeGender === 'M' ? 'ชาย' : 'หญิง'})
                              </span>
                            )}
                          </td>
                          <td className="py-1 text-center font-mono">{it.qty}</td>
                          <td className="py-1 text-right font-mono font-bold text-slate-800">{it.unitPrice * it.qty}.00</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Financial Calculation footer */}
              <div className="space-y-0.5 text-[9.5px] text-slate-700">
                <div className="flex justify-between">
                  <span>ฐานภาษี (VATAble Base):</span>
                  <span className="font-mono">
                    {((selectedReceiptBooking ? selectedReceiptBooking.totalAmount : (selectedReceiptOrder?.totalAmount || 0)) / 1.07).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>ภาษีมูลค่าเพิ่ม (VAT 7%):</span>
                  <span className="font-mono mr-1">
                    {((selectedReceiptBooking ? selectedReceiptBooking.totalAmount : (selectedReceiptOrder?.totalAmount || 0)) * 0.07 / 1.07).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between font-black text-slate-900 border-t border-slate-200 pt-1.5 text-[11px]">
                  <span>ยอดชำระสุทธิ (Grand Total):</span>
                  <span className="font-mono text-emerald-700 text-[11.5px]">
                    {selectedReceiptBooking ? selectedReceiptBooking.totalAmount : selectedReceiptOrder?.totalAmount}.00 บาท
                  </span>
                </div>
              </div>

              {/* Signature stamp */}
              <div className="pt-2.5 text-center border-t border-slate-200 space-y-0.5 text-[8.5px] text-slate-400">
                <p>💸 รับชำระแล้วโดย: <span className="font-bold text-slate-700 uppercase">โอนเงินธนาคารอิเล็กทรอนิกส์ (PROMPTPAY BANK DIRECT)</span></p>
                <p className="font-bold text-emerald-600">✓ ปิดกล่องปิดลิ้นชักเรียบร้อย ถูกต้องตามกฎหมาย</p>
                <p className="italic">"ขอบพระคุณลูกค้าที่วางใจคอมเพล็กซ์ของเราค่ะ"</p>
              </div>
            </div>

            {/* Booking actions: cancel/refund and cash for managers, no-show
                for any staff. */}
            {selectedReceiptBooking && (() => {
              const b = selectedReceiptBooking;
              const timing = slotTiming(b.date, b.startTime);
              const canNoShow = (b.status === BookingStatus.CONFIRMED || b.status === BookingStatus.COMPLETED) && timing.started;
              const canCancel = canManageBookings && (b.status === BookingStatus.CONFIRMED || b.status === BookingStatus.PENDING_PAYMENT);
              const canCash = canManageBookings && b.status === BookingStatus.PENDING_PAYMENT;
              if (!canNoShow && !canCancel && !canCash) return null;
              return (
                <div id="booking-actions" className="flex flex-wrap gap-2 text-[11px]">
                  {canCash && (
                    <button type="button" onClick={() => handleMarkPaidInCash(b)} className="flex-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 font-bold py-1.5 rounded-lg">💵 รับเงินสดแล้ว</button>
                  )}
                  {canNoShow && (
                    <button type="button" onClick={() => handleMarkNoShow(b)} className="flex-1 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 font-bold py-1.5 rounded-lg">🚫 ไม่มาใช้สนาม</button>
                  )}
                  {canCancel && (
                    <button type="button" onClick={() => handleCancelBooking(b)} className="flex-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-bold py-1.5 rounded-lg">✖ ยกเลิก / คืนเงิน</button>
                  )}
                </div>
              );
            })()}

            {/* Print action buttons */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                onClick={() => {
                  setSelectedReceiptBooking(null);
                  setSelectedReceiptOrder(null);
                }}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 py-2 rounded-xl font-bold text-center transition"
              >
                ปิดย้อนกลับ
              </button>
              
              <button
                type="button"
                onClick={() => {
                  window.print();
                  onAddAuditLog('RECEIPT_PRINTED_BY_STAFF', 'Report', selectedReceiptBooking ? selectedReceiptBooking.id : (selectedReceiptOrder?.id || ''), null, null);
                }}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-xl text-center transition flex justify-center items-center gap-1 shadow-sm font-sans"
              >
                <Receipt className="h-3.5 w-3.5" /> พิมพ์บิล/บันทึก PDF
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
