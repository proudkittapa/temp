# Work Log

Several AI assistants (and people) work on this repository. **Before pushing
to `main`, add an entry at the top of this file** saying what changed, why,
how it was checked, and what was left undone, so the next session can pick
up where the last one stopped without re-reading the whole history.

Entry format:

```
## YYYY-MM-DD — short title
- **Who:** person / AI tool + session link if there is one
- **Commit(s):** hash(es) — the commit that adds the entry can say "this commit"
- **Changed:** what and why, one bullet per fix, with the files touched
- **Verified:** tests run and manual checks, with results
- **Not done / follow-ups:** known open issues
```

---

## 2026-10-23 — Cash refunds from the drawer

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com (decision 5: "yes staff could")
- **Commit(s):** this commit (on `main`, parent `c08e262`)
- **Changed:** a refund can now be paid back in cash from the drawer
  instead of only by bank transfer:
  - `model.Refund.Method` (`TRANSFER` default, `CASH`); `Shift.CashRefundsAtClose`
    frozen at close like the other cash figures; money column list updated.
  - `CancelBookings` / `RefundPayment` take `refund_method`
    (`POST /admin/bookings/:id/cancel`, `POST /admin/payments/:id/refund`);
    anything else is a 400. A CASH refund needs an open shift: it takes the
    drawer lock (`lockDrawerForCash`) before its timestamp, like every
    other cash movement, so it lands in exactly one shift.
  - Shift expected cash = float + cash bookings + cash orders + kept
    deposits − cash refunds (`ShiftView.cash_refunds`); blind count hides it.
  - Day summary `refunded_from_drawer`; `GET /staff/summary` now actually
    returns it **and `kept_deposits`** (the previous commit computed kept
    deposits but the handler never sent them, so API-mode day ledger cash
    left them out). Both withheld in blind count.
  - Frontend: `askRefundMethod` dialog after the refund decision (cancel
    booking and refund slip); CASH without an open shift needs the same
    confirmation as other cash; shift panel shows "− คืนเงินสดจากลิ้นชัก";
    day ledger cash subtracts drawer refunds; the refunds line reads
    "ที่รับเป็นเงินสด · ที่รับเป็นเงินโอน · จ่ายเป็นเงินสดจากลิ้นชัก".
    Demo mode does the same locally (refund entries carry `method`).
  - Files: `models.go`, `money_columns.go`, `shift_service.go`,
    `booking_admin.go`, `lifecycle_api.go`, `shop_api.go`, `types.ts`,
    `api.ts`, `staff/shared.tsx`, `bookingActions.tsx`, `slipActions.tsx`,
    `dayReport.tsx`, `DayTotalTab.tsx`, README, TODO.
- **Verified:**
  - New DB test `TestCashRefundFromDrawer` (cash refund lowers expected
    cash, transfer doesn't, summary figure, CASH with no shift =
    `ErrNoOpenShift`, TRANSFER fine). Full `go test -race ./...` with
    `TEST_DATABASE_URL` passes; `tsc` clean; vitest 66/66.
  - Live against the running server: two 180-baht cash walk-ins (+360),
    cancel one with CASH refund → expected 4383.05 → 4203.05,
    `cash_refunds` 180; cancel the other with TRANSFER → unchanged;
    `refund_method: BOGUS` → 400. Staff screen (manager) shows the
    "− คืนเงินสดจากลิ้นชัก 180" figure and the refunds line with
    "จ่ายเป็นเงินสดจากลิ้นชัก 180"; staff1 (blind) gets 0s.
- **Not done / follow-ups:** the new method dialog was not clicked
  through in a browser (type-checked; the API path it calls was tested
  live). Decision 4 (login lockout policy) still open.

---

## 2026-10-23 — Kept rental deposits count as income

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com (decision 6: "sure")
- **Commit(s):** this commit (on `main`, parent `f8f659b`)
- **Changed:** a deposit kept at return (damage, loss) is income on the
  day it was kept (`deposit_settled_at`), not the day of the rental:
  - `POSService.TotalsBetween`: `kept_deposits`, added to `rental_income`
    (day summary / staff day total).
  - `ReportService.Dashboard`: daily order revenue, monthly chart, sales
    split (rental) and all-time order sales include them.
  - Staff day ledger (`dayReport.tsx`): rental income and expected cash
    include them (the kept cash stays in the drawer); the breakdown says
    "รวมมัดจำที่ยึด"; browser-only mode computes the same.
  - Sales CSV: one row per kept deposit ("มัดจำที่ยึด (kept deposit)",
    dated when kept), so LineTotal adds up to income.
  - Admin dashboard in browser-only mode: same rules.
- **Verified:** `go vet`, `go test ./...`, DB tests (new
  `TestKeptDepositIsIncome`: 100 deposit, 40 kept -> kept_deposits +40,
  rental income +90 = 50 fee + 40), `tsc`, vitest.
- **Not done / follow-ups:** the sales CSV lists orders by the month they
  were made; a deposit kept in the following month appears in the rental
  month's file (dated when kept).

---

## 2026-10-23 — Owner decisions: cancel after start logged, no-show rules in Admin, audit retention

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com (answers to the 8 open decisions; this commit: 3, 7, 8)
- **Commit(s):** this commit (on `main`, parent `5f82fd8`)
- **Decided, not changed:** 1 no bank reference at slip approval; 2 waiting
  slips are not auto-rejected.
- **Changed:**
  - **3. Cancel after the hour started: allowed, logged.** `CancelBookings`
    counts cancelled hours that had started (`hourStarted`, Bangkok) into
    `started_hours` in its result and the `BOOKING_CANCELLED` audit entry;
    the counter's cancel dialog warns first.
  - **7. No-show rules set by admins:** `pricing_configs.no_show_resale_percent`
    (1-100) and `no_show_grace_minutes` (0-120), saved with
    `PUT /admin/pricing-config` (`ConfigInput`, replaces the 4 loose
    arguments); unset = the `NO_SHOW_*` env settings as before. Used for the
    freed hour's price (`planSlots`) and the no-show button (`MarkNoShow`);
    `/pricing` reports the values in effect. Admin -> Pricing has the
    fields (browser-only mode stores them locally).
  - **8. Audit log kept two years:** `AUDIT_RETENTION_DAYS` (default 730);
    the minute job deletes older entries, 5,000 at a time
    (`service.PruneAuditLogs`).
  - Docs: `golang-backend/.env.example`.
- **Verified:** `go vet`, `go test ./...` (new `TestHourStarted`), DB tests
  (new: audit retention keeps 700-day, deletes 800-day; no-show resale 0 %
  refused, 80 %/20 min saved and reported, a freed 180 THB hour re-sells at
  144), `tsc`, vitest.
- **Not done / follow-ups:** 5 (cash refunds from the drawer) and 6 (kept
  deposits as income) next; 4 (login lockout) waits for the owner's choice.

---

## 2026-10-23 — Owner rules: hours per booking, walk-in expiry, banked cash, voucher validity

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com (answers to "any logic doesn't make sense": 1 keep, 2 keep, 3/4/5/6 change)
- **Commit(s):** this commit (on `main`, parent `fc8cef0`)
- **Decided, not changed:** customers still can't cancel their own
  bookings (staff do); points stay 1 per paid hour.
- **Changed:**
  - **Hours per booking configurable:** `MAX_HOURS_PER_BOOKING` (default 3,
    1-24) replaces the constant; `/pricing` returns `max_hours_per_booking`,
    the customer slot picker and its hint use it (`mockData.maxHoursPerBooking`;
    browser-only mode reads the same name from the root `.env`).
  - **Walk-in transfers expire after 30 minutes** like online bookings
    (`ExpireUnpaidBookings` no longer skips bookings made by staff; the
    unpaid cap still counts only the customer's own). The counter's waiting
    box says so and tells staff when it was cancelled; browser-only
    `expireUnpaidLocal` matches.
  - **Cash taken out at close:** `shifts.banked_cash` (0..counted);
    `LastCount` = counted - banked, so a nightly bank run needs no opening
    note. Close form field "นำเงินออก / ฝากธนาคาร", sent as `banked_cash`,
    shown in the shift history; same in browser-only mode; the opening line
    now reads "money left in the drawer from the last shift".
  - **Vouchers valid 365 days:** `VOUCHER_VALID_DAYS` (default 365, 1-3650).
  - Docs: both `.env.example`, `golang-backend/README.md`, TODO note; Thai
    text for the banked-cash limit.
- **Verified:** `go vet`, `go test ./...`, DB tests incl. new
  `owner_rules_db_test.go` (4 hours refused by default and allowed with
  MAX_HOURS_PER_BOOKING=4; walk-in transfer EXPIRED after the hold and the
  court freed; banked more than counted refused, next float = counted -
  banked opens without a note; voucher valid 365 days), `tsc`, vitest 66/66.
  Live with MAX_HOURS_PER_BOOKING=4: `/pricing` says 4, customer page hint
  "สูงสุด 4 ชั่วโมง", a 5th pick refused with "4 ชั่วโมง"; manager closed a
  shift (expected 4,383.05) with 1,000 banked -> next opening expects
  3,383.05.
- **Note:** a walk-in whose transfer arrives after 30 minutes is now
  approved as a late payment (re-books the hour if still free and not over;
  otherwise refund) - as online bookings already were.

---

## 2026-10-23 — Full code recheck, part 3 (staff, admin and customer screens)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com ("recheck every codes. no bug")
- **Commit(s):** this commit (on `main`, parent `59749a6`)
- **Changed** (each finding confirmed in the code first):
  - **Staff screen (API mode):** PromptPay walk-in wait box no longer
    vanishes after switching the date away and back (compares the loaded
    date); the booking pool prefers the open tab's (fresh) copy of a row (a
    stale "unpaid" copy hid the refund when cancelling); loads only what the
    role may read (one 403 used to blank the screen for custom roles; a role
    without "shifts" is no longer told to open a shift - the server
    decides); blind count follows the server rule (no view_reports) also
    with no shift open, and its "doesn't match" answer now asks for the note;
    the cancel dialog's refund box starts unticked for a slip nobody approved
    (ticked = "bank checked"); the count box resets when the shift changes;
    the cart is frozen while a checkout is on its way (and its retry key kept).
  - **Staff screen (browser-only mode, same rules as the server):** void
    takes back only points the sale earned (none today) and can't run twice;
    cancel / no-show cancel unused rewards bought with the points (shared
    `planPointsCover`/`applyPointsCover`, also used by void); dispense refuses
    cancelled / free-hour vouchers; rental and checkout use stored stock and
    the current price; blind staff aren't shown the difference.
  - **Admin screens:** user search results are no longer filtered again in
    the browser (hid "081-234-5678" matches); closure hours snap to offered
    options (a 09:00-10:00 closure was saved as 07:00-22:00 with 09-21
    opening hours); Excel import skips unreadable cells with the reason
    instead of defaults (blank stock 50, unknown category F&B, ...); the
    dashboard grid shows unpriced hours as closed; tier counts customers
    only and say when partial; role pickers / suspend only where the server
    allows (`permissions.outranks`); tier not offered for staff accounts;
    audit search finds ids; browser-only occupancy counts active courts and
    the report groups payments by code + customer + date.
  - **Customer screen:** free-hour hint by reward kind (any free-hour reward
    an admin adds); nav bar updates after a silent session expiry;
    browser-only mode now expires unpaid online bookings after 30 minutes
    and enforces the 3-unpaid cap (`expireUnpaidLocal`, `unpaidGroupsLocal`).
  - `SECURITY_REVIEW.md`: section for the recheck (role escalation etc.).
- **Verified:** `go vet`, `go test ./...`, DB tests, `tsc`, vitest 65/65
  (new: demo expiry/cap test), `vite build`. Playwright (API mode): custom
  "cashier" role (sell_rent + shifts) sees 8 products, no 403, no errors;
  customer on the payment step signs out from the nav bar -> booking code
  and QR gone, login form back; opening hours 09-21 -> closure dropdowns
  show and hold 09:00 / 21:00; open-shift flow and counter walk-in + sale
  still work.
- **Not done / follow-ups:** none from the recheck. The browser-only
  changes were checked by type check and unit test, not all clicked
  through.

---

## 2026-10-23 — Full code recheck, part 2 (booking core)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com ("recheck every codes. no bug")
- **Commit(s):** this commit (on `main`, parent `c605993`)
- **Changed** (each confirmed in the code first; DB tests fail without the fix where noted):
  - **Partial refund of an approved payment** (`booking_admin.go`
    RefundPayment): refunding part of a VERIFIED payment whose hours were
    all cancelled marked it REFUNDED, so the rest then needed a bank check
    (wrong for cash) and it read as fully refunded. The close-as-refunded
    step now only applies to slips nobody approved. Test
    `TestPartialRefundKeepsApprovedPayment` (failed before: REFUNDED after
    100 of 440).
  - **Audit "before" was the after-state** (VerifyPayment, RejectPayment,
    MarkPaidInCash): GORM writes new values into the struct; old status /
    method are captured first. Test `TestAuditBeforeStateIsTheOldState`.
  - **Undo no-show onto a closed court** (`UndoNoShow`): takes the date's
    closure lock (order: customer, closure, court group, row, as
    CreateBookings) and refuses while the court is closed at that hour.
    Test `TestUndoNoShowRespectsClosures`.
  - **Deadlock slip re-upload vs approve/cancel/cash** (`SaveSlip`): now
    locks payment then customer like the staff actions. New race test
    `TestConcurrencySlipReuploadVersusApprove` counts Postgres deadlocks:
    26 in 60 rounds (28 s) before, 0 (1 s) after.
  - **Third "half" of a full court** (`court_admin_service.go`): at most
    two halves, counted under the full court's row lock. Test
    `TestFullCourtHasTwoHalvesAtMost`.
  - **500s for expected cases** (`repository/booking.go`, `booking_api.go`):
    court regrouped mid-booking -> 409 "busy, try again"; unknown court ->
    400; a late payment on a court closed since -> "slot gone, refund
    instead" (was "slot already booked").
  - **Walk-in customer name/phone** length-checked (200/30 characters).
  - Thai texts for the new messages; tests in `recheck_db_test.go` (new).
- **Verified:** `go vet`, `go test ./...`, `go test -race` with all DB
  tests (incl. 13 race tests), `tsc`, vitest 64/64.
- **Not done / follow-ups:** part 3 = staff, admin and customer screen
  findings.

---

## 2026-10-23 — Full code recheck, part 1 (backend + customer screen fixes)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com ("recheck every codes. no bug")
- **Commit(s):** this commit (on `main`, parent `0991185`)
- **How:** six reviewers read the whole code in parallel (Go booking core,
  Go shop/money, Go auth/handlers/startup, frontend API+customer, staff
  screen, admin+mockData); every finding is checked by hand before fixing.
  Also `go test -race` (unit + DB race tests) and staticcheck. This commit
  has the fixes done so far; the staff/admin screen and booking-core
  findings follow in part 2.
- **Changed:**
  - **Role editing could escalate** (`role_service.go`, `role_api.go`): a
    role can only hold permissions its editor has, and nobody edits a role
    holding permissions they lack (e.g. ADMIN). Before, "manage roles"
    alone could give itself every permission. Unit test + live: 403 for
    own-role escalation, stripping ADMIN and a stronger new role; equal role
    still 201. Thai texts added.
  - **Slow uploads/reports cut at 60 s** (`main.go` requestDeadline): the
    slip route (2 min) and reports (90 s) now set their own connection
    deadlines. Live: a 70 s slip upload failed at 61 s before, 200 after.
  - **Background jobs vs shutdown** (`main.go` runJob): jobs take the app
    context (cancelled on SIGTERM, skipped after it); the wait for them has
    its own 10 s limit. Live: SIGTERM -> "Stopped cleanly".
  - **Admin user search** (`user_service.go` phoneLike): phone matching only
    when the search looks like a phone ("somchai1" no longer matches every
    phone containing 1). Unit test.
  - **Text limits in characters, not bytes** (Thai = 3 bytes): user name,
    product name, order customer name, deposit note, court name, shop
    name/address/phone (shop phone 50 as in the form).
  - **Phone typed without its 0** ("812345678" -> "0812345678": 9 digits
    starting 6/8/9) in Go, its SQL twin and `mockData.normalizePhone`;
    Go, TS and DB tests.
  - **Rental return body** (`shop_api.go`): read also without
    Content-Length (chunked), so a kept deposit isn't lost.
  - **Expired vouchers** (`reward_service.go`, `pos.go`): Dispense refuses
    without a pointless write; covering points no longer cancels an expired
    voucher (which gave its points back).
  - **Checkout**: quantity cap per product across lines (not per line),
    line notes length-checked, linked court must exist.
  - **Shift**: opening float cap 10,000,000 (same as the count).
  - **AdjustStock**: product total checked in the size branch; a size for a
    product without sizes refused.
  - **Customer screen**: cleared whenever the signed-in account changes
    (nav sign-out, another tab) - the next person saw the QR/booking; a
    late slip waiting for review no longer shows the QR again (invited a
    second transfer).
  - **Thai errors**: a used/cancelled free-hour voucher and a court closed
    mid-booking got the wrong text (rule order); tests.
  - Removed unused `currentRole` (staticcheck).
- **Verified:** `go vet`, `go test ./...`, `go test -race` incl. all DB race
  tests, `tsc`, vitest 63/63; live checks as listed.
- **Not changed, on purpose:** blind count staff can still add up today's
  cash from the order/booking lists they need for work (a limit of the
  blind count, not fixable without hiding sales from the counter); a
  checkout retry returns the order as it is now even if voided later
  (normal idempotent replay).

---

## 2026-10-23 — Cleanup: unused packages, larger small text

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com (group 3, "sure")
- **Commit(s):** this commit (on `main`, parent `c0568b6`)
- **Changed:**
  - `package.json` / `package-lock.json`: removed `@google/genai`,
    `express`, `@types/express`, `dotenv`, `motion`, `tsx`, `autoprefixer`
    (nothing imports them: searched src, scripts, configs; Tailwind 4 needs
    no autoprefixer). `esbuild` kept (Vite uses it). The lock was updated
    with `npm uninstall --package-lock-only`; the `xlsx` entry (0.20.3 from
    cdn.sheetjs.com) is unchanged. `clean` script no longer mentions
    `server.js`.
  - `.env.example`: removed the AI Studio `GEMINI_API_KEY` and `APP_URL`
    blocks (read by nothing). `metadata.json` left alone (the template
    platform's file).
  - Text sizes: `text-[7px]`/`[8px]` -> `[10px]`, `[9px]`/`[9.5px]` ->
    `[11px]` in 76 places (walk-in grid, day total, slips, shop, rentals,
    admin dashboard/users/discounts/products/pricing/audit, App).
  - `TODO.md` updated.
- **Verified:** `npm ls --package-lock-only` consistent; a fresh install of
  the new list (150 packages instead of 199) -> `tsc --noEmit` ok, vitest
  61/61, `vite build` ok (customer page 122.7 KB gzip, as before). Dev web
  server restarted on it: Playwright counter flow (cash walk-in + sale) ok,
  no page errors; `node dev-runner.js` (browser-only mode) serves the page.
  Text sizes: screenshots before/after at 1024 px and 390 px (walk-in grid,
  day total, slips, admin dashboard) - same number of clipped elements (1
  each, already there before), no page-wide sideways scroll, grid cells
  still fit.
- **Not done / follow-ups:** this sandbox's proxy blocks cdn.sheetjs.com,
  so a full `npm ci` with the real `xlsx` tarball couldn't run here (the
  checks used `xlsx` 0.18.5 from npm in a local folder, not committed). The
  Docker web build on a normal server downloads it as before.

---

## 2026-10-23 — More race tests; schema setup under one lock

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com ("what do we do next" -> group 3, "sure")
- **Commit(s):** this commit (on `main`, parent `65471d8`)
- **Changed:**
  - `concurrency_test.go`: 3 more races (12 in all). Closure vs booking
    (refused as closed, or got in first and listed in the closure's
    affected bookings; odd rounds close court B full while its left half is
    booked). Rental return vs void (stock back once, deposit settled once,
    drawer deposits add up to 0). Cash payment vs shift close (in the
    closed shift's frozen cash total, or refused "no open shift"; odd rounds
    on an expired booking with a closure created on that date at the same
    moment - the lock order TODO section 11 had left open). Extra random
    pauses on the faster side so both orders happen.
  - `main.go`: `setupSchema` takes a session advisory lock (4205) on one
    connection (`Connection` + `Session{NewDB: true}`) for the whole setup;
    the body is `setupSchemaLocked`. Found by test first: two servers
    started together on an empty database -> one failed in AutoMigrate
    ("duplicate key ... pg_type_typname_nsp_index") and exited, 3 of 3
    tries. `perf_indexes.go` comment: lock keys taken.
  - `TODO.md`: two items ticked.
- **Verified:** `go vet ./...`, `go test ./...`; with `TEST_DATABASE_URL`
  all DB tests pass at 40 and 50 rounds; outcome mix checked in the test
  database (closure: 30 booked first / 10 refused; cash: recorded and
  refused, both with and without expiry; rental: 10 settled by return /
  30 by void). Two servers on a new empty database: 5 of 5 tries both
  `/readyz` 200, no errors in either log, default rows complete (25 courts,
  20 prices, 4 discounts, 4 roles). Dev database restart: ready, no errors.
- **Not done / follow-ups:** small cleanup (unused packages, 7-9 px text)
  is next.

---

## 2026-10-22 — Money columns numeric(12,2)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com ("do 1", item 4)
- **Commit(s):** this commit (on `main`, parent `b119af2`)
- **Found first:** the amount columns were not `double precision` but
  GORM's default for `float64`, `numeric` without a scale - already exact
  in the database, just with any number of decimals. (Checked on the dev
  databases arena_fresh, arena_db, arena_review.)
- **Changed:**
  - `golang-backend/money_columns.go` (new): `moneyColumns` (20 columns in
    8 tables) and `convertMoneyColumns`, run first in `setupSchema`: for each
    table, columns not yet numeric(12,2) (unscaled numeric or double
    precision) get one `ALTER TABLE ... ALTER COLUMN ... TYPE numeric(12,2)
    USING round(...::numeric, 2)` (one rewrite per table), under the
    migration advisory lock; values below a satang are counted in the log
    first; a failure stops the start with the table named.
  - `internal/model/models.go`: `type:numeric(12,2)` on those 20 fields, so
    a new database is created that way and AutoMigrate finds what it
    expects. Percentages and court shares stay as they were. Go types are
    unchanged (`float64` + `RoundBaht`); reads come back exact at 2 decimals.
- **Verified:** `go vet ./...`, `go test ./...`; with `TEST_DATABASE_URL`
  (fresh schema, created as numeric(12,2)) all DB/race tests pass. On a copy
  of arena_fresh: 8 tables converted, sums of every money column identical
  before/after; a second start rewrote nothing (same relfilenodes) and a
  third, with DDL logging on, issued no column ALTER. Then arena_fresh
  itself: API sale of 3 x 12.35 -> order 37.05, unit price 12.35 (numeric),
  shift expected cash +37.05 exactly; Playwright counter: cash walk-in 280
  (payment 280.00 VERIFIED) and a product sale saved; no page errors.
- **Not done / follow-ups:** Go still does money arithmetic in `float64`
  (rounded to the satang at each step). `shopspring/decimal` would make that
  exact too but changes every amount in the services and the JSON (strings
  by default) - left for an owner decision. The `+ 0.005` tolerance in the
  two CHECK constraints is now unnecessary but harmless.

