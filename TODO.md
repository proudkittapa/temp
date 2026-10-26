# TODO

## Next session: start here (paused 2026-10-22)

1. ~~**Security assessment**~~ - done 2026-10-22, see `SECURITY_REVIEW.md`
   (20 findings fixed). Still open from it, needing a decision or a bigger
   change: **slip reuse with a re-saved copy** (staff enter the bank
   reference + amount when approving?), **courts held by junk slips** (a
   review deadline for waiting slips?), **phone numbers not verified** (OTP
   via SMS/LINE), account lockout (section 0), revoking sessions
   (token_version, with forgot-password), no cancel/refund after the hour
   started. (Opening float vs last count and `override_closure` needing
   the closures permission: done 2026-10-22.)
2. **Owner decisions still open** (section 0 and below): no-show half-court
   resale price 125 (section 12); audit-log retention; kept rental
   deposits as income; cash refunds from the drawer; login lockout policy;
   real business details (typed in Admin after deploy).
3. **Go live** (section 8b, `DEPLOY.md`): owner rents the server + domain,
   follows DEPLOY.md; then `TESTING_CHECKLIST.md` on the real address,
   test HTTPS, set up the nightly backup cron and an off-server copy.
4. ~~**Before real customers**~~ (section 11 "Go-live"): done 2026-10-22 -
   concurrency tests, phone numbers in one form, money columns
   numeric(12,2).
5. **Then:** LINE login and notifications (1-2), forgot password by SMS
   (4), VAT tax invoices (5).

Kept on purpose (owner, 2026-10-22): the browser-only demo mode
(`npm run dev`) - rules stay in Go *and* TypeScript; change and test both.

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
4. ~~**Safety checks**~~ - done 2026-10-22: automated concurrency tests on a
   real Postgres (`golang-backend/concurrency_test.go`).
