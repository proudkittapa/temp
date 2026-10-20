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

## 2026-10-20 — In-page dialogs, Gregorian dates, availability before login, VAT to TODO

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `83728ff`)
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