---

## 2026-10-22 — Small security items: closure override, opening float, demo refund check

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com ("do 1", item 3)
- **Commit(s):** this commit (on `main`, parent `e7b662c`)
- **Changed:**
  - **Booking through a closure needs `manage_closures`:**
    `CreateWalkInBooking` answers 403 "booking during a closure needs the
    manage_closures permission" for `override_closure` without it (built-in
    STAFF lacks it, MANAGER/ADMIN have it). Counter screen
    (`walkinActions.tsx`): without the permission it explains instead of
    offering "จองกรณีพิเศษ" (both modes).
  - **Opening float vs last count:** `shifts.opening_note` (new column);
    `ShiftService.Open(float, note, ...)` refuses (400) a float other than
    the cash counted at the last close unless a note is given; stored on the
    shift and in `SHIFT_OPENED` (with `last_count`). `LastCount`;
    `GET /staff/shift` returns `last_count` while no shift is open. Screen
    (`DayTotalTab.tsx`, `shiftActions.tsx`, `api.shiftState`): shows the last
    count with "ใช้ยอดนี้", a note box when the float differs, the same rule
    in browser-only mode; the managers' shift history shows the opening
    note.
  - **Browser-only demo refund:** the refund button asks "ตรวจในบัญชีธนาคาร
    แล้วว่าเงินโอนเข้ามาจริง?" for a slip nobody approved in both modes
    (`slipActions.tsx`; before, only API mode asked). Cancel-with-refund
    already matched (the ticked box is the bank check in both modes).
  - Thai texts for the two new server messages (`errorText.ts`, test).
  - `shifts_db_test.go` (new, needs `TEST_DATABASE_URL`); race test passes
    a note (each round reopens at 500 after counting 570).
  - Docs: `golang-backend/README.md` (walk-in override, shift open),
    `SECURITY_REVIEW.md` (two Lows marked fixed, #2 note), `TODO.md`.
- **Verified:** `go vet ./...`, `go test ./...`, with `TEST_DATABASE_URL`
  all DB tests pass; `tsc --noEmit`, vitest 61/61. Live API: admin closed
  bad-7 for a day; staff walk-in with override -> 403 with the new message,
  staff without override -> 409 "closed", manager with override -> 201.
  Playwright (API mode, staff account): last count line shown (3,786),
  float 3,686 -> note box appears, "เปิดกะ" without note -> dialog
  "เงินทอนตั้งต้นไม่ตรง…", shift stays closed; "ใช้ยอดนี้" fills 3786 and hides
  the note box; float 3,686 + note -> shift opened, server stored the note
  (`GET /admin/shifts`). No page errors.
- **Not done / follow-ups:** the browser-only refund dialog was checked by
  the type checker only, not clicked through in a browser. Next in group 1:
  money columns as numeric.

---

## 2026-10-22 — Phone numbers stored in one form, indexed lookups

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com ("do 1", item 2)
- **Commit(s):** this commit (on `main`, parent `f78d02f`)
- **Changed:**
  - `internal/repository/user.go`: `NormalizeStoredPhones` rewrites phones
    stored before sign-up normalized them to canonical form (one UPDATE;
    per number the account already canonical, else the oldest, gets it;
    the others keep their format and are returned). `phoneMatch`: plain
    `phone = ?` once no old-format phone is left, otherwise also the old
    regex, so leftover accounts are still found (the default until startup
    has checked, e.g. for `make-admin`). `FindByIdentity` is two indexed
    queries (email, phone) merged oldest first; `GetByPhone` uses
    `phoneMatch`. `DuplicatePhones` removed.
  - `main.go`: `warnDuplicatePhones` -> `normalizePhones` (in
    `setupSchema`, every start): logs how many were fixed and the ids (not
    the numbers) of accounts to merge by hand.
  - `phones_db_test.go` (new, needs `TEST_DATABASE_URL`): formats, two
    kinds of duplicates, lookups while duplicates are left, and the next run
    after a manual merge.
  - `TODO.md` updated.
- **Verified:** `go vet ./...`, `go test ./...`; with `TEST_DATABASE_URL`
  the new test and the 9 race tests pass. EXPLAIN with 50,000 users: phone
  lookup is an index scan, 0.03 ms (old regex: seq scan, 31 ms); email uses
  `idx_users_email_lower`. Live on the dev database: registered an account,
  changed its phone in SQL to "+66 81-770-2859", restarted -> log "Phone
  numbers: 1 stored in canonical form", stored `0817702859`, login with
  `0817702859` -> 200.
- **Not done / follow-ups:** accounts left with a duplicate number are not
  merged automatically (bookings, points and passwords differ - a person
  decides). The member search (`phone LIKE`) already used the prefix index.

---

## 2026-10-22 — Concurrency tests on a real PostgreSQL

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com ("do 1": group 1 of the next steps, item 1)
- **Commit(s):** this commit (on `main`, parent `797bf2e`)
- **Changed:**
  - `golang-backend/main.go`: the schema setup (AutoMigrate list, data
    migrations, indexes, constraints, default rows) moved unchanged into
    `setupSchema(setupDB)`, so the tests build the database exactly as the
    server does. Nothing else in startup changed.
  - `golang-backend/concurrency_test.go` (new): 9 race tests, skipped
    unless `TEST_DATABASE_URL` is set; refuses a database whose name doesn't
    end in `_test` (it drops the schema). Each race repeats
    `CONCURRENCY_ROUNDS` times (default 15) on fresh slots/users, with a
    random 0-2 ms start delay so both orders of arrival happen:
    6 customers on one hour (1 wins); overlapping 2-hour blocks (1 wins);
    full court vs both halves (full alone or both halves); approve vs
    cancel with refund (refunded in full, or rejected + refund check
    pending; never a standing hour or leftover points); slip vs hold expiry
    (on time and held, or late and released); 5x redeem (1 voucher, 40 of
    100 points left); 7 buyers for 3 items (3 sold, stock 0); cancel vs
    spending the booking's points (0 points, no active voucher); void vs
    shift close (cash counted at close = what the shift's sales add up to
    afterwards). After each: points = sum of ledger, none negative.
  - Docs: `golang-backend/README.md` (how to run), `TODO.md` (items ticked).
- **Verified:** `go vet ./...`, `go test ./...` (race tests skip without the
  variable). With `TEST_DATABASE_URL` on a local Postgres 16: 5 runs x 50
  rounds, all pass (the last 2 with the random delay: approve-vs-cancel
  ended 79 refunded / 21 cancelled-first, slip-vs-expiry 73 on time / 27
  late, so both orders were tested). Check that the tests catch a bug: with
  the user row lock removed from `Redeem`, the redeem test fails (restored
  after). No bug found in the app code.
- **Not done / follow-ups:** not covered: closures vs bookings, rental
  return vs void, MarkPaidInCash vs shift close (TODO section 11 lock-order
  note). Next in group 1: phone numbers stored in one form, then the small
  security items, then money as numeric.

---

## 2026-10-22 — Fix regressions from the security fixes

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com ("find if we created any bug when we fixed the security part" -> "yes" to fixing them)
- **Commit(s):** this commit (on `main`, parent `5f6ee7e`)
- **Changed:** a review of 5f6ee7e found four problems (all else in it
  works - see Verified); fixed:
  - **Refund dead end:** `payments.refund_check_pending` set by
    `CancelBookings` when a refund was asked for a slip nobody approved
    (cleared by any refund, `applyRefund`); `ListRefundChecks` +
    `GET /staff/payments?status=REFUND_CHECK`; `DismissRefundCheck` +
    `POST /admin/payments/:id/no-refund` (reason required, audit
    `REFUND_NOT_NEEDED`). Staff screen: the slip tab loads and lists them
    for managers (`#refund-checks`, "ไม่มีเงินเข้า (ไม่ต้องคืน)" / "เงินเข้าจริง
    — คืนเงิน"); the cancel/closure messages point there.
    `paymentReviews` shared by both lists.
  - **Slip type by content:** `slipImageExt` replaces `checkSlipImage` +
    the name check; `allowedSlipExt` removed; test updated (pdf case
    added).
  - **Thai texts** for the 13 new server messages (`errorText.ts`, test).
  - **CORS docs** for the cross-origin dev setup (README, `.env.example`).
  - `SECURITY_REVIEW.md` gets a "Follow-up: regressions" table;
    golang-backend/README the new endpoints.
- **Verified:** `go vet`, `go test ./...`, `tsc`, `vitest` 61/61.
  - Review of 5f6ee7e live (before these fixes): role limits with a
    custom staff-manager role, refund rules, blind count, self-approval,
    5-slip cap, release-mode refusals, make-admin --yes, backup
    permissions; hardened Docker stack (read-only backend, fixed Caddy
    IP, CSP): 4.4 MB slip upload, QR, charts, slip images, Excel - no CSP
    violations, no page errors.
  - After: JPEG named .png -> stored .jpg; PNG named .jpg -> .png; JPEG
    without extension -> .jpg; HTML/PDF refused. Refund checks: two
    cancellations listed, "no money" closes one (again -> refused, empty
    reason -> refused, audit row), refund with bank check closes the
    other (REFUNDED 153); a partial cancellation is listed while its slip
    stays in the queue. Playwright: manager closes a card in the slip tab
    (Thai notice, card gone); a customer's non-image slip shows the Thai
    message; the :3001 cross-origin setup works with CORS_ALLOWED_ORIGINS.
- **Not done / follow-ups:** the browser-only demo mode still records
  refunds of unapproved slips without a bank check (the rules should match
  in both modes - owner decision to keep that mode).

---

## 2026-10-22 — Security review and fixes

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XDLgFVCg4iMYeu1EqarqcQ, requested by the owner
- **Commit(s):** this commit
- **Changed:** see `SECURITY_REVIEW.md` for every finding. Fixed:
  - Roles: `SetRole`/`SetActive` refuse a role or target account holding
    permissions the caller lacks (book_online excepted) - "manage staff"
    could make anyone ADMIN.
  - Money: refunds of a payment that was never approved need
    `bank_checked` (cancel without it records no refund and returns
    `refund_needs_check`; UI asks the manager); staff can't approve their
    own booking's slip; blind closers don't see the variance figure.
  - Slips: content must match the extension, JPEG/PNG ≤ 40 MP; ≤ 5 slips
    per payment (`payments.slip_uploads`), ≤ 20 per customer per day (new
    index `idx_audit_logs_user_created`).
  - Server: release mode refuses a missing/example `PROMPTPAY_ID`,
    `SEED_DEMO_USERS=true` and a JWT secret under 32 chars; request logs
    without query strings; no CORS headers unless `CORS_ALLOWED_ORIGINS` is
    set; `make-admin <phone>` shows the account and needs `--yes`; bind
    errors no longer echo Go internals; notes/reasons ≤ 500 characters.
  - Deployment (`deploy/`, DEPLOY.md): CSP/HSTS/Permissions-Policy, body
    limit in Caddy; Caddy at a fixed IP and the only trusted proxy; log
    rotation, no-new-privileges, memory/pid limits, read-only backend;
    private backups (umask 077) outside the checkout, encrypted off-server
    copy, `.env` files in a password manager; monthly image updates; SSH
    hardening. `.env.example` has `PROMPTPAY_ID=` empty. `bun.lock` removed.
- **Verified:** `go vet`, `go test ./...` (new `slip_image_test.go`,
  `role_guard_test.go`), `tsc`, vitest 60, `vite build`. End-to-end against
  a real server + Postgres: 16/16 checks (escalation refused, HR can still
  promote a customer, own-slip approval refused, unapproved refund needs the
  bank check, HTML-as-JPG refused, 6th slip refused, blind close hides the
  figure, generic bad-body message, no CORS header, long notes refused);
  release-mode refusals and a valid release start; make-admin flow; logs
  without query strings. Caddyfile validated with Caddy 2.10.2, compose with
  `docker compose config`. Not run: the containers themselves (no Docker
  daemon here) - check on first deploy that Caddy/Postgres start with
  no-new-privileges and the read-only backend accepts slips.
- **Not done / follow-ups:** the "Not fixed" table in SECURITY_REVIEW.md
  (slip reuse with re-saved copies, junk-slip holds, phone verification,
  lockout policy, session revocation, cancel after the hour started,
  opening float, override_closure) - listed in TODO "start here".

## 2026-10-22 — Paused: security assessment started, next steps written down

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com ("pause for now and write down what to do next")
- **Commit(s):** this commit (on `main`, parent `5487bf5`)
- **Changed:** TODO.md gets a "Next session: start here" block at the top:
  the security assessment (scope per area - sign-in/permissions, input and
  files, money logic, deployment - and the expected output), the open owner
  decisions, going live with DEPLOY.md, the go-live code items, then LINE /
  SMS / VAT. The browser-only demo mode decision is repeated there.
- **Verified:** docs only. The three security review passes were stopped
  before they reported - **no security findings exist yet**; nothing was
  changed in code.
- **State for the next session:** `main` builds and tests pass (last code
  change 5487bf5, deployment files). Local test setup in the cloud box
  (Postgres on 5433, backend on 8080, Vite on 3001, Docker daemon with
  mirror.gcr.io) is not part of the repo.

---

## 2026-10-22 — Deployment files (Docker + Caddy) and DEPLOY.md

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com (TODO 8b)
- **Commit(s):** this commit (on `main`, parent `e9ee714`)
- **Changed:**
  - `deploy/docker-compose.yml` (project `arena`): `db` postgres:16-alpine
    (volume `pgdata`, pg_isready health check, 60 s stop grace),
    `backend` (built from `golang-backend/`, env from `golang-backend/.env`
    plus DATABASE_URL / GIN_MODE=release / SEED_DEMO_USERS=false /
    TRUSTED_PROXIES set by compose, volume `uploads`, `/readyz` health
    check, 35 s stop grace), `web` (Caddy on 80/443, volumes for
    certificates). Fixed subnet 172.28.0.0/24 for the trusted proxy.
    Settings in `deploy/.env` (`SITE_ADDRESS`, `POSTGRES_PASSWORD`) - kept
    apart from the root `.env` that Vite reads; example in
    `deploy/.env.example`.
  - `golang-backend/Dockerfile` (+ `.dockerignore`: no .env/uploads in
    images): golang:1.25-alpine build of the whole package, static binary
    on alpine:3.22, non-root user, `/app/uploads` volume.
  - `deploy/web.Dockerfile` (+ root `.dockerignore`): node:22-alpine
    `VITE_DATA_SOURCE=api npm run build`, served by caddy:2-alpine.
  - `deploy/Caddyfile`: `/api/*`, `/healthz`, `/readyz` -> backend; the
    app with an index.html fallback; zstd/gzip; built assets cached for a
    year, the page no-cache; nosniff / DENY framing / referrer policy;
    no Server header. `SITE_ADDRESS` = domain (automatic HTTPS) or `:80`.
  - `deploy/backup.sh`: pg_dump (custom format) + tar of the slip images
    into `deploy/backups/`, 30 days kept (`backups/` git-ignored).
  - `arena-backend make-admin <phone>` (main.go): gives a registered
    account the admin role, audit-logged - the first admin of a new
    installation (no demo accounts in production).
  - `DEPLOY.md`: server, Docker install, settings, start, first admin,
    backups + cron + restore, updates, day-to-day commands, uptime check,
    the laptop tunnel demo. README links it; TODO 8a/8b updated.
  - `vite.config.ts`: `allowedHosts: ['.trycloudflare.com']` (TODO 8a).
- **Verified:** in the cloud session with Docker 29 (Docker Hub rate limit
  -> mirror.gcr.io as the test machine's registry mirror; the build ran in
  a scratch copy with two sandbox-only patches - the sandbox proxy's CA
  for `go mod download`/`npm ci`, and xlsx 0.18.5 from npm because
  cdn.sheetjs.com is blocked here; the committed files are unpatched):
  - both images build; `docker compose up` on an empty database: tables,
    migrations, 16 indexes (pg_trgm OK), backend healthy, web up.
  - through Caddy: page (no-cache, gzip, security headers, no Server
    header), hashed asset (immutable, zstd), unknown path -> index.html,
    `/readyz` `/healthz`, API.
  - register owner -> `make-admin` -> admin dashboard; demo account
    rejected; customer booking + slip upload, signed slip image served
    through Caddy, file in the uploads volume.
  - backend sees the client address from Caddy, a forged
    X-Forwarded-For is ignored.
  - `docker compose stop backend`: "Stopped cleanly."; `down` + `up`:
    admin and slip still there.
  - `backup.sh` -> dump + tgz; restore as documented (pg_restore --clean,
    tar over the uploads folder): an account created after the backup is
    gone, owner login works.
  - Playwright on http://localhost: customer sign-in on a phone-sized
    screen (no demo buttons), staff slip queue shows the slip image; no
    page errors.
- **Not done / follow-ups:** a real server and domain (owner), HTTPS was
  not exercised here (needs a public domain); copying backups off the
  server is described, not automated; a restore step that deleted the
  uploads folder first was dropped from DEPLOY.md (extract over it).

---

## 2026-10-22 — Decision recorded: keep the browser-only demo mode

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, decision by traning.mbt@gmail.com ("keep it for now")
- **Commit(s):** this commit (on `main`, parent `c2b1669`)
- **Changed:** TODO 11 (structure): the owner keeps `npm run dev` (data in
  the browser) for now. Consequence: rules stay in both Go and
  TypeScript, and changes must be made and tested in both modes. Step 5
  of the code-quality plan (rules only on the server) is on hold until
  the Docker demo (8b) can replace this mode.
- **Verified:** docs only.

---

## 2026-10-22 — Frontend: load only what the open screen shows

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com (step 4 of the code-quality plan)
- **Commit(s):** this commit (on `main`, parent `93b95ad`)
- **Changed:**
  - `staff/useStaffPOS.tsx`: the main load (every 15 s and after every
    action) fetched 8 data sets on every tab; now the slip queue and the
    current shift always, plus the open tab's: products (shop, rentals),
    rentals out (rentals), day summary / today's orders / today's bookings
    / shift history for managers (day total). The grid load fetches the
    date's bookings and closures only on the walk-in tab; session check,
    courts and pricing (prices, receipt header) always. Opening a tab
    loads its data (`activePosTab` in the deps).
  - `customer/useCustomerPanel.tsx`: on the payment step (polled every
    10 s) only `/auth/me` + `/me/bookings`; leaving it reloads everything.
- **Verified:** `tsc`, `vitest` 60/60. Playwright (API backend), requests
  per 15 s refresh as a manager: walk-in 7, slips 5, shop 6, rentals 7,
  vouchers 5, day total 9 (all 13 before). Customer: step 1 = 8 per 30 s
  (unchanged), payment step 2 per 10 s (8 before); a manager marking the
  booking paid in cash -> the customer's screen showed the paid notice by
  itself. Staff tabs all render; walk-in cash booking and shop sale saved;
  undo no-show OK; no page errors.

---

## 2026-10-22 — Frontend: load the staff/admin code only when needed

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com (step 4 of the code-quality plan)
- **Commit(s):** this commit (on `main`, parent `5aa11e4`)
- **Changed:**
  - `App.tsx`: `StaffPOS` and `AdminPanel` via `React.lazy` + `Suspense`
    ("กำลังโหลด...").
  - `AdminPanel.tsx`: the dashboard tab (recharts) is lazy too.
  - `admin/productActions.tsx`: `await import('xlsx')` in the template and
    Excel-import handlers (template shows an error if it can't load).
  - Production build (API mode), gzip: one 448 KB file for everyone ->
    customer page 122 KB; StaffPOS 31 KB, AdminPanel 31 KB, dashboard
    charts 125 KB, xlsx 143 KB loaded on demand. No >500 KB warning.
- **Verified:** `tsc`, `vitest` 60/60, both builds. Playwright on the
  production build (`vite preview`, API proxy): customer page requests
  only `index`; staff sign-in loads `StaffPOS` (6 tabs shown); admin loads
  `AdminPanel` + `DashboardTab` (chart legend shown); Excel template
  download loads `xlsx` and saves product_upload_template.xlsx; no page
  errors.
- **Notes:** the cloud test box has xlsx 0.18.5 locally (CDN blocked), so
  the xlsx chunk size is approximate; the repo still uses 0.20.3.

---

## 2026-10-22 — Backend speed-ups, part 2: checkout, sign-in check, booking, shifts

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com (step 3 of the code-quality plan)
- **Commit(s):** this commit (on `main`, parent `5eaaf39`)
- **Changed:**
  - `POSService.checkoutTx`: the cart in a fixed number of statements -
    lock all its products (id order), then all their sizes (id order; a
    size always after its product, as in returns/voids), check the lines
    in cart order in memory (quantities of the same product/size on
    several lines add up), one stock `UPDATE ... FROM (VALUES ...)` per
    table (`takeStock`), one batch insert of the lines. Was 4-7 round
    trips per line while holding the locks. Error texts unchanged.
  - Authentication: `RoleService.SessionUser` reads the user and the
    role's permissions in one LEFT JOIN (built-in fallback for a role with
    no row, as before); `Authenticate(auth, roles)` no longer takes the
    user service. Not cached on purpose.
  - `CreateBooking` loads the pricing config once and passes it to
    `checkBookingWindow`, `planSlots` and `NewSlotQuoter` (was 3 loads).
  - `ShiftService.view`: a closed shift with all its figures frozen at
    close returns without recounting.
  - Two misplaced doc comments in pos.go put back on their functions.
- **Verified:** `go vet`, `go test ./...` (middleware test updated for the
  new signature).
  - Checkout, live: same product on two lines (stock -5), two lines
    exceeding stock (refused, "only 4 in stock", nothing changed), two
    shoe sizes, size sold out, missing size, size of another product,
    unknown product, rental in a sale, deposit by PromptPay (refused),
    deposit rental in cash (deposit 400) - all as before. 8 parallel
    checkouts for 5 items: 5 OK, 3 out of stock, stock 0.
  - Sign-in check: old and new binaries side by side - `/auth/me`
    identical for admin, manager, staff, customer, a custom role, a role
    with no row, a suspended account, a bad token; four permission-gated
    endpoints give the same 200/403 for 4 role cases.
  - Booking: window (40 days -> refused), 05:00 refused, student half
    court 212.5, walk-in 40 days ahead allowed.
  - `/admin/shifts`: identical JSON old vs new (10 shifts, 9 closed).
- **Not done / follow-ups:** audit rows store full snapshots and are never
  pruned (needs a retention decision); frontend refetching (step 4).

---

## 2026-10-22 — Backend speed-ups, part 1: dashboard, user list, audit log

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com (step 3 of the code-quality plan)
- **Commit(s):** this commit (on `main`, parent `d763a02`)
- **Changed:**
  - `ReportService.Dashboard`: ~33 sequential queries (18 in a 6-month
    loop) -> 6: settings + all-time totals in one select of subqueries;
    bookings day/pending/all-time with FILTER; paid bookings by month and
    sport; counter-sale lines by kind and Bangkok month with the day's
    share; day occupancy; hourly occupancy. `physicalCourts` removed.
  - `GET /admin/users`: paged (`limit` 200 default, max 1000, `offset`),
    `search` (part of name/email/phone, LIKE-escaped), `has_more`.
    Repository `FetchAll` -> `FetchPage`. Admin users tab: the list is
    loaded by its own effect and searched on the server 300 ms after
    typing stops; a note shows when more accounts exist than are listed.
  - `GET /admin/audit-logs`: `has_more` instead of `total` (no COUNT of
    every matching row per page); keyset paging with `before_id` (offset
    still works); order `created_at DESC, id DESC`.
  - `POSService.views`: order lines, product names and staff names
    fetched in IN-batches of 1,000 (one IN list over a month's orders
    could pass Postgres' 65,535-parameter limit).
  - `api.ts`: `request(..., { withMeta })` returns the whole body;
    `listUsers({ search, limit })` -> `{ users, hasMore }`.
  - README (API examples), TODO 11 updated.
- **Verified:** `go vet`, `go test ./...`, `tsc`, `vitest` 60/60.
  - Dashboard: old and new binaries side by side on the same database,
    JSON identical for 11 dates (2025-12-31 ... 2026-12-15), after adding
    temporary rows across months, sports and statuses and two orders at
    the Bangkok month boundary (23:30 / 00:30); rows removed afterwards.
    Local timing 10 ms -> 7 ms (the gain is the 27 fewer round trips to a
    remote database).
  - API: users default/limit 3 (has_more true)/phone/Thai name/email+role
    searches, `50%` escaped; audit page 2 by `before_id` equals offset 3;
    bad cursor -> 400; month report loads with order lines.
  - Playwright: users tab lists 8, search "นักเรียน" -> 1 (one request),
    cleared -> 8; no page errors.
- **Not done / follow-ups:** checkout round trips, caches, `GET
  /admin/shifts` per-shift queries (next commits); the audit screen still
  loads the newest 500 and filters in the browser.

---

## 2026-10-22 — Panel hooks split by area

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com ("split them by area first")
- **Commit(s):** this commit (on `main`, parent `213abb3`)
- **Changed:** code moved, not rewritten. Each `use<Panel>.tsx` (staff
  1,909 lines, admin 1,723, customer 1,217) now has:
  - `use<Panel>Core`: state, refs, effects, data loading and small shared
    helpers (546 / 427 / 399 lines with the composition below);
  - one hook per area, each in its own file, receiving what it uses from
    the core and from earlier areas through one typed `deps` parameter:
    - staff/: sessionActions, shiftActions, slipActions, bookingActions,
      voucherActions, walkinActions, shopActions, rentalActions, dayReport
    - admin/: sessionActions, dashboardData, pricingActions, courtActions,
      userActions, productActions, reportActions
    - customer/: accountActions, slotPicker, bookingFlow, rewardActions
  - `use<Panel>` calls the core, then the areas in dependency order, and
    returns them merged - same shape as before, so the tabs and the
    context are unchanged.
  - Module-level helpers of the staff/admin/customer hook files moved to
    `<dir>/shared.tsx` (re-exported), so area files don't import the hook
    file (no import cycles).
  - Done with a one-off TypeScript-AST script that also checks the core
    never uses an area's names and that areas have no dependency cycles.
    It refused one assignment (admin `emptyBusiness`/`businessFrom` feed
    the core's state) - those stayed in the core.
  - TODO and the REQUIREMENTS.md file map updated.
- **Verified:** `npm run lint` 0 errors, `vitest` 60/60, `vite build` both
  modes. Playwright (API backend), no page errors: all staff and admin
  tabs open; customer login -> pick -> confirm -> QR -> slip
  (SLIP_UPLOADED); slip replaced -> warning -> approve (CONFIRMED/VERIFIED);
  undo no-show (point back); walk-in cash booking ("สำเร็จแล้ว! ยอด 200
  บาท", booking in DB); shop checkout (order in DB).
- **Not done / follow-ups:** rentals and shift close were not clicked
  through (moved verbatim, type-checked).

---

## 2026-10-22 — Split the three big panels by tab

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com (step 2 of the code-quality plan)
- **Commit(s):** this commit (on `main`, parent `70868b9`)
- **Changed:** code moved, not rewritten. For each of StaffPOS (3,269
  lines), AdminPanel (3,478) and CustomerPanel (2,269):
  - `components/<area>/use<Panel>.tsx`: the component body (state,
    effects, handlers) unchanged, returning everything as one object, plus
    `<Panel>Context` / `use<Panel>Context()` (typed from the hook's return
    type, throws outside the panel). Module-level helpers and types of the
    old file live here too, exported.
  - One component per tab/section reading the context:
    staff/ WalkinTab, SlipsTab, ShopTab, RentalsTab, VouchersTab,
    DayTotalTab; admin/ DashboardTab, PricingTab, CourtsTab, ProductsTab,
    UsersTab, MemberDiscountsTab, ReportsTab, AuditLogTab (RolesTab was
    already separate); customer/ AccountBox, PickSlotsStep, ConfirmStep,
    PaymentStep, MyBookingsBox, LineSimulator.
  - The panel files keep the login screen, header, tab bar, shared dialogs
    and the provider: 414 / 140 / 131 lines.
  - Done with a one-off script using the TypeScript compiler API (names
    each file needs taken from the AST, unused imports removed by the
    language service); strict mode then verified it. One manual fix:
    `PaymentStep` lost the `currentBooking` narrowing of its old
    `activeStep === 3 && currentBooking &&` wrapper -> `if (!currentBooking)
    return null`.
  - REQUIREMENTS.md file map and TODO updated.
- **Verified:** `npm run lint` 0 errors, `vitest` 60/60, `vite build` in
  both modes. Playwright against the API backend, no page errors:
  every staff tab and all 9 admin tabs open; typing in the walk-in form
  keeps the text; customer login -> pick an hour -> confirm -> QR + payee
  -> slip upload (DB: SLIP_UPLOADED); staff slip queue: slip replaced ->
  warning + approve blocked -> acknowledge -> approve (DB: CONFIRMED /
  VERIFIED); undo no-show from the booking dialog (points back).
  - A console 404 seen on the staff page also happens on the code before
    the split (not from this change).
- **Not done / follow-ups:** the hooks are still 1.2-1.9k lines; splitting
  them by area is the next step (TODO 11, structure).

---

## 2026-10-22 — TypeScript strict mode on

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com (step 1 of the code-quality plan)
- **Commit(s):** this commit (on `main`, parent `4c1c3c5`)
- **Changed:**
  - devDependencies `@types/react` 19.2.18 and `@types/react-dom` 19.2.7
    (pinned). Without them every component was untyped (JSX, hooks, events
    all `any`), which is where TODO's "~3,500 strict errors" came from.
  - `tsconfig.json`: `strict`, `noUnusedLocals`, `noFallthroughCasesInSwitch`.
    `npm run lint` (tsc) is clean.
  - Real errors fixed:
    - `AddAuditLog` type in `types.ts`, shared by App and the four screens
      (they declared a looser, different signature); audit target types
      gain `Role` and `Voucher`, which screens already logged.
    - Chart `<Legend fontSize>` is not a prop -> `wrapperStyle`.
    - `MemberPhoneInput` local mode: missing member tier -> NORMAL.
    - The explicit `any`s in AdminPanel (Excel import rows, error, audit
      diff, discount field) and StaffPOS (LINE messages) typed.
    - Unused `React` imports and an unused `canEditPricing`.
- **Verified:** `tsc` 0 errors, `vitest` 60/60, `vite build` (API mode)
  OK; Playwright smoke on customer, staff (member search dropdown) and
  admin (dashboard chart legend) screens: no page errors.
- **Notes:** the cloud test box can't reach cdn.sheetjs.com, so its local
  `node_modules` has xlsx 0.18.5 for type checking; the repo still pins
  0.20.3 (unchanged). `noImplicitReturns` left off (15 style-only hits).

---

## 2026-10-22 — Undo a no-show

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com (owner: "staff can undo no show")
- **Commit(s):** this commit (on `main`, parent `1b1428c`)
- **Changed:**
  - `BookingService.UndoNoShow` (`booking_admin.go`) +
    `POST /staff/bookings/:id/undo-no-show` (counter permission, as
    marking): NO_SHOW -> CONFIRMED (the minute job completes it again if
    the hour is over). Locks customer, court group, then the booking (the
    order of a new booking); refused with 409 "the hour was already sold to
    another customer" when a booking holds that court or a conflicting one
    at that hour. Gives back what the no-show mark(s) took and earlier
    undos haven't returned (ledger rows on the booking with note
    "No-show..."), as EARN_BOOKING "No-show undone ...". Rewards cancelled
    to cover the points stay cancelled. Audit `BOOKING_NO_SHOW_UNDONE`.
  - StaffPOS: "↩️ ลูกค้ามาแล้ว (ยกเลิก "ไม่มา")" (`#undo-no-show-button`) in
    the booking detail of a no-show; browser-only mode does the same
    (local no-show ledger rows now carry the booking id). `api.undoNoShow`.
    Thai texts for the two new server errors (`errorText.ts`, tests).
  - Docs: README, golang-backend/README, TODO 12 (ticked), features.html,
    TESTING_CHECKLIST 4b.1f.
- **Verified:** `go vet`, `go test ./...`, `tsc`, `vitest` 60/60.
  - Live API: paid booking (points 1 -> 2), no-show (-> 1), undo
    (CONFIRMED, points_restored 1, -> 2), second undo refused, no-show
    again (-> 1), a live booking put on that hour -> undo 409, points stay 1.
  - Playwright (API mode): today's no-show in the day list -> ออกใบเสร็จ
    -> undo -> "ยกเลิก "ไม่มา" แล้ว ... คืนแต้ม 1 แต้ม", row shows
    ยืนยันแล้ว, ledger has the undo row; no page errors.
- **Not done / follow-ups:** no time limit on undo (it is audited); a
  no-show undone after the court was closed for a day off isn't checked
  against the closure.

---

## 2026-10-21 — Review fixes for the graceful lifecycle and the resale fixes

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `f13923a`)
- **Changed:** 8 confirmed findings of a review of ebca032..f13923a.
  1. `dev-runner.js`: stops the Go backend with SIGINT. On SIGTERM `go run`
     died at once, leaving the real server orphaned with a broken log pipe
     (its next log line killed it, mid-request) - so the graceful shutdown
     never happened under `npm run dev:api`.
  2. `connectDB`: `DisableAutomaticPing` - GORM's own ping had no time
     limit, so a database host that accepts and never answers hung startup
     forever and ignored Ctrl+C. Only the bounded `PingContext` remains.
  3. A failed listener (port taken) exits with status 1 ("Stopped after an
     error."), so restart policies apply; it exited 0 before.
  4. After the first signal, signals act normally again: a second Ctrl+C /
     SIGTERM ends the process at once. `srv.Close()` after the drain time
     runs out, so the limit holds.
  5. Occupancy: a no-show is left out when any later paid booking uses the
     same or a conflicting court that hour (was: only the one named by
     `resale_of` - both halves no-shows + full court resold counted 1.5).
     Server `notResoldNoShow` and AdminPanel `occupiedShare`.
  6. `api.ts`: GET requests time out after 20 s ("เซิร์ฟเวอร์ตอบช้าเกินไป").
     The refresh skips a tick while a load runs, so one request stuck on a
     dead connection froze the screen with no error. Writes have no
     timeout (their outcome matters; retries reuse the idempotency key).
  7. `mockData.ts` `listPrice`: resale list price without the NORMAL tier
     discount, as the server's `ListPrice` (the preview disagreed if an
     admin gave NORMAL a discount).
  8. `refreshMe`: the newer-session check runs before the 401 return.
  - Also: `/readyz` comment corrected; staff logout clears the load-error
    banners.
- **Verified:** `go vet`, `go test ./...`, `tsc`, `vitest` 60/60.
  - Silent DB host (accepts, never answers): Ctrl+C stops the wait at
    once; with `DB_CONNECT_TIMEOUT_SECONDS=8` it exits 1 after 2 attempts.
  - Port taken: "ERROR: ... address already in use", exit status 1.
  - `node dev-runner.js --api`, Ctrl+C during a booking held 3 s by a row
    lock: the booking returned 201, backend logged "Stopped cleanly.",
    no process left running.
  - Second SIGTERM during the drain: the process ended at once.
  - Occupancy live: both halves no-show then the full court sold -> 1
    court-hour (0.3% of 19 courts x 16 h), not 1.5.
- **Not done / follow-ups (suspected, not fixed):** a second instance
  starting while the first builds an index CONCURRENTLY waits in
  `ensureIndexes` (setup connection has no lock_timeout) - only matters
  with several instances; `/readyz` has no drain delay before the listener
  closes (fine for one instance); `seenSlip` pins the version when the
  queue loads, not when the card is first looked at (an extra click at
  worst).

---

## 2026-10-21 — Review fixes: live refresh, no-show resale, index builds

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `ebca032`)
- **Changed:** the 12 confirmed findings of a review of a33e71d..396d334.
  1. Slip approval: each card remembers the slip version (upload time) it
     first showed; approve/reject send that one, not the version the 15 s
     refresh brought in. A replaced slip shows `#slip-changed-notice` and
     blocks both buttons until staff click "ตรวจสลิปใหม่แล้ว"
     (`StaffPOS.tsx` `seenSlip`).
  2. `api.refreshMe` no longer writes the old session back if the user
     signed out or someone else signed in while `/auth/me` was in flight.
  3. New `useLiveLoad` (`src/useLiveTick.ts`): a refresh tick never drops
     the load in progress and is skipped while one runs (before, a load
     slower than the interval was cancelled on every tick: frozen data, no
     error banner, piled-up requests). Used by the staff main/grid loads
     and the customer grid load. The grid has its own error state, so the
     banner no longer flickers. Storage events wake only a visible tab, at
     most every 3 s; pricing rules and member discounts load in a fixed
     order, so two tabs can't keep waking each other.
  4. and 6. Resale price (`booking_service.go` `noShowFreedShare`,
     `SlotQuoter.ListPrice`; `mockData.ts` `noShowFreedShare`/
     `resalePrice`): the freed share of the court at percent x the normal
     non-member price **with the half-court rate** (half 250 -> 125, was
     250 = no discount, and 500 at 100%); a full court over one no-show
     half: that half discounted, the other at the normal price (375); never
     above the customer's normal price. Percent range now 1-100 (0 made
     free QR bookings). **Departs from the earlier "percent replaces the
     half-court rate" note - flagged for the owner in TODO 12.**
  5. Browser-only PromptPay walk-in on a resale hour: QR and pending box
     use the booked amount (were the full price); `resaleOf` is stored.
     Local no-show re-reads the booking and refuses a second mark (it took
     the point back twice).
  7. Occupancy (dashboard and hourly chart, server and browser) counts a
     re-sold no-show once (`notResoldNoShow` in `report_service.go`).
  8. Admin day grid ignores no-shows.  9. Day-off "affected bookings"
     leaves out no-shows.  10. Payment screen hides slip upload once
     REJECTED.
  11. `buildPerfIndexes`: one connection, `statement_timeout`/`lock_timeout`
     0 even if DATABASE_URL sets them, and `pg_try_advisory_lock(4204)` so
     a second instance skips instead of dropping the first one's
     half-built index.
  12. The new double-booking index is created before the old one is
     dropped (old kept if the create fails); `IsLiveSlotConflict` knows
     both names.
- **Verified:** `go vet`, `go test ./...` (new `TestNoShowFreedShare`),
  `tsc`, `vitest` 60/60 (resale tests rewritten).
  - Live API: half normal 250; full court over a no-show half 375
    (`resale_of` set); same half after its no-show 125; the other half
    250 with no resale. Dashboard loads.
  - Live startup: old index recreated by hand -> dropped on start; a
    dropped perf index rebuilt; with lock 4204 held elsewhere -> "another
    instance is building them - skipped here", built on the next start.
  - Playwright (API mode): staff slip queue open, customer re-uploads ->
    after the refresh the notice shows and approve is disabled; after
    acknowledging, approve works; no page errors.
- **Not done / follow-ups:** `planSlots` reads no-shows outside its
  transaction (a booking at the very moment of a no-show mark pays full
  price - harmless). The receipt modal's booking isn't refreshed by the
  live tick (the server refuses stale actions). No undo for a no-show
  (owner decision, TODO 12). The audit search now matches across fields
  (e.g. "admin create") - left as is.

---

## 2026-10-21 — Graceful start-up and shutdown

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `0877cee`)
- **Changed:**
  - `golang-backend/main.go`: the server waits for the database before
    doing anything else (`connectDB`: retry with backoff 1 s → 10 s, up to
    `DB_CONNECT_TIMEOUT_SECONDS`=60, then exits with the last error;
    Ctrl+C while waiting stops it). It listens only after the schema and
    index setup is done.
  - New `GET /healthz` (process up) and `GET /readyz` (503 until set up,
    then pings the database).
  - SIGINT/SIGTERM: stop accepting connections, let requests in progress
    finish (`srv.Shutdown`, up to `SHUTDOWN_TIMEOUT_SECONDS`=30), wait for
    the background jobs (minute job loop, performance-index builds) to
    stop, close the database pool, log "Stopped cleanly.".
  - `perf_indexes.go`: takes the shutdown context; an index build cut off
    by shutdown is rebuilt on the next start (existing logic).
  - `dev-runner.js`: in API mode Vite starts only after `/readyz` answers
    (up to 3 min for the first `go run` compile); force-kill after 35 s
    instead of 5 s so the backend's graceful shutdown can finish.
  - Docs: `.env.example`, `docs/features.html` settings table, TODO 8b
    (healthcheck + `stop_grace_period` for the future docker-compose).
