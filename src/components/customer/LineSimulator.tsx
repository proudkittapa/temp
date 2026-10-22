import { useCustomerPanelContext, lineMessageTime } from './useCustomerPanel';

export default function LineSimulator() {
  const {
    myLineMessages,
    setShowLineSimulator
  } = useCustomerPanelContext();
  return (
    <div id="line-phone-simulator" className="col-span-1 lg:col-span-4 transition-all duration-300 ease-in-out">
      <div className="sticky top-6 bg-slate-950 text-white rounded-[32px] border-8 border-slate-800 overflow-hidden shadow-2xl h-[650px] flex flex-col">

        {/* Phone Ear Speaker & Cam */}
        <div className="h-6 bg-slate-800 w-full flex justify-center items-center relative">
          <div className="h-3 w-20 bg-slate-950 rounded-b-xl absolute top-0" />
          <div className="flex justify-between w-full px-5 text-xs text-slate-400 select-none">
            <span>05:30 น.</span>
            <span className="flex gap-1 items-center">📶 🛜 🔋 100%</span>
          </div>
        </div>

        {/* Line OA AppHeader */}
        <div className="bg-[#1e2a38] p-4 flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-full bg-emerald-500 flex items-center justify-center font-bold text-white text-xs shadow-inner">SP</div>
            <div>
              <p className="font-bold text-xs">สนามกีฬาคอมเพล็กซ์ LINE OA</p>
              <p className="text-xs text-emerald-400 flex items-center gap-0.5">● แอดมินและระบบ AI พร้อมตอบ</p>
            </div>
          </div>
          <button onClick={() => setShowLineSimulator(false)} className="text-slate-400 hover:text-white text-xs px-2 py-1">ย่อ</button>
        </div>

        {/* Simulated chat container */}
        <div className="flex-1 p-3 overflow-y-auto space-y-4 bg-slate-900 scrollbar-none font-sans">

          {/* Automated welcome message */}
          <div className="flex items-start gap-2 max-w-[85%]">
            <div className="h-6 w-6 rounded-full bg-emerald-500 flex items-center justify-center text-[11px] font-bold text-white shrink-0">SP</div>
            <div className="bg-[#293646] p-2.5 rounded-xl text-[11px] text-slate-200">
              สวัสดีค่ะ ยินดีต้อนรับสู่ LINE OA ของสปอร์ตคอมเพล็กซ์ 🏸🏀 <br />ระบบจะส่งข้อมูลยืนยันการจอง และแจ้งเตือนล่วงหน้าให้ท่านที่นี่โดยอัติโนมัติค่ะ
            </div>
          </div>

          {/* Loop client side LINE alerts */}
          {myLineMessages.map((msg) => (
            <div key={msg.id} className="flex flex-col items-start gap-1 max-w-[85%]">
              <span className="text-[11px] text-slate-400 pl-8 font-mono">{lineMessageTime(msg.timestamp)}</span>
              <div className="flex items-start gap-2">
                <div className="h-6 w-6 rounded-full bg-emerald-500 flex items-center justify-center text-[11px] font-bold text-white shrink-0">SP</div>
                <div className="bg-emerald-950 border border-emerald-900/60 p-3 rounded-2xl text-[11px] text-emerald-100 whitespace-pre-wrap font-sans">
                  {msg.text}
                </div>
              </div>
            </div>
          ))}

          {myLineMessages.length === 0 && (
            <p className="text-xs text-slate-500 text-center pt-10">ไม่มีแจ้งเตือนในขณะนี้ ยืนยันการจองเพื่อเริ่มรับ Push message ทาง LINE</p>
          )}
        </div>

        {/* Input simulation footer */}
        <div className="p-3 bg-[#18222d] border-t border-slate-800 flex items-center gap-2">
          <input
            type="text"
            disabled
            placeholder="ระบุข้อความโต้ตอบอัตโนมัติ..."
            className="w-full bg-[#243141] text-xs py-2 px-3 rounded-full text-slate-400 outline-none cursor-not-allowed"
          />
          <button disabled className="h-8 w-8 rounded-full bg-emerald-600 flex items-center justify-center text-white text-xs cursor-not-allowed">ส่ง</button>
        </div>
      </div>
    </div>
  );
}
