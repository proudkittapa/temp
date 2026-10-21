# TODO (planned, not started)

## Order of work (do top to bottom)
Each step names the sections below. The order puts cheap, blocking items
first and items that need outside accounts later.

1. **Owner answers the decisions** - section 0, incl. the real business
   name / address / tax ID and whether the business is VAT-registered. Each is
   a yes/no; several are small code changes once decided.
2. **Fix receipts and the payment screen** with those details - section 5,
   plus "receipts show the print time and the viewer as cashier" (section 7).
3. **Safety checks before going live** - section 7: database backstop against
   double booking, concurrency tests and automatic retry of "busy" errors.
4. **Deploy to a real server with HTTPS** - section 8. Needed for real-phone
   testing, the LINE login callback and LINE webhooks.
5. **Test on real phones** - section 6 and section 3 ("real phones / inside
   the LINE app"); scan the PromptPay QR with two Thai banking apps.
6. **LINE**: prerequisites, then LINE Login (section 1), then LINE OA
   notifications (section 2).
7. **Forgot password** - section 4 (needs an SMS provider, or LINE from step 6).
8. **Staff POS and Admin on a tablet** - section 3.
9. **Remaining small improvements** - section 7: refunds split by method,
   report year picker, Excel import preview, rental deposit, tidy-ups.
10. **Basketball courts A, B, C, each full or half** - section 10 (before
    launch if basketball is sold from day one; it changes the court list).
11. **One login, screens by permission, admin-defined roles** - section 9.

## 0. Owner decisions pending (found in the 2026-10-20/21 reviews)
Each needs a yes/no from the owner before it is built.
- [x] **Cash with no shift open:** decided 2026-10-21 - cash is refused until a shift is open (server and screen).
- [x] **Blind cash count:** decided 2026-10-21 - counter staff don't see the expected cash (server withholds it); they confirm their count first, then explain any difference. Managers/admins still see it.
- [x] **Manager permissions:** decided 2026-10-21 - for now managers keep what the app allows today (manual point changes, full dashboard and reports). Roles and permissions become configurable in section 9.
- [x] **Basketball courts:** clarified 2026-10-21 - A, B and C are three separate courts, each bookable full or by half, and each closable fully or by half. Work planned in section 10.
- [x] **Voiding a sale whose points were already spent:** decided 2026-10-21 - the customer's unused rewards are cancelled to cover the points; if the reward was already received, the sale can't be voided.
- [ ] **Cash refunds and the drawer:** refunds are treated as bank transfers (the shift's expected cash ignores them). If staff ever refund cash from the drawer, the shift must subtract them.
- [ ] **Login lockout policy:** 20 wrong passwords from anywhere lock an account for 15 minutes (someone who knows a staff phone number can keep it locked). Keep, or switch to a delay/CAPTCHA? Behind a proxy, `TRUSTED_PROXIES` must be set (the server now warns in release mode).
- [ ] **Business details:** the real business name and PromptPay account name for the payment screen and receipts (the payment screen now just says "check the recipient name in your banking app"). See also item 5.

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
- [x] Customer pages on phones: list view with big hour buttons under 640px (grid/list toggle, remembered), bottom booking bar, one-column steps, folded rewards, text ≥ 11-12px; checked at 375/390/430px with no sideways scrolling (2026-10-20).
- [ ] Staff POS and Admin usable on a tablet (next round).
- [ ] Try the customer flow on real phones, inside the LINE app too.

## 4. Forgot password — reset with the phone number
- [ ] Customers who forget their password reset it using their registered phone number: request a reset → a one-time code is sent to that phone (SMS, or LINE once item 2 exists) → enter the code + a new password.
- [ ] Backend: `POST /auth/password-reset/request {phone}` (always answers the same, so it doesn't reveal which numbers are registered) and `POST /auth/password-reset/confirm {phone, code, new_password}`; codes expire after ~10 minutes, single use, stored hashed; rate-limited like logins (`login_failures`).
- [ ] Needs an SMS provider account (e.g. ThaiBulkSMS / Twilio) and its API key in `golang-backend/.env`. Until then the current "contact staff" message stays.
- [ ] Optional: staff/admin can trigger a reset for a customer at the counter after checking ID.

## 5. VAT on receipts
- [ ] Receipts print a "VAT 7%" breakdown (price ÷ 1.07) under a hard-coded placeholder header — "SMART SPORT COMPLEX CLUB", "188 Ramkhamhaeng Rd…", TAX ID `0-1055-59092-49-0` (`StaffPOS.tsx` receipt modal) — so they are not valid tax invoices. Replace the placeholders with the real business details either way.
- [ ] If the business is VAT-registered: add the seller's name, address and 13-digit tax ID (admin setting, server-side), a running tax-invoice number, and the customer's name/tax ID when asked for a full tax invoice (ใบกำกับภาษีเต็มรูป).
- [ ] If not registered: remove the VAT lines and call it a receipt (ใบเสร็จรับเงิน).
- Owner to decide which applies, and send the real name / address / tax ID (also needed for the payment screen - item 0).

## 6. Test the features
- [ ] Add items 1–5 to `TESTING_CHECKLIST.md` and run through the whole checklist on real phones (iOS + Android, inside the LINE app and in a normal browser).
- [ ] Scan the PromptPay QR with at least two Thai banking apps.

## 7. Smaller improvements found in the 2026-10-21 code review (not done)
- [ ] Day summary: split refunds by method and count only refunds of money counted as received.
- [ ] Backend concurrency tests on a real Postgres (verify vs cancel, expiry vs slip upload, void vs shift close) and an automatic retry of deadlock/serialization errors instead of "busy, try again".
- [ ] Database backstop against double booking: a partial unique index on (court_id, date, start_time) for non-cancelled rows, behind the existing locks.
- [ ] Receipts show the print time and the viewer as cashier, not when/by whom the money was taken.
- [ ] Reports year picker covers last/this/next year only.
- [ ] Excel import: show a preview of parsed rows before saving; read files with `readAsArrayBuffer`.
- [ ] Rental security deposit (FR-5.3) is not modelled.
- [ ] Tidy-ups: drop `export` from symbols used only inside their file (api.ts, mockData.ts, Dialog.tsx); `bangkokNow` and `localDateOf` each build their own date formatter.

## 8. Deploy (production)
- [ ] A server or managed host for the Go backend + Postgres, the frontend built with `VITE_DATA_SOURCE=api npm run build`, served over HTTPS.
- [ ] Production settings in `golang-backend/.env` (never in the repo): `GIN_MODE=release`, a long random `JWT_SECRET` (the server refuses to start without it in release mode), `DATABASE_URL`, `PROMPTPAY_ID`, `CORS_ALLOWED_ORIGINS`, `TRUSTED_PROXIES` behind a reverse proxy, and **no** `SEED_DEMO_USERS`.
- [ ] Create the real admin account and remove/disable demo accounts; daily database backups and a tested restore; a place to keep slip images (`uploads/`) that survives redeploys.

## 9. One login for everyone; screens by permission; roles set by the admin
Today the app has separate sign-ins for the customer page, Staff POS (`#/staff`, `#/manager`) and Admin (`#/admin`), and each keeps its own session.
- [ ] One sign-in page for every account. After sign-in the user lands on what they can use (customer booking, counter, settings) and only sees the menus/tabs/buttons their permissions allow; the demo role switcher goes away in production.
- [ ] Permissions as data: a list of named permissions (e.g. book online, verify slips, sell & rent, open/close shift, cancel & refund, record cash, adjust points, edit pricing, manage courts & closures, view reports (limited/full), export, manage users & roles, view audit log). Every server route checks a permission instead of a fixed role.
- [ ] Admin screen to create/edit roles and tick their permissions; assign a role to each staff account. Built-in roles CUSTOMER / STAFF / MANAGER / ADMIN are created with today's rights (managers as they are now: manual points, full dashboard) so nothing changes until the admin edits them; ADMIN can't remove its own access to roles.
- [ ] Session: one token per user; `api.ts` sessions per panel (`customer` / `staff` / `admin`) merge into one; audit log keeps who did what.

## 10. Basketball: courts A, B, C - each bookable full or by half, closable full or by half
Today there is one basketball floor: "A (full)" plus halves "B (left)" and "C (right)" of that same floor. The owner clarified there are three courts.
- [ ] Courts: A, B and C, each a booking group of three rows - full court, left half, right half (the existing `mutex_group_id` + `share_of_group` model already supports this: full blocks both halves, a half blocks the full court, the two halves don't block each other). Migration: keep `b_full_a` as A full, rename `b_half_b` / `b_half_c` to A left / A right (their bookings stay valid), add B and C (full + halves) in new groups. Same in the browser-only seed (`DEFAULT_COURTS` + `initializeState` migration).
- [ ] Closures by group: closing a full court also closes its halves; closing one half closes that half and the full court, not the other half. Server `repository.ClosureFor` and every availability check, frontend `findClosure` (needs the court list), the closure form (choose court + full/left/right), and "affected bookings" when a closure is saved.
- [ ] Grid: show basketball as A/B/C with full/half choices (9 rows today's way, or one row per court with a full/half toggle); half courts keep the half-court price and the off-peak-only rule unless the owner changes it.
- [ ] Dashboard occupancy counts 3 basketball courts; update tests, `TESTING_CHECKLIST.md` and the README court section.
- [ ] Admin: a rename button for courts (the server already accepts a new name; the screen has none). Note: courts are already configurable - the admin adds courts (and half courts tied to a full court) and opens/closes them; with rename, B and C could be set up from the screen, leaving only the group-aware closures as code work.