- **Verified:** `go vet`, `go build`.
  - DB down at start: "Waiting for the database (attempt 1..3)", the port
    stayed closed; after Postgres started → "Database is ready.", then
    listening, `/readyz` = ready.
  - SIGTERM during a booking held by a 3 s row lock: new connections
    refused, the in-flight booking returned 200, the process exited after
    2.2 s with "Stopped cleanly.".
  - `node dev-runner.js --api`: "Backend is ready." printed before Vite
    started; Ctrl+C → backend "Stopped cleanly.", both processes exited,
    ports free.
- **Not done / follow-ups:** the bug review of a33e71d..396d334 (live
  refresh, no-show, perf indexes) came back with 12 findings - fixed in the
  next entry.

---

## 2026-10-21 — Known bugs fixed (locks, expiry job, DB backstops, demo users)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `396d334`)
- **Changed:** the open correctness items of TODO section 11.
  - `SaveSlip` locks the customer row before the payment (a slip moves an
    EXPIRED payment back into the unpaid cap; it raced new bookings).
  - Expiry job: a PENDING payment whose bookings are gone is closed as
    EXPIRED instead of being re-picked every minute (500 of them blocked
    all newer expiries).
  - `LockCourtGroupTx` reads the court's mutex group inside the
    transaction, locks in id order and re-checks the group on the locked
    row (retries if an admin regrouped courts meanwhile).
  - `MarkPaidInCash` on an expired group takes the date's closure lock
    before the drawer lock (CreateBookings' order).
  - `ensureConstraints` (main.go, at startup, NOT VALID then VALIDATE):
    users.points ≥ 0, products/product_variants.stock ≥ 0, payments
    refund within the amount, orders deposit returned+kept within the
    deposit; unique index `idx_shifts_one_open`. CHECK violation → 409
    with a Thai message.
  - Demo accounts with passwords are folded out of API builds
    (`initializeState`).
- **Verified:** go vet + go test, tsc, vitest 57/57. Live: all 5 checks
  validated on existing data; SQL negative stock and a second open shift
  refused. Basketball halves 09:00 OK, full court refused; job expired a
  backdated booking; late slip on it OK; cash on an expired group
  (re-reserve path) VERIFIED. API build has no demo email/password.
  Caught by these tests: my first SaveSlip change used an ambiguous
  `Select("id")` with a join and broke every slip upload - fixed
  (`bookings.id`) and both normal and late slips re-tested.
- **Not done / follow-ups:** money as numeric; an independent review of
  the live-refresh / no-show / index commits is running.

---

## 2026-10-21 — No-show frees the court; resale at 50% after a 15-minute grace

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `8b7542a`)
- **Changed:** TODO section 12 (decided by the owner earlier today).
  - Settings `NO_SHOW_GRACE_MINUTES` (15) and `NO_SHOW_RESALE_PRICE_PERCENT`
    (50), also in `GET /pricing` as `no_show_grace_minutes` /
    `no_show_resale_percent` for the screens. (`booking_service.go`,
    `pricing_admin_service.go`, `.env.example`)
  - MarkNoShow allowed only from start + grace (Thai message added).
  - A NO_SHOW no longer holds the court: `CheckOverlapTx`, the gantt
    query, and the double-booking index - now `idx_bookings_held_slot`
    `WHERE status NOT IN ('CANCELLED','NO_SHOW')` (the old
    `idx_bookings_live_slot` is dropped at startup).
  - Resale: `planSlots` finds a NO_SHOW on a conflicting court at that
    hour and prices the slot at the rule's hourly price x percent
    (`SlotQuoter.BasePrice`, no member/half-court rate); the booking stores
    `resale_of` = the no-show's id. Online bookings can't take a started
    hour, so resale is at the counter.
  - Frontend: `findConflictingBooking` ignores NO_SHOW; new `findNoShow`,
    `resalePrice`, `noShowRules`, `noShowOpenAt` (mockData). Staff grid
    shows the freed hour "🟢 ว่าง · ลูกค้าไม่มา · ราคาพิเศษ" with the resale
    price; the no-show button is disabled until the grace time (shows
    when) and its confirmation says no refund + the resale price; the day
    list labels a no-show "ไม่มา · สนามว่างแล้ว". Browser-only walk-ins use
    the resale price too. Unit tests for both.
  - Docs: TODO section 12 ticked + order of work tidied (tablet, no-show,
    small improvements done), feature guide, checklist 4b.1e.
- **Verified:** go vet + go test, tsc, vitest (no-show/resale tests added).
  Live (22:19 Bangkok, 22:00 hour): with grace 60 the no-show is refused;
  with 15 it's accepted; walk-in on another court 200; resale walk-in by a
  discounted member 100 with `resale_of` set; a second walk-in for the
  same hour refused; online booking refused (already started); new index
  present, old one gone. Playwright: no-show button → confirm (no refund,
  100 baht) → cell turns "🟢 ว่าง 100฿ ลูกค้าไม่มา · ราคาพิเศษ", selecting
  it shows 100฿; no page errors. The disabled-before-grace button state
  was not clicked through (needs a booking under 15 min old).

---

## 2026-10-21 — Live refresh (staff every 15 s, customer 30 s / 10 s on payment)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `a33e71d`)
- **Changed:** nothing updated until someone clicked (new slips, another
  counter's walk-ins, a customer's payment approved/expired).
  - New `src/useLiveTick.ts`: a counter bumped every N ms while the page
    is visible, at once on returning to it (visibilitychange/focus, unless
    it just ran) and on a storage event (browser-only mode, another tab).
    Hidden tabs don't poll.
  - StaffPOS: the existing data effects also depend on the tick (15 s);
    header shows "อัปเดตอัตโนมัติ hh:mm:ss" after each successful load.
  - CustomerPanel: same, 30 s (10 s on the payment step). The payment
    screen now follows the reloaded payment (it kept the copy from when the
    booking was made) and shows ✅ approved / ✖️ rejected or refunded
    (with the reason) and hides the slip upload once settled.
  - Admin panel doesn't poll (settings/reports).
  - Docs: TODO live refresh ticked, feature guide limitation replaced,
    checklist 4b.1d.
