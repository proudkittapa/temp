import { MemberType } from '../../types';
import { memberTierLabel, isPaidBooking, FREE_HOUR_REWARD_IDS, formatDate } from '../../mockData';
import DemoLogins, { DEMO_CUSTOMERS } from '../DemoLogins';
import { Shield, Sparkles } from 'lucide-react';
import { useCustomerPanelContext } from './useCustomerPanel';
import * as api from '../../api';

export default function AccountBox() {
  const {
    accountOpen,
    authEmail,
    authError,
    authName,
    authPassword,
    authPhone,
    authOpen,
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
    lineEnabled,
    loginWith,
    openAuth,
    pendingCheckout,
    redemptions,
    rewardsCatalog,
    selectedSlots,
    setAccountOpen,
    setAuthEmail,
    setAuthError,
    setAuthName,
    setAuthOpen,
    setAuthPassword,
    setAuthPhone,
    setAuthTab,
    setForgotResult,
    setPendingCheckout,
    setShowRewards,
    signInWithLine,
    showRewards
  } = useCustomerPanelContext();
  return (
    <div id="customer-auth-console" className="bg-slate-900 text-white rounded-2xl border border-slate-800 overflow-hidden shadow-md">
      {loggedInUser ? (
        /* Logged In View: one line; the details, rewards and sign-out
           fold out under "บัญชีของฉัน". */
        <div className="p-4 sm:p-5">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-emerald-600 flex items-center justify-center font-bold text-white shadow-sm border border-emerald-500 shrink-0">
              {loggedInUser.name.substring(0, 2)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-slate-100 truncate">{loggedInUser.name}</p>
              <p className="text-xs text-slate-400 truncate">{memberTierLabel(loggedInUser.memberType)} · <span className="text-amber-300 font-bold">{loggedInUser.points || 0} แต้ม</span></p>
            </div>
            <button type="button" id="account-toggle" aria-expanded={accountOpen} onClick={() => setAccountOpen(v => !v)}
              className="shrink-0 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold min-h-[40px] px-3.5 rounded-lg border border-slate-700 transition">
              บัญชีของฉัน {accountOpen ? '▴' : '▾'}
            </button>
          </div>

          {accountOpen && (
          <div id="account-details" className="mt-4 space-y-4">
          {/* Profile Details segment */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-xs bg-slate-950/50 p-4 rounded-xl border border-slate-800">
            <div className="space-y-1 font-sans">
              <span className="text-xs text-slate-400 font-bold block">เบอร์โทร</span>
              <span className="font-mono text-slate-200 font-bold text-xs">{loggedInUser.phone || 'ไม่ระบุ'}</span>
            </div>
            <div className="space-y-1 font-sans">
              <span className="text-xs text-slate-400 font-bold block">ระดับสมาชิก</span>
              <span className="text-emerald-400 font-bold flex items-center gap-1 text-[11px] leading-tight">
                {memberTierLabel(loggedInUser.memberType)}
                {loggedInUser.memberType === MemberType.CORPORATE && loggedInUser.orgName ? ` [${loggedInUser.orgName}]` : ''}
              </span>
            </div>
            <div className="space-y-1 font-sans">
              <span className="text-xs text-slate-400 font-bold block">สมัครเมื่อ</span>
              <span className="font-mono text-slate-300 text-xs">{loggedInUser.createdAt ? formatDate(loggedInUser.createdAt) : 'ไม่ระบุ'}</span>
            </div>
            <div className="space-y-1 font-sans bg-amber-950/20 border border-amber-900/40 p-2 rounded-lg">
              <span className="text-xs text-amber-400 font-bold block">แต้มสะสม</span>
              <span className="text-amber-300 font-black text-sm flex items-center gap-1 font-mono">
                {loggedInUser.points || 0} แต้ม
              </span>
              <span className="text-xs text-slate-400 block leading-tight">ได้ 1 แต้มต่อชั่วโมงที่จอง หรือทุก 100 บาทที่ซื้อของ</span>
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
                    แลกของรางวัล
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
                    ของรางวัลที่แลกแล้ว ({redemptions.filter(v => v.userId === loggedInUser?.id).length} ชิ้น)
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
                            รหัสสำหรับแจ้งพนักงาน
                          </span>
                          <span className="font-mono text-xs font-black text-amber-300 bg-amber-950/80 px-2 py-0.5 rounded border border-amber-800/40 tracking-wider">
                            {voucher.claimCode}
                          </span>
                        </div>
                        {/* By kind (any free-hour reward an admin adds); the
                            browser-only seed's rewards have no kind - by id. */}
                        {(voucher.rewardKind === 'FREE_OFFPEAK_HOUR' || FREE_HOUR_REWARD_IDS.includes(voucher.rewardId)) && (voucher.status || 'ACTIVE') === 'ACTIVE' && (
                          <p className="text-xs text-emerald-300/80">แจ้งรหัสนี้ที่เคาน์เตอร์เพื่อจองสนามช่วงนอกพีคฟรี 1 ชั่วโมง</p>
                        )}
                      </div>
                    ))}

                    {redemptions.filter(v => v.userId === loggedInUser?.id).length === 0 && (
                      <div className="text-center py-8 text-slate-500 text-xs font-medium leading-relaxed">
                        ยังไม่มีของรางวัลที่แลกไว้
                      </div>
                    )}
                  </div>
                </div>

                {/* Earnings history simulation */}
                <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-800 space-y-2">
                  <span className="text-[11px] font-bold text-slate-300 block border-b border-slate-800 pb-1">
                    แต้มจากการจอง
                  </span>
                  {(() => {
                    const userConfirmedBookings = bookings.filter(b => b.userId === loggedInUser?.id && isPaidBooking(b));
                    return (
                      <div className="space-y-1.5 font-sans">
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-slate-400 mb-1">ชั่วโมงที่จองและชำระแล้ว</span>
                          <span className="font-bold text-emerald-400 font-mono">{userConfirmedBookings.length} ชม. ({userConfirmedBookings.length} แต้ม)</span>
                        </div>

                        <div className="max-h-[80px] overflow-y-auto space-y-1 text-xs">
                          {userConfirmedBookings.map(kb => (
                            <div key={kb.id} className="flex justify-between text-slate-400 border-b border-slate-900/60 pb-0.5">
                              <span>{formatDate(kb.date)} {kb.startTime} น.</span>
                              <span className="text-amber-400 font-bold">+1 แต้ม</span>
                            </div>
                          ))}
                          {userConfirmedBookings.length === 0 && (
                            <div className="text-xs text-slate-400">
                              ยังไม่มีการจองที่ชำระแล้ว
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

          {lineEnabled && (
            <div id="line-link-box" className="flex flex-wrap items-center justify-between gap-3 bg-slate-950/50 p-4 rounded-xl border border-slate-800 text-xs">
              {loggedInUser.lineLinked ? (
                <span className="text-emerald-400 font-bold">✓ เชื่อมบัญชี LINE แล้ว · เข้าสู่ระบบด้วย LINE ได้ และรับแจ้งผลการจองทาง LINE</span>
              ) : (
                <>
                  <span className="text-slate-300">เชื่อมบัญชี LINE เพื่อเข้าสู่ระบบด้วย LINE และรับแจ้งผลการจองทาง LINE</span>
                  <button type="button" id="btn-line-link" onClick={() => void signInWithLine(true)}
                    className="bg-[#06C755] hover:bg-[#05b34c] text-white font-bold min-h-[40px] px-4 rounded-lg">เชื่อมบัญชี LINE</button>
                </>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
            <button type="button" onClick={handleLogout}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold min-h-[40px] px-4 rounded-lg border border-slate-700 transition">
              ออกจากระบบ
            </button>
            <button type="button" onClick={handleDeleteAccount} className="text-xs text-slate-500 hover:text-rose-300 underline">
              ขอลบบัญชี
            </button>
          </div>
          </div>
          )}
        </div>
      ) : !authOpen ? (
        /* Guest, form folded: hours can be picked without an account. */
        <div className="p-4 sm:p-5 space-y-3">
          {authError && (
            <div role="alert" className="bg-rose-950/30 border border-rose-900/40 text-rose-300 p-3 rounded-xl text-xs">{authError}</div>
          )}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <Shield className="h-5 w-5 text-emerald-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-slate-100">เลือกเวลาได้เลย ไม่ต้องเข้าสู่ระบบก่อน</p>
                <p className="text-xs text-slate-400 mt-0.5">เข้าสู่ระบบตอนกดจอง · สมาชิกได้ราคาส่วนลดและสะสมแต้ม</p>
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button type="button" id="btn-open-login" onClick={() => openAuth('login')}
                className="flex-1 sm:flex-none bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold min-h-[40px] px-4 rounded-lg transition">
                เข้าสู่ระบบ
              </button>
              <button type="button" id="btn-open-register" onClick={() => openAuth('register')}
                className="flex-1 sm:flex-none bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold min-h-[40px] px-4 rounded-lg border border-slate-700 transition">
                สมัครสมาชิก
              </button>
            </div>
          </div>
          {lineEnabled && (
              <button type="button" id="btn-line-login-compact" onClick={() => void signInWithLine()}
                className="w-full bg-[#06C755] hover:bg-[#05b34c] text-white text-sm font-bold min-h-[44px] px-4 rounded-lg transition flex items-center justify-center gap-2">
                <span className="bg-white text-[#06C755] text-[10px] font-black rounded px-1 leading-4">LINE</span>
                เข้าสู่ระบบด้วย LINE
              </button>
          )}
        </div>
      ) : (
        /* Guest: the sign-in / sign-up form */
        <div className="p-5 md:p-6">
          <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3 mb-4">
            <div className="flex items-start gap-2">
              <Shield className="h-5 w-5 text-emerald-500 shrink-0" />
              <div>
                <h3 className="text-sm font-bold text-slate-100">เข้าสู่ระบบ / สมัครสมาชิก</h3>
                <p id="auth-pending-note" className="text-xs text-slate-400 mt-1 leading-normal">
                  {pendingCheckout && selectedSlots.length > 0
                    ? `เข้าสู่ระบบหรือสมัครสมาชิกเพื่อจอง ${selectedSlots.length} ชม. ที่เลือกไว้ — เวลาที่เลือกยังอยู่ เข้าสู่ระบบแล้วจะไปขั้นตรวจสอบการจองทันที`
                    : 'สมาชิกได้ราคาส่วนลดและสะสมแต้มจากทุกการจอง'}
                </p>
              </div>
            </div>
            <button type="button" id="btn-close-auth" aria-label="ปิด" onClick={() => { setAuthOpen(false); setPendingCheckout(false); setAuthError(null); setForgotResult(null); }}
              className="shrink-0 text-slate-400 hover:text-white text-xs font-bold min-h-[40px] px-2">
              ✕ ปิด
            </button>
          </div>

          {lineEnabled && authTab !== 'forgot' && (
            <div className="mb-4 space-y-3 md:max-w-md">
              <button type="button" id="btn-line-login" onClick={() => void signInWithLine()}
                className="w-full bg-[#06C755] hover:bg-[#05b34c] text-white text-sm font-bold min-h-[44px] px-4 rounded-lg transition flex items-center justify-center gap-2">
                <span className="bg-white text-[#06C755] text-[10px] font-black rounded px-1 leading-4">LINE</span>
                เข้าสู่ระบบด้วย LINE
              </button>
              <p className="text-center text-[11px] text-slate-500">หรือใช้เบอร์โทรและรหัสผ่าน</p>
            </div>
          )}

          {/* Tabs Switcher */}
          <div className="flex bg-slate-950/60 p-1 rounded-xl w-full border border-slate-800 md:max-w-md mb-4 text-xs">
            <button
              onClick={() => { setAuthTab('login'); setAuthError(null); setForgotResult(null); }}
              className={`flex-1 py-1.5 rounded-lg font-bold text-center transition ${authTab === 'login' ? 'bg-emerald-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'}`}
            >
              เข้าสู่ระบบ
            </button>
            <button
              onClick={() => { setAuthTab('register'); setAuthError(null); setForgotResult(null); }}
              className={`flex-1 py-1.5 rounded-lg font-bold text-center transition ${authTab === 'register' ? 'bg-emerald-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'}`}
            >
              สมัครสมาชิก
            </button>
            <button
              onClick={() => { setAuthTab('forgot'); setAuthError(null); setForgotResult(null); }}
              className={`flex-1 py-1.5 rounded-lg font-bold text-center transition ${authTab === 'forgot' ? 'bg-emerald-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'}`}
            >
              ลืมรหัสผ่าน
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
          {/* The server keeps only password hashes: a forgotten password is
              reset by staff at the counter. The demo can show it. */}
          {authTab === 'forgot' && api.USE_BACKEND ? (
            <p id="forgot-help" className="text-sm text-slate-300 bg-slate-950/40 border border-slate-800 rounded-xl p-4">
              ลืมรหัสผ่าน? ติดต่อพนักงานที่เคาน์เตอร์เพื่อตั้งรหัสใหม่ค่ะ
            </p>
          ) : (
          <form onSubmit={e => { e.preventDefault(); void guarded(authTab === 'login' ? handleLogin : authTab === 'register' ? handleRegister : handleForgotPassword)(e); }} className="space-y-3 font-sans text-xs">
            {authTab === 'register' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="auth-name" className="block text-xs font-bold text-slate-400 mb-1">ชื่อที่ใช้จอง</label>
                  <input
                    id="auth-name"
                    type="text"
                    required
                    placeholder="เช่น สมศักดิ์"
                    value={authName}
                    onChange={(e) => setAuthName(e.target.value)}
                    className="w-full text-base sm:text-xs bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-white focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600"
                  />
                </div>
                <div className="bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/80 flex flex-col justify-center">
                  <span className="text-xs text-slate-300 font-medium">สมัครแล้วเป็นลูกค้าทั่วไป</span>
                  <p className="text-xs text-slate-500 mt-1 leading-normal">นักเรียน/นักศึกษา หรือสมาชิกบริษัท แจ้งพนักงานที่เคาน์เตอร์พร้อมหลักฐานเพื่อรับส่วนลดค่ะ</p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label htmlFor="auth-identity" className="block text-xs font-bold text-slate-400 mb-1">
                  {authTab === 'forgot' ? 'เบอร์โทร หรือ อีเมล' : authTab === 'register' ? 'อีเมล (ไม่บังคับ)' : 'เบอร์โทร หรือ อีเมล'}
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
                  <label htmlFor="auth-password" className="block text-xs font-bold text-slate-400 mb-1">{authTab === 'register' ? 'ตั้งรหัสผ่าน (อย่างน้อย 6 ตัว)' : 'รหัสผ่าน'}</label>
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
                  <label htmlFor="auth-phone" className="block text-xs font-bold text-slate-400 mb-1">เบอร์มือถือ (ใช้เข้าสู่ระบบ)</label>
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
                {authTab === 'login' && 'เข้าสู่ระบบ'}
                {authTab === 'register' && 'สมัครสมาชิก'}
                {authTab === 'forgot' && 'ดูรหัสผ่าน (โหมดสาธิต)'}
              </button>
            </div>
            {authTab === 'login' && <DemoLogins accounts={DEMO_CUSTOMERS} onPick={loginWith} dark />}
          </form>
          )}
        </div>
      )}
    </div>
  );
}
