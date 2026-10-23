import { CourtType, BookingStatus, PaymentMethod, MemberType } from '../../types';
import { findClosure, calculatePrice, isHourOffPeak, findConflictingBooking, slotTiming, openSlotHours, formatBaht, formatDate, resalePrice } from '../../mockData';
import { QRCodeSVG } from 'qrcode.react';
import MemberPhoneInput from '../MemberPhoneInput';
import { Activity, Receipt } from 'lucide-react';
import { useStaffPOSContext } from './useStaffPOS';

export default function WalkinTab() {
  const {
    bookings,
    busy,
    cancelPendingWalkin,
    confirmPendingWalkin,
    courts,
    daysOff,
    gridReady,
    guarded,
    handleWalkinBookingSubmit,
    memberPhoneHandlers,
    pendingWalkin,
    posGridSportType,
    setPosGridSportType,
    setSelectedReceiptBooking,
    setSelectedReceiptOrder,
    setWalkinCourtId,
    setWalkinDate,
    setWalkinMember,
    setWalkinName,
    setWalkinPayMethod,
    setWalkinPhone,
    setWalkinSlot,
    setWalkinVoucherCode,
    walkinCourtId,
    walkinDate,
    walkinMember,
    walkinName,
    walkinPayMethod,
    walkinPhone,
    walkinSlot,
    walkinSuccessAlert,
    walkinVoucherCode
  } = useStaffPOSContext();
  return (
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

        <form onSubmit={e => { e.preventDefault(); void guarded(handleWalkinBookingSubmit)(e); }} className="space-y-4 text-xs">
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
                {openSlotHours().map(h => (
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
                readOnly={!!walkinMember}
                title={walkinMember ? 'ชื่อจากข้อมูลสมาชิก (แก้ไม่ได้)' : undefined}
                className={`w-full bg-slate-50 border border-slate-200 py-2 px-3 rounded-lg text-xs${walkinMember ? ' opacity-70 cursor-not-allowed' : ''}`}
              />
            </div>
            <div>
              <label className="block text-slate-700 font-semibold mb-1.5">5. เบอร์มือถือรับ LINE แทงสถานะ</label>
              <MemberPhoneInput
                id="walkin-member-phone"
                required
                placeholder="พิมพ์เบอร์หรือชื่อสมาชิก เช่น 089xxxxxxx"
                value={walkinPhone}
                {...memberPhoneHandlers(walkinMember, setWalkinMember, setWalkinPhone, setWalkinName)}
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
            disabled={busy}
            className="w-full bg-[#1e293b] hover:bg-[#334155] disabled:opacity-50 text-white py-3 rounded-lg font-bold text-xs shadow-sm transition"
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
              <button type="button" disabled={busy} onClick={guarded(confirmPendingWalkin)} className="disabled:opacity-50 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-lg">
                ✅ ได้รับเงินแล้ว ยืนยันการจอง
              </button>
              <button type="button" disabled={busy} onClick={guarded(cancelPendingWalkin)} className="disabled:opacity-50 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold py-2 rounded-lg">
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
            การจองของวันที่ {formatDate(`${walkinDate}T12:00:00+07:00`)}
          </span>
          <span className="block text-[10px] text-slate-400">ทุกการจองของวันที่เลือกในฟอร์ม (รวมที่รอชำระ)</span>

          <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
            {bookings.filter(b => b.date === walkinDate && b.status !== BookingStatus.CANCELLED).map((b) => (
              <div key={b.id} className="bg-white p-3 rounded-xl border border-slate-200/60 text-xs flex justify-between items-center bg-slate-50/20 hover:bg-slate-50 transition">
                <div>
                  <p className="font-bold text-slate-800">{courts.find(c => c.id === b.courtId)?.name}</p>
                  <p className="text-[10px] text-slate-500">ผู้จอง: {b.userName} | เวลา: <span className="font-bold text-slate-700">{b.startTime} - {b.endTime} น.</span></p>
                  <p className="text-[11px] text-slate-400">รหัสจอง: <span className="font-mono">{b.bookingCode}</span> | ยอด: {formatBaht(b.totalAmount)} บ.</p>
                </div>
                <div className="flex flex-col gap-1 items-end">
                  {b.status === BookingStatus.PENDING_PAYMENT ? (
                    <span className="text-[11px] bg-amber-100 text-amber-800 font-extrabold px-1.5 py-0.5 rounded-md">รอชำระเงิน</span>
                  ) : b.status === BookingStatus.NO_SHOW ? (
                    <span className="text-[11px] bg-violet-100 text-violet-800 font-extrabold px-1.5 py-0.5 rounded-md">ไม่มา · สนามว่างแล้ว</span>
                  ) : (
                    <span className="text-[11px] bg-emerald-100 text-emerald-800 font-extrabold px-1.5 py-0.5 rounded-md">ยืนยันแล้ว</span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedReceiptBooking(b);
                      setSelectedReceiptOrder(null);
                    }}
                    className="text-[11px] bg-slate-800 hover:bg-slate-700 text-white font-bold py-1 px-2 rounded-md flex items-center gap-1 transition-all mt-1"
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
                  : 'text-slate-600 hover:bg-slate-200/50'
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
      {!gridReady && (
        <p id="staff-grid-loading" role="status" className="text-xs text-slate-500 mb-2">⏳ กำลังโหลดการจองของวันที่เลือก…</p>
      )}
      <div className={`overflow-x-auto border border-slate-200 rounded-xl bg-white shadow-inner${gridReady ? '' : ' opacity-40 pointer-events-none'}`} aria-busy={!gridReady}>
        <table className="w-full text-left border-collapse min-w-[1100px]">
          <thead>
            <tr className="bg-[#f8fafc] text-[10px] uppercase font-black text-slate-500 border-b border-slate-200">
              <th className="p-3 bg-[#f8fafc] sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] w-36 border-r border-slate-200">สนาม</th>
              {openSlotHours().map((time) => (
                <th key={time} className="p-2 text-center text-[11px] min-w-[75px] border-l border-slate-200">
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
                    <span className="text-[10px] text-[#0f5132] font-semibold bg-[#d1e7dd] px-1 py-0.2 rounded w-max mt-0.5 inline-block">Off-Peak เท่านั้น</span>
                  )}
                </td>

                {/* Hourly slots */}
                {openSlotHours().map((time) => {
                  const hourNum = parseInt(time.split(':')[0], 10);

                  // 1. Is there a booking on this court OR a mutex-group
                  // sibling (FR-1.2, e.g. the full court)?
                  const bItem = findConflictingBooking(court.id, walkinDate, time, bookings, courts);

                  // 2. Is there a closure/maintenance?
                  const closureItem = findClosure(daysOff, walkinDate, court.id, hourNum, courts);

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
                        <span className="block text-[10px] font-black text-rose-600">🔴 จองแล้ว</span>
                        <span className="block text-[11px] text-[#0f172a] whitespace-nowrap overflow-hidden text-ellipsis max-w-[70px] mx-auto font-black" title={bItem.userName}>
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
                        <span className="block text-[10px] font-black text-rose-700">⚠️ ปิดสนาม</span>
                        <span className="text-[10px] text-rose-900 block max-w-[65px] truncate mx-auto">
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
                        <span className="block text-[10px] font-semibold text-slate-500">⌛ ผ่านไปแล้ว</span>
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
                        <span className="block text-[10px] font-semibold text-slate-500">🚫 ปิดช่วง Peak</span>
                        <span className="text-[10px] text-slate-400 block">บาสเกตบอลครึ่งสนาม</span>
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
                        <span className="block text-[10px] font-semibold text-slate-500">🚫 ปิดบริการ</span>
                        <span className="text-[10px] text-slate-400 block">นอกเวลาทำการ</span>
                      </td>
                    );
                  }

                  // An hour freed by a no-show: free, at the resale price.
                  const resale = resalePrice(court, walkinDate, time, bookings, courts, priceBase.total);
                  const shownPrice = resale ?? priceBase.total;

                  if (isActiveSelection) {
                    return (
                      <td 
                        key={time} 
                        className="p-1 border-l border-slate-200 bg-[#3b82f6] text-white text-center font-bold relative cursor-pointer ring-2 ring-[#93c5fd] animate-pulse"
                        title="เลือกช่องสนามและชั่วโมงเวลานี้อยู่!"
                      >
                        <span className="block text-[8.5px] font-black uppercase text-white">⭐ จะจองคิว</span>
                        <span className="block text-[11px] font-mono leading-none">{shownPrice}฿</span>
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
                      <span className="block text-[10px] font-bold text-slate-500">🟢 ว่าง</span>
                      <span className="block text-[11px] font-mono font-black text-[#1e293b]">{shownPrice}฿</span>
                      {resale !== undefined
                        ? <span className="noshow-resale text-[7.5px] text-violet-700 font-bold block">ลูกค้าไม่มา · ราคาพิเศษ</span>
                        : <span className="text-[7.5px] text-slate-400 italic block font-mono">{isPeak ? '⚡ Peak' : 'Off-Peak'}</span>}
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
  );
}
