import { MemberType } from '../../types';
import { memberTierLabel, isPaidBooking, FREE_HOUR_REWARD_IDS, formatDate } from '../../mockData';
import DemoLogins, { DEMO_CUSTOMERS } from '../DemoLogins';
import { Shield, Sparkles } from 'lucide-react';
import { useCustomerPanelContext } from './useCustomerPanel';

export default function AccountBox() {
  const {
    authEmail,
    authError,
    authName,
    authPassword,
    authPhone,
    authTab,
    bookings,
    busy,
    forgotResult,
    guarded,
    handleDeleteAccount,
    handleForgotPassword,
    handleLogin,
    handleLogout,
    handleRedeemReward,
    handleRegister,
    loggedInUser,
    loginWith,
    redemptions,
    rewardsCatalog,
    setAuthEmail,
    setAuthError,
    setAuthName,
    setAuthPassword,
    setAuthPhone,
    setAuthTab,
    setForgotResult,
    setShowRewards,
    showRewards
  } = useCustomerPanelContext();
  return (
    <div id="customer-auth-console" className="bg-slate-900 text-white rounded-2xl border border-slate-800 overflow-hidden shadow-md">
      {loggedInUser ? (
        /* Logged In View */
        <div className="p-5 md:p-6 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-full bg-emerald-600 flex items-center justify-center font-bold text-white text-lg shadow-sm border border-emerald-500 shrink-0">
                {loggedInUser.name.substring(0, 2)}
              </div>
              <div>
                <h3 className="text-sm font-black text-slate-100 flex items-center gap-2">
                  สวัสดีคุณ {loggedInUser.name}
                  <span className="px-2.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 text-xs font-bold uppercase tracking-wider">
                    สยามก๊วนคลับ
                  </span>
                </h3>
                <p className="text-[11px] text-slate-400 font-medium">สิทธิ์บัญชีผู้เล่น: {loggedInUser.email || 'ไม่มีอีเมล'}</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleLogout}
                className="bg-slate-800 hover:bg-slate-700 hover:text-white text-slate-300 text-[11px] font-bold py-1.5 px-3.5 rounded-lg border border-slate-700 transition"
              >
                🚪 ลงชื่อออกจากระบบ (Logout)
              </button>
              <button
                onClick={handleDeleteAccount}
                className="bg-rose-950/40 hover:bg-rose-900 border border-rose-900/40 text-rose-300 text-xs font-bold py-1.5 px-3 rounded-lg transition"
              >
                🗑️ ขอลบข้อมูลบัญชีของฉัน (Delete Account)
              </button>
            </div>
          </div>

          {/* Profile Details segment */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-xs bg-slate-950/50 p-4 rounded-xl border border-slate-800">
            <div className="space-y-1 font-sans">
              <span className="text-xs text-slate-400 font-bold block">เบอร์โทรศัพท์ผู้ติดต่อหลัก:</span>
              <span className="font-mono text-slate-200 font-bold text-xs">{loggedInUser.phone || 'ไม่ระบุ'}</span>
            </div>
            <div className="space-y-1 font-sans">
              <span className="text-xs text-slate-400 font-bold block">ระดับสิทธิ์แสตมป์ส่วนลดประจำตัว:</span>
              <span className="text-emerald-400 font-bold flex items-center gap-1 text-[11px] leading-tight">
                🌟 {memberTierLabel(loggedInUser.memberType)}
                {loggedInUser.memberType === MemberType.CORPORATE && loggedInUser.orgName ? ` [${loggedInUser.orgName}]` : ''}
              </span>
            </div>
            <div className="space-y-1 font-sans">
              <span className="text-xs text-slate-400 font-bold block">วันที่เริ่มจัดทะเบียนร่วมก๊วน:</span>
              <span className="font-mono text-slate-300 text-xs">{loggedInUser.createdAt ? formatDate(loggedInUser.createdAt) : 'ไม่ระบุ'}</span>
            </div>
            <div className="space-y-1 font-sans bg-amber-950/20 border border-amber-900/40 p-2 rounded-lg">
              <span className="text-xs text-amber-400 font-bold block">🏆 แต้มสะสมปัจจุบัน (Reward Points):</span>
              <span className="text-amber-300 font-black text-sm flex items-center gap-1 font-mono">
                {loggedInUser.points || 0} แต้ม
              </span>
              <span className="text-xs text-slate-400 block leading-tight">(1 แต้ม / ชม.จอง หรือ 100 บ. ซื้อของ)</span>
            </div>
          </div>

          {/* 🌟 USER LOYALTY POINTS & REWARD CLUBS */}
          <div className="mt-5 border-t border-slate-800 pt-5 space-y-4">
            <button type="button" id="rewards-toggle" onClick={() => setShowRewards(v => !v)} className="w-full flex items-center justify-between gap-2 min-h-[40px] text-left">
              <span className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-400" />
                <span className="text-sm font-black text-amber-400">แต้มสะสมและของรางวัล ({loggedInUser.points || 0} แต้ม)</span>
              </span>
              <span className="text-slate-400">{showRewards ? '▴' : '▾'}</span>
            </button>

            {showRewards && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Left Column: List of Redeemable Rewards */}
              <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-800 space-y-3">
                <div className="flex justify-between items-center border-b border-slate-800 pb-2">
                  <span className="text-[11px] font-bold text-slate-300 flex items-center gap-1.5">
                    🎁 เลือกของรางวัลพรีเมียม
                  </span>
                  <span className="text-xs text-amber-400 font-bold bg-amber-950/40 px-2 py-0.5 rounded border border-amber-900/60 font-mono">
                    คงเหลือ: {loggedInUser?.points || 0} แต้ม
                  </span>
                </div>

                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                  {rewardsCatalog.map(reward => {
                    const canRedeem = (loggedInUser?.points || 0) >= reward.cost;
                    return (
                      <div key={reward.id} className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800 flex justify-between items-center gap-3 hover:border-slate-700 transition">
                        <div className="space-y-0.5 max-w-[70%]">
                          <span className="text-[11px] font-bold text-slate-100 flex items-center gap-1">
                            <span className="text-sm leading-none">{reward.emoji}</span>
                            {reward.name}
                          </span>
                          <p className="text-xs text-slate-400 leading-snug">
                            {reward.description}
                          </p>
                        </div>
                        <div className="flex flex-col items-end shrink-0 gap-1.5">
                          <span className="text-xs font-black text-amber-300 bg-amber-950/20 px-2 py-0.5 rounded font-mono">
                            {reward.cost} แต้ม
                          </span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={guarded(() => handleRedeemReward(reward))}
                            className={`text-xs font-bold py-1 px-3.5 rounded-md transition duration-200 shadow-sm ${
                              canRedeem 
                                ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-slate-950 font-extrabold hover:shadow-md hover:brightness-110 active:scale-95 cursor-pointer' 
                                : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-800'
                            }`}
                          >
                            {canRedeem ? 'แลกแต้ม' : 'แต้มไม่พอ'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Right Column: Active Vouchers and Point Earnings Logs */}
              <div className="space-y-4">
                {/* Active Coupon Code list */}
                <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-800 space-y-3">
                  <span className="text-[11px] font-bold text-slate-300 block border-b border-slate-800 pb-2">
                    🎟️ บัตรกำนัลสิทธิ์ของคุณ ({redemptions.filter(v => v.userId === loggedInUser?.id).length} ชิ้น)
                  </span>

                  <div className="space-y-2 max-h-[170px] overflow-y-auto pr-1">
                    {redemptions.filter(v => v.userId === loggedInUser?.id).map(voucher => (
                      <div key={voucher.id} className="bg-gradient-to-br from-emerald-950/30 to-slate-900 border border-emerald-900/40 p-2.5 rounded-lg space-y-1 relative overflow-hidden">
                        <span className="absolute -right-5 -bottom-5 text-4xl opacity-10 leading-none">🎖️</span>
                        <div className="flex justify-between items-start gap-1">
                          <span className="text-xs font-bold text-emerald-300">
                            {voucher.rewardName}
                          </span>
                          <span className="text-xs text-slate-500 font-mono shrink-0">
                            {voucher.redeemedAt}
                            {voucher.status && voucher.status !== 'ACTIVE' && (
                              <span className="ml-1 font-bold text-slate-300">{voucher.status === 'REDEEMED' ? '· รับแล้ว' : voucher.status === 'CANCELLED' ? '· ยกเลิก (บิลที่ได้แต้มถูกยกเลิก)' : '· หมดอายุ'}</span>
                            )}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/60">
                          <span className="text-xs text-slate-400">
                            รหัสสำหรับยืนยันกับสตาฟ:
                          </span>
                          <span className="font-mono text-xs font-black text-amber-300 bg-amber-950/80 px-2 py-0.5 rounded border border-amber-800/40 tracking-wider">
                            {voucher.claimCode}
                          </span>
                        </div>
                        {FREE_HOUR_REWARD_IDS.includes(voucher.rewardId) && (voucher.status || 'ACTIVE') === 'ACTIVE' && (
                          <p className="text-xs text-emerald-300/80">🏸 แจ้งรหัสนี้ที่เคาน์เตอร์เพื่อจองสนามช่วง Off-Peak ฟรี 1 ชั่วโมง</p>
                        )}
                      </div>
                    ))}

                    {redemptions.filter(v => v.userId === loggedInUser?.id).length === 0 && (
                      <div className="text-center py-8 text-slate-500 text-xs font-medium leading-relaxed">
                        ยังไม่มีคูปองเวาเชอร์ที่แลกไว้ 🏷️ <br />
                        สะสมแต้มจากการจองแตะสล็อตเล่นเพื่อปลดล็อกได้ค่ะ!
                      </div>
                    )}
                  </div>
                </div>

                {/* Earnings history simulation */}
                <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-800 space-y-2">
                  <span className="text-[11px] font-bold text-slate-300 block border-b border-slate-800 pb-1">
                    📊 แหล่งแต้มสะสมชั่วโมงเล่น (1 Point per Hour)
                  </span>
                  {(() => {
                    const userConfirmedBookings = bookings.filter(b => b.userId === loggedInUser?.id && isPaidBooking(b));
                    return (
                      <div className="space-y-1.5 font-sans">
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-slate-400 mb-1">ชั่วโมงสนามได้รับก๊วนที่จองสำเร็จ:</span>
                          <span className="font-bold text-emerald-400 font-mono">{userConfirmedBookings.length} ชม. ({userConfirmedBookings.length} แต้ม)</span>
                        </div>

                        <div className="max-h-[80px] overflow-y-auto space-y-1 text-xs">
                          {userConfirmedBookings.map(kb => (
                            <div key={kb.id} className="flex justify-between text-slate-400 border-b border-slate-900/60 pb-0.5">
                              <span>📅 วันเล่น {kb.date} ({kb.startTime})</span>
                              <span className="text-amber-400 font-bold">+1 แต้ม</span>
                            </div>
                          ))}
                          {userConfirmedBookings.length === 0 && (
                            <div className="text-xs text-slate-400">
                              (ยังไม่มีประวัติตารางจองจริงที่สตาฟตรวจสอบยืนยันสลิป แต้มเดิมของคุณถูกแอดโดยผู้จัดการระบบ)
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
            )}
          </div>
        </div>
      ) : (
        /* Anonymous Authed Screen */
        <div className="p-5 md:p-6">
          <div className="flex items-center gap-2 border-b border-slate-800 pb-3 mb-4">
            <Shield className="h-5 w-5 text-emerald-500 shrink-0" />
            <div>
              <h3 className="text-xs font-black text-slate-100 uppercase tracking-widest leading-none">ก๊วนผู้เล่น & ส่วนลดอัตโนมัติ (Customer Account Center)</h3>
              <p className="text-xs text-slate-400 mt-1 leading-normal">
                ตามหลักมาตรฐานความมั่นคงใหม่ ลูกค้าสยามสปอร์ตคอมเพล็กซ์จะต้องล็อคอินเข้าสู่ระบบก่อน เพื่อระบุสิทธิ์ส่วนลดที่ติดกับบัญชีจริงของคุณ!
              </p>
            </div>
          </div>

          {/* Tabs Switcher */}
          <div className="flex bg-slate-950/60 p-1 rounded-xl w-full border border-slate-800 md:max-w-md mb-4 text-xs">
            <button
              onClick={() => { setAuthTab('login'); setAuthError(null); setForgotResult(null); }}
              className={`flex-1 py-1.5 rounded-lg font-bold text-center transition ${authTab === 'login' ? 'bg-emerald-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'}`}
            >
              🔑 เข้าสู่ระบบก๊วน
            </button>
            <button
              onClick={() => { setAuthTab('register'); setAuthError(null); setForgotResult(null); }}
              className={`flex-1 py-1.5 rounded-lg font-bold text-center transition ${authTab === 'register' ? 'bg-emerald-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'}`}
            >
              📝 สมัครสมาชิกใหม่
            </button>
            <button
              onClick={() => { setAuthTab('forgot'); setAuthError(null); setForgotResult(null); }}
              className={`flex-1 py-1.5 rounded-lg font-bold text-center transition ${authTab === 'forgot' ? 'bg-emerald-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'}`}
            >
              ❓ ลืมรหัสผ่าน
            </button>
          </div>

          {/* Success recover/Error alerts inside Auth UI */}
          {authError && (
            <div role="alert" className="bg-rose-950/30 border border-rose-900/40 text-rose-300 p-3 rounded-xl text-xs font-sans mb-4">
              {authError}
            </div>
          )}

          {forgotResult && (
            <div className="bg-emerald-950/50 border border-emerald-800 text-emerald-300 p-3 rounded-xl text-xs font-sans whitespace-pre-line mb-4 leading-normal">
              {forgotResult}
            </div>
          )}

          {/* Tab Form rendering */}
          <form onSubmit={e => { e.preventDefault(); void guarded(authTab === 'login' ? handleLogin : authTab === 'register' ? handleRegister : handleForgotPassword)(e); }} className="space-y-3 font-sans text-xs">
            {authTab === 'register' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="auth-name" className="block text-xs font-bold text-slate-400 mb-1">ชื่อ (ชื่อเล่น หรือชื่อก๊วน):</label>
                  <input
                    id="auth-name"
                    type="text"
                    required
                    placeholder="เช่น พี่เหน่ง ก๊วนทุบดิน, สมศักดิ์"
                    value={authName}
                    onChange={(e) => setAuthName(e.target.value)}
                    className="w-full text-base sm:text-xs bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-white focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
                  />
                </div>
                <div className="bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/80 flex flex-col justify-center">
                  <span className="text-xs font-bold text-emerald-400 block">🌟 สิทธิ์เริ่มต้นบัญชีของคุณ:</span>
                  <span className="text-xs text-slate-300 font-medium">ลูกค้าทั่วไป (Normal) - ลด 0%</span>
                  <p className="text-xs text-slate-500 mt-1 leading-normal">* คุณจะได้รับสิทธิ์ทั่วไปโดยทันที เพื่อเปิดสิทธิ์ส่วนลดอื่นๆ (เช่น นักศึกษา/บริษัท MOU/สมาชิก) กรุณาแจ้งให้เจ้าหน้าที่ Admin ตรวจสอบหลักฐานและตั้งค่าให้หลังบ้านค่ะ</p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label htmlFor="auth-identity" className="block text-xs font-bold text-slate-400 mb-1">
                  {authTab === 'forgot' ? 'ระบุเบอร์โทร หรือ อีเมลที่กู้คืน:' : authTab === 'register' ? 'อีเมล (ไม่บังคับ):' : 'เบอร์โทรศัพท์ หรือ อีเมล:'}
                </label>
                <input
                  id="auth-identity"
                  type={authTab === 'register' ? 'email' : 'text'}
                  required={authTab !== 'register'}
                  placeholder={authTab === 'register' ? 'เช่น user@mail.com' : 'เช่น 0845678901 หรือ user@mail.com'}
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  className="w-full text-base sm:text-xs bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-white focus:outline-none focus:border-emerald-600"
                />
              </div>

              {authTab !== 'forgot' && (
                <div>
                  <label htmlFor="auth-password" className="block text-xs font-bold text-slate-400 mb-1">{authTab === 'register' ? 'ตั้งรหัสผ่าน (อย่างน้อย 6 ตัว):' : 'รหัสผ่าน:'}</label>
                  <input
                    id="auth-password"
                    type="password"
                    required
                    placeholder="••••••"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    className="w-full text-base sm:text-xs bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-white focus:outline-none focus:border-emerald-600"
                  />
                </div>
              )}

              {authTab === 'register' && (
                <div>
                  <label htmlFor="auth-phone" className="block text-xs font-bold text-slate-400 mb-1">เบอร์มือถือ (ใช้เข้าสู่ระบบ):</label>
                  <input
                    id="auth-phone"
                    type="tel"
                    required
                    placeholder="เช่น 08XXXXXXXX"
                    value={authPhone}
                    onChange={(e) => setAuthPhone(e.target.value)}
                    className="w-full text-base sm:text-xs bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-white"
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end pt-1">
              <button
                type="submit"
                className="bg-emerald-600 hover:bg-emerald-500 font-bold px-6 py-2 rounded-lg text-white font-sans transition"
              >
                {authTab === 'login' && '🔑 กดลงชื่อเข้าสู่ระบบ'}
                {authTab === 'register' && '📝 ลงทะเบียนบันทึกและเข้าใช้งาน'}
                {authTab === 'forgot' && '🔍 ดึงรหัสผ่านของฉันคืนชีพ'}
              </button>
            </div>
            {authTab === 'login' && <DemoLogins accounts={DEMO_CUSTOMERS} onPick={loginWith} dark />}
          </form>
        </div>
      )}
    </div>
  );
}