- **Verified:** tsc, vitest 54/54. Playwright with two browsers and no
  clicks: customer slip uploaded from outside → staff queue 0 → 1 after
  13 s; staff approved from outside → customer payment screen shows
  "ชำระเงินเรียบร้อย" after 3 s, upload box hidden; no page errors.
- **Not done / follow-ups:** each staff tick re-runs ~12 requests (the
  existing loads); fine for one venue, per-resource loading is in TODO
  section 11 (performance).

---

## 2026-10-21 — Performance indexes (empty or existing database)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XDLgFVCg4iMYeu1EqarqcQ, requested by the owner
- **Commit(s):** this commit
- **Changed:**
  - `golang-backend/perf_indexes.go` (new): the 16 indexes from TODO section 11
    (each matched against its real query). Built with `CREATE INDEX
    CONCURRENTLY IF NOT EXISTS` in a goroutine after startup, on its own
    connection without the request time limits (`openSetupDB`), so a big
    existing database keeps taking bookings while they build and the server
    starts at once. An INVALID index (build cut off by a crash/redeploy) is
    dropped and rebuilt. `pg_trgm` is created if allowed (a trusted
    extension: the database owner can, e.g. on Render); otherwise the two
    search indexes are skipped with a warning. Failures only log.
  - Audit-log search now matches one expression (`auditSearchExpr`: user,
    action, target id and reason joined) so a trigram index can serve it;
    `perf_indexes_test.go` checks the query and the index use the same text.
- **Verified:** `go vet`, `go test ./...` pass. Real Postgres 16 as a
  non-superuser owner: empty database → 16 built in 35 ms, all valid;
  restart → nothing rebuilt; ~950k rows (50k users, 300k bookings /
  payments / audit rows) with the indexes dropped and one marked invalid →
  API answered after ~0.7 s while all 16 built in 10 s, the invalid one was
  rebuilt; EXPLAIN shows each index used (my bookings, slip queue, expiry and
  finished jobs, member phone+name search incl. Thai, audit search); audit and
  member search results through the API are correct.
- **Not done / follow-ups:** with several servers starting at once they'd
  race on the same build (harmless: one fails with a warning) - covered by
  the "startup migrations unlocked" item in TODO section 11.

## 2026-10-21 — Points only from court bookings

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `65fcdd8`)
- **Changed:** owner decision: points come only from paid court hours (1
  per hour); counter sales - F&B, equipment and rentals - earn none (they
  earned 1 per 100 THB). The member-phone box stays (links the sale to
  the member's name), relabelled "👤 เบอร์โทรสมาชิก (เว้นได้ — ผูกบิลกับ
  สมาชิก ไม่ได้แต้ม)".
  - Server: `ProcessCheckout` no longer writes EARN_PURCHASE entries;
    `points_earned` stays in the response (0, or the old points on a
    replay of an older sale). VoidOrder still takes back purchase points of
    older sales (it reads the ledger). (`pos.go`)
  - Browser-only mode: `StorageService.addPoints` removed; sale/rental
    messages no longer mention points. (`StaffPOS.tsx`, `mockData.ts`)
  - Docs: REQUIREMENTS FR-4.1 / AC-6, TESTING_CHECKLIST 4b.2, feature guide
    (points rule, sale/void/rental lines; sale + rental screenshots
    retaken with the new label).
- **Verified:** go vet + go test, tsc, vitest 54/54. Live: 150-baht sale
  with a member's phone → order in the member's name, points_earned 0,
  balance unchanged; 2-hour booking paid → +2. Feature guide: 9/9 images,
  no sideways scroll at phone width.

---

## 2026-10-21 — Feature guide brought up to date

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `7ce4967`)
- **Changed (docs only, `docs/features.html`):** points rule corrected
  (bookings 1 point per paid hour, counter 1 per 100 baht - it said 1 per
  100 baht for both); added: 30-min hold only for customers' own bookings,
  max 3 unpaid, slip file rules/auto-shrink, points/rewards taken back on
  cancel/no-show, walk-in transfer waits for staff (never auto-cancelled),
  grid loading state, rental without a name + cash fee/deposit, day ledger
  refund split, a cash-drawer card (open, expected = float + cash bookings
  + cash sales/rentals + deposits held, refunds = transfers, blind close),
  a "network dropped" card (retry is safe, what the busy/in-progress
  messages mean), manager cancel reward rule, deposit setting row, new
  server variables (DB_MAX_OPEN_CONNS, DB_LOCK_TIMEOUT_MS,
  DB_STATEMENT_TIMEOUT_MS, TRUSTED_PROXIES), two rules cards, a "current
  limitations" section, phone/tablet note. Screenshots retaken (9, adds
  rental form and shift box), still embedded (~1 MB).
- **Verified:** opened at phone width: 9/9 images load, no sideways
  scroll, no page errors.

---

## 2026-10-21 — Fixes from the independent bug review of today's changes

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `780141d`)
- **Changed:** an independent reviewer went over commits 0139a14..a9026ac;
  its panic/startup/report-timeout/closed-shift findings were already fixed
  in dfbd781. The rest:
  - Retry keys (client, `api.ts`): kept at most 2 min (an identical sale
    later is a new sale, not a replay of an old one); cleared when another
    user signs in/out (not on a session refresh of the same user); dropped
    on 422. Cart and rental form carry an id (`api.newActionId`, refs in
    StaffPOS, reset when the cart/form contents change or on success) sent
    as the body `idempotency_key`, so checkout's own in-transaction replay
    works again and a new cart never matches an old body.
  - Retry keys (server, `handler/idempotency.go`): scope = user id +
    endpoint (was the raw token, so a retry after re-login got 422);
    anonymous requests (sign-in/up) are never stored (they held JWTs);
    a claim still in progress after 3 min is taken over (crash/restart);
    a key released between claim and lookup is claimed again (was 404/500);
    stored responses kept 1 h (was 24 h).
  - Unpaid-booking cap counts only bookings the customer made - a pending
    walk-in staff made for a member no longer blocks their online booking.
    (`booking_service.go` countUnpaidGroups)
  - No-show audit records rewards cancelled / points short.
  - Slip upload request deadline 2 min (slow phone uploads).
  - StaffPOS: rental "collect cash" and return/deposit messages use the
    server's recorded amounts; browser-only void gives the deposit back;
    walk-in grid no longer stays "loading" when the pricing-cache refresh
    fails. AdminPanel browser-only Excel import re-reads products after the
    preview. slipImage keeps accepted files up to ~5 MB byte for byte (the
    duplicate-slip hash sees the real file).
  - Not a bug: "pool starvation from pricing inside a transaction" -
    planSlots/NewSlotQuoter run before the transaction.
  - TODO: kept deposits missing from income reports / day ledger.
- **Verified:** go vet + go test, tsc, vitest 54/54. curl: login with a key
  stores nothing; same key from a second token of the same staff → replay;
  another user → 422; 5-min-old in-progress claim → taken over and sold;
  fresh in-progress claim → 409; pending member walk-in counted by the cap
  query: 0 (was 1). Playwright: lost-response sale → retry sends the same
  key and shows the same receipt (twice); two identical sales in a row →
  two receipts; deposit return with 30 kept → "คืนมัดจำ 170 … ด้ามแตก".
- **Not done / follow-ups:** TODO section 11.

---

## 2026-10-21 — "Open shift" banner scrolls to the shift box

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `dfbd781`)
- **Changed:** user reported "กดเพื่อเปิดกะ ไม่ได้". Opening a shift works
  (staff, manager, API and browser-only mode all tested), but on a short
  window (e.g. VS Code's built-in browser) the banner only switched tab and
  the shift box opened below the fold, so nothing seemed to happen. The
  banner and the "ไปเปิดกะ" dialog button now scroll the shift box into
  view and focus the float field (`goOpenShift`, `StaffPOS.tsx`).
- **Verified:** tsc; Playwright at 1000×560: banner → float focused, box
  in view → open → "เปิดกะโดย…"; same flow OK at 1280×900 for staff and
  manager (API) and in browser-only mode.
- **Not done / follow-ups:** if the user still can't open a shift, need the
  exact message/screenshot.

---

## 2026-10-21 — Fixes to today's review fixes (self-review)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `a9026ac`)
- **Changed:**
  - Idempotency: a panic inside a request released no key, so every
    retry got "still being processed" for 24 h - the key is now released
    before the panic is re-raised to gin's recovery. (`handler/idempotency.go`)
  - Startup schema work (AutoMigrate, index builds, data migrations,
    seeds) ran under the new statement/lock timeouts and could fail to
    start on a big database - it now runs on a separate connection
    without them, closed afterwards. (`main.go`)
  - `statement_timeout` default 15 s → 90 s (backstop only): it cut
    reports off before their 90 s request deadline; each request's own
    context deadline (30 s / 90 s) cancels its queries first.
    (`main.go`, `.env.example`)
  - Closed shifts showed a live-recomputed deposit total next to the
    frozen expected cash - now frozen at close (`shifts.cash_deposits_at_close`).
    (`models.go`, `shift_service.go`)
- **Verified:** go vet + go test; server restarts cleanly on arena_fresh,
  setup connection closed (2 app connections left).
- **Not done / follow-ups:** an independent bug review of today's changes
  is running; its findings follow in the next commit.

---

## 2026-10-21 — Review batch B: retry protection, reward clawback on cancel

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `0a5e781`)
- **Changed:**
  - Retry protection for every write. Server: `handler.Idempotency`
    middleware on `/api/v1` (after auth and CORS, so replays carry CORS
    headers): an `Idempotency-Key` header claims a row in the new
    `idempotency_keys` table (scope = hash of Authorization + method +
    path); a repeat after success replays the stored status/body with
    `Idempotent-Replay: true`, a repeat while running gets 409, another
    session/endpoint gets 422, a non-2xx releases the key. Bookkeeping
    uses a context detached from the request (5 s). Keys pruned after 24 h
    by the job loop; CORS allows the header. Client (`api.ts` request()):
    every non-GET, non-/auth, non-form request sends a key, reused while
    the same endpoint + body is retried, dropped on success; checkout no
    longer sends a fresh body key per call. Thai texts for the new
    messages + test.
  - Rewards: `coverPointsWithRewards` (pos.go) shared by VoidOrder and
    `reversePoints` (booking cancel, no-show): unused rewards bought with
    the points are cancelled and their points returned before taking the
    booking's points back. A booking cancel still goes ahead when a reward
    was already handed over and reports `points_short`; void still
    refuses. CancelResult gains `cancelled_vouchers`, `points_short`
    (audited, shown in the staff message).
- **Verified:** go vet + go test, tsc, vitest 54/54. curl: same key twice
  → same order code + replay header, stock −1 once; same key from another
  session → 422; 3 parallel sends with one key → one order; failed
  request (bad qty) then same key → runs. Cancel-with-refund: reward not
  used → voucher CANCELLED, 3 points taken, balance back to 2; reward
  handed over → cancel OK, points_short 3, voucher stays REDEEMED.
  Playwright: server saved the sale but the response was dropped →
  "ขายไม่สำเร็จ" → confirm again → same receipt REC…EDC29E, same key on
  both requests, no page errors.
- **Not done / follow-ups:** batch C (live refresh). Browser-only mode
  has no reward clawback on cancel.

---

## 2026-10-21 — Review batch A: small bug fixes

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `1be7f0c`)
- **Changed:**
  1. Staff walk-in grid (API mode): `loadedDate` gate - while another
     date loads, "⏳ กำลังโหลด…", grid greyed/unclickable, submit refused
     (it showed every slot free; the review's "old date's bookings" claim
     was wrong - the grid filters by date). (`StaffPOS.tsx`)
  2. Slip upload: new `src/slipImage.ts` - non-images refused with a Thai
     message; anything not JPG/PNG/WebP or over 1.5 MB is drawn to a
     canvas and sent as ≤1600 px JPEG (HEIC phones too); small files go
     unchanged so the server's duplicate-slip hash still matches.
     (`CustomerPanel.tsx`)
  3+5. `ReturnRentalItem`: lock order → item (was item → order, the
     reverse of VoidOrder), decide the deposit settlement first, take the
     drawer lock before touching stock (checkout's order) and the time
     after it. `VoidOrder`: lock its items and restock in checkout's sorted
     key order (`itemLockKey`). (`pos.go`)
  4. `CancelBookings`: `res` and `refund` reset at the start of each
     RetryTx attempt (param renamed `wantRefund`); expiry job's
     `cancelled` flag too. (`booking_admin.go`, `booking_service.go`)
  6. CSV export: formula guard also catches leading spaces, tab and CR;
     numbers (e.g. -50) are no longer prefixed. (`AdminPanel.tsx`)
  7. `index.html`: `lang="th"`, title "จองสนามกีฬา | Sports Complex",
     meta description.
- **Verified:** go vet + go test, tsc. Live API: shift 1200 → rent 60 +
  200 deposit → 1460 → return keeping 20 → 1280 (status DELIVERED,
  returned 180); second return refused; void of a new rental → deposit
  back, item marked returned, drawer unchanged at 1280; cancel-with-refund
  of an unpaid booking → 1 cancelled, refund 0, REJECTED. Playwright:
  grid banner + aria-busy while a 2 s-delayed date loads, gone after;
  `prepareSlipImage` in the page: 24.8 MB PNG → 1.2 MB 1600×1280 JPEG,
  1 KB PNG unchanged, PDF refused; no page errors.
- **Not done / follow-ups:** batches B (retry keys, reward clawback on
  cancel) and C (live refresh) - TODO section 11.

---

## 2026-10-21 — Review fixes: DB limits/timeouts, walk-in expiry; review in TODO

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `d98053a`)
- **Changed:** after a performance/concurrency/frontend review (three
  reviewers + spot checks), the user chose to fix two P0s now and put the
  rest - indexes included, "since the data is fake" - in TODO.
  - Database: pool capped (`DB_MAX_OPEN_CONNS`, default 20, idle = max,
    30 min lifetime); `statement_timeout` 15 s, `lock_timeout` 5 s,
    `idle_in_transaction_session_timeout` 30 s added to the connection
    string unless it sets them (`DB_STATEMENT_TIMEOUT_MS`,
    `DB_LOCK_TIMEOUT_MS`); every request gets a context deadline (30 s,
    90 s for reports/dashboard/export); uploads over 1 MB spill to disk
    (`MaxMultipartMemory`). Lock timeout (55P03) → 409 "busy"; statement
    timeout / deadline → 503 "took too long". (`main.go`,
    `repository/user.go`, `handler/booking_api.go`, `.env.example`)
  - Walk-in paid by PromptPay was cancelled by the 30-minute unpaid-hold
    job (customer already playing, hour resold online, "mark cash" then
    skews the drawer). The job now only expires bookings the customer made
    (created_by = user_id). (`booking_service.go` ExpireUnpaidBookings)
  - TODO: new section 11 with every open finding (go-live: indexes, phone
    lookup, retry keys, live refresh, walk-in grid loading, bundle split;
    scaling to 2 servers; correctness; performance; structure). Order of
    work step 6 points at it.
- **Verified:** go vet + go test, gofmt. Live: a booking on a court row
  locked by another session fails after 5.0 s with 409 "busy" (no
  retries); walk-in + online PromptPay bookings both backdated 40 min →
  next job run: online EXPIRED, walk-in still PENDING, and staff verify
  of the walk-in → VERIFIED.
- **Not done / follow-ups:** TODO section 11.

---

## 2026-10-21 — Staff POS / Admin on a tablet

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `64aa6d5`)
- **Changed:** F&B sale screen: products and cart side by side from
  tablet width (md) instead of desktop (lg), cart sticky, products 2 per
  row until lg - in portrait the cart used to sit below all products.
  (`StaffPOS.tsx`)
- **Verified:** tsc. Playwright at 820×1180 and 1180×820 (touch): page
  width = viewport on staff (walk-in, POS) and every admin tab (pricing,
  courts, products, users, reports, roles, audit) - no sideways scroll;
  screenshots checked for walk-in, POS and pricing.
- **Not done / follow-ups:** a real-tablet try; small text links
  (แก้ไข/ลบ, ตั้งมัดจำ) could get bigger tap areas.

---

## 2026-10-21 — Rental deposit

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `5415f84`)
- **Changed:** owner decisions: a fixed deposit per rental item, cash, and
  any counter staff may keep part/all of it with a reason.
  - Model: `products.deposit`; `orders.deposit_amount / deposit_returned /
    deposit_kept / deposit_note / deposit_settled_at` (NOT NULL DEFAULT 0
    for the amounts so old rows read 0).
  - Checkout: rental deposit = Σ deposit × qty, stored on the order, not
    in total_amount (no points, not revenue); a rental with a deposit must
    be cash. Return of the last item settles it: `keep_deposit` + `note`
    (note required when keeping; ≤ deposit); giving cash back needs an open
    shift. Void gives the deposit back. Shift expected cash = float + cash
    bookings + cash orders + deposits taken − deposits given back
    (`cash_deposits`, hidden in blind count). (`models.go`, `pos.go`,
    `shift_service.go`, `shop_api.go`)
  - Admin: deposit field when creating a rental product, "ตั้งมัดจำ" button
    per rental product (`PUT /admin/products/:id` via new
    `api.updateProduct`), Excel column "มัดจำ". Staff: rental form shows fee
    + deposit = cash to collect; list shows the held deposit; return asks
    the amount kept and the reason; shift panel shows deposits held. Local
    mode does the same. (`AdminPanel.tsx`, `StaffPOS.tsx`, `api.ts`,
    `types.ts`); feature guide and checklist 4b.1b updated.
- **Verified:** go vet + go test, tsc, vitest 53/53. curl: deposit set to
  200; PromptPay rental refused; cash rental 60 + 200 → shift expected
  1000 → 1260; keep without note / keep 500 refused; keep 50 "เอ็นขาด" →
  returned 150, expected 1110; void of a new rental → deposit_returned
  200, expected back to 1110. Playwright (API mode): form shows "เก็บเงินสด
  รวม 260", list shows the deposit, return with 30 kept + reason → "คืน
  มัดจำ 170 บาท (หักไว้ 30 บาท: ด้ามแตก)"; no page errors.
- **Not done / follow-ups:** kept deposits are not shown as income in the
  monthly reports.

---

## 2026-10-21 — Excel product import: preview before saving

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `0139a14`)
- **Changed:** after reading the file, the admin sees the rows that will
  be added (name, type, price, stock; first 20) and the skipped ones, and
  must press "นำเข้า N รายการ" - cancel saves nothing. (`AdminPanel.tsx`)
- **Verified:** tsc. Playwright (API mode, admin, generated .xlsx with 2
  good rows + 1 bad): preview listed both and the skipped row, confirm
  saved 2; no page errors.
- **Not done / follow-ups:** none.

---

## 2026-10-21 — Day summary: refunds split by method

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `3cef87d`)
- **Changed:** `GET /staff/summary` gains refunded_cash, refunded_promptpay
  and refunded_not_received; `refunded` is now only refunds of payments
  that were approved (counted as received) = cash + promptpay. Refunds of
  slips never approved are reported apart. (`booking_admin.go` Summary,
  `shop_api.go`, `api.ts`). Staff day report shows "คืนเงินวันนี้: X
  (ของเงินสด A · ของเงินโอน B)" and the not-received line; local mode
  computes the same split. (`StaffPOS.tsx`)
- **Verified:** go vet, tsc. Live on arena_fresh: DB refunds today = 180
  approved transfer + 424 never-approved → API refunded 180,
  refunded_promptpay 180, refunded_not_received 424, refunded_cash 0.
- **Not done / follow-ups:** cash refunds still don't reduce the drawer's
  expected cash (owner decision, TODO section 0).

---

## 2026-10-21 — Feature guide: screenshots embedded

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `aafdad8`)
- **Changed (docs only):** screenshots showed as broken images when the
  page was opened outside the repo folder. They are now embedded as base64
  in `docs/features.html` (one ~800 KB self-contained file); `docs/img/`
  removed.
- **Verified:** no `img/` references left; 7 images embedded.

---

## 2026-10-21 — Feature guide: login, all settings, screenshots

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `3c13bd4`)
- **Changed (docs only):** `docs/features.html` gains a login section
  (addresses, register/login, making staff accounts, lockout, demo
  accounts), a settings section (every admin setting with its tab and
  default, and every server `.env` variable), and 7 screenshots in
  `docs/img/` (customer phone views, staff login/walk-in/POS, admin
  settings/roles), taken with Playwright from the API-mode demo data.
- **Verified:** screenshots spot-checked; page opened locally.
- **Not done / follow-ups:** retake screenshots when the UI changes.

---

## 2026-10-21 — Visual feature guide (docs/features.html)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `74fcdfa`)
- **Changed (docs only):** one self-contained Thai HTML page for first-time
  users: features by role (customer, counter staff, manager, admin), the
  customer booking flow, rules the system enforces, a who-can-do-what
  table and what's coming. Open the file in a browser. Update it when
  features change.
- **Verified:** n/a (docs).

---

## 2026-10-21 — Member search with +66; Excel read as ArrayBuffer

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `5ec9bed`)
- **Changed:**
  - Member dropdown: a partial number typed with the country code
    ("+66 845", "0066 81") now matches (`user_service.go` partialPhone +
    test; same rule in `MemberPhoneInput.tsx` local mode).
  - Admin Excel import reads files with `readAsArrayBuffer` / XLSX
    `type: 'array'` instead of the deprecated `readAsBinaryString`.
    (`AdminPanel.tsx`)
- **Verified:** go vet + go test (new `partial_phone_test.go`), tsc,
  vitest 53/53; live `GET /staff/members?q=+66 845` → 0845678901. Excel
  import not re-clicked in a browser.
- **Not done / follow-ups:** Excel import preview (TODO section 7).

---

## 2026-10-21 — Automatic retry of deadlocks / serialization failures

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `8a4c5bf`)
- **Changed:** new `repository.RetryTx(db, fn)` runs a transaction up to 3
  times when Postgres aborts it with 40P01/40001 (25-250 ms jittered pause,
  stops if the request is cancelled). All 35 `db.Transaction` calls in
  services/repositories now use it. Closures that fill outer results reset
  them per attempt (`pos.go` bulk product import `out`, `booking_service.go`
  CreateBooking `result`); a scan found no other outer appends/counters.
  The client only sees "busy" if all 3 attempts collide.
- **Verified:** go vet + go test. Live: 4 simultaneous 2-court bookings of
  the same slot by different customers → one 201, three 409 "already
  booked", 2 rows, no server errors.
- **Not done / follow-ups:** automated concurrency tests on real Postgres
  (TODO section 7).

---

## 2026-10-21 — Frontend tidy-up (no behaviour change)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `fdcefb1`)
- **Changed:** TODO section 7 tidy-ups.
  - Dropped `export` from 18 symbols used only inside their own file:
    api.ts (API_BASE_URL, SessionKind, assetUrl, CreatedBookingGroup,
    PricingSnapshot, getPricing, WalkInInput, ReviewResult, CancelResult,
    RewardItem, CheckoutInput), mockData.ts (CourtCounts,
    DEFAULT_PRICING_CONFIG, PAID_BOOKING_STATUSES, normalizePromptPayId,
    bangkokNow), Dialog.tsx (DialogOptions, DialogResult).
  - `bangkokNow` no longer builds a new Intl formatter per call: it reuses
    `BKK_DATE` and a module-level `BKK_HOUR`, from one `Date` (midnight
    gives hour 0, checked).
