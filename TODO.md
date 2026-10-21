# TODO (planned, not started)

## Order of work (do top to bottom, by priority)
Cheap and blocking first, then what changes what customers/staff see
(before launch), then launch, then things that need outside accounts.

1. **Owner answers the remaining decisions** - section 0: cash refunds vs
   the drawer, login lockout policy, and the real business name / address /
   tax ID / VAT registration.
2. ~~**Fix receipts and the payment screen**~~ - done 2026-10-21: business
   details are an admin setting (Pricing tab), receipts use them and show who
   took the money and when. Left: running tax-invoice number and full tax
   invoice (section 5); the owner still has to type in the real details.
3. ~~**Basketball courts A, B, C, each full or half**~~ - done 2026-10-21
   (section 10).
4. **Safety checks** - section 7: automated concurrency tests (the
   double-booking backstop and automatic retry are done).
5. ~~**One login, screens by permission, admin-defined roles**~~ - done 2026-10-21 (section 9).
   Before launch so staff learn the final sign-in once (if launch can't
   wait, do it right after; today's separate sign-ins work).
6. **Deploy to a real server with HTTPS** - section 8 (8a: free tunnel from
   the Mac for testers now; 8b: VPS + Docker + Caddy for customers).
7. **Test on real phones** - section 6 and section 3 (real phones, inside the
   LINE app); scan the PromptPay QR with two Thai banking apps.
8. **LINE**: prerequisites, then LINE Login (section 1), then LINE OA
   notifications (section 2).
9. **Forgot password** - section 4 (needs an SMS provider, or LINE from step 8).
10. **Staff POS and Admin on a tablet** - section 3.
11. **Remaining small improvements** - section 7: refunds split by method,
    report year picker, Excel import preview, rental deposit, tidy-ups.

## 0. Owner decisions pending (found in the 2026-10-20/21 reviews)
Each needs a yes/no from the owner before it is built.
- [x] **Cash with no shift open:** decided 2026-10-21 - cash is refused until a shift is open (server and screen).
- [x] **Blind cash count:** decided 2026-10-21 - counter staff don't see the expected cash (server withholds it); they confirm their count first, then explain any difference. Managers/admins still see it.
- [x] **Manager permissions:** decided 2026-10-21 - for now managers keep what the app allows today (manual point changes, full dashboard and reports). Roles and permissions become configurable in section 9.
- [x] **Basketball courts:** clarified 2026-10-21 - A, B and C are three separate courts, each bookable full or by half, and each closable fully or by half. Work planned in section 10.
- [x] **Voiding a sale whose points were already spent:** decided 2026-10-21 - the customer's unused rewards are cancelled to cover the points; if the reward was already received, the sale can't be voided.
- [ ] **Cash refunds and the drawer:** refunds are treated as bank transfers (the shift's expected cash ignores them). If staff ever refund cash from the drawer, the shift must subtract them.
- [ ] **Login lockout policy:** 20 wrong passwords from anywhere lock an account for 15 minutes (someone who knows a staff phone number can keep it locked). Keep, or switch to a delay/CAPTCHA? Behind a proxy, `TRUSTED_PROXIES` must be set (the server now warns in release mode).
- [ ] **Business details:** the owner types the real name, address, phone, tax ID and VAT status in Admin → Pricing → ข้อมูลร้าน (built 2026-10-21). Until then receipts show "ยังไม่ได้ตั้งชื่อร้าน" and no VAT lines. The name should match the PromptPay account name - the payment screen shows it as the payee.

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
- [x] Hard-coded placeholder header replaced by the admin setting (name, address, phone, tax ID, VAT registered) - `PUT /admin/business`, `StaffPOS.tsx` receipt.
- [x] VAT-registered: seller name, address, 13-digit tax ID and the VAT 7% breakdown are printed (title ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ).
- [ ] Still to do if VAT-registered: a running tax-invoice number (the receipt number is now the booking/order code), and a full tax invoice (ใบกำกับภาษีเต็มรูป) with the customer's name/address/tax ID when asked.
- [x] Not registered: no VAT lines, titled ใบเสร็จรับเงิน.
- Owner sets which applies in the admin setting (item 0).

## 6. Test the features
- [ ] Add items 1–5 to `TESTING_CHECKLIST.md` and run through the whole checklist on real phones (iOS + Android, inside the LINE app and in a normal browser).
- [ ] Scan the PromptPay QR with at least two Thai banking apps.

## 7. Smaller improvements found in the 2026-10-21 code review (not done)
- [x] Day summary: refunds split by method (cash / transfer) and only refunds of approved payments counted; refunds of never-approved slips shown apart. Done 2026-10-21.
- [x] Automatic retry of deadlock/serialization errors: every transaction runs through `repository.RetryTx` (3 attempts). Done 2026-10-21.
- [ ] Backend concurrency tests on a real Postgres (verify vs cancel, expiry vs slip upload, void vs shift close) - only a manual parallel-booking check was done.
- [x] Database backstop against double booking: partial unique index `idx_bookings_live_slot` on (court_id, date, start_time) for non-cancelled rows; a hit returns 409 "slot already booked". Done 2026-10-21.
- [x] Receipts show who took the money and when (payment verified_by/verified_at for bookings, the seller for counter sales), plus the print time. Done 2026-10-21.
- [x] Reports year picker: next year down to 5 years back. Done 2026-10-21.
- [x] Excel import: preview of the rows to add and the skipped ones, saved only after confirming. Done 2026-10-21.
- [x] Rental deposit (FR-5.3): per-product cash deposit, given back on return or partly/fully kept by staff with a reason; drawer expected cash follows it. Done 2026-10-21. (Kept deposits are not yet shown in revenue reports.)
- [x] Tidy-ups: `export` dropped from symbols used only inside their file (api.ts, mockData.ts, Dialog.tsx); `bangkokNow` reuses shared formatters. Done 2026-10-21.

## 8. Deploy (production)

### 8a. Quick demo for testers (free, from the owner's Mac) - before 8b if needed
- [ ] Add `allowedHosts: ['.trycloudflare.com']` to `server` in `vite.config.ts` (Vite blocks unknown host names: "Blocked request. This host is not allowed").
- [ ] Run `npm run dev:api` and `cloudflared tunnel --url http://localhost:3000` (`brew install cloudflared`), send the printed `https://...trycloudflare.com` address. From China the tunnel may need the VPN on.
- Limits: works only while the Mac is on; the address changes on every restart; demo accounts (password `123456`) and the ⚡ demo login buttons are open to anyone with the link - test data only.

### 8b. Real server
- [ ] **Host:** a small Linux VPS in Singapore (DigitalOcean / Vultr / AWS Lightsail, about US$6-12/month) + optionally a domain (about US$10-15/year). A VPS rather than Render/Railway because slip images are saved on the server's disk (`golang-backend/uploads/`), which their cheaper plans wipe on restart, and Postgres there is a separate paid service.
- [ ] **Deployment files in the repo** (not written yet):
  - `docker-compose.yml`: Postgres (data in a volume), the Go backend (`uploads/` in a volume), Caddy.
  - `golang-backend/Dockerfile`: builds the whole package (`go build .`, not `main.go` alone - see WORKLOG 2026-10-21).
  - Frontend build: `VITE_DATA_SOURCE=api npm run build` → `dist/` (demo login buttons are left out of production builds).
  - `Caddyfile`: serve `dist/`, send `/api/*` to the backend on port 8080, automatic HTTPS for the domain.
  - `DEPLOY.md`: step-by-step for a fresh server (install Docker, copy `.env`, `docker compose up -d`, update, backup, restore).
- [ ] **Production settings** in `golang-backend/.env` on the server only (never in the repo or chat):
  - `GIN_MODE=release`; a long random `JWT_SECRET` (`openssl rand -hex 32`; the server refuses to start without it in release mode);
  - `DATABASE_URL` with a strong Postgres password;
  - `PROMPTPAY_ID` = the shop's real PromptPay number (the default `0105561008012` is only an example - payments would go to the wrong account);
  - `TRUSTED_PROXIES=` Caddy's address (otherwise every customer looks like one IP to the login limit); `CORS_ALLOWED_ORIGINS=` the site's address;
  - `SEED_DEMO_USERS=false`; court counts (`BASKETBALL_COURT_COUNT` etc.) if not the defaults.
- [ ] **First start:** create the real admin account (and staff accounts with their roles); no demo accounts; type the business details in Admin → Pricing → ข้อมูลร้าน (section 0).
- [ ] **Backups:** daily Postgres dump + copy of `uploads/` off the server (e.g. to object storage), kept ~30 days; test a restore once before launch.
- [ ] **Running it:** the backend restarts by itself after a crash or reboot (`restart: unless-stopped`); simple uptime check (e.g. UptimeRobot, free) that alerts the owner; how to update = `git pull` + rebuild + restart, written in `DEPLOY.md`.
- [ ] After deploy: run `TESTING_CHECKLIST.md` against the real address (step 7), and use this address for the LINE callback/webhook (section 1-2 prerequisites).

## 9. One login for everyone; screens by permission; roles set by the admin
Done 2026-10-21 (see WORKLOG.md).
- [x] One sign-in for every account (the customer page's login; the counter and settings screens offer the same form). After sign-in a staff/admin account lands on the counter or settings; the nav bar shows only the screens the role may use; the demo role switcher stays in dev/browser-only mode only. Old `#/staff`, `#/manager`, `#/admin` links still open those screens.
- [x] 17 permissions (`model/permissions.go`, mirrored in `src/permissions.ts`); every protected route checks one; built-in roles keep exactly their old rights (`route_access_test.go`).
- [x] Admin tab "🔐 สิทธิ์และบทบาท": create/edit/delete roles, tick permissions; role pickers list custom roles. ADMIN keeps "manage roles"; built-in and in-use roles can't be deleted.
- [x] One session per browser (old per-screen sessions are merged on first load); audit log keeps who did what.
- [ ] Optional later: custom roles are staff-type only (customer-only checks such as walk-in member matching look for role CUSTOMER); a "customer tier" role type if ever needed.

## 10. Basketball: courts A, B, C - each bookable full or by half, closable full or by half
Done 2026-10-21 (see WORKLOG.md).
- [x] Courts A, B and C, each a mutex group of full court + left half + right half. A keeps its ids (`b_full_a`, `b_half_b` = A left, `b_half_c` = A right, renamed only if the old "B"/"C" names were unchanged, so existing bookings stay valid); B and C are new (`bb-b-*`, `bb-c-*`, groups `bball-court-2/3`). Same in the server seed and the browser-only seed + migration.
- [x] Closures by group: closing a full court also closes its halves; closing one half closes that half and the full court, not the other half (server `repository.ClosureFor` + `ClosureCourts`, every booking path; frontend `findClosure`; "affected bookings" when a closure is saved). The closure form already lists every court, so choosing full/left/right means choosing that row.
- [x] Grid shows 9 basketball rows (today's way); half courts keep the half-court price and off-peak-only rule. Dashboard occupancy already counts by court group, so it counts 3 basketball courts.
- [x] Admin: "✏️ เปลี่ยนชื่อ" button per court (admin only); the server now refuses a rename to a name another court already has.
- [ ] Optional later: one grid row per court with a full/left/right choice instead of 9 rows.
