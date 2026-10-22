import { PaymentStatus } from '../../types';
import { formatBaht, businessInfo } from '../../mockData';
import { QRCodeSVG } from 'qrcode.react';
import { AlertTriangle, FileImage } from 'lucide-react';
import { useCustomerPanelContext, PAYMENT_HOLD_MINUTES } from './useCustomerPanel';

export default function PaymentStep() {
  const {
    SLIP_SAMPLES,
    bookings,
    busy,
    currentBooking,
    currentPayment,
    guarded,
    handleSlipUploadSimulation,
    nowTick,
    qrCodePayload,
    setActiveStep,
    setSelectedSlots
  } = useCustomerPanelContext();
  if (!currentBooking) return null; // the panel shows this step only with a booking
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm space-y-6">
      <div className="text-center space-y-2">
        <span className="inline-flex text-xs items-center gap-1 font-bold text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1 rounded-full">
          <AlertTriangle className="h-3 w-3" /> ชำระเงินล่วงหน้าเพื่อยืนยันสิทธิ์คอร์ท
        </span>
        <h2 className="text-lg font-bold text-slate-900">ชำระเงินค่านัดผ่าน QR Thai PromptPay</h2>
        <p className="text-xs text-slate-500">กรุณาสแกนรหัสคิวอาร์ และทำการโอนเงินยอดและแสกนด้วยแอพนาคารจากนั้นส่งหลักฐานสลิปด้านล่าง</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">

        {/* Thai PromptPay QR Visual Simulation */}
        <div id="promptpay-qr-display" className="bg-slate-50 p-5 rounded-2xl border border-slate-100 flex flex-col items-center justify-center space-y-4 shadow-inner">
          {/* PromptPay Banner Header */}
          <div className="w-56 h-10 bg-sky-900 rounded flex items-center justify-between px-3">
            <div className="text-white text-xs font-extrabold flex flex-col">
              <span className="text-[11px] tracking-widest text-[#579FFF]">PROMPT PAY</span>
              <span className="text-xs select-none -mt-1 leading-none font-sans">พร้อมเพย์</span>
            </div>
            {/* Visual logo simulation */}
            <div className="flex gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse"></span>
              <span className="h-1.5 w-1.5 rounded-full bg-sky-300"></span>
              <span className="h-1.5 w-1.5 rounded-full bg-[#18f3b2]"></span>
            </div>
          </div>

          {/* The actual PromptPay (EMVCo) payload as a scannable QR code */}
          <div className="bg-white border border-slate-200 p-3 rounded">
            {currentPayment?.status === PaymentStatus.VERIFIED ? (
              <div id="payment-verified-notice" className="h-44 w-44 flex flex-col items-center justify-center text-center gap-1 text-sm text-emerald-700 font-bold">
                <span className="text-3xl">✅</span>
                ชำระเงินเรียบร้อย การจองยืนยันแล้ว
              </div>
            ) : currentPayment?.status === PaymentStatus.REJECTED || currentPayment?.status === PaymentStatus.REFUNDED ? (
              <div id="payment-closed-notice" className="h-44 w-44 flex flex-col items-center justify-center text-center gap-1 text-xs text-rose-700 font-bold">
                <span className="text-2xl">✖️</span>
                {currentPayment.status === PaymentStatus.REFUNDED ? 'การจองนี้ถูกยกเลิกและคืนเงินแล้ว' : 'สลิปไม่ผ่านการตรวจ การจองนี้ถูกยกเลิก'}
              </div>
            ) : currentPayment?.status === PaymentStatus.EXPIRED ? (
              // The hold ran out: don't invite a new payment - only a
              // slip for money already sent (late payment).
              <div id="expired-payment-notice" className="h-44 w-44 flex flex-col items-center justify-center text-center gap-1 text-xs text-rose-700 font-bold">
                <span className="text-2xl">⌛</span>
                หมดเวลาชำระแล้ว กรุณาอย่าโอนเงินเพิ่ม
              </div>
            ) : qrCodePayload ? (
              <QRCodeSVG value={qrCodePayload} size={176} level="M" />
            ) : (
              <div className="h-44 w-44 flex items-center justify-center text-xs text-slate-400">ไม่พบ QR</div>
            )}
          </div>

          <div className="text-center space-y-1">
            <p className="text-xs font-semibold text-slate-500">สแกนด้วยแอปธนาคาร ยอดเงินจะขึ้นให้อัตโนมัติ</p>
            <p className="text-sm font-black text-slate-800">รหัสจอง {currentBooking.bookingCode}</p>
            {businessInfo().name
              ? <p id="payee-name" className="text-xs text-slate-600">ชื่อบัญชีผู้รับ: <b className="text-slate-800">{businessInfo().name}</b> — ตรวจให้ตรงในแอปธนาคารก่อนกดโอน</p>
              : <p className="text-xs text-slate-500">ตรวจชื่อผู้รับในแอปธนาคารก่อนกดโอน</p>}
            <p className="text-xs font-extrabold text-slate-800 text-lg mt-1">ยอดโอน: {formatBaht(currentPayment?.amount ?? currentBooking.totalAmount)} บาท</p>
            {currentPayment?.status === PaymentStatus.PENDING && (() => {
              // Capped: server and browser clocks can differ slightly.
              const minutesLeft = Math.min(PAYMENT_HOLD_MINUTES, Math.ceil((new Date(currentPayment.createdAt).getTime() + PAYMENT_HOLD_MINUTES * 60000 - nowTick) / 60000));
              return minutesLeft > 0
                ? <p className="text-[11px] font-bold text-amber-700">⏳ กรุณาชำระและส่งสลิปภายใน {minutesLeft} นาที</p>
                : <p className="text-[11px] font-bold text-rose-700">⌛ หมดเวลาชำระแล้ว ระบบอาจยกเลิกการจองนี้</p>;
            })()}
            {currentPayment?.status === PaymentStatus.SLIP_UPLOADED && (
              <p className="text-[11px] font-bold text-sky-700">📨 ส่งสลิปแล้ว รอพนักงานตรวจ — อัปโหลดใหม่ได้หากส่งผิดรูป (หน้านี้อัปเดตผลให้เอง)</p>
            )}
            {currentPayment?.status === PaymentStatus.VERIFIED && (
              <p className="text-[11px] font-bold text-emerald-700">ดูการจองได้ที่ "รายการจองของฉัน" ด้านล่าง พบกันที่สนาม!</p>
            )}
            {currentPayment?.status === PaymentStatus.REJECTED && (() => {
              const reason = bookings.find(b => b.id === currentBooking.id)?.cancellationReason;
              return <p className="text-[11px] font-bold text-rose-700 max-w-xs">{reason ? `เหตุผล: ${reason} · ` : ''}หากโอนเงินแล้ว กรุณาติดต่อเคาน์เตอร์</p>;
            })()}
            {currentPayment?.status === PaymentStatus.EXPIRED && (
              <p className="text-[11px] font-bold text-rose-700 max-w-xs">
                การจองนี้ถูกยกเลิกเพราะไม่ได้รับสลิปภายใน {PAYMENT_HOLD_MINUTES} นาที หากคุณโอนเงินไปแล้ว ส่งสลิปด้านล่าง —
                พนักงานจะยืนยันการจองให้หากสนามยังว่าง หรือคืนเงินให้หากมีผู้อื่นจองไปแล้ว
              </p>
            )}
          </div>
        </div>

        {/* Upload Slip Selector Simulator - not once the payment is settled */}
        <div className={`space-y-4${currentPayment?.status === PaymentStatus.VERIFIED || currentPayment?.status === PaymentStatus.REFUNDED || currentPayment?.status === PaymentStatus.REJECTED ? ' hidden' : ''}`}>
          <div className="bg-slate-50 p-4 rounded-xl border border-dashed border-slate-200">
            <span className="block text-xs font-semibold text-slate-700 mb-2">โอนแล้ว ส่งรูปสลิปที่นี่:</span>

            <div className="space-y-2">
              {/* Stock-photo "slips" are a demo shortcut - never offer them to real customers. */}
              {import.meta.env.DEV && SLIP_SAMPLES.map((sample, sIdx) => (
                <button
                  key={sIdx}
                  type="button"
                  onClick={guarded(() => handleSlipUploadSimulation(sample.url))}
                  className="w-full flex items-center gap-3 bg-white p-3 rounded-lg border border-slate-200 hover:border-emerald-600 transition hover:bg-slate-50 text-left text-xs"
                >
                  <FileImage className="h-7 w-7 text-emerald-700" />
                  <div>
                    <p className="font-bold text-slate-800">{sample.name}</p>
                    <p className="text-xs text-slate-500">จำลองอัพโหลดภาพถ่ายสลิปเพื่อส่งให้แอดมิน</p>
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-4 text-center">
              {import.meta.env.DEV && <p className="text-xs text-slate-400">--- หรือ ---</p>}
              <label className="inline-flex items-center cursor-pointer mt-2 text-sm bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 rounded-lg font-bold text-white transition">
                <FileImage className="h-4 w-4 mr-1.5" /> เลือกรูปสลิปจากเครื่อง
                <input 
                  type="file" 
                  accept="image/jpeg,image/png,image/webp,image/heic,image/*"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Cleared so choosing the same file again (after a
                    // failed upload) fires onChange again.
                    e.target.value = '';
                    if (file) {
                      // localStorage mode can't keep a real file, so it
                      // records a placeholder image; API mode uploads
                      // the actual file.
                      void guarded(handleSlipUploadSimulation)("https://images.unsplash.com/photo-1554415707-6e8cfc93fe23?w=300&q=80", file);
                    }
                  }}
                  className="hidden" 
                />
              </label>
            </div>
          </div>

          <div className="p-4 bg-amber-50 rounded-lg text-xs space-y-1 p-3.5 border border-amber-200 text-amber-800">
            <p className="font-bold">ขั้นตอนหลังจอง:</p>
            <p>1. ระบบกันสนามไว้ให้ {PAYMENT_HOLD_MINUTES} นาที — โอนและส่งสลิปภายในเวลานี้</p>
            <p>2. พนักงานตรวจสลิปแล้วยืนยันการจอง</p>
            <p>3. ดูสถานะได้ที่ "ตรวจสอบสถานะการจอง" ด้านล่าง (ขึ้น "อนุมัติเรียบร้อย" เมื่อยืนยันแล้ว)</p>
          </div>
        </div>
      </div>

      <div className="flex justify-end pt-4 border-t border-slate-50">
        <button
          type="button"
          onClick={() => {
            setActiveStep(1);
            setSelectedSlots([]);
          }}
          className="bg-slate-500 hover:bg-slate-100 text-xs font-bold text-slate-600 py-2 px-4 rounded text-center transition"
        >
          ชำระภายหลัง (กลับมาส่งสลิปได้จากรายการจองด้านล่าง ภายใน {PAYMENT_HOLD_MINUTES} นาที)
        </button>
      </div>
    </div>
  );
}
