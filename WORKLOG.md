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

## 2026-10-20 — Second review: fix findings 1–5 and 7–16; managers keep closures

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `772ab1a`)
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
