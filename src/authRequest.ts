// The nav bar's "เข้าสู่ระบบ" asks the booking screen to open its sign-in
// form. The screen may not be mounted yet (another screen was open), so the
// request is kept until the screen takes it.
let requested = false;
const EVENT = 'open-customer-auth';

export function requestCustomerAuth() {
  requested = true;
  window.dispatchEvent(new Event(EVENT));
}

// True once per request.
export function takeCustomerAuthRequest(): boolean {
  const r = requested;
  requested = false;
  return r;
}

export function onCustomerAuthRequest(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
