import { useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import { notify } from '../Dialog';

// LINE sends the browser back here (/line-callback?code&state) after a
// LINE sign-in. Signs in, links LINE to the account, or - for a LINE
// account not yet known - asks for the phone number once (owner decision:
// required). onDone returns to the booking page.
export default function LineCallback({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'working' | 'phone' | 'error'>('working');
  const [error, setError] = useState('');
  const [signupToken, setSignupToken] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // a code works once (React dev runs effects twice)
    started.current = true;
    const q = new URLSearchParams(window.location.search);
    const code = q.get('code'), state = q.get('state');
    if (q.get('error') || !code || !state) {
      setError(q.get('error') === 'access_denied' ? 'ยกเลิกการเข้าสู่ระบบด้วย LINE แล้ว' : 'เข้าสู่ระบบด้วย LINE ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
      setStep('error');
      return;
    }
    api.finishLineLogin(code, state)
      .then(r => {
        if (r.kind === 'needsPhone') {
          setSignupToken(r.signupToken);
          setName(r.name);
          setStep('phone');
          return;
        }
        if (r.kind === 'linked') notify('เชื่อมบัญชี LINE เรียบร้อยแล้วค่ะ');
        onDone();
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : String(err));
        setStep('error');
      });
  }, [onDone]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.completeLineSignup(signupToken, name, phone);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div id="line-callback" className="max-w-md mx-auto bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
      <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
        <span className="bg-[#06C755] text-white text-[10px] font-black rounded px-1.5 py-0.5">LINE</span>
        เข้าสู่ระบบด้วย LINE
      </h2>

      {step === 'working' && <p role="status" className="text-sm text-slate-600">กำลังเข้าสู่ระบบ…</p>}

      {step === 'phone' && (
        <form onSubmit={e => void submit(e)} className="space-y-3 text-sm">
          <p className="text-slate-600">ครั้งแรกที่ใช้ LINE กับเรา กรุณากรอกเบอร์มือถือ (ใช้ติดต่อและค้นหาการจองที่เคาน์เตอร์)</p>
          <div>
            <label htmlFor="line-name" className="block text-xs font-bold text-slate-600 mb-1">ชื่อที่ใช้จอง</label>
            <input id="line-name" required value={name} onChange={e => setName(e.target.value)}
              className="w-full text-base border border-slate-300 rounded-lg py-2 px-3" />
          </div>
          <div>
            <label htmlFor="line-phone" className="block text-xs font-bold text-slate-600 mb-1">เบอร์มือถือ</label>
            <input id="line-phone" type="tel" required placeholder="เช่น 08XXXXXXXX" value={phone} onChange={e => setPhone(e.target.value)}
              className="w-full text-base border border-slate-300 rounded-lg py-2 px-3" />
          </div>
          {error && <p role="alert" className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}
          <button type="submit" className="w-full bg-[#06C755] hover:bg-[#05b34c] text-white font-bold min-h-[48px] rounded-xl">ยืนยัน</button>
          <button type="button" onClick={onDone} className="w-full text-slate-500 text-sm underline">ยกเลิก กลับหน้าจอง</button>
        </form>
      )}

      {step === 'error' && (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>
          <button type="button" onClick={onDone} className="w-full bg-slate-800 text-white font-bold min-h-[44px] rounded-xl">กลับหน้าจอง</button>
        </div>
      )}
    </div>
  );
}