- **Verified:** tsc (noUnusedLocals), vitest 53/53, `vite build` OK.
- **Not done / follow-ups:** none.

---

## 2026-10-21 — Rental form without group name; report years; double-booking backstop

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `34a56a4`)
- **Changed:**
  - Rental form: removed the required "ชื่อก๊วน / ผู้ค้ำประกัน" box (the
    owner doesn't use it). The order is named after the linked member, or
    "ลูกค้าทั่วไป (Walk-in)"; fields renumbered. (`StaffPOS.tsx`)
  - Admin → reports year picker: next year down to 5 years back (was
    last/this/next). (`AdminPanel.tsx`)
  - Partial unique index `idx_bookings_live_slot` on bookings (court_id,
    date, start_time) WHERE status <> 'CANCELLED' (`main.go` ensureIndexes;
    warns instead of failing if old duplicates exist). A violation maps to
    409 "slot already booked" (`repository.IsLiveSlotConflict`,
    `respondError`), already translated in errorText.
- **Verified:** go vet + go test (new `booking_conflict_test.go`), tsc.
  Live: index created on arena_fresh; a duplicate live row inserted by SQL
  is refused; second customer on the same slot gets the normal 409;
  cancel then rebook the same slot works.
- **Not done / follow-ups:** concurrency tests and automatic retry of busy
  errors (TODO step 4).

---

## 2026-10-21 — Member's name comes from the database (locked)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `1b3a29f`)
- **Changed:** the user said the customer-name box must not be editable
  once a member is linked, since the name comes from the database.
  - Staff POS (F&B cart, rental, walk-in): picking a member - or typing a
    member's full phone - fills the name box with their name and makes it
    read-only; changing the phone unlinks and clears it. Non-members still
    type a name. (`StaffPOS.tsx` memberPhoneHandlers, `MemberPhoneInput.tsx`
    exact-match auto-link)
  - Server: a counter sale or walk-in booking for a registered member
    always stores the member's account name, ignoring a typed one.
    (`pos.go` Checkout, `booking_service.go` customerContact)
- **Verified:** go vet + go test, tsc. curl: sale with member phone + typed
  name stored the member's name, sale without phone kept "โต๊ะ 3"; walk-in
  with member phone stored the member's name, non-member kept the typed
  name. Playwright (cart): pick → name filled, not editable; backspace on
  phone → name cleared, editable; typing 085-678-9012 links that member;
  no page errors.
- **Not done / follow-ups:** rental "renter / group name" is also locked to
  the member's name when a member is linked (same rule) - say if rentals
  should keep a free-text group name instead.

---

## 2026-10-21 — Member dropdown opens on click

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `810590b`)
- **Changed:** the user found the member-phone box still looked like a plain
  text field - the list only appeared after typing 2 characters. Now
  clicking/focusing the box (or the new ▾ button) opens the list of members
  A-Z at once, and typing narrows it (any length). Up to 20 shown, with a
  "type to search" note at 20. `GET /staff/members` with an empty q returns
  the first 20 A-Z. (`MemberPhoneInput.tsx`, `user_service.go`, comments in
  `handlers.go` / `api.ts`)
- **Verified:** go vet + go test, tsc. Playwright (API mode, staff, F&B cart):
  clicking the empty box lists 5 members; ArrowDown + Enter picks one and
  fills phone and name; ▾ opens the list; typing "ต" narrows it; no page
  errors.
- **Not done / follow-ups:** none.

---

## 2026-10-21 — Member-phone fields: dropdown of matching members

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `8dc659a`)
- **Changed:** the "🎁 เบอร์โทรสมาชิก" boxes were plain text, so staff had to
  know the exact number. Now they drop down matching customers.
  - Backend: `GET /staff/members?q=` (permission sell_rent or
    counter_bookings) - active customers whose phone starts with q's digits
    or whose name contains q (min 2 chars, max 8 results, LIKE wildcards
    escaped); returns id, name, phone, tier, points only.
    (`user_service.go` SearchMembers, `handlers.go`, `main.go`)
  - Frontend: new `MemberPhoneInput.tsx` (debounced search, arrows/Enter/
    Escape, "ไม่พบสมาชิก" hint, free typing still allowed; local mode filters
    stored users). Used for the F&B cart, rental and walk-in phone fields;
    picking fills the customer name if it is empty. `api.searchMembers`.
- **Verified:** go vet + go test (incl. route access test), tsc, vitest 53/53.
  curl: "08", "084-5" and a Thai name match; "a%" and 1 char return
  nothing; a customer gets 403. Playwright (API mode, staff): walk-in pick by
  name with Enter fills phone + name; unknown number shows the hint; cart
  "0856" lists the student member and click fills the phone; no page errors.
  Local mode type-checked only.
- **Not done / follow-ups:** "+66 8..." partial numbers aren't matched
  (full +66 numbers are normalised by the existing checkout code).

---

## 2026-10-21 — Fix `npm run dev:api`: backend didn't compile

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XDLgFVCg4iMYeu1EqarqcQ, reported by the owner
- **Commit(s):** this commit (on `main`, parent `9f886d8`)
- **Changed:** `dev-runner.js` ran `go run main.go`, which compiles only that
  file, so the functions in `seed_courts.go` (court counts from env) were
  "undefined". It now runs `go run .` (the whole package); README and
  golang-backend/README say the same.
- **Verified:** `node dev-runner.js --api` starts the backend (logs the court
  counts, seeds demo users) and Vite; `/api/v1/courts` returns 200.
- **Not done / follow-ups:** none. `go test ./...` never caught this because
  it builds the whole package; only the single-file `go run` broke.

## 2026-10-21 — One login, screens by permission, roles tab (TODO step 5, stages 3-5: frontend + docs)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XDLgFVCg4iMYeu1EqarqcQ, requested by the owner
- **Commit(s):** this commit (on `main`, parent `68f052f`)
- **Changed:**
  - `src/permissions.ts` (new): the 17 permissions with Thai labels, built-in
    role rights (same as the server seed), `can(user, ...perms)`,
    `canUseCounter`, `canUseSettings`. `User.permissions` comes from `/me`.
  - `src/api.ts`: one session key `sports_complex_api_session`;
    `migrateLegacySessions()` keeps an old admin/staff/customer session (in
    that order) so nobody is logged out; `login` returns the user with
    permissions; `listRoles` / `saveRole` / `deleteRole`.
  - `App.tsx`: top nav in API mode (จองสนาม / หน้าเคาน์เตอร์ / ตั้งค่า shown by
    permission, user name, ออกจากระบบ). A staff account signing in at the
    customer login is taken to the counter (or settings if it has no counter
    rights) instead of being refused (`CustomerPanel` `onStaffSignIn`).
  - `StaffPOS.tsx`: tabs shown by permission (walk-in → counter_bookings,
    slips → verify_slips, F&B / rentals → sell_rent, vouchers, today's total
    → day_summary/shifts); cancel/refund and blind count use permissions.
  - `AdminPanel.tsx`: tab bar from `ADMIN_TABS` + permission map; data is
    fetched only for tabs the account may open; role dropdowns use the roles
    list. New `RolesTab.tsx` (สิทธิ์และบทบาท): list, create, edit, delete
    roles; ADMIN's manage_roles box is locked; read-only demo note in
    browser-only mode.
  - Docs: README sign-in paragraph, TESTING_CHECKLIST 1.5-1.7b rewritten +
    new section 1b (roles), TODO step 5 / section 9 marked done.
- **Verified:** `tsc` clean, vitest 53 passing (new `permissions.test.ts`:
  `can` fallbacks, session migration), `vite build` OK, `go vet` / `go test`
  pass. Browser (Playwright, API mode against Postgres): logged out → only
  booking in nav; staff → `#/staff`, counter only; manager → settings with
  dashboard + accounts only; admin → all tabs, created a cashier role in the
  UI; an account given that role sees only F&B + rentals at the counter; an
  old per-screen staff session is upgraded to the single key. Browser-only
  mode: no nav bar, all 4 staff tabs, roles tab shows the demo note.
- **Not done / follow-ups:**
  - Deviation from the plan: no separate `LoginPage.tsx` - the customer login
    box is the single sign-in and the counter/settings gates show the same
    form. The dev role switcher doesn't sign in by itself; the ⚡ demo
    buttons do.
  - Custom roles are treated as staff-type accounts (no customer-only custom
    roles yet) - noted in TODO section 9.
  - `TestLoginThrottleBurstOnlyLetsFiveThrough` failed once and then passed
    20/20 with and without this change - looks flaky, not caused by it.

## 2026-10-21 — Roles as permission sets (TODO step 5, stages 1-2: backend)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XDLgFVCg4iMYeu1EqarqcQ, requested by the owner
- **Commit(s):** this commit (on `main`, parent `e0cc9d4`)
- **Changed:**
  - `model/permissions.go`: 17 permissions and the built-in roles CUSTOMER /
    STAFF / MANAGER / ADMIN with exactly the rights the fixed roles had;
    `roles` table (`model.Role`, permissions as JSON text).
  - `service/role_service.go`: seed built-ins (existing rows untouched;
    ADMIN always keeps manage_roles), permissions lookup, list (with account
    counts), create/update/delete with checks (valid permissions, unique
    name, built-ins not deletable, roles in use not deletable, ADMIN keeps
    manage_roles), audit-logged.
  - Middleware: `Authenticate` loads the role's permissions every request
    (edits apply at once); `RequirePermission(any of...)` / `RequireLogin`
    replace the fixed role groups; all 51 protected routes in `main.go` map
    to permissions; in-handler role checks became permission checks (blind
    cash count = no view_reports; customer details = counter/slip/refund/
    member permissions). `/auth/me` returns `permissions`. New
    `/admin/roles` (list: manage_roles or manage_staff; edit: manage_roles).
    Giving a user a role accepts any role in the table.
- **Verified:** new `route_access_test.go` reads `main.go` and checks every
  old protected route keeps exactly its old access for each built-in role
  (mutation-tested: a wrong permission fails it). `go test ./...` passes;
  `TestLoginThrottleBurstOnlyLetsFiveThrough` failed once and then passed
  20/20 runs with and without this change (timing-sensitive, pre-existing).
  Against Postgres: permission matrix for the 4 demo accounts identical to
  before; custom "cashier" role (sell_rent + shifts) reaches exactly those
  routes; editing it applies on the next request; bad permission 400,
  duplicate name 409, manager can't create roles 403, delete built-in /
  in-use 409, ADMIN without manage_roles 409. Found and fixed: saving
  permissions through a column map skipped the JSON serializer (500).
- **Not done / follow-ups:** stages 3-5 (one login + screens by permission
  in the frontend, roles screen, docs) - next commits.

## 2026-10-21 — Court counts from env (BASKETBALL_COURT_COUNT etc.)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XDLgFVCg4iMYeu1EqarqcQ, requested by the owner
- **Commit(s):** this commit (on `main`, parent `f0c61ec`)
- **Changed:** court counts per type are settings instead of code.
  - Backend: new `golang-backend/seed_courts.go` - `BASKETBALL_COURT_COUNT`
    (default 3), `BADMINTON_COURT_COUNT` (12), `PICKLEBALL_COURT_COUNT` (3),
    `MEETING_ROOM_COUNT` (1); bad values (not a whole number, < 0, > 26 for
    basketball / > 50 otherwise) fall back to the default with a warning.
    Basketball court n is lettered A-Z, each a mutex group of full + left +
    right half (A keeps `b_full_a`/`b_half_b`/`b_half_c`; others
    `bb-<letter>-full|left|right`, group `bball-court-<n>`). The seed adds
    missing courts on every start; lowering a count never deletes a court -
    it logs each still-open court beyond the count. `main.go` uses it and
    logs the counts.
  - Frontend (browser-only mode): `mockData.ts` `parseCourtCounts` /
    `buildDefaultCourts` with the same names, defaults, limits and ids;
    `vite.config.ts` reads the un-prefixed names from the root `.env` or the
    environment into `__COURT_COUNTS__`; the upgrade path in
    `initializeState` now adds any missing seeded court.
  - Docs: both `.env.example` files, README.md, golang-backend/README.md.
- **Verified:** `go test .` (new `seed_courts_test.go`: default = today's 25
  courts with the same ids, count 5 -> A-E each full + 2 halves, bad values);
  `npx vitest run` 49/49 (new court-count tests); `tsc`; `vite build`.
  Against Postgres: `BASKETBALL_COURT_COUNT=5` added courts D and E
  (15 rows, 5 groups); back to 3 logged a warning per still-open D/E court
  and kept them; `abc` fell back to 3 with a warning; after closing D/E no
  warning. Browser-only with `BASKETBALL_COURT_COUNT=5 MEETING_ROOM_COUNT=2`:
  fresh seed 15 basketball + 2 meeting rooms.
- **Not done / follow-ups:** none for this change. (The test DB used here
  keeps courts D/E closed; that's local to this session.)

## 2026-10-21 — Basketball courts A, B, C; closures by court group; court rename

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XDLgFVCg4iMYeu1EqarqcQ, requested by the owner
- **Commit(s):** this commit (on `main`, parent `5a10aee`)
- **Changed:** TODO step 3 / section 10 (step 1, owner decisions, skipped at the owner's request).
  - Courts: basketball is now three courts A, B, C, each a mutex group of
    full + left half + right half. A keeps its ids (`b_half_b`/`b_half_c`
    were always A's halves, once misnamed "B"/"C"), so existing bookings
    stay valid; B and C are new (`bb-b-*`, `bb-c-*`, groups
    `bball-court-2/3`). Server seed (`main.go`) renames A's halves only if
    they still have an old seeded name; browser-only seed + migration
    (`mockData.ts` `BASKETBALL_COURTS`, `initializeState`) does the same.
  - Closures follow the booking group rule: closing a full court closes its
    halves, closing a half closes that half and the full court but not the
    other half. New `model.CourtsConflict`; `repository.ClosureFor` now takes
    the target court and the closed courts (`repository.ClosureCourts`) and
    is used that way in all three booking paths (`booking_service.go`
    planSlots + in-transaction re-check, `booking_admin.go` late payment).
    `DayOffService.Create` lists affected bookings on every court the
    closure covers. Frontend `findClosure` takes the court list (all six
    call sites updated); fixed a doc comment that sat on the wrong function.
  - Admin: "✏️ เปลี่ยนชื่อ" per court (admin only, both modes); the server's
    court update now refuses a name another court already has.
  - Docs: REQUIREMENTS.md FR-1.1/1.2/1.3 and AC-1 describe three courts and
    group closures; TESTING_CHECKLIST.md 3.2-3.4, 5.8-5.11, 6f.1; TODO.md.
- **Verified:** `go vet` + `go test ./...` pass (new `TestClosureForCourtGroups`,
  9 cases); `npx tsc --noEmit`; `npx vitest run` 46/46 (new tests for
  `findClosure` groups, fresh seed and the upgrade path). Against Postgres:
  restart on an existing DB renamed A's halves and added B and C; closing
  A-left blocked A-left and A-full but not A-right or court B; closing B
  09-12 blocked all three B rows in the window only and listed B's booking
  as affected; closing A-full listed an A-right booking as affected; rename
  to a duplicate name 409, manager 403. Browser (API and local mode): 9
  basketball rows with the right closed hours, rename works.
- **Not done / follow-ups:** grid is still 9 rows (optional: one row per
  court with a full/left/right choice). Courts list in the customer/staff
  screens is active courts only, so a closure on a deactivated full court
  isn't seen client-side (the server still enforces it).

## 2026-10-21 — Receipts: business details setting, real cashier and paid time

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `caf84fe`)
- **Changed:** TODO step 2 (step 1, the owner's real details, skipped - so
  it is a setting the owner fills in).
  - Backend: `pricing_config` gains business_name/address/phone/tax_id and
    vat_registered (AutoMigrate adds the columns); `PUT /admin/business`
    (admin only) validates (13-digit tax ID; VAT needs name, address, tax
    ID), locks the row, audits BUSINESS_INFO_UPDATED. Staff booking lists'
    `payment` now carries verified_at / verified_by_name; counter orders carry
    created_by_name. (`models.go`, `pricing_admin_service.go`,
    `pricing_api.go`, `main.go`, `booking_service.go`, `pos.go`)
  - Admin → Pricing: "ข้อมูลร้าน" card (both modes). `AdminPanel.tsx`
  - Receipt: header from the setting (red "not set" note when empty);
    VAT-registered → tax ID, ใบกำกับภาษีอย่างย่อ title and VAT lines (VAT
    rounded, base = total − VAT); otherwise plain ใบเสร็จรับเงิน, no VAT.
    Cashier = who verified the payment / sold the order, plus "paid" time;
    print time kept. `StaffPOS.tsx`, `mockData.ts` (businessInfo, formatTaxId)
  - Customer payment screen shows "ชื่อบัญชีผู้รับ: <name>" when set.
    `CustomerPanel.tsx`
  - Thai texts for the new errors (`errorText.ts` + test).
- **Verified:** go vet + go test, tsc, vitest 40/40. Live on arena_fresh:
  bad tax ID / VAT without address refused, staff PUT 403, saved + audited,
  `GET /pricing` returns it, public `/bookings` has no payment info, staff
  list has verified_by_name. Playwright (API mode): receipt shows the shop,
  tax ID, VAT 19.63 on 300, cashier "วิชัย ผู้จัดการ" and paid time;
  unticking VAT in the admin card → title ใบเสร็จรับเงิน and no VAT lines.
  Local mode was only type-checked, not clicked through.
- **Not done / follow-ups:** running tax-invoice number and full tax invoice
  (TODO section 5); the owner must enter the real details.

---

## 2026-10-21 — TODO order of work re-prioritised

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `7eaa6d3`)
- **Changed (docs only):** basketball A/B/C and the single login were at the
  end of the order; now basketball is step 3 (before real bookings) and
  single login step 5 (before deploy), decided items removed from step 1.
- **Verified:** n/a (docs).

---

## 2026-10-21 — TODO: single login with roles/permissions; basketball A/B/C

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `cca3259` (on `main`, parent `b0ee7a7`); follow-up adds the court-rename item to section 10 (docs only)
- **Changed (docs only):** owner decisions recorded in `TODO.md`: managers
  keep today's rights for now; basketball is three courts (A, B, C) each
  bookable/closable full or by half. New sections 9 (one sign-in, screens
  by permission, admin-defined roles with permissions) and 10 (basketball
  A/B/C plan: groups of full + two halves, migration keeping existing
  bookings, group-aware closures, grid, occupancy); added to the order of
  work. Not built now: both are larger changes (owner asked to keep
  token use low).
- **Verified:** n/a (docs).

---

## 2026-10-21 — Blind cash count; voided sales cancel rewards bought with their points

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `b0ee7a7` (on `main`, parent `f887d02`)
- **Background:** Owner decisions: "cash count - yes" (staff count without
  seeing the expected amount) and "reward should be cancelled once the sale
  is voided and points used".
- **Changed:**
  - Blind count, backend (`shop_api.go` `blindCount`/`blindShift`): STAFF
    get the current shift with cash figures zeroed and `blind: true`; the
    day summary zeroes cash and the totals it could be derived from.
    Frontend (`StaffPOS.tsx`): staff see the float and an instruction instead
    of the expected amount, day-report cash shows "—"; closing asks to
    confirm the count, then locks it; a difference brings up a note dialog
    showing short/over, and the same count is resubmitted with the note.
    Managers keep the old view. Browser-only mode: blind for the STAFF role.
  - Void with spent points, backend (`pos.go` `VoidOrder`): if the balance
    can't cover this sale's points, the customer's ACTIVE vouchers are
    cancelled newest first (new status `CANCELLED`, points back as ledger
    `VOUCHER_CANCELLED`) and the full reversal applied; if used rewards
    can't be cancelled, the void is refused ("...already spent on a reward
    that was handed over..."). Response lists `cancelled_vouchers`.
    Frontend: void message names cancelled vouchers; customer voucher list
    shows "ยกเลิก"; browser-only mode does the same before undoing the sale;
    Thai translations (incl. a shortfall in the count message, which was
    shown in English).
- **Verified:** `go vet`, `go test`, `tsc`, vitest 39/39. Live: staff shift
  view expected 0/blind, manager 1000; staff summary cash withheld; sale
  +26 pts, redeem 25, void -> voucher CANCELLED, balance 27->2->1; with the
  reward already used the void is refused and the order stays DELIVERED.
  Browser: staff opens a shift, sees the blind note and "—", counts 990,
  confirms, gets "ยอดนับขาด... 10 บาท" note dialog with the count locked,
  closes; DB has counted 990 / expected 1000 / variance -10 / the note.
- **Not done:** remaining owner decisions (manager permissions,
  basketball closure, cash refunds vs drawer, lockout policy, business
  details).

---

## 2026-10-21 — Cash only with an open shift

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `f887d02` (on `main`, parent `ff4fa47`)
- **Background:** Owner decision ("make sure they open the shift"): cash
  taken with no drawer shift open is in no shift's count, so it is refused
  instead of only warned.
- **Changed:** backend `lockDrawerForCash` (shift_service.go) - the drawer
  lock plus "a shift must be open", used by cash walk-ins
  (`CreateBookings`), mark-cash (`MarkPaidInCash`) and cash checkout/rentals
  (`checkoutTx`); new `ErrNoOpenShift` -> 409 "open the cash drawer shift
  before taking cash". Voids are unchanged (a closed shift's sale was
  already refused). Staff POS: the cash warning became a refusal with a
  "ไปเปิดกะ" button that opens the shift tab; banner text says cash is
  blocked; Thai translation of the new message. TODO item ticked,
  checklist 7.21 rewritten, backend README note.
- **Verified:** `go vet`, `go test`, `tsc`, vitest 39/39. Live: no shift ->
  cash walk-in and cash sale refused with the message, PromptPay sale 200;
  open shift -> cash sale 200. Browser: cash walk-in with no shift shows
  "ต้องเปิดกะลิ้นชักก่อนรับเงินสด", "ไปเปิดกะ" lands on the shift tab, no
  booking made, no page errors.
- **Not done:** the other owner decisions in TODO.md item 0.

---

## 2026-10-21 — TODO ordered by what to do next

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `ff4fa47` (on `main`, parent `5987cce`)
- **Changed:** `TODO.md` starts with "Order of work" (owner decisions ->
  receipts/payment screen -> pre-launch safety -> deploy -> real-phone tests
  -> LINE -> forgot password -> tablet layout -> small improvements) and has
  a new section 8 "Deploy (production)" (it was missing; LINE and real-phone
  testing need it). Docs only, no code change.
- **Verified:** n/a (docs).

---

## 2026-10-21 — Full code review: races, money rules, dead code

- **Who:** Claude Code (Opus 5.5) with review/fix subagents, session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `5987cce` (on `main`, parent `c3109fb`)
- **Background:** Owner asked for a review of frontend and backend for bugs,
  race conditions, improvements and redundant code, and to fix them. Five
  read-only reviews (backend money paths, backend shop/auth/admin, customer
  UI, staff/admin UI, dead code); every finding was checked before fixing.

