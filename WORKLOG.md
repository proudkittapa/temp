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

## 2026-10-20 — Fix review findings 1–4 and 6–9 (QR, prices, walk-ins, slip approval)

- **Who:** Claude Code (Opus 5.5), session https://claude.ai/code/session_01XQcPofjWpD4MF3bFSh4wPo, requested by traning.mbt@gmail.com
- **Commit(s):** this commit (on `main`, parent `54ff9d5`)
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
