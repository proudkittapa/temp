import { formatBaht } from '../mockData';
import { CheckCircle, AlertTriangle, MessageSquare } from 'lucide-react';
import { useCustomerPanel, CustomerPanelContext, CustomerPanelProps, SHOW_LINE_SIM } from './customer/useCustomerPanel';
import AccountBox from './customer/AccountBox';
import PickSlotsStep from './customer/PickSlotsStep';
import ConfirmStep from './customer/ConfirmStep';
import PaymentStep from './customer/PaymentStep';
import MyBookingsBox from './customer/MyBookingsBox';
import LineSimulator from './customer/LineSimulator';

export default function CustomerPanel(props: CustomerPanelProps) {
  const s = useCustomerPanel(props);
  const {
    activeStep,
    apiError,
    bookingSuccessAlert,
    currentBooking,
    currentPriceDetails,
    handleProceedToCheckout,
    isNarrow,
    myLineMessages,
    selectedSlots,
    setBookingSuccessAlert,
    setSelectedSlots,
    setShowLineSimulator,
    showLineSimulator
  } = s;
  return (
    <CustomerPanelContext.Provider value={s}>
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pb-28">
      {apiError && (
        <div className="lg:col-span-12 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>โหลดข้อมูลจากเซิร์ฟเวอร์ไม่สำเร็จ: {apiError}</span>
        </div>
      )}
      
      {/* Phones: the selection and the next step stay in reach at the bottom */}
      {isNarrow && activeStep === 1 && selectedSlots.length > 0 && (
        <div id="mobile-booking-bar" className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-200 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex items-center justify-between gap-3">
          <span>
            <span className="block text-sm font-bold text-slate-900">{selectedSlots.length} ชม. · {formatBaht(currentPriceDetails().total)} บาท</span>
            <button type="button" onClick={() => setSelectedSlots([])} className="text-xs text-rose-600 underline">ล้างที่เลือก</button>
          </span>
          <button type="button" onClick={handleProceedToCheckout} className="bg-emerald-700 text-white font-bold rounded-xl px-5 min-h-[48px] text-base">จองต่อ →</button>
        </div>
      )}

      {/* Dynamic Line Notification Simulator Button (demo). On phones: a
          small round button that never covers the booking bar or forms. */}
      {SHOW_LINE_SIM && (
      <button 
        id="btn-line-sim-toggle"
        aria-label="ข้อความ LINE (จำลอง)"
        aria-expanded={showLineSimulator}
        onClick={() => setShowLineSimulator(!showLineSimulator)}
        className={`fixed z-30 items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-full shadow-2xl transition duration-200 bottom-4 left-4 p-3 sm:bottom-6 sm:left-6 sm:px-5 sm:py-3 ${isNarrow && activeStep === 1 && selectedSlots.length > 0 ? 'hidden' : 'flex'}`}
      >
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-slate-100 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-3 w-3 bg-white"></span>
        </span>
        <MessageSquare className="h-5 w-5" />
        <span className="hidden sm:inline font-sans font-medium text-sm">LINE OA ลูกค้า ({myLineMessages.length})</span>
      </button>
      )}

      {/* Main Form Left Arena */}
      <div className={`col-span-1 lg:col-span-8 space-y-6 ${showLineSimulator ? 'lg:col-span-8' : 'lg:col-span-12'}`}>
        
        {bookingSuccessAlert && (
          <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 text-emerald-800 p-4 rounded-xl shadow-sm">
            <CheckCircle className="h-5 w-5 mt-0.5 text-emerald-600 shrink-0" />
            <div className="w-full">
              <p className="font-semibold text-sm">ทำรายการสำเร็จ!</p>
              <p className="text-xs text-emerald-600 mt-1">{bookingSuccessAlert}</p>
            </div>
            <button onClick={() => setBookingSuccessAlert(null)} className="text-emerald-500 hover:text-emerald-800 text-xs font-semibold px-2">ปิด</button>
          </div>
        )}

        {/* 🔐 CUSTOMER AUTHENTICATION & PROFILE CONSOLE */}
        <AccountBox />

        {/* Step Indicator */}
        <div id="booking-steps-indicator" className="scroll-mt-32 sm:scroll-mt-24 bg-white p-3 sm:p-5 rounded-2xl border border-slate-100 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className={`h-8 w-8 shrink-0 rounded-full flex items-center justify-center font-bold text-sm ${activeStep >= 1 ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-400'}`}>1</div>
            <div>
              <p className="text-xs font-semibold text-slate-800"><span className="hidden sm:inline">ขั้นตอนที่ 1</span><span className="sm:hidden">เลือกเวลา</span></p>
              <p className="hidden sm:block text-xs text-slate-500">เลือกสนามและเช็กตาราง</p>
            </div>
          </div>
          <div className="h-px bg-slate-200 flex-1 mx-2 sm:mx-4 max-w-[80px]" />
          <div className="flex items-center gap-2 sm:gap-3">
            <div className={`h-8 w-8 shrink-0 rounded-full flex items-center justify-center font-bold text-sm ${activeStep >= 2 ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-400'}`}>2</div>
            <div>
              <p className="text-xs font-semibold text-slate-800"><span className="hidden sm:inline">ขั้นตอนที่ 2</span><span className="sm:hidden">ข้อมูล</span></p>
              <p className="hidden sm:block text-xs text-slate-500">กรอกเบอร์โทร & เช็คราคา</p>
            </div>
          </div>
          <div className="h-px bg-slate-200 flex-1 mx-2 sm:mx-4 max-w-[80px]" />
          <div className="flex items-center gap-2 sm:gap-3">
            <div className={`h-8 w-8 shrink-0 rounded-full flex items-center justify-center font-bold text-sm ${activeStep >= 3 ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-400'}`}>3</div>
            <div>
              <p className="text-xs font-semibold text-slate-800"><span className="hidden sm:inline">ขั้นตอนที่ 3</span><span className="sm:hidden">ชำระเงิน</span></p>
              <p className="hidden sm:block text-xs text-slate-500">ชำระ QR & อัพโหลดสลิป</p>
            </div>
          </div>
        </div>

        {/* Step 1: Arena Selector / Slot grid */}
        {activeStep === 1 && <PickSlotsStep />}

        {/* Step 2: Information & Checkout */}
        {activeStep === 2 && <ConfirmStep />}

        {/* Step 3: PromptPay QR payment panel */}
        {activeStep === 3 && currentBooking && <PaymentStep />}

        {/* Existing Bookings tracking for user in customer view */}
        <MyBookingsBox />
      </div>

      {/* LINE Notification Sidebar Phone Simulator (Module 5 Integration UI) */}
      {SHOW_LINE_SIM && showLineSimulator && <LineSimulator />}

    </div>
    </CustomerPanelContext.Provider>
  );
}