### Backend (`golang-backend/`)
- **Money rules:** approving a partly refunded payment is allowed when the
  money left covers the hours that stand (was always refused - a closure
  that refunded one hour of a waiting slip left the other hour stuck);
  mark-cash refused while a slip waits or after a refund (it counted
  transfer money as drawer cash); a late payment re-confirms only hours
  cancelled by expiry, never hours a manager cancelled (new
  `bookings.cancel_kind`: EXPIRED / SLIP_REJECTED / STAFF / REFUNDED); a
  slip is reusable only after staff rejected it (new
  `payments.slip_released`, new partial unique index); staff can approve a
  PENDING payment without a slip only for walk-ins; lock/DB errors during a
  late payment no longer turn into "slot gone, refund instead"; replaced
  slip files are kept as evidence.
- **Races:** void takes the drawer lock (void vs shift close); POS locks
  customer -> drawer -> stock rows sorted by id (no cashier deadlocks);
  checkout `idempotency_key` (repeat returns the first sale, `replayed:true`);
  unique indexes on order and voucher codes with retry; `UpdateConfig` locks
  its row.
- **Other:** month export has no row limit; sale category/rental flag
  snapshotted on `order_items` (editing a product no longer rewrites past
  reports); 500s return a generic message (details logged); sign-up limit
  10/IP/hour; manual points change capped at ±10,000; a new half court must
  name its full court (`half_of`); `JWT_SECRET` required and
  `TRUSTED_PROXIES` warned in release mode; one-off migrations run in a
  transaction under an advisory lock; background jobs recover from panics
  and time out; `http.Server` timeouts; indexes on the report/shift filters.
- **Removed:** `AuditLogService`, unused repository methods and handler
  fields, `OrderPending/OrderReady`; merged duplicate Bangkok-day and
  hour-range helpers.