5. ~~**One login, screens by permission, admin-defined roles**~~ - done 2026-10-21 (section 9).
   Before launch so staff learn the final sign-in once (if launch can't
   wait, do it right after; today's separate sign-ins work).
6. **Deploy to a real server with HTTPS** - section 8 (8a: free tunnel from
   the Mac for testers now; 8b: VPS + Docker + Caddy for customers).
   Section 11 "Go-live" items: all done (2026-10-22).
7. **Test on real phones** - section 6 and section 3 (real phones, inside the
   LINE app); scan the PromptPay QR with two Thai banking apps.
8. **LINE**: prerequisites, then LINE Login (section 1), then LINE OA
   notifications (section 2).
9. **Forgot password** - section 4 (needs an SMS provider, or LINE from step 8).
10. ~~**Staff POS and Admin on a tablet**~~ - done 2026-10-21 (section 3).
11. ~~**No-show: re-sell the court at half price**~~ - done 2026-10-21 (section 12).
12. **Remaining improvements** - section 7 and section 11 (refund split, year
    picker, Excel preview, rental deposit, live refresh, retry protection,
    indexes, concurrency tests and phone lookups are done; left: smaller customer
    download, kept deposits in reports).

## 0. Owner decisions pending (found in the 2026-10-20/21 reviews)
Each needs a yes/no from the owner before it is built.
- [x] **Cash with no shift open:** decided 2026-10-21 - cash is refused until a shift is open (server and screen).
- [x] **Blind cash count:** decided 2026-10-21 - counter staff don't see the expected cash (server withholds it); they confirm their count first, then explain any difference. Managers/admins still see it.
- [x] **Manager permissions:** decided 2026-10-21 - for now managers keep what the app allows today (manual point changes, full dashboard and reports). Roles and permissions become configurable in section 9.
- [x] **Basketball courts:** clarified 2026-10-21 - A, B and C are three separate courts, each bookable full or by half, and each closable fully or by half. Work planned in section 10.
- [x] **Voiding a sale whose points were already spent:** decided 2026-10-21 - the customer's unused rewards are cancelled to cover the points; if the reward was already received, the sale can't be voided.
- [x] **Cash refunds and the drawer** (decided and done 2026-10-23): each refund records TRANSFER or CASH; a cash refund needs an open shift and is subtracted from its expected cash (frozen at close), the day ledger and `refunded_from_drawer` in the day summary; staff choose the method when refunding.
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
- [x] Staff POS and Admin on a tablet: checked at iPad portrait 820×1180 and landscape 1180×820 - no sideways scrolling on any staff/admin tab; F&B cart now beside the products (sticky) from tablet width. Done 2026-10-21. Still worth a try on a real tablet (small text links such as แก้ไข/ลบ are small to tap).
- [ ] Try the customer flow on real phones, inside the LINE app too.

## 4. Forgot password — reset with the phone number
- [ ] Customers who forget their password reset it using their registered phone number: request a reset → a one-time code is sent to that phone (SMS, or LINE once item 2 exists) → enter the code + a new password.
- [ ] Backend: `POST /auth/password-reset/request {phone}` (always answers the same, so it doesn't reveal which numbers are registered) and `POST /auth/password-reset/confirm {phone, code, new_password}`; codes expire after ~10 minutes, single use, stored hashed; rate-limited like logins (`login_failures`).
- [ ] Needs an SMS provider account (e.g. ThaiBulkSMS / Twilio) and its API key in `golang-backend/.env`. Until then the current "contact staff" message stays.
- [ ] Optional: staff/admin can trigger a reset for a customer at the counter after checking ID.

## 5. VAT on receipts
- [x] Hard-coded placeholder header replaced by the admin setting (name, address, phone, tax ID, VAT registered) - `PUT /admin/business`, `StaffPOS.tsx` receipt (dialog in the panel since the 2026-10-22 split).
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
- [x] Backend concurrency tests on a real Postgres (`golang-backend/concurrency_test.go`, run with `TEST_DATABASE_URL`): same-hour bookings, overlapping blocks, full court vs halves, approve vs cancel, slip vs expiry, redeem twice, checkout of the last items, cancel vs redeem, void vs shift close - each repeated with random arrival order, checking one winner, stock, points = ledger, cash at close. No bug found (5 runs of 50 rounds each). Done 2026-10-22.
- [x] Database backstop against double booking: partial unique index `idx_bookings_live_slot` on (court_id, date, start_time) for non-cancelled rows; a hit returns 409 "slot already booked". Done 2026-10-21.
- [x] Receipts show who took the money and when (payment verified_by/verified_at for bookings, the seller for counter sales), plus the print time. Done 2026-10-21.
- [x] Reports year picker: next year down to 5 years back. Done 2026-10-21.
- [x] Excel import: preview of the rows to add and the skipped ones, saved only after confirming. Done 2026-10-21.
- [x] Rental deposit (FR-5.3): per-product cash deposit, given back on return or partly/fully kept by staff with a reason; drawer expected cash follows it. Done 2026-10-21. (Kept deposits are not yet shown in revenue reports.)
- [x] Tidy-ups: `export` dropped from symbols used only inside their file (api.ts, mockData.ts, Dialog.tsx); `bangkokNow` reuses shared formatters. Done 2026-10-21.

## 8. Deploy (production)

### 8a. Quick demo for testers (free, from the owner's Mac) - before 8b if needed
- [x] (done 2026-10-22) Add `allowedHosts: ['.trycloudflare.com']` to `server` in `vite.config.ts` (Vite blocks unknown host names: "Blocked request. This host is not allowed").
- [ ] Run `npm run dev:api` and `cloudflared tunnel --url http://localhost:3000` (`brew install cloudflared`), send the printed `https://...trycloudflare.com` address. From China the tunnel may need the VPN on.
- Limits: works only while the Mac is on; the address changes on every restart; demo accounts (password `123456`) and the ⚡ demo login buttons are open to anyone with the link - test data only.

### 8b. Real server
- [ ] **Host:** a small Linux VPS in Singapore (DigitalOcean / Vultr / AWS Lightsail, about US$6-12/month) + optionally a domain (about US$10-15/year). A VPS rather than Render/Railway because slip images are saved on the server's disk (`golang-backend/uploads/`), which their cheaper plans wipe on restart, and Postgres there is a separate paid service.
- [x] **Deployment files in the repo** (done 2026-10-22, tested with Docker in the cloud session): `deploy/docker-compose.yml` (Postgres 16 with a volume, the backend with an uploads volume, health check on `/readyz`, 35 s stop grace, Caddy), `golang-backend/Dockerfile` (whole package, static binary, non-root), `deploy/web.Dockerfile` (`VITE_DATA_SOURCE=api` build served by Caddy), `deploy/Caddyfile` (site + `/api` + `/healthz` `/readyz`, automatic HTTPS for `SITE_ADDRESS`), `deploy/backup.sh` (DB dump + slip images, 30 days), `DEPLOY.md` (fresh server to running, first admin via `make-admin`, backups/restore, updates).
- [ ] **Production settings** in `golang-backend/.env` on the server only (never in the repo or chat):
  - `GIN_MODE=release`; a long random `JWT_SECRET` (`openssl rand -hex 32`; the server refuses to start without it in release mode);
  - `DATABASE_URL` with a strong Postgres password;
  - `PROMPTPAY_ID` = the shop's real PromptPay number (the default `0105561008012` is only an example - payments would go to the wrong account);
  - `TRUSTED_PROXIES=` Caddy's address (otherwise every customer looks like one IP to the login limit); `CORS_ALLOWED_ORIGINS=` the site's address;
  - `SEED_DEMO_USERS=false`; court counts (`BASKETBALL_COURT_COUNT` etc.) if not the defaults.
- [ ] **First start** (how-to in DEPLOY.md section 5; `arena-backend make-admin <phone>` exists): create the real admin account (and staff accounts with their roles); no demo accounts; type the business details in Admin → Pricing → ข้อมูลร้าน (section 0).
- [ ] **Backups** (`deploy/backup.sh` + cron in DEPLOY.md; restore tested): daily Postgres dump + copy of `uploads/` off the server (e.g. to object storage), kept ~30 days; test a restore once before launch.
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

## 11. Performance / concurrency review (2026-10-21) - what's left
Full review: three reviewers (backend performance, concurrency/money, frontend) + spot checks. Done the same day: database pool cap + statement/lock/idle timeouts + request deadlines (section below, "done"), walk-in PromptPay no longer auto-expires (reversed 2026-10-23, owner: walk-in transfers expire after 30 minutes like online bookings).

### Go-live (do before real customers - not needed while the data is fake)
- [x] **Database indexes** - done 2026-10-21 (`golang-backend/perf_indexes.go`): 16 indexes (order items, my bookings, slip queue, expiry/finished jobs, vouchers, open rentals, audit by type, users by role, phone prefix, closures by date, shifts, and pg_trgm search on member names and the audit log). Built CONCURRENTLY in the background after startup, so they work on an empty database and on one full of data without blocking writes; an index left unfinished by an interrupted build is rebuilt on the next start.
- [x] **Phone lookups** (done 2026-10-22): every start stores old-format phones ("081-555-0000", "+66...") in canonical form (`repository.NormalizeStoredPhones`, from `setupSchema`); lookups (login, register, walk-in, checkout, make-admin) are then `phone = ?` on the index (50k users: 0.03 ms instead of 31 ms), login's email and phone are two indexed queries. An account whose number an older account already has keeps its old format and is logged by id to be merged by hand; while any is left, lookups also use the old regex so it is still found.
- [x] Retry protection: every app write (not sign-in or slip upload) sends an `Idempotency-Key` reused while the same action is retried; the server (`handler/idempotency.go`, table `idempotency_keys`, pruned after 24 h) replays the first success, answers 409 while it is still running, releases the key on failure. Done 2026-10-21.
- [x] Live refresh: staff screens reload every 15 s while visible (header shows "อัปเดตอัตโนมัติ hh:mm:ss"), customer screens every 30 s (10 s on the payment screen), and at once when the user comes back to the tab/app; the payment screen follows the server (approved / rejected / refunded / expired). Hidden tabs don't poll. Done 2026-10-21 (`src/useLiveTick.ts`). Admin screens don't poll.
- [x] Walk-in grid while loading another date: now shows "กำลังโหลด…", greyed and not clickable, and booking is refused until that date's data is in (it used to show every slot free). Done 2026-10-21.
- [x] **Customers download the staff/admin app** (done 2026-10-22): StaffPOS, AdminPanel and the dashboard tab (charts) are lazy, xlsx is imported when a file is made/read. Customer page: 448 KB -> 122 KB gzip; staff +31 KB, admin +31 KB, charts 125 KB, xlsx 143 KB on demand.
- [x] `index.html`: `lang="th"`, real title and description. Done 2026-10-21.
- [x] Demo users/passwords are no longer in a `VITE_DATA_SOURCE=api` build (checked: no demo email or password in `dist`). Done 2026-10-21.

### Scaling to 2+ servers
- [ ] Slip images are on the server's own disk - move to shared storage (S3/GCS or a shared volume) before a second server.
- [x] Background jobs run in every server - done 2026-10-26: one server holds a lease row (`job_leases`, 2-minute expiry on the database clock, renewed each minute, given up at shutdown) and runs the jobs; a row rather than an advisory lock, which would hold a pooled connection (deadlock with `DB_MAX_OPEN_CONNS=1`). `CompleteFinishedBookings` updates 1,000 at a time and skips rows a request has locked.
- [x] Startup migrations/indexes run unlocked - done 2026-10-22/23: the whole `setupSchema` holds one session advisory lock (4205) on one connection; two servers starting together on an empty database used to crash one of them in AutoMigrate (3 of 3 tries), now both start (5 of 5).
- [ ] Cash-drawer attribution uses each server's clock (`ReturnRentalItem` now takes its time after the drawer lock - fixed 2026-10-21): stamp `shift_id` on payments/orders/deposit settlements under the drawer lock and compute expected cash by shift.

### Correctness
- [x] Booking cancel / no-show now cancel unused rewards bought with those points (shared `coverPointsWithRewards` with VoidOrder); a reward already handed over is reported (`points_short`), the cancel still goes ahead. Done 2026-10-21. (Browser-only mode doesn't do the clawback.)
- [x] Lock order: rental return now locks order → item → drawer → stock, void locks its items and restocks in checkout's sorted order. Done 2026-10-21. (MarkPaidInCash now takes the closure lock before the drawer for an expired booking, the order CreateBookings uses; race test with a closure and a shift close at the same moment passes, 2026-10-23.)
- [x] `CancelBookings` (and the expiry job's counter) reset per retry attempt. Done 2026-10-21.
- [x] `SaveSlip` takes the customer's lock first (as CreateBookings); the expiry job closes orphan payments (booking rows gone) instead of re-picking them forever. Done 2026-10-21.
- [x] `LockCourtGroupTx` re-reads the court's group inside the transaction and re-checks it on the locked row (retries if regrouped meanwhile). Done 2026-10-21.
- [x] Database backstops: CHECK constraints (points, stock, variant stock ≥ 0; refund within the payment; deposit settled within what was taken) and a unique "one open shift" index (`ensureConstraints`, main.go); a violation answers 409. Done 2026-10-21.
- [x] Money columns `numeric(12,2)` (done 2026-10-22, `golang-backend/money_columns.go`): the 20 amount columns (bookings, payments, refunds, orders, order items, products, pricing rules, shifts) are converted at start, one ALTER per table under the migration lock, values rounded to the satang (they already were; any that weren't are counted in the log). They had been GORM's `numeric` without a scale (exact, but any number of decimals). Go keeps `float64` rounded with `RoundBaht`; switching Go to `shopspring/decimal` would remove that last float step but touches every amount in the services - not done.

- [x] Kept rental deposits are income (owner 2026-10-23): in the day summary (`kept_deposits`, inside `rental_income`), the dashboard (day, month chart, sales split, all-time), the day ledger (also its expected cash) and the sales CSV (own row), on the day they were kept.

### Performance (beyond indexes)
- [x] Admin dashboard: ~33 sequential queries -> 6 grouped ones (done 2026-10-22; output compared identical with the old code on 11 dates incl. month boundaries). A daily rollup / cache for all-time totals only if the tables get very large.
- [x] Unbounded lists (done 2026-10-22): `GET /admin/users` is paged (200 default, `search`, `has_more`; the users tab searches on the server); audit log returns `has_more` instead of a full COUNT, with keyset paging (`before_id`); order lines/products/staff are loaded in IN-batches of 1,000 (no 65k-parameter failure). Still open: the monthly export is built in memory (fine for a month of one complex). The audit screen now searches and filters on the server, 200 at a time with "load more" (done 2026-10-26).
- [x] `GET /admin/shifts` (done 2026-10-22): a closed shift with its figures frozen at close is no longer recounted (0 queries instead of 3); older shifts closed before `cash_deposits_at_close` existed still are.
- [x] Checkout (done 2026-10-22): one locking query for all products, one for their sizes, one stock UPDATE per table (`takeStock`), one batch insert of the lines - instead of 4-7 round trips per line under the locks. Same checks and messages; parallel test: 8 buyers for 5 items -> 5 sold, 3 out of stock, stock 0.
- [x] Pricing config loaded once per booking and passed down (was 3x). The signed-in user and their role's permissions come from one joined query per request (was 2) - deliberately not cached, so a suspension or role change still applies to the next request even with several servers (done 2026-10-22).
- [x] Frontend refetching (done 2026-10-22): the staff screen loads, on each refresh and after each action, what every tab shows (slip queue, shift, session, courts, pricing) plus only the open tab's data - 5-9 requests instead of 13; the customer payment step polls only the customer's own bookings (2 requests per 10 s instead of 8). Not done: a query cache (e.g. TanStack Query) with per-resource invalidation, memoised grid cells. Was: Frontend: every action refetches everything (~13 requests per sale) - per-resource queries (e.g. TanStack Query) with targeted invalidation; ~~`request()` timeout~~ (GETs time out after 20 s since 2026-10-21); grid cells read localStorage and recompute on every keystroke - memoise the slot matrix, `calculateLedger` once per render.
- [ ] Audit rows store full order/product snapshots and are never pruned - store ids/totals, partition or archive by month.

### Structure / debt
- [x] React type checking (done 2026-10-22): `@types/react`/`@types/react-dom` added; `strict`, `noUnusedLocals`, `noFallthroughCasesInSwitch` on in `tsconfig.json` (`npm run lint` = 0 errors). The ~3,500 errors were nearly all from React being untyped; 8 real ones fixed. Left off: `noImplicitReturns` (15, style only).
- [ ] Pricing/availability/drawer rules exist in Go and TypeScript - server returns the availability matrix (status, price, reason) and error codes instead of English text matched by ~130 regexes.
- [ ] Two data modes (110 `USE_BACKEND` branches) - one DataSource interface, or drop browser-only mode for a Docker demo.
  - **Owner decision 2026-10-22: keep the browser-only demo mode (`npm run dev`, data in localStorage) for now.** So the TypeScript copy of the rules stays too: every rule change must be made in Go *and* in `mockData.ts`/the local branches, and tested in both modes. Revisit when the Docker setup (section 8b) exists - it can replace this mode as the no-install demo.
- [x] Split StaffPOS / AdminPanel / CustomerPanel by tab (done 2026-10-22): panels 131-414 lines, one file per tab (35-491 lines) under `components/{staff,admin,customer}/`, state and handlers in `use<Panel>.tsx` behind a typed context.
- [x] The three `use<Panel>.tsx` hooks split by area (done 2026-10-22): each keeps a core (state, effects, data loading; 400-570 lines) and calls one hook per area (staff: session, shift, slips, booking actions, vouchers, walk-in, shop, rentals, day report; admin: session, dashboard data, pricing, courts, users, products, reports; customer: account, slot picker, booking flow, rewards).
- [x] Slip upload: type check and downscale to ≤1600 px JPEG when not JPG/PNG/WebP or over 1.5 MB (`src/slipImage.ts`); CSV formula guard covers leading spaces/tab/CR and leaves numbers alone. Done 2026-10-21.
- [ ] Small: token in localStorage (the Caddy deployment sends a CSP). Done 2026-10-23: 7-9 px text raised to 10-11 px (76 places); unused packages removed (`@google/genai`, `express`, `@types/express`, `dotenv`, `motion`, `tsx`, `autoprefixer`) with the AI Studio leftovers in `.env.example` (`GEMINI_API_KEY`, `APP_URL`) and the `clean` script's `server.js`.

## 12. No-show: free the court and re-sell it (all decided 2026-10-21) - done 2026-10-21
Done: `NO_SHOW_GRACE_MINUTES` / `NO_SHOW_RESALE_PRICE_PERCENT` (sent to the screens in `GET /pricing`), overlap check and the double-booking index (`idx_bookings_held_slot`, replaces `idx_bookings_live_slot`) ignore NO_SHOW, resale price in `planSlots` (`bookings.resale_of` = the no-show's id), staff grid shows "ลูกค้าไม่มา · ราคาพิเศษ", the no-show button waits for the grace period. Resale is effectively counter-only (online bookings must start in the future).
Today a no-show keeps the money (no refund, the hour's point is taken back) but the hour stays blocked: only CANCELLED bookings free a court (`repository.CheckOverlapTx` and the unique index in `ensureIndexes`, main.go). So nobody else can play that hour.
- [x] **Grace period 15 minutes:** the 🚫 ไม่มาใช้สนาม button (and `POST /staff/bookings/:id/no-show`) works only from 15 minutes after the hour's start (today: from the start). Make it an env value, `NO_SHOW_GRACE_MINUTES=15`.
- [x] **No-show frees the court:** a NO_SHOW hour no longer blocks that court (and its basketball group) in the overlap check, the unique index (`WHERE status NOT IN ('CANCELLED','NO_SHOW')`, rebuilt in `ensureIndexes`) and the availability grid. The no-show customer's payment stays kept and counts as income.
- [x] **Re-sell at a discount:** another customer (online or walk-in at the counter) can book the freed hour for **half price** by default - env `NO_SHOW_RESALE_PRICE_PERCENT=50` (100 = full price). The server computes the price; the grid shows the freed hour with the discounted price and a label (e.g. "ว่าง (ลูกค้าไม่มา) ราคาพิเศษ").
- [x] The discount applies only to the freed hour and only while it is still that hour (it has already started, so normally a counter walk-in); decided: the resale percent **replaces** the member discount - the price is the court's normal price × the percent (changed 2026-10-21: a half court keeps the half-court rate, see below).
- [x] If the original customer arrives late after the hour was re-sold, the counter shows the hour as taken by the new booking; the no-show stays recorded (no refund).
- [x] Reports/day summary: both the kept no-show payment and the resale booking count as income; audit log records who marked the no-show and the resale.
- [x] Browser-only mode: same rules in `mockData.ts` / StaffPOS; add to `TESTING_CHECKLIST.md`.
- Decided: marking a no-show **always** frees the court (no separate button).
Follow-up review fixes (2026-10-21, see WORKLOG): a freed **half** court is re-sold at the percent of its normal **half** price (250 -> 125; before it cost 250, the same as a normal half, and at 100% double); a full court over one no-show half is discounted on that half only (125 + 250); resale never costs more than the customer's normal price; `NO_SHOW_RESALE_PRICE_PERCENT` must be 1-100. Re-sold no-shows count once in occupancy; the admin grid and the day-off "affected bookings" list ignore no-shows. **Owner: confirm** the half-court change (it departs from "the percent replaces the half-court rate" above).
- [x] **Undo a no-show** (owner: yes, 2026-10-22): any staff, from the booking's detail ("↩️ ลูกค้ามาแล้ว"), `POST /staff/bookings/:id/undo-no-show`. Back to CONFIRMED, the points the no-show took come back (rewards cancelled to cover them stay cancelled); refused once the hour was sold to someone else.

