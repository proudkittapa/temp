# TODO (planned, not started)

## 1. LINE Login — sign in with LINE *or* phone number
- [ ] Add "Login with LINE" next to the existing phone + password login (keep both).
- [ ] Backend: OAuth flow (`/auth/line/start` → LINE → `/auth/line/callback`), verify the ID token, find/create the user by `users.line_user_id` (column already exists), then issue our normal JWT.
- [ ] LINE doesn't provide a phone number → ask new LINE users for their phone once (needed for contact and walk-in matching). Let existing phone users link their LINE account.
- Cost: LINE Login is free. Estimate: ~1–2 days.

## 2. LINE OA notifications
- [ ] Replace the simulated LINE messages (`line_messages` in localStorage) with real Messaging API push messages: booking created (with QR/amount), slip approved, slip rejected (with reason), booking expired, day-before reminder.
- [ ] On LINE login, offer "add the OA as friend" (customers must be friends to receive pushes).
- [ ] Send from the backend after the DB transaction commits; a failed push must never fail the booking.
- Cost (Thailand, check current prices): Free plan = 300 push messages/month (~150 bookings at ~2 messages each); Basic ฿1,280/month + VAT = 15,000 messages. Replies to customer chats are free. Estimate: ~1–2 days on top of item 1.
- Optional later: LIFF (open the booking site inside the LINE app with automatic login), ~1 day.

### Prerequisites (owner to prepare)
- [ ] LINE Business ID → create the LINE Official Account.
- [ ] LINE Developers Console: **one Provider** containing both a **LINE Login channel** and a **Messaging API channel** (same provider, or the user IDs won't match).
- [ ] Channel secrets / access tokens go in `golang-backend/.env` only, never in the repo or chat.
- [ ] A public HTTPS address (deployed app) for the login callback and webhook; a temporary tunnel is fine for testing.

## 3. Mobile-friendly UI
- [ ] Make the customer pages work well on phones (most customers will book from LINE / mobile): booking grid (currently a wide table), checkout + QR step, booking history, login/register.
- [ ] Staff POS usable on a tablet.
- [ ] Check at 375px width (iPhone SE) and 390–430px; no sideways scrolling, buttons big enough to tap.

## 4. Forgot password — reset with the phone number
- [ ] Customers who forget their password reset it using their registered phone number: request a reset → a one-time code is sent to that phone (SMS, or LINE once item 2 exists) → enter the code + a new password.
- [ ] Backend: `POST /auth/password-reset/request {phone}` (always answers the same, so it doesn't reveal which numbers are registered) and `POST /auth/password-reset/confirm {phone, code, new_password}`; codes expire after ~10 minutes, single use, stored hashed; rate-limited like logins (`login_failures`).
- [ ] Needs an SMS provider account (e.g. ThaiBulkSMS / Twilio) and its API key in `golang-backend/.env`. Until then the current "contact staff" message stays.
- [ ] Optional: staff/admin can trigger a reset for a customer at the counter after checking ID.

## 5. Server-backed admin reports and counter sales (API mode)
- [ ] With `VITE_DATA_SOURCE=api` the admin dashboard, CSV report and audit-log tab still read this browser's localStorage, not the server (a notice says so). Add `GET /admin/bookings?from&to` (bookings + payments), `GET /admin/audit-logs` and a monthly report endpoint, and switch those tabs to them.
- [ ] F&B sales and racket/shoe rentals are stored only in the counter's browser in both modes, so they are lost when the browser is cleared, two counters don't see each other's sales, and the cash drawer (`/staff/summary`) doesn't include them. Move orders, stock and rentals to the backend.
- Estimate: ~2–3 days.

## 6. Test the features
- [ ] Add items 1–5 to `TESTING_CHECKLIST.md` and run through the whole checklist on real phones (iOS + Android, inside the LINE app and in a normal browser).
- [ ] Scan the PromptPay QR with at least two Thai banking apps.