### Frontend (`src/`)
- **Customer:** one action at a time for booking, slip upload, redeem,
  sign-in/up (a double tap booked twice); redeem re-checks the balance
  after the question; before booking/spending, a check that another tab
  hasn't signed in as someone else; the grid waits for the chosen date
  (it briefly showed the old date's bookings as free) and optional data
  (rewards, vouchers) can no longer break it; browser-only booking
  re-checks availability, start time and closures on fresh data; the file
  picker resets; sign-out clears the previous person's screen; half-court
  "discount" strike price fixed; labels linked to inputs, alerts announced,
  16px inputs on phones, iPhone safe area.
- **Shared:** `api.ts` drops a session on 401 only if it is still the
  token that failed, handles non-JSON replies, plain Thai network message;
  sign-in/out in another tab refreshes this tab (`onSessionChangedElsewhere`);
  header clock is its own component (the page no longer re-renders every
  second); dialogs trap focus, Escape works anywhere, focus returns, fresh
  state per dialog; `errorText` no longer cuts court names containing
  ": ", and translates session/permission/new money-rule messages;
  `findClosure` / `findPricingRule` replace six copies of the closure check
  and two of the rule lookup (an hour with no rule is no longer "off-peak").
- **Staff:** cancel from the day report finds the whole group (it cancelled
  everything without the refund option when the walk-in date wasn't
  today); error banner on every tab; closing a shift re-reads the expected
  cash; mark-cash hidden while a slip waits; browser-only mode: partial
  cancel shrinks amount and QR, void refuses closed-shift cash sales,
  refunds counted on the day each was made, refund capped like the server.
- **Admin:** member-tier on/off dropdown fixed (any change switched the
  tier off); every save is guarded against double clicks; error banner;
  dashboard closures for past dates; role changes picked up without
  re-login; Excel import resets, skips duplicates, validates like the
  server; CSV download URL revoked later; dashboard money formatted and
  computed once per render; half-court picker; working member-tier filter;
  no-op point changes not audit-logged; phantom "save" button fixed.
- **Removed:** unused imports/state/props, dead seed data and storage keys,
  unused types/enum members and API wrappers, an old slot-toggle handler;
  48 Tailwind classes that don't exist rounded to real shades.

### Verified
- `gofmt`, `go vet`, `go test ./...` (new tests: standing-hours rule,
  expired-only re-reserve, walk-in check, lock order, sign-up limit,
  respondError); `tsc`, `tsc --noUnusedLocals --noUnusedParameters` clean;
  vitest 39/39; production build.
- Backend live (fresh DB on :8081 by the fix agent, then main DB on :8080):
  closure partial refund then verify keeps the paid hour; mark-cash refused
  for waiting/refunded; late slip re-reserves only expired hours; cancelled
  slip can't be reused; same idempotency key twice/3 parallel -> one order;
  void vs closed shift refused; points cap; sign-up limit 11th -> 429;
  migrations applied on a copy of the old DB and on the test DB; earlier
  money scenarios (`e2e12.sh`) unchanged.
- Browser (Playwright `s14.cjs`, `ui14/15.cjs`, `s12.cjs`), no page errors:
  double-tap confirm -> 1 booking; grid shows loading then the date;
  Escape closes a dialog with focus elsewhere; a second tab signing in as
  another customer updates the first; tier off->on stays on; half court
  without a full court is refused, picker lists the full court; staff
  cancel from the day report offers the refund; phones 390px no sideways
  scroll in both modes.

### Not done / follow-ups
- TODO.md item 0 (owner decisions, now incl. void after points spent, cash
  refunds vs drawer, lockout policy) and new item 7 (smaller improvements).

---

## 2026-10-21 — Thai errors everywhere, audit trail, login limit per account

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `c3109fb` (on `main`, parent `ba0fa54`)
- **Background:** Owner picked items 6-8 of the open-problems list ("fix
  6-8, leave the rest, the rest note in the todo").

### Changed
1. **Thai error messages on every screen** (`src/errorText.ts`, `src/api.ts`):
   the server's English errors are translated once, in `ApiError`, so
   staff, manager and admin screens get Thai like customers do (the
   customer-only translator in `CustomerPanel.tsx` is gone). About 100
   rules cover sign-in, booking, slips, refunds/cancel, shifts, sales,
   stock, rentals, vouchers, points, courts, closures and pricing; numbers,
   court names, times and product names are kept ("สนามแบดมินตัน 3
   18:00-19:00 ถูกจองไปแล้ว", "คืนเงินได้ไม่เกิน 180 บาท"). Unknown messages
   are shown as sent; `ApiError.serverMessage` keeps the original.
2. **Audit trail of the customer's side** (`booking_service.go`,
   `handlers.go`): online bookings are logged as `BOOKING_CREATED` and slip
   uploads (and replacements) as `SLIP_UPLOADED`, in the same transaction
   as the change. Before, an online booking first appeared at approval.
3. **Login limit per account** (`login_throttle.go`, `auth_service.go`):
   the per-account limits were keyed by the typed identity, so an account's
   phone and email each got their own 5/20 tries. Login now looks the
   account up first and keys by it (`AccountKeyForUser`); unknown
   identities are keyed as before.
4. **Bug found while testing 3:** Postgres stores microseconds, the throttle
   compared nanosecond times, so (a) the current attempt counted as a
   prior one - only 4 tries were allowed, not 5 - and (b) refused attempts
   were never removed, lengthening lockouts. Times are truncated to
   microseconds; new test with a microsecond store fails without the fix.
5. **TODO.md item 0:** the owner decisions left open (cash with no shift,
   blind count, manager permissions, basketball closure, business
   details); LINE, forgot password, tablet layout and device testing were
   already items 1-6.
6. Docs: `golang-backend/README.md` (limit per account, new audit actions).

### Verified
- `go vet`, `go test ./...` (new `TestLoginThrottleAccountKeySharedByPhoneAndEmail`,
  `TestLoginThrottleWithMicrosecondStore`), `tsc`, vitest 36/36 (new
  `errorText.test.ts` with exact server strings).
- Live on Postgres: 3 wrong passwords by phone + 2 by email → the 6th try
  (even with the right password) gets 429, and only the 5 failures are
  stored; an online booking and its slip upload appear in `audit_logs` and
  in the admin Audit Log tab; admin saving an overlapping price rule shows
  "ช่วงเวลาซ้อนกับกติกา ... — แก้ไขหรือปิดกติกานั้นก่อน"; a locked-out
  customer sees "ลองผิดหลายครั้งเกินไป กรุณารอ 14 นาทีแล้วลองใหม่".

### Not done / follow-ups
- Everything in TODO.md item 0 (owner decisions) and items 1-6.

---

## 2026-10-21 — First-time user walkthrough fixes

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `ba0fa54` (on `main`, parent `c194b36`)
- **Background:** Owner asked to "recheck everything makes sense, act as if
  using the app for the first time". Walked through API mode on an empty
  database (`arena_fresh`) as a new customer (sign up, book, pay, upload a
  slip), as staff (approve the slip), as a manager (cash walk-in, open
  shift, sell, close shift) and as admin (every tab), with screenshots at
  each step. Frontend only; no backend change.

### Changed
1. **Sign-up form** (`CustomerPanel.tsx`): the first field was labelled
   "อีเมล / เบอร์โทรศัพท์" with the example "user@mail.com หรือ
   0845678901" but is the email - a newcomer typing their phone there got
   the server's English "email address is not valid". In sign-up it is now
   "อีเมล (ไม่บังคับ)" (optional, as the server allows), the phone field says
   it is the login, the password field says "at least 6" and it is checked
   before sending. Tab "สมัครสัญญาสมาชิกใหม่" → "สมัครสมาชิกใหม่".
2. **Thai error messages for customers:** sign-in, sign-up, booking, slip
   and reward errors from the server (English) are shown in Thai
   (`customerErrorThai`): wrong password, already registered, bad phone,
   suspended, slot just taken, hour started, off-peak only, closed, outside
   hours, booking window, 3-hour limit, unpaid-booking limit, duplicate
   slip, not enough points, busy, network. Unknown messages still show as
   sent.
3. **Payment screen:** removed the made-up account name "บจก. กีฬาแฮปปี้
   พาร์คคอมเพล็กซ์" under the QR (now "ตรวจชื่อผู้รับในแอปธนาคารก่อนกดโอน");
   "(Simulation Upload)" heading and the dangling "--- หรือ ---" only in dev
   builds; the real upload button is the main green button; the steps box
   had a garbled word and promised a LINE confirmation that is not built -
   now says where to see the status; "within 5 minutes" promise removed.
4. **LINE simulator:** hidden in production API builds (it simulates
   notifications that don't exist yet, TODO item 2) and shows only the
   signed-in customer's messages (it showed the demo customer's to
   everyone). Its floating button moved to the bottom-left - on desktop it
   covered the "ยืนยันการจอง" button.
5. **Court type tabs and header:** counts were typed in ("Basketball (1)"
   while the grid shows 3 basketball courts; wrong as soon as an admin adds
   or closes a court) - now counted from the court list, in Thai, and a type
   with no courts is hidden. Header tagline no longer lists fixed counts.
   Legend "ว่าง (ปกติ)" → "ว่าง (Off-Peak / ราคาปกติ)" to match the cells.
6. **Staff POS:** the slip queue shows the slip picture on the card (staff
   could approve without opening the link); taking cash (walk-in, sale,
   rental, mark-paid) with no drawer shift open asks first - that cash is
   in no shift's count, which made the drawer screen show two different
   cash figures; day-report cards relabelled: "ชั่วโมงสนามที่เล่นวันนี้
   (ชำระแล้ว)", "เงินที่รับวันนี้ทั้งหมด" (court money includes advance
   payments for other days), "แยกตามช่องทางรับเงิน", "เงินสดที่รับวันนี้"
   (it was "in the drawer", which is the shift box's job); menu header no
   longer says "F&B only" above the shuttlecocks; garbled text in the
   empty reject panel.
7. **Admin:** dashboard grid marked cash bookings "✓ โอนแล้ว" →
   "✓ ชำระแล้ว"; pricing table header "สิทธิ์สกัดกั้น" → "ประเภทราคา", the
   filter boxes now sit under the right columns, the rule label is shown
   (a filter searched it but it was never displayed), prices/day badges
   don't wrap; users table lost the "รหัสผ่าน" column that only ever showed
   dots (it pushed the actions column off screen); audit log entries are a
   one-line summary with details folded (one sale filled the whole box, so
   the log looked like it had one entry) plus a count; button labels "เพิ่ม
   สนามกีฬาเข้าสต๊อก" → "เพิ่มสนาม", "ล็อคปิดสิทธิ์เวลานี้" → "บันทึกวันปิด
   บริการ"; "ผู้บันทึกกานต์" → "ผู้ทำรายการ".

### Verified
- `tsc`, vitest 32/32.
- Playwright walkthrough scripts (`/var/tmp/fresh/s1-s12.cjs`) on a fresh
  database, no page errors: sign-up with a too-short password → Thai
  message; sign-up without email works; wrong password → Thai message;
  duplicate slip → "สลิปนี้เคยใช้กับการจองอื่นแล้ว..."; new slip shows as a
  picture in the staff queue; slip approved → customer sees "อนุมัติ
  เรียบร้อย" and +2 points; shift closed at 1,030 matching; cash walk-in
  with no shift → warning, cancelling it books nothing; tabs read
  "บาสเกตบอล (3) | แบดมินตัน (12) | พิกเคิลบอล (3) | ห้องประชุม (1)" in both
  modes; phone 390px has no sideways scroll.
- Earlier regression scripts re-run: `ui14` (double-click walk-in → one
  booking, stuck pending walk-in cleared, cash receipt "เงินสด (CASH)" -
  now after accepting the no-shift warning) and `ui15` (date/hours kept on
  refresh, ledger redeem, suspended customer signed out) pass.

### Not done / follow-ups
- (Staff/admin English errors and the missing online-booking audit entry
  were fixed in the "Thai errors everywhere" entry above.)
- Taking cash with no shift open is warned, not blocked - owner to decide
  whether to block it.
- The real business name / PromptPay account name should be shown on the
  payment screen and receipts once known (see TODO item 5).
- The three owner decisions from the review entry below are still open.

---

## 2026-10-20 — Fixes from the full UI/backend review

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `c194b36` (on `main`, parent `8d7ad74`)
- **Background:** A four-part review (customer UI, staff/admin UI, booking
  and money backend, shop/reports/auth backend) found the issues below. The
  owner said "leave the pending, fix the rest": three items that need the
  owner's decision are left as they are (see Not done).

### Changed — backend (`golang-backend/`)
1. **Refunds are records now** (`model.Refund`, table `refunds`): every
   refund is a row (amount, reason, who, when); `Payment.RefundAmount` is
   the running total. The day summary and the dashboard's all-time refunds
   count the rows, so a refund is counted on the day it was made.
   One-off migrations run through the new `app_migrations` table (`once()`
   in `main.go`): back-fill refund rows from old payments, and the earlier
   EXPIRED status migration.
2. **Cancel (`CancelBookings`)**: `refund` only refunds money that was
   received (paid hours, or a slip waiting/late) and is ignored otherwise;
   each row is updated only if still PENDING/CONFIRMED (a concurrent change
   fails the call instead of being overwritten); cancelling some hours of an
   unpaid group lowers the amount and regenerates the QR; with nothing left
   a waiting payment becomes REFUNDED (if refunded) or REJECTED.
3. **Refund payment**: needs money received; cancels any hours still
   pending; refunds at most `amount - refunded - what standing hours pay
   for`; closes as REFUNDED when no paid hour is left. **Verify** refuses a
   payment that has a refund.
4. **Locks:** verify, mark-cash, cash walk-ins and cash sales lock the user
   / the cash drawer (shared lock against shift open/close) in a fixed
   order; re-reserving late payments locks court groups in key order.
   Deadlocks / serialization failures answer 409 "busy, try again".
5. **No-show** and **rental return** are conditional updates (no double
   effect); a voided sale's rentals are stamped returned and can't be
   "returned" again; a cash sale from an already-closed shift can't be
   voided; void locks the user before taking points back.
6. **Shifts** store their cash breakdown at close, so the closed-shift view
   no longer changes when later data does.
7. **Reports:** counter totals split F&B / equipment / rentals by product
   (a mixed cart was all counted as one); occupancy ignores inactive courts;
   the month report lists a group's refund once (on the paying row).
8. **Auth:** login throttling counts the attempt before checking the
   password (a burst can't slip more than 5 tries through); registration
   checks name length, phone length, email format (an "email" that is a
   phone number could take over that login) and password ≤ 72 bytes (400).
9. **Slots:** default date is today in Bangkok; a bad date answers 400.
10. **Staff booking list** (`GET /bookings?date=`) now includes each row's
    group `payment` {method, status} for receipts.

### Changed — frontend (`src/`)
1. **Bangkok dates everywhere:** `localDateOf`/`getTodayDateStr` use
   Asia/Bangkok whatever the browser's zone; quick date buttons, the local
   dashboard, CSV times (`bangkokStamp`) and audit-log times too.
2. **Customer page:** a refresh no longer resets the chosen date or wipes
   picked hours (they reset only when the court list really changes); LINE
   simulator no longer crashes on old time-only timestamps (stored as ISO
   now); step 2 prices with the account's tier and shows the struck price
   only when there is a discount; meeting-room hours say "ราคาปกติ" instead
   of Off-Peak, off-peak-only follows the price rule; grid cells work with
   the keyboard (Tab + Enter/Space, aria labels); browser-only mode re-reads
   the signed-in customer (fresh points, signed out if suspended);
   redemptions go through the points ledger. Dead `getSlotStatus` removed.
3. **Staff POS:** one action at a time (`guarded`, buttons greyed while
   busy - a double click made two walk-ins); a waiting PromptPay walk-in
   that was settled/cancelled/expired elsewhere is cleared instead of
   blocking new walk-ins; cancel offers a refund when a slip is waiting;
   receipts list the whole group, show the real payment method and the
   cashier, and can't be printed for an unpaid booking; the day report uses
   today's bookings (not the walk-in tab's date) and the server's paid count;
   browser-only day totals count money by the day it was received; slip
   upload time shown as date+time; staff name/role refreshed from the
   server; logging out clears the previous person's screen; a used
   free-hour voucher clears the voucher check; off-peak-only courts checked
   for walk-ins; browser-only mode: phone lookup matches customers only,
   mark-cash only for unpaid/waiting/expired payments, verify refuses a
   refunded payment; amounts formatted with `formatBaht`.
4. **Admin:** closures and court closing pass `refund=true` (the server
   refunds only what was received); Excel import keeps a 0 price/stock;
   browser-only mode: pricing rules can't overlap (as on the server),
   editing a rule doesn't re-enable it, manual point changes need a reason
   and go through the ledger, the CSV lists a group refund once.
5. **Other:** audit ids use `crypto.randomUUID`; the seeded pending demo
   payment has a real QR and is created at seed time (it used to expire at
   once).

### Docs
- `golang-backend/README.md`: refund rules, registration checks, staff
  booking list payment field. `TESTING_CHECKLIST.md`: 6d.9-6d.14,
  7.12-7.16.

### Verified
- `go vet`, `go test ./...` (incl. new `TestLoginThrottleBurstOnlyLetsFiveThrough`),
  `tsc`, vitest 32/32 (new Bangkok date tests; also run with
  `TZ=America/New_York`).
- Live API scenarios against Postgres (`e2e10/11.sh`), all as expected:
  partial cancel of an unpaid group 288→144 with a new QR, then verify OK;
  waiting slip cancelled without refund → REJECTED, refund later →
  REFUNDED; cancel with refund → REFUNDED and out of the queue; partial
  refund of a waiting slip closes it and verify is refused; refund capped
  at what no standing hour pays for; refunds per day from refund rows;
  voided rental can't be returned; void refused for a closed shift's cash
  sale; mixed cart splits +15 F&B / +60 equipment; registration rejects a
  phone-as-email and a 73+ char password; slots with a bad date → 400.
- Playwright (`ui14-16.cjs`), no page errors: API mode - double-clicked
  PromptPay walk-in made one booking; a pending walk-in blocks the next
  until settled, and disappears after it is cancelled on the server;
  cash walk-in receipt shows "เงินสด (CASH)" with print enabled; day report
  and customer grid load. Browser-only mode - old LINE timestamp shown
  without a crash; keyboard Enter picks a grid cell; after a refresh the
  chosen date and hour stay; redemption writes a REDEEM ledger entry
  (500→495); a suspended customer is signed out on reload.

### Not done / follow-ups (owner to decide)
- **Blind cash count:** staff see the expected cash before counting the
  drawer; hiding it until the count is entered is a policy choice.
- **Manager permissions vs. spec:** what managers may do with point
  adjustments and the dashboard differs from REQUIREMENTS.md. Confirm which
  is wanted.
- **Basketball closure:** a closure on the full basketball court does not
  block the half courts (and vice versa). Decide whether a closure should
  cover the whole court group.
- Low: the login throttle's per-account limit is keyed by the typed
  identity, not the resolved user (phone vs. email of the same account
  count separately).

---

## 2026-10-20 — Customer booking on phones

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `8d7ad74` (on `main`, parent `f57397e`)
- **Background:** Owner approved the plan: automatic phone layout with a
  grid/list toggle; show all hours (taken ones greyed); quick day buttons;
  Staff POS / Admin tablet layout left for a later round.

### Changed (`src/components/CustomerPanel.tsx`, `src/App.tsx`)
1. **`slotStatus()`**: the booked / closed / started / off-peak-only /
   no-price / free / selected decision that every grid cell made inline is
   one function now, used by the grid and the new list - they can't
   disagree. Grid cells render from it (same states, same order).
2. **View mode:** list under 640px (matchMedia, follows rotation), grid
   above; "ตาราง / รายการ" toggle remembered in localStorage
   (`sports_complex_booking_view`, try/catch).
3. **List view:** a card per court ("ว่าง X ชม.", off-peak-only, how many
   picked), tap to open; hours as 52px buttons, 3 per row, with price and
   Peak; unavailable hours greyed with the reason. Courts with a selection
   open by default.
4. **Quick dates** วันนี้ / พรุ่งนี้ / มะรืน (within the booking window), all
   screen sizes.
5. **Phones:** fixed bottom bar with hours + total + "จองต่อ →" and "ล้างที่
   เลือก"; the demo LINE button shrinks to an icon and hides while the bar
   shows; the rewards club starts folded (toggle with the point balance);
   step labels shortened; changing step scrolls the booking area into view
   (below the sticky header, `scroll-mt`); the demo role switcher is two
   compact rows. Member-since date was a raw ISO timestamp in API mode -
   now `formatDate`.
6. **Readability:** 63 text sizes of 7-10.5px on the customer page raised to
   11-12px; section titles shortened.

### Verified
- `tsc`, vitest 29/29.
- Playwright `mob1.cjs` at 375/390/430px (local) and 390px (API): list
  view by default, quick date, open a court, pick 2 hours → bottom bar
  "2 ชม. · 324 บาท", LINE button hidden → "จองต่อ" → step 2 → step 3 (API:
  real booking created); **no sideways scrolling** at any step, no page
  errors. `desk1.cjs`/`desk2.cjs` at 1400px: grid by default, toggle +
  reload remembered, no bottom bar, step indicator visible below the header
  after "next". Smoke test both modes clean. Screenshots reviewed.

### Not done / follow-ups
- Staff POS / Admin on tablets (TODO item 3).
- The backend/Postgres in this sandbox were stopped twice by the
  environment between runs (not an app problem) - restart them if API tests
  suddenly see no courts.

---

## 2026-10-20 — In-page dialogs, Gregorian dates, availability before login, VAT to TODO

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `f57397e` (on `main`, parent `83728ff`)
- **Owner's decisions:** VAT → TODO; replace pop-ups; Gregorian dates
  (2026); let guests see availability. Mobile redesign: recommendation
  given, waiting for the go-ahead.

### Changed
1. **Dialogs** (`src/components/Dialog.tsx`, `<DialogHost/>` in App): every
   `alert` (134) → `notify()`, every `confirm` (18) / `prompt` (5) →
   awaited `ask()` / `askText()` / `dialog()` in the three panels (handlers
   made async). Native pop-ups are blocked or ugly in in-app browsers like
   LINE. Required text boxes keep OK disabled until filled. The Staff POS
   cancel-booking chain (reason prompt → OK/Cancel meaning "all hours /
   this hour" → refund confirm) is now one dialog: reason, a radio choice
   with the hours spelled out, and a refund checkbox showing the amounts.
   Wording of several questions made plain (e.g. delete-account, rule
   delete).
2. **Gregorian dates:** `formatDate` / `formatDateTime` in mockData (Thai
   month names, Gregorian year, Bangkok time: "20 ต.ค. 2026 13:56") used
   for the header clock, shift times, rental times, voucher expiry and
   redeem dates, receipts; dashboard month labels and the report year list
   no longer add 543.
3. **Availability before login:** the blurred "log in first" overlay over
   the customer booking grid is gone; a one-line hint links to the login
   box; picking a slot still asks to log in (unchanged).
4. **TODO item 5 (VAT on receipts):** the receipt's header is a hard-coded
   placeholder (business name, address, TAX ID 0-1055-59092-49-0) with a
   VAT 7% breakdown - real details needed, VAT lines only if registered.

### Verified
- `tsc`, vitest 29/29 (no backend changes).
- Playwright `ui12.cjs` both modes: header clock "20 ต.ค. 2026 …"; guest
  sees the grid unblurred with prices, clicking a slot opens the in-page
  login message; manager walk-in then cancel → one dialog (OK disabled
  until a reason, refund checkbox) → "ยกเลิก 1 ชั่วโมงแล้ว · บันทึกคืนเงิน
  180 บาท", slot free again; **0 native pop-ups**. Smoke test both modes:
  no errors. Screenshots of the dialog at 1400px and 390px checked.

### Not done / follow-ups
- Mobile redesign (see the recommendation to the owner).
- My older Playwright scripts (`ui5`–`ui10`) answered native dialogs and
  need updating to click `#app-dialog-ok` if re-run.

---

## 2026-10-20 — Cash drawer shifts, voiding sales, closed-court bookings, separate panel URLs

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `83728ff` (on `main`, parent `b373e73`)
- **Background:** The owner said "fix all that you are certain to fix" from
  the remaining list. Done here: shifts (FR-6.1/6.2), voiding counter
  sales, cancelling a closed court's bookings, separate staff/admin URLs
  with the role switcher out of production, export logging. Left for the
  owner's decision: VAT lines on receipts (is the business VAT-registered?),
  mobile redesign, replacing prompt()/confirm() with dialogs, date format
  (Buddhist vs Gregorian), showing availability before login.

### Changed
1. **Shifts** (`internal/service/shift_service.go`): one open shift at a
   time (advisory lock), `GET /staff/shift`, `POST /staff/shift/open`
   `{opening_float}`, `POST /staff/shift/close` `{counted_cash, notes}`,
   `GET /admin/shifts` (managers). Expected = float + approved cash booking
   payments + non-voided cash orders during the shift; refunds are
   transfers so not deducted. Close stores expected/counted/variance and
   who closed (`closed_by_*`, new columns); a note is required when the
   count is off; a closed shift keeps its stored expected. Audited
   SHIFT_OPENED/SHIFT_CLOSED. Staff POS: shift panel in "ยอดลิ้นชัก"
   (open with float, live expected, count + note, over/short result,
   managers see closed shifts) and a yellow "no shift open" banner on every
   tab; same rules in browser-only mode (`shifts` in localStorage).
   Cash sales are not blocked without a shift (banner only).
2. **Void a sale** (`POSService.VoidOrder`, `POST /admin/orders/:id/void`,
   managers, reason required, today's sales only): stock back (rental
   items still out too, per size), purchase points taken back (ledger
   `REVERSE_PURCHASE`, never below zero), status CANCELLED + `voided_at`/
   `void_reason` (new columns), audited ORDER_VOIDED. "✖ ยกเลิกบิล" for
   managers in the receipts list (both modes).
3. **Closing a court** now returns its upcoming bookings; the Admin panel
   lists them and offers to cancel them with refunds (like closures).
4. **Separate URLs:** `/` customer, `/#/staff` counter (staff + managers),
   `/#/admin` settings (`/#/manager` = manager demo view); the role switcher
   updates the hash and is hidden in production API builds
   (`SHOW_ROLE_SWITCHER`).
5. `GET /admin/report` is audit-logged as REPORT_EXPORTED (with `kind`).

### Verified
- `go vet`, `go test ./...`, `tsc`, vitest 29/29.
- Live API (`/var/tmp/e2e8.sh`): no shift → null; close without shift
  refused; open 2000, second open refused; cash walk-in 180 + cash sale
  650 → expected 2830, PromptPay sale not counted; void: staff 403, no
  reason refused, manager void → CANCELLED, points 149→143, stock back,
  double void refused, yesterday's sale refused, voided rental → size
  back in stock and gone from rentals; expected after voids 2180; close
  100 short without note refused, with note → variance -100, closed_by;
  manager list / staff 403; exact close → 0. Court close → upcoming list.
  Export and void/shift audit rows present.
- Playwright: `ui9.cjs` both modes (banner, open shift, cash sale moves
  expected, manager void, short close needs note, result, history);
  `ui10.cjs` closing a court with 2 bookings → cancelled + 360 THB refund
  recorded; `ui11.cjs` production API build: no switcher on `/`,
  `/#/staff`, `/#/admin`, each opens its panel. Smoke test both modes clean.

### Not done / follow-ups
- Decisions for the owner (see Background).
- A sale older than today can't be voided (it belongs to a closed day).

---

## 2026-10-20 — Courts on the server, editable opening hours, no user delete in API mode

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `b373e73` (on `main`, parent `6856bcd`)
- **Background:** In API mode the Admin courts tab and the "🗑️ ลบไอดี"
  button only changed the browser's copy (a "new" court couldn't be booked,
  a "closed" one still could, a "deleted" user could still log in). The
  owner agreed to: courts on the server (close instead of delete), hide user
  delete in API mode, and make opening hours editable (they were fixed at
  07:00-23:00 in code on both sides; the old `operating_hours` list in the
  Admin panel was loaded but never shown or used).

### Changed
1. **Courts** (`internal/service/court_admin_service.go`,
   `internal/handler/court_api.go`): `GET /admin/courts` (managers, incl.
   closed), `POST /admin/courts` and `PUT /admin/courts/:id` (admins: add,
   rename, open/close, off-peak-only; type and half-court share fixed).
   Never deleted. Closing reports `upcoming_bookings` (not auto-cancelled).
   Duplicate names refused. Audited. Admin panel courts tab uses them in API
   mode; the delete-court button is gone in both modes (toggle instead);
   managers see the list but can't add/toggle (they use closures). The
   "จองครึ่งสนามได้" checkbox was misleading - it makes the court a half
   court priced at the half-court rate - relabelled.
2. **Opening hours:** `PricingConfig.OpenHour/CloseHour` (default 7/23,
   0 <= open < close <= 24) via `PUT /admin/pricing-config`
   (`open_hour`, `close_hour`). Booking checks them (`checkOpenHour`);
   `hourSlotEnd` now only validates the format, so bookings made before the
   hours changed stay valid. Pricing rules may cover any part of
   00:00-24:00 (they still decide which hours each sport is open); an hour
   inside the opening hours with no rule now says "no price set for that
   hour" instead of "outside opening hours". Dashboard hours follow the
   setting. Frontend: `openingHours()` / `openSlotHours()` in mockData
   replace `OPENING_HOUR`/`CLOSING_HOUR`; customer, staff and admin grids,
   closure hour pickers and occupancy use them; `calculatePrice` treats
   hours outside them as closed. Admin → Pricing has "เวลาเปิดให้จอง"
   (admin only), warning which sport/day hours have no price rule yet.
3. **User delete:** hidden in API mode (suspend instead, records kept).
   Removed the dead `operatingHours` state from the Admin panel.

### Verified
- `go build`, `go vet`, `go test ./...` (new `TestCheckOpenHour`, rule
  test updated: 06:00 / 22-24 rules now valid), `tsc`, vitest 29/29.
- Live API (`/var/tmp/e2e7.sh`): 06:00 refused at 07-23; manager can't
  change hours (403); open > close refused; at 06-24 a 06:00 slot without a
  rule refused, with a 06-07 rule booked; back to 07-23 refused again;
  dashboard hours follow. Courts: manager list OK / create 403; admin
  create → in public list and bookable; duplicate name and unknown type
  refused; close → `upcoming_bookings: 1`, gone from public list, booking
  refused; rename + reopen; audit COURT_CREATED/COURT_UPDATED.
- Playwright (`/var/tmp/e2e/ui8.cjs`, API mode): admin sets 06-24 → warning
  lists unpriced hours → customer grid 06:00-23:00 (18 columns); new court
  appears in the customer grid, closing it removes it; no delete-court or
  delete-user buttons; manager: no add form, toggles disabled, no Pricing
  tab; reset to 07-23 → 16 columns. Smoke test both modes: no errors.

### Not done / follow-ups
- Closing a court doesn't move/cancel its upcoming bookings (count shown).
- Shift open/close (FR-6.1/6.2) and voiding counter orders, as before.

---

## 2026-10-20 — Counter sales, rentals and admin reports on the server

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `6856bcd` (on `main`, parent `cd31b74`)
- **Background:** The owner asked to fix the first two "still weird" items:
  (1) in API mode the admin dashboard, CSV report and audit log read the
  browser's localStorage; (2) F&B sales and rentals lived only in the
  counter's browser and were missing from the cash drawer.

### Changed
1. **Counter shop on the backend** (`internal/service/pos.go` rewritten,
   `internal/handler/shop_api.go` new). `GET /staff/products` (with shoe
   sizes), `POST /pos/order` (prices from the catalog, stock locked +
   decremented per product and per shoe size, `customer_phone` → points 1 per
   100 THB, rental orders stay `PREPARING`, audit `ORDER_CREATED`),
   `GET /staff/orders?date=`, `GET /staff/rentals`,
   `POST /staff/rentals/items/:id/return` (restocks the size, closes the
   rental when all items are back, refuses a second return). Managers:
   `GET/POST /admin/products`, `PUT /admin/products/:id`,
   `POST /admin/products/:id/stock` (reason required, per size for shoes,
   never below 0, audited). New `ErrOutOfStock` → 409. Catalog seeded like
   `DEFAULT_PRODUCTS` (shoes = 20 size/gender variants). Removed the unused
   `repository/product.go` and the old checkout handler.
2. **Cash drawer:** `GET /staff/summary` now adds `orders_cash`,
   `orders_promptpay`, `fb_sales`, `equipment_sales`, `rental_income`,
   `orders_count`; the Staff POS "ยอดลิ้นชัก" uses them in API mode.
3. **Reports on the backend** (`internal/service/report_service.go`):
   `GET /admin/dashboard?date=` (day revenue/occupancy, all-time totals,
   pending revenue, refunds, 6-month revenue, 30-day hourly occupancy,
   counter sales split, month by sport), `GET /admin/report?month=`
   (bookings with their group's payment + orders with lines),
   `GET /admin/audit-logs` (admin only, search/type filter). The Admin
   panel uses them in API mode; the "reads this browser" notices are gone.
   Managers no longer see the audit tab in API mode (RBAC: admin only).
4. **Staff POS (both modes):** member points by typing the phone (staff
   can't list users in API mode); rentals use the product's price (the
   free-typed rental price is gone) and the product's size variants (the
   separate `shoe_inventory` list, which disagreed with the product data, is
   gone); rental list shows every item still out with its own return
   button; receipts show 2-decimal amounts and product names from the
   server. **Shuttlecocks couldn't be sold:** the equipment-sales tab had no
   button; for-sale equipment now shows in the "F&B / ลูกแบด" tab and an
   all-equipment cart is recorded as `EQUIPMENT_SALE` (was always `FB`).
   Today's orders are matched by local date (UTC strings were off before
   07:00 Bangkok; new `localDateOf` in mockData).
5. **Admin panel:** product create/stock/Excel import go to the server in
   API mode; stock changes ask for a reason and, for shoes, a size; new
   equipment is a rental only if "ให้เช่า" is ticked (form) or the template's
   เช่า column is TRUE (Excel) — before, every EQUIPMENT item became a
   rental. Two CSV exports: bookings and counter sales; dashboard shows
   pending revenue and refunds.

### Verified
- `go build`, `go vet`, `go test ./...` (new `pos_test.go`), `tsc`, vitest 29/29.
- Live API (`/var/tmp/e2e6.sh`): customer 403 on staff products/orders;
  F&B sale with member phone → prices from catalog, stock down; 1,300 THB
  sale → +13 points; qty 0 / over stock / rental item in a sale / shoes
  without size refused; shoe+racket rental → PREPARING, same size again
  refused (0 left), return → still open, second item → DELIVERED, stock
  back, double return refused; manager create / restock (reason required,
  no negative) / per-size restock / deactivate (gone from staff list);
  staff 403 on admin endpoints; drawer summary includes orders; dashboard
  and month report numbers checked against the DB; audit-logs 403 for
  manager, filters work for admin. Race: 5 parallel rentals of the last
  pair → one 200, four 409, stock 0.
- Playwright (`/var/tmp/e2e/ui7.cjs`) in API and local mode: sale with
  phone, rental by size, return, drawer, dashboard cards, per-size stock
  +10 with reason, both CSV downloads, audit tab (server logs, hidden for
  manager). Click-through smoke test both modes: no errors, no failed API
  calls. Voucher test (`e2e5.sh`) still passes.

### Not done / follow-ups
- Shift open/close (FR-6.1/6.2: opening float, counted cash, over/short)
  does not exist anywhere in the UI — not "browser-only", simply missing.
- Orders can't be voided/refunded yet (no endpoint or button).
- The courts tab, operating hours and user deletion in the Admin panel are
  still localStorage-only in API mode.
- Frontend actions that only the browser knew (`REPORT_CSV_EXPORTED`,
  receipt printed) are not in the server audit log.
- FR-7.4 asks for `.xlsx`; exports are CSV (opens in Excel).

---

## 2026-10-20 — Staff can use the free-hour reward; UX clean-up (fake dashboard data, wording)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `cd31b74` (on `main`, parent `80ec384`)
- **Background:** The owner asked to "allow the staff to use the reward"
  (the free 1-hour off-peak court voucher could be redeemed but never used)
  and "is the UI easy to use? anything weird?".

### Changed
1. **Free-hour voucher → booking.** New payment method `VOUCHER`
   (`model.PaymentVoucher`, `PaymentMethod.VOUCHER`); reward catalog items
   have a `kind` (`ITEM` / `FREE_OFFPEAK_HOUR`, `rw-hour` migrated);
   vouchers record the `booking_id` they paid for. `POST /staff/bookings`
   with `payment_method: VOUCHER` + `voucher_code`: exactly one hour, off-peak
   only, booked for the voucher's owner, 0 THB, confirmed at once, no points,
   voucher locked and set REDEEMED in the same transaction. `/dispense`
   refuses free-hour vouchers. Cancelling the booking re-activates the
   voucher and never records a refund. `booking_service.go`,
   `booking_admin.go`, `reward_service.go`, `booking_api.go`, `main.go`.
2. **Staff POS.** Walk-in has a third option "🎟️ คูปองชั่วโมงฟรี" with a
   code box; the voucher tab shows "🏸 ใช้จองชั่วโมงฟรี" for a free hour,
   which opens the walk-in form with the code, name and phone filled in.
   Same rules in browser-only mode (localStorage `redemptions`, reward ids
   in `FREE_HOUR_REWARD_IDS`). Cancel skips the refund question when
   nothing was paid. Customer voucher list explains how to use the hour.
3. **Points fix found while testing:** cancelling or marking no-show on a
   0-THB hour took back a point that was never given. Only hours with an
   amount > 0 are reversed now (backend and local mode).
4. **Admin dashboard showed made-up numbers:** a fixed 28% occupancy when
   nothing was booked, a revenue chart generated from a formula (340,000 THB
   bars next to a 400 THB all-time total), a fixed peak-hour curve, a fake
   70/30 drink/snack split, and a default date of 2026-06-20. All now come
   from recorded bookings/orders (occupancy = sold court-hours ÷ physical
   courts × 16 h, half courts count half), default date = today. Reports
   tab: month/year default to now, the year list had a broken value
   (`2570` instead of 2027), and the CSV ignored the month, had no quoting
   (commas in names broke rows, `=` could run as a formula) and no BOM (Thai
   garbled in Excel) — fixed, with payment method/status/refund columns.
5. **API mode honesty:** dashboard, CSV report and audit-log tabs still read
   localStorage; they now say so (TODO.md item 5 for server endpoints).
   Local audit entries are named after the signed-in user, not always
   "คุณ กิตติ"/"คุณ วิชัย"; Staff POS header shows the real user and role.
6. **Wording/visual:** "สนามบิน" (airport) → "สนาม" in closure alerts;
   booking-history subtitle said "ร้านอาหาร" (restaurant); role-save alert
   said "สภากรรมาธิการ"; removed the "Download ZIP" header link (the file
   doesn't exist) and the "100% Client-Side Sandbox" footer (now says which
   mode is running); the mobile "please log in" overlay was hidden behind
   the sticky court-name column.

### Verified
- `go build`, `go vet`, `go test ./...` pass; `tsc --noEmit` clean; vitest
  29/29.
- Live API (`/var/tmp/e2e5.sh`): free-hour lookup kind, dispense refused,
  peak hour refused, 2 hours refused, water voucher refused, no code
  refused, off-peak → 0 THB VOUCHER VERIFIED CONFIRMED 0 points booked for
  the owner (not the typed phone), reuse refused, manager cancel with
  refund=true → refund 0, voucher ACTIVE again, points unchanged, rebook OK.
- Playwright both modes: voucher tab → "ใช้จองชั่วโมงฟรี" → prefilled form
  → peak refused → off-peak booked, success banner; local cancel → no refund
  prompt, voucher ACTIVE. Click-through smoke test of all tabs in both modes:
  no page errors, no failed API calls. Screenshots of dashboard/CSV checked.

### Not done / follow-ups
- Server-side admin dashboard/report/audit log and server-side F&B/rental
  orders (TODO.md item 5).
- UX items reported to the owner but not changed: the role-switcher
  ("Simulator Controls") is the only navigation and is visible to customers;
  booking grid is a wide table on phones (TODO item 3); many 7–10 px fonts;
  cancel/refund use browser prompt()/confirm() chains; lots of alert()s;
  receipt prints a VAT 7% breakdown with no tax ID; the grid is hidden until
  login so customers can't check availability first; dates are shown in
  Buddhist years in some places (header clock, receipts) and ISO Gregorian
  in others (dashboard, booking codes).

---

## 2026-10-20 — Cancellations & refunds, late payments, rewards, cash, 2-decimal prices, statuses, booking window

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `80ec384` (on `main`, parent `8f1f20f`)
- **Background:** The owner asked to fix the "things that don't make sense"
  list: 1 cancel/refund, 2 late payments, 3 reward redemption, 4 cash,
  5 rounding to 2 decimals, 6 use the unused statuses, 7 a configurable
  booking window (1 month); 8 password reset by phone → TODO only; 9 LINE →
  later (already in TODO).
- **Interpretation of #4:** any staff may take cash for a walk-in (FR-5.1);
  additionally managers/admins can record that an existing unpaid booking
  was paid in cash. Say if only managers/admins should take cash at all.

### Changed
1. **Cancel / refund (FR-6.3).** `POST /admin/bookings/:id/cancel` (manager/
   admin; reason required; whole group or chosen hours; `refund` records the
   paid hours as refunded), `POST /admin/payments/:id/refund` (refund a
   payment no booking stands for). Points for cancelled confirmed hours are
   taken back (never below zero; ledger type `REVERSE_BOOKING`). New
   `payments.refund_amount`; status `REFUNDED` once it covers the amount.
   UI: "✖ ยกเลิก / คืนเงิน" in the Staff POS booking detail (managers), and
   after creating a closure the Admin panel offers to cancel the overlapped
   bookings with refunds. Customer history shows "คืนเงินแล้ว X บาท".
   `internal/service/booking_admin.go`, `internal/handler/lifecycle_api.go`.
2. **Late payment.** Expired holds now get payment status `EXPIRED` (+
   `expired_at`) instead of `REJECTED`; old rows are migrated at startup.
   The customer can still send a slip for it (history button "โอนแล้วแต่
   หมดเวลา? ส่งสลิป"; the payment page hides the QR and says not to pay
   again). The slip shows in the staff queue as "⚠️ ส่งสลิปหลังหมดเวลา";
   approving it re-books the same slots if all are still free (same checks
   and locks as a new booking), otherwise it fails with "refund the customer
   instead" and a manager uses "💸 คืนเงิน".
3. **Rewards in API mode.** Seeded catalog; `GET /rewards`,
   `POST /me/rewards/:id/redeem` (points deducted via the ledger, voucher
   `RW-XXXXXX` valid 30 days), `GET /me/vouchers`, staff
   `GET /staff/vouchers/:code` and `POST …/dispense` (once only; expired
   vouchers refused). New Staff POS tab "🎁 รับของรางวัล" (both modes).
   `internal/service/reward_service.go`.
4. **Cash.** Walk-in form offers cash again (confirmed at once, counted in
   the drawer) and PromptPay (QR + confirm). Managers/admins: "💵 รับเงินสดแล้ว"
   on an unpaid booking (`POST /admin/bookings/:id/mark-cash`). The drawer
   report no longer hard-codes "0 cash"; in API mode it uses the new
   `GET /staff/summary` (money approved today by method, refunds today).
5. **Prices to 2 decimals** (NFR-4): `RoundBaht` in Go and `roundBaht` in TS
   (same results); totals rounded to the satang; displayed with
   `formatBaht` ("212.50", "1,530").
6. **Statuses in use:** `COMPLETED` set automatically every minute once a
   confirmed hour has ended; `NO_SHOW` set by staff on a started hour
   ("🚫 ไม่มาใช้สนาม", takes back that hour's point, payment kept);
   payment `REFUNDED` and the new `EXPIRED`; voucher `REDEEMED`/`EXPIRED`.
   Revenue/occupancy counts treat COMPLETED and NO_SHOW as paid.
7. **Booking window:** online bookings up to `max_advance_days` ahead
   (default 30, admin-editable 1–365 in Admin → Pricing; stored in
   `pricing_config`); the date picker is limited to it; counter bookings
   aren't limited.
8. **TODO.md** item 4: password reset by phone number (not built).

### Verified
- `go vet`, `go test`, `tsc`, `vitest` 29/29, `vite build`.
- Live backend + PostgreSQL: student half court 212.5 THB and QR amount
  "212.50"; +31 days refused online, +30 OK, counter OK, admin sets 60
  (manager 403); late payment with free slot → EXPIRED → late slip →
  staff approve re-books both hours with points; late payment with taken
  slot → approval 409 "refund instead", staff refund 403, manager refund →
  REFUNDED; 3-hour cash group: cancel one hour with refund (162, 1 point
  back, payment still VERIFIED) then the rest (REFUNDED); staff cancel 403,
  no reason 400; manager records cash on an online booking (staff 403);
  no-show on the current hour (point back), on tomorrow's hour refused;
  confirmed booking moved to yesterday → COMPLETED by the minute job;
  rewards: redeem 25-point reward, second attempt "not enough points",
  vouchers list, customer can't look codes up, staff dispense once, expired
  voucher refused; day summary splits cash/PromptPay/refunds. All earlier
  scenarios from previous entries re-run unchanged.
- Browser (Playwright), API mode: date picker max = today+30, then +45 after
  the admin changed it; half court shows "212.50฿"; redeem → code shown →
  staff voucher check → handed over → "รับไปแล้ว"; cash walk-in confirms
  with no QR; expired booking shows "หมดเวลาชำระ", payment page without QR,
  late slip upload, staff queue late badge + manager refund button, approval
  OK; manager records cash, cancels one of two hours with refund, marks a
  no-show; drawer shows cash/QR/refunds; plain staff sees no manager
  actions; closure over a paid booking → cancel + refund offered and done.
  Browser-only mode: cash walk-in, manager cancel with refund, points back.
  Click-through of every tab in both modes: no errors, no failed API calls.

### Not done / follow-ups
- Refunds are records: the money is transferred back by staff outside the
  system.
- The "free off-peak hour" reward is handed out as a voucher; booking that
  hour at 0 THB isn't automated (staff book it and the voucher is marked
  used).
- Password reset by phone (TODO.md 4) and LINE (TODO.md 1–2).
- In browser-only mode there is no payment expiry, so no late-payment flow.

---

## 2026-10-20 — Full re-verification from a clean clone; 4 more fixes

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `8f1f20f` (on `main`, parent `eb131fc`)
- **Background:** The owner asked whether everything really works. Everything
  was re-run from a fresh clone of `main`, started with the real
  `npm run dev:api` against an empty database. That found four problems.

### Changed
- **Slip deleted itself on a quick re-upload** (existing bug): files were named
  payment id + timestamp, so two uploads within one second (a double-click)
  got the same name; the second overwrote the first and the "delete the old
  slip" step then deleted the new one. Names now use a random part, and the
  old file is only deleted if it is a different file.
  `golang-backend/internal/handler/handlers.go`.
- **First unknown-account login was slower** (131 ms vs ~65 ms), a small
  leak of "this account doesn't exist": the dummy password hash is now built
  at startup. `internal/service/auth_service.go`.
- **Dev runner kept running when only npm was stopped** (IDE stop button,
  `kill <npm pid>`): npm doesn't pass SIGTERM through its shell. The runner
  now shuts down when its parent process goes away (and on SIGHUP).
  `dev-runner.js`.
- **No way to log out of the Admin panel in API mode** (existing gap): once
  a manager signed in there, switching to the admin account needed clearing
  browser storage. The header now shows who is signed in with a log-out
  link. `src/components/AdminPanel.tsx`.

### Verified (all from a clean clone / fresh database)
- `go vet`, `go test` (no cache), `tsc`, `vitest` 28/28 (also with
  `TZ=America/New_York`), `vite build`.
- `npm run dev:api`: seeding reports "verified"; every API scenario from the
  last two entries re-run and matched (cap, duplicate slip, slip version,
  member tier, walk-in flow, phones, points, current-hour rule, limits, POS
  quantities and codes, email case, 6 parallel bookings → 3, closure waits
  for an in-flight booking, 413s, roles, suspension, IP-scoped lockout).
- Re-upload within the same second → link 200, one file on disk.
- First unknown-account login 65 ms vs known account 64 ms.
- Dev runner: SIGTERM to npm only → 0 processes left; real Ctrl+C (SIGINT to
  the foreground process group) → 0 left; port clash on 8080 → it stops the
  rest instead of half-running.
- Login lock shared between two backend instances on one database.
- Browser click-through of every customer sport tab, every Staff POS tab and
  every Admin tab (as manager: 6 tabs, then log out and as admin: 8) in API
  mode, and all tabs in browser-only mode: no page errors, no console errors,
  no failed API calls. End-to-end flows (online booking + history, walk-in
  with QR + confirm, tier/points changes, promote + suspend, browser-only
  approve/reject/closed hours) all pass.

### Not verified (can't be from here)
- Scanning the QR with a real Thai banking app (payloads match the
  `promptpay-qr` reference library byte for byte, and the rendered image
  decodes to them).
- The dev runner on Windows (the `taskkill` path).
- Running behind a real reverse proxy / HTTPS.

---

## 2026-10-20 — Close the remaining review items (5, 10–22) and the follow-ups

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `eb131fc` (on `main`, parent `f644839`)
- **Background:** The owner asked to fix everything still open: items 5 and
  10–22 from the first review, plus the follow-ups listed in the previous
  entry (in-memory login limits, staff roles / suspension in API mode).

### Changed
- **5 POS negative quantities:** each line must be 1–100; order type and
  payment method are validated (400). `internal/service/pos.go`.
- **10 Unpaid cap raced by parallel requests:** the cap is re-checked inside
  the booking transaction with the customer's row locked (`FOR UPDATE`), so
  simultaneous bookings by one customer run one after another.
  `internal/service/booking_service.go`.
- **11 Closure created mid-booking:** bookings take a shared per-date
  advisory lock and re-read closures inside their transaction; creating a
  closure takes the same lock exclusively, so it waits for in-flight
  bookings (which then show up as affected) and blocks new ones until it is
  committed. `booking_service.go`, `day_off_service.go`.
- **12 Huge uploads hit the disk before the size check:** new `LimitBody`
  middleware caps bodies before anything reads them (slip uploads 5 MB +
  framing, everything else 1 MB); oversize → 413.
  `internal/handler/middleware.go`, `handlers.go`.
- **13 Email case:** emails are stored lower-case, compared ignoring case,
  and unique on `lower(email)`. `repository/user.go`, `auth_service.go`, `main.go`.
- **14 Repeating receipt codes:** `REC<date>-<random>` checked for uniqueness,
  like booking codes. `pos.go`.
- **15 DB hiccup broke public pages for logged-in users:** a failed session
  lookup now continues as anonymous; login-only routes answer 503 instead of
  401 (which made the frontend drop the session). `middleware.go`.
- **16 Seeding ignored errors:** every seed write is checked and reported;
  "verified" is only logged when all succeeded; a missing pricing config
  stops startup. `main.go`.
- **17 Invalid CORS:** no more `Allow-Credentials` with `*` (the API uses
  bearer tokens); optional `CORS_ALLOWED_ORIGINS` allowlist. `main.go`,
  `.env.example`.
- **18 `npm run dev` needed Go:** the dev runner only starts the backend in
  API mode, and in API mode checks for Go first with a clear message.
  `dev-runner.js`.
- **19 Dev runner left processes running:** children run in their own
  process groups and the whole group is stopped (then force-killed after
  5 s), including the binary `go run` starts; if one side exits, the other
  is stopped too. `dev-runner.js`.
- **20 DB password in two places:** removed from `main.go`; without a `.env`
  the server loads `.env.example`, and with no `DATABASE_URL` at all it stops
  with a clear message.
- **21 Weekday off by one west of UTC:** `getDayType` reads the calendar date
  in UTC. `src/mockData.ts`.
- **22 Booking history re-scanned everything per row:** lookups are built
  once with `useMemo`; the list also uses Bangkok time instead of the
  browser's clock. `src/components/CustomerPanel.tsx`.
- **Login limits (follow-up):** stored in a new `login_failures` table
  (hashed keys, pruned every minute) so they survive restarts and work
  across instances. Lockout is now harder to abuse: 5 failures lock the
  account only from that IP, 20 from anywhere lock the account, 50 lock an
  IP. `internal/service/login_throttle.go`, `model.LoginFailure`.
- **Roles and suspension in API mode (follow-up):** new admin-only
  `PUT /admin/users/:id/role` and `PUT /admin/users/:id/active` (audit-logged;
  nobody can change their own). The Admin users tab uses them; managers keep
  tier and points only. Accounts are never deleted through the API (their
  bookings and points history must stay) - suspend instead.
  `user_service.go`, `handlers.go`, `src/api.ts`, `AdminPanel.tsx`.

Docs: README.md, golang-backend/README.md, .env.example, TESTING_CHECKLIST.md.

### Verified
- `go vet`, `go test ./...` pass (new: DB-backed throttle logic with the
  per-IP/per-account rules and pruning; middleware during a DB outage →
  public 200 / protected 503). `tsc` clean; `vitest` 28/28, also with
  `TZ=America/Los_Angeles` (the old `getDayType` fails 2 tests there).
  `vite build` succeeds.
- Live backend + PostgreSQL 16: qty -5/0/101 → 400; three parallel POS
  sales → three different receipt codes; `John@Gmail.com` stored lower-case,
  re-register with other case refused, login in capitals works; 6 parallel
  bookings by one customer → exactly 3 created, 3 × 429; a closure waited
  ~2.5 s for an in-flight booking lock, then later bookings into it were
  refused; 50 MB upload → 413 in 1 ms, no temp files; 2 MB JSON → 413; CORS
  header only for the allowed origin; manager promote 403, admin promote OK,
  self-demote 403, promoted user reaches the staff queue, suspension makes
  their token 401 and login fail; 5 failures from one IP lock it while the
  owner logs in from another IP; the lock survives a backend restart; seed
  logs "verified".
- Dev runner: `npm run dev` works with Go removed from PATH; Ctrl+C frees
  port 3000; `--api` serves on 8080 and 3000 through the proxy, Ctrl+C stops
  the compiled Go binary too; backend falls back to `.env.example`.
- Browser (API mode): 2-hour booking shows one upload button in history;
  admin promotes a customer to STAFF and suspends them from the users tab;
  own role select is disabled.

### Not done / follow-ups
- Slip duplicates are caught only for identical files; matching the bank's
  transaction reference needs a third-party slip-verification service and an
  account with it.
- Deleting users through the API is intentionally not offered (suspend).
- Still browser-only in API mode (documented in README): POS / F&B /
  rentals, reward redemption, password reset, courts, products, operating
  hours.

---

## 2026-10-20 — Second review: fix findings 1–5 and 7–16; managers keep closures

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `f644839` (on `main`, parent `772ab1a`)
- **Background:** A second review produced 16 findings. The owner decided #6
  (managers creating/deleting court closures) is allowed, so the spec was
  changed instead of the code, and asked for everything else to be fixed.

### Changed
1. **Unpaid-booking cap bypassed by uploading any image.** The cap now counts
   groups awaiting a slip *or* awaiting staff review (3 max).
   `golang-backend/internal/service/booking_service.go` (`countUnpaidGroups`).
2. **One slip reused for several bookings.** Each upload's SHA-256 is stored
   (`payments.slip_hash`, not exposed in JSON); the same file on another
   payment that isn't REJECTED is refused (409), backed by a partial unique
   index (`ensurePaymentSlipIndex` in `main.go`). Only byte-identical files
   are caught — a re-screenshot isn't; real protection needs a bank
   slip-verification service (not done).
3. **Walk-ins confirmed before any money arrived, at the wrong price.**
   PromptPay walk-ins are now created PENDING_PAYMENT; the Staff POS shows
   the server's amount (member price) and QR, and staff press "ได้รับเงินแล้ว"
   (calls verify, which awards the points) or cancel. Cash walk-ins are still
   confirmed at once. Unconfirmed ones expire after 30 min. Same flow in
   browser-only mode. `booking_service.go`, `src/components/StaffPOS.tsx`.
4. **`+66…` phones didn't match `0…`.** `NormalizePhone` (Go and TS) now
   rewrites 66/0066 to the leading 0 (mobile and landline); SQL lookups use
   the same canonical form so old rows stored with dashes or +66 still match.
   `internal/repository/user.go`, `src/mockData.ts` (`normalizePhone`).
5. **Login locked out the newer of two duplicate-phone accounts.** Login now
   tries the password against every account with that phone/email
   (`FindByIdentity`); startup logs duplicate phones so they can be merged.
6. **Spec only:** REQUIREMENTS.md RBAC matrix and FR-1.3 now give closures to
   Manager and Admin (matches the code).
7. **No login rate limit.** New in-memory `LoginThrottle`: 5 failures per
   account / 50 per IP in 15 minutes → 429 with Retry-After. Unknown accounts
   now run a dummy bcrypt so response time doesn't reveal who is registered.
   Gin only trusts `X-Forwarded-For` from `TRUSTED_PROXIES` (new env var).
   `internal/service/login_throttle.go`, `auth_service.go`, `main.go`.
8. **Slip images were public.** `/uploads` is no longer served; slips are
   fetched via signed, expiring links (`/api/v1/slips/<file>?exp&sig`, 1–2 h)
   handed only to the owner and staff. `internal/handler/slips.go`; Vite
   proxy entry for `/uploads` removed.
9. **Slip could be swapped while staff reviewed it.** Verify/reject now send
   the `slip_uploaded_at` staff saw; a newer slip → 409 "replaced this slip".
10. **Manual points: no reason, actor stored as an id, self-adjust allowed.**
    Reason required (audit log + ledger note), actor name logged, own
    balance and non-customers refused; overdraw is a 409. The Admin users
    tab's ±1 buttons now call this API in API mode (with a reason prompt).
11. **Online booking of an hour already in progress.** Refused online (the
    counter can still sell it); the customer grid shows "⌛ หมดเวลาจอง", the
    staff grid marks finished hours. Times judged in Asia/Bangkok
    (`slotTiming` in `src/mockData.ts`).
12. **100% discount / 0 THB price → 0.00 QR.** Discounts must be < 100,
    rule prices > 0, and a booking total of 0 is refused (server and UI).
13. **Checkout summary looked up courts in localStorage.** `calculatePrice`
    now takes the court object itself (signature change; all callers updated).
14. **Rules could cover hours that can't be booked.** Opening hours are now
    one constant pair (07:00–23:00, `OpeningHour`/`ClosingHour` in Go,
    `OPENING_HOUR`/`CLOSING_HOUR` in TS) used by booking validation, rule
    validation, the rule form and both grids.
15. **One bad payment stopped the expiry job.** It now processes payments
    oldest first, carries on past errors (reported together), and counts
    only committed expiries.
16. **No way to set a customer's tier in API mode.** New `GET /admin/users`
    and `PUT /admin/users/:id/member-type` (manager/admin, audit-logged); the
    Admin users tab uses them in API mode. Role changes / suspend / delete
    are still not available there (shown as disabled).

Also fixed while in these files:
- Student/Corporate discount labels were swapped (shown 20% / 15%, spec says
  15% / 20%) in the customer profile and the Admin users tab; labels now come
  from the configured tiers (`memberTierLabel`).
- The Staff POS walk-in date jumped back to today after every action.

Docs: README.md, golang-backend/README.md (routes, slips, walk-in flow, login
limits), golang-backend/.env.example (`TRUSTED_PROXIES`), TESTING_CHECKLIST.md
(new and changed checks), REQUIREMENTS.md (#6).

### Verified
- `go vet`, `go test ./...` pass; new tests: phone normalization, login
  throttle, slip-version check, signed slip links (valid/tampered/expired/
  wrong key), booking start rules, opening hours, rule validation.
- `tsc --noEmit` clean; `vitest` 28/28 (new: phone, Bangkok slot timing with a
  mocked clock, tier labels, court-object pricing); `vite build` succeeds.
- Live backend + PostgreSQL 16, every finding reproduced then re-tested:
  cap with an uploaded slip → 429; same slip on a second booking → 409;
  signed link 200 (image/png) / tampered 403 / old `/uploads` path 404;
  verify with a stale slip version → 409, current → OK; PromptPay walk-in
  for a corporate member → 144 THB, PENDING, 0 points, then verify → +1;
  cash walk-in → confirmed +1; `+66 87 777 6666` stored as `0877776666` and
  logs in as `087-777-6666`; newer duplicate-phone account logs in; points
  without reason 400 / self 403 / overdraw 409 / audit shows name + reason;
  online booking of the current hour refused, walk-in allowed; discount 100,
  23–24 rule, 0-price rule, 06:00 booking all 400; manager closure 201;
  6th login after 5 failures → 429 even with the right password, other
  accounts unaffected; unknown vs known account login ~63 ms each; expiry
  job cancelled a stale 2-hour group with an orphaned payment queued ahead.
- Browser (Playwright): customer grid "⌛ หมดเวลาจอง" for the current hour;
  tier label 20% for corporate; staff walk-in panel shows member price + QR,
  confirm awards the point; slip link opens through the app; manager users
  tab shows correct percentages, role select disabled, tier save and +1
  points (with reason) work; browser-only walk-in waits for payment and can
  be cancelled; earlier regression flow (3-hour approve, reject, closed
  hours) unchanged.

### Not done / follow-ups
- Slip duplicates are caught only for identical files; matching the bank's
  transaction reference needs a slip-verification service.
- Login limits are per process (in memory); several backend instances would
  need a shared store (e.g. Redis).
- In API mode, staff roles, suspending and deleting users still need the
  database directly.
- Still open from the first review: 5, 10–22 (see the entry below).

---

## 2026-10-20 — Fix review findings 1–4 and 6–9 (QR, prices, walk-ins, slip approval)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** `772ab1a` (on `main`, parent `54ff9d5`)
- **Background:** A code review produced 22 findings. The owner asked for
  1–4 and 6–9 to be fixed now; for #6 they chose to *hide* the pricing tabs
  from managers rather than allow managers to edit prices.

### Changed
1. **PromptPay QR with a phone-number merchant ID was unpayable** (backend).
   `0812345678` was rewritten to `0066812345678` and then, being 13
   characters long, encoded as a tax ID (sub-tag 02). The ID type is now
   decided before reformatting; dashes/spaces/`+66` are accepted; field
   lengths are computed instead of hard-coded; an invalid `PROMPTPAY_ID`
   stops the server at startup instead of producing bad QR codes.
   QR payloads are now only built for PromptPay payments (not cash walk-ins).
   Files: `golang-backend/internal/pkg/promptpay/promptpay.go` (+ new
   `promptpay_test.go`), `internal/service/payment_service.go`,
   `internal/service/booking_service.go`, `main.go`.
2. **Half-court toggle halved the full court's price** (frontend). The toggle
   is removed; a court is half-price only if it is a half-court (B/C,
   `shareOfGroup < 1`), the same rule the server uses. The basketball panel
   now explains "pick court B or C for half court". Files:
   `src/mockData.ts` (`calculatePrice`), `src/components/CustomerPanel.tsx`.
3. **`golang-backend/.env` overrode `npm run dev:api`'s settings** (backend).
   `loadEnv` no longer overwrites variables already set in the environment
   (standard dotenv behaviour), so the dev runner's `PORT=8080` and
   `SEED_DEMO_USERS=true` win. The dev runner no longer injects its own
   `DATABASE_URL`, so the one in `.env` is still used. Files: `main.go`,
   `dev-runner.js`, `golang-backend/README.md`.
4. **Walk-ins didn't recognise members who registered with dashes** (backend).
   Phones are now stored digits-only at registration (min. 9 digits), and
   phone lookups (login, duplicate check, walk-in member lookup) compare
   digits only — including accounts created before this fix, whose stored
   phone may still contain dashes. Files: `internal/repository/user.go`
   (`NormalizePhone`, `GetByIdentity`, new `GetByPhone`),
   `internal/service/auth_service.go`, `internal/service/booking_service.go`,
   `internal/handler/handlers.go`.
6. **Managers saw Pricing / Membership-discount tabs whose saves always
   failed** (frontend). Hidden for a MANAGER login in API mode (the server
   only lets ADMIN change prices). Browser-only mode is unchanged. File:
   `src/components/AdminPanel.tsx`.
7. **Browser-only mode: approving a multi-hour slip confirmed only the first
   hour; rejecting left the other hours pending forever** (frontend). Approve
   and reject now act on every pending hour of the booking group (same code,
   customer and date, like the backend), award 1 point per confirmed hour,
   and refuse a payment that was already handled. Files: `src/mockData.ts`
   (new `bookingGroupOf`), `src/components/StaffPOS.tsx`.
8. **Browser-only mode QR was invalid** ("MOCK" checksum) (frontend). Replaced
   with a real generator identical to the Go one. File: `src/mockData.ts`.
9. **Price grid showed prices for hours the server treats as closed**
   (frontend). `calculatePrice` no longer falls back to another rule or 200 ฿;
   an hour no active rule covers returns `isOpen: false` and both the customer
   and staff grids show it as "closed" and refuse to book it. Files:
   `src/mockData.ts`, `src/components/CustomerPanel.tsx`,
   `src/components/StaffPOS.tsx`.

### Verified
- `go vet ./...`, `go test ./...` pass; new tests check the QR payload
  byte-for-byte against the independent `promptpay-qr` npm package (v0.5.0),
  including the CRC-16 standard check value.
- `npx tsc --noEmit` clean; `npx vitest run` 24/24 pass (7 new tests: QR,
  full court not halved, closed hours, booking group). `vite build` succeeds.
- Backend run against a local PostgreSQL 16:
  - with a `.env` containing `PORT=9999`, `SEED_DEMO_USERS=false` and the
    environment setting `PORT=8099`, `SEED_DEMO_USERS=true` → listened on
    8099 and seeded demo users; `.env`'s `DATABASE_URL`/`PROMPTPAY_ID` still applied;
  - register `089-111-2222` → stored `0891112222`; registering `0891112222`
    again → 409; login with `089 111 2222` works; walk-in typed `0891112222`
    → member found, STUDENT price 153 ฿, +1 point; a pre-existing row stored
    as `082-222-3333` is also found from `0822223333`;
  - `PROMPTPAY_ID=0812345678` → booking QR uses sub-tag `01 0066812345678`;
    `PROMPTPAY_ID=12345` → server refuses to start.
- Browser checks (Playwright, Chromium):
  - browser-only mode: no half-court toggle; full court A 425 ฿ (student),
    half court B 213 ฿; the rendered QR image decodes to exactly the reference
    library's payload; a 3-hour group approved → all 3 hours CONFIRMED and +3
    points; a 2-hour group rejected → both hours CANCELLED; after deleting the
    weekday 22:00–23:00 badminton rule, 22:00 shows "closed" in both grids;
  - API mode: manager login shows no Pricing / Membership tabs; admin sees both.

### Not done / follow-ups
Still open from the same review (not fixed in this change):
5 POS accepts negative quantities · 10 unpaid-booking limit can be raced ·
11 a closure created mid-booking may not block it · 12 large slip uploads
are written to disk before the 5 MB check · 13 email login is
case-sensitive · 14 POS receipt codes repeat · 15 DB hiccup fails public
pages for logged-in users · 16 startup seeding ignores errors · 17 CORS
settings invalid cross-site · 18 `npm run dev` needs Go even in
browser-only mode · 19 dev runner can leave processes running · 20 default
DB password in two places · 21 weekday detection off by one west of UTC ·
22 booking history re-scans on every render.

Notes for whoever picks this up:
- Existing users whose phone was stored with dashes are found by
  digits-only comparison but are not rewritten; a one-off cleanup
  (`UPDATE users SET phone = regexp_replace(phone, '[^0-9]', '', 'g')`) is
  safe once no two rows collide.
- Pricing rules now define opening hours in the UI too: deleting a rule
  closes that hour for booking.
