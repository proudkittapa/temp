# Sports Arena Booking & POS Go Database Server Middleware

This directory contains the production-grade, highly performant **Go (Golang)** backend system built to support our Sports Court Booking & POS Arena client SPA. It manages user roles, dynamic scheduling blocks (including half-court configurations), PromptPay Dynamic EMVCo QR computations, transactional POS checkouts, and custom loyalty point wallets.

---

## 🛠 Features Implemented in Go
1. **Acquire Concurrent Locks on Bookings**: Row locking (`SELECT FOR UPDATE` inside `RepeatableRead` write transactions) resolves race conditions and blocks double bookings on basketball courts or sub-allocated sides (Side A/B half-courts).
2. **EMVCo Co-Branded PromptPay CRC-16 Checksum Generator**: Inbuilt CRC-16 (polynomial `0x1021`) standard computations build dynamic QR barcodes on booking payloads instantaneously.
3. **Front-Desk cashier POS & inventories**: Sells drinks or equipment rentals (shoes dimensions standardizations, racket pressure specs) and registers operations with ACID rollbacks.
4. **CRM Loyal Points Accrual Wallet**: Spends earn points atomically matching the local rule standard of `$100 THB = 1 Point`.
5. **Session and Log Interceptors**: Secures users via Bcrypt hashes, validates outgoing requests via JWT tokens, and writes audit reports.

---

## 📂 Layout Architecture
```
/golang-backend
├── go.mod                     # Module configurations
├── main.go                    # Configures connection pool (pgxpool) and listens to routes
└── internal
    ├── model
    │   └── models.go          # Custom database structures and tags (Role, DayType, Booking, Product, etc.)
    ├── pkg
    │   └── promptpay
    │       └── promptpay.go   # Complete implementation of CRC-16 checksum and EMVCo payload rules
    ├── repository
    │   └── booking.go         # SQL queries and row checking blocks for court schedule limits
    ├── service
    │   ├── pos.go             # Counter shop: catalog, stock, sales, rentals/returns, day totals
    │   └── report_service.go  # Admin dashboard, monthly export, audit-log listing
    └── handler
        ├── handlers.go        # HTTP controllers: Register/Login, Slots, Payments, users
        └── shop_api.go        # Counter shop, drawer summary and admin report endpoints
```

---

## 🚀 Setup & Execution Guide

### 1. Prerequisites
- **Go 1.21** or later installed.
- **PostgreSQL 14** or later active.

### 2. Set Up a Local Database (Homebrew, macOS)
```bash
brew install postgresql@16
brew services start postgresql@16

# Create the role + database matching this directory's .env defaults
psql postgres -c "CREATE ROLE arena_user WITH LOGIN PASSWORD 'ArenaSecurePass99';"
psql postgres -c "CREATE DATABASE arena_db OWNER arena_user;"
```
No manual schema/DDL step is needed - `main.go` uses GORM's `AutoMigrate` to
create every table on startup, and seeds the config rows the pricing engine
needs (`pricing_config`, `member_discounts`) plus the same courts/pricing
rules as the frontend's `DEFAULT_COURTS`/`DEFAULT_PRICING_RULES`, so a
booking priced through this backend matches what the frontend shows for the
same slot. The DDL in `BACKEND_PLAN.md` is reference documentation of that
same schema, not something you run by hand.

Not on macOS/Homebrew, or prefer not to install Postgres system-wide? Two
alternatives:
```bash
# Docker - easiest to tear down later
docker run --name arena-postgres \
  -e POSTGRES_USER=arena_user \
  -e POSTGRES_PASSWORD=ArenaSecurePass99 \
  -e POSTGRES_DB=arena_db \
  -p 5432:5432 \
  -d postgres:16
```
Or a free hosted instance ([Neon](https://neon.tech), [Supabase](https://supabase.com)) - copy the connection string they give you into `.env`'s `DATABASE_URL` (adjust `sslmode` to `require`).

### 3. Install Backend Dependencies
Run the command below inside the `/golang-backend` directory to pull official package requirements:
```bash
go mod tidy
```

### 4. Run the Unit Tests
The unit tests cover pure business logic (mutex-group booking conflicts,
half-court/membership pricing math) and need neither Postgres nor network
access:
```bash
go build ./...      # compiles the whole module
go vet ./...         # static checks
go test ./... -v     # runs internal/model and internal/service tests
```

### 5. Set Environment Variables
Without a `.env`, the server uses `.env.example`, whose values match step
2's Homebrew setup (that file is the only place the local database password
is written down). If you used Docker/a hosted DB instead, or a different
local user/password, copy it to `.env` and edit it:
```bash
cp .env.example .env
cat .env
# DATABASE_URL=postgres://arena_user:ArenaSecurePass99@localhost:5432/arena_db?sslmode=disable
# PORT=8080
# JWT_SECRET=<output of: openssl rand -hex 32>   # unset = random per run (logins reset on restart)
# PROMPTPAY_ID=0105561008012                      # merchant PromptPay ID for customer QR codes
# SEED_DEMO_USERS=true   # local dev only: demo accounts, password 123456
# TRUSTED_PROXIES=        # reverse proxy IPs whose X-Forwarded-For is believed
# CORS_ALLOWED_ORIGINS=   # e.g. https://book.example.com; empty = any origin
```
**Court counts.** `BASKETBALL_COURT_COUNT` (default 3), `BADMINTON_COURT_COUNT`
(12), `PICKLEBALL_COURT_COUNT` (3) and `MEETING_ROOM_COUNT` (1) set how many
courts exist; the server checks on every start (`seed_courts.go`). Each
basketball court is lettered (A, B, C, ...) and is a full court plus a left
and a right half. Raising a count adds the missing courts; lowering it never
deletes one (bookings and reports point at it) - the log warns, and the
admin closes the extra courts in Admin → บริหารสนาม. Courts can also be added,
renamed and closed in the Admin panel.

A variable already set in the environment wins over `.env`, so
`npm run dev:api` (which sets `PORT=8080` and `SEED_DEMO_USERS=true`) works
whatever `.env` says. `PROMPTPAY_ID` may be a mobile number (`0812345678`,
dashes/spaces allowed) or a 13-digit tax ID; the server refuses to start with
anything else.

### 6. Launch Server
Compile and start the engine using the Go toolchain:
```bash
go run .
```
The server will boot up and signal readiness:
```
GORM Database connection established successfully!
Running GORM AutoMigrate for all system schemas...
Database schemas verified and migrated successfully!
Default pricing_config/member_discounts/courts/pricing_rules rows verified.
Sports Arena Go Backend server launching on Port 8080...
```

---

## 🧪 Testing Core REST API Endpoints

Routes that need a login take `Authorization: Bearer <token>` from the
register/login response. Staff routes (`/staff/*`, `/pos/*`) need a STAFF,
MANAGER or ADMIN token; `/admin/*` needs MANAGER or ADMIN. Start the server
with `SEED_DEMO_USERS=true` to get demo accounts (password `123456`) - e.g.
customer `0856789012`, staff `0834567890`. Never set it in production.

### 1. Register User Profile
```bash
curl -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Tanawat Badpro",
    "email": "tanawat@example.com",
    "phone": "0898887766",
    "password": "Password99"
  }'
```
Phone and email must be unique. The server also checks the details: name up
to 100 characters, a Thai phone number (at most 15 digits), a valid email
address (optional), and a password of at most 72 characters (bcrypt reads
only 72 bytes) -
anything else is refused with 400. Log in later with
`POST /api/v1/auth/login` and `{"identity": "<phone or email>", "password": "..."}`.

### 2. Check Availability
```bash
curl "http://localhost:8080/api/v1/courts"
curl "http://localhost:8080/api/v1/bookings?date=2026-06-20"
```
Other customers' bookings come back without user details.

### 3. Book Slots & Get the PromptPay Payload
Books up to 3 one-hour slots as a single group (one booking code, one
payment for the total). All-or-nothing: if any slot is taken, closed,
outside opening hours (no pricing rule covers it), already over, or a
half-court side at a peak hour (FR-1.2), nothing is booked (409/400).
Bookable hours are 07:00-23:00, and online a slot must not have started
yet (the counter can still sell an hour in progress). An unpaid booking
holds its slots for 30 minutes: if no slip is uploaded by then it is
cancelled automatically. A customer can hold at most 3 booking groups that
staff haven't approved yet - awaiting a slip *or* awaiting slip review -
at once (429).
Price, member discount and half-court rate are all computed server-side:
```bash
curl -X POST http://localhost:8080/api/v1/bookings \
  -H "Authorization: Bearer <Your_Token>" \
  -H "Content-Type: application/json" \
  -d '{
    "date": "2026-06-20",
    "slots": [
      {"court_id": "b_half_b", "start_time": "14:00"},
      {"court_id": "b_half_b", "start_time": "15:00"}
    ]
  }'
```

### 4. Upload a Payment Slip
Only the booking's owner (or staff) may upload; JPG/PNG/WEBP up to 5 MB.
The same file can't be attached to two live payments (409). Slip images are
not public: `slip_url` in responses is a signed link
(`/api/v1/slips/<file>?exp=..&sig=..`) valid for 1-2 hours, handed only to
the booking's owner and staff. `<booking_id>` is the first booking id from
step 3:
```bash
curl -X POST http://localhost:8080/api/v1/bookings/<booking_id>/upload-slip \
  -H "Authorization: Bearer <Your_Token>" \
  -F slip=@slip.jpg
```

### 5. Staff Slip Review (FR-3.3)
```bash
# Queue of uploaded slips with their booking groups
curl http://localhost:8080/api/v1/staff/payments -H "Authorization: Bearer <Staff_Token>"
# Approve: payment VERIFIED, every booking in the group CONFIRMED,
# 1 loyalty point per booked hour written to the points ledger.
# expected_slip_uploaded_at is the payment's slip_uploaded_at from the
# queue: if the customer has replaced the slip since, the call fails (409)
# so nobody approves an image they didn't see. Required when there is a slip.
curl -X POST http://localhost:8080/api/v1/staff/payments/<payment_id>/verify \
  -H "Authorization: Bearer <Staff_Token>" -H "Content-Type: application/json" \
  -d '{"expected_slip_uploaded_at": "2026-06-19T10:15:02.123456Z"}'
# Reject: payment REJECTED, bookings CANCELLED so the slots free up
curl -X POST http://localhost:8080/api/v1/staff/payments/<payment_id>/reject \
  -H "Authorization: Bearer <Staff_Token>" -H "Content-Type: application/json" \
  -d '{"reason": "amount mismatch", "expected_slip_uploaded_at": "2026-06-19T10:15:02.123456Z"}'
```

### 6. Staff Walk-in Booking
Goes through the same availability checks and pricing as online bookings,
and is credited to the registered customer with that phone (member price,
loyalty points). `CASH` is created CONFIRMED with a VERIFIED payment.
`VOUCHER` (with `voucher_code`) books a free off-peak hour, see 8c.
`PROMPTPAY` is created PENDING_PAYMENT with the QR payload in the response;
staff confirm it with `POST /staff/payments/:id/verify` once the transfer
has arrived (that also awards the points) or cancel it with `/reject`, and
it expires after 30 minutes like an online booking:
```bash
curl -X POST http://localhost:8080/api/v1/staff/bookings \
  -H "Authorization: Bearer <Staff_Token>" -H "Content-Type: application/json" \
  -d '{"date": "2026-06-20", "slots": [{"court_id": "bad-3", "start_time": "19:00"}],
       "customer_name": "Somchai", "customer_phone": "0811111111", "payment_method": "CASH"}'
```

### 7. Court Closures / Days Off (FR-1.3)
Public list (booking grids use it), manager/admin create and delete. A
closure blocks new bookings (staff walk-ins may override); bookings that
already exist in the window are returned as `affected_bookings` so staff
can contact those customers:
```bash
curl "http://localhost:8080/api/v1/days-off?from=2026-06-01&to=2026-06-30"
curl -X POST http://localhost:8080/api/v1/admin/days-off \
  -H "Authorization: Bearer <Manager_Token>" -H "Content-Type: application/json" \
  -d '{"date": "2026-06-20", "court_id": "bad-3", "reason": "Floor repair",
       "is_full_day": false, "start_hour": 9, "end_hour": 12}'
curl -X DELETE http://localhost:8080/api/v1/admin/days-off/<id> -H "Authorization: Bearer <Manager_Token>"
```
Use `"court_id": null` (or `"all"`) to close every court.

### 8. Pricing (FR-2)
`GET /pricing` (public) returns the pricing rules, member-tier discounts and
half-court rate that every booking is charged from. Editing is admin-only;
active rules for the same court type and day type may not overlap (409),
and every change is audit-logged:
```bash
curl http://localhost:8080/api/v1/pricing
curl -X PUT http://localhost:8080/api/v1/admin/pricing-rules/p-bad-wd-p \
  -H "Authorization: Bearer <Admin_Token>" -H "Content-Type: application/json" \
  -d '{"court_type": "BADMINTON", "day_type": "WEEKDAY", "start_hour": 17, "end_hour": 22,
       "price_per_hour": 300, "price_type": "PEAK", "label": "Badminton weekday peak"}'
curl -X PUT http://localhost:8080/api/v1/admin/member-discounts/STUDENT \
  -H "Authorization: Bearer <Admin_Token>" -H "Content-Type: application/json" \
  -d '{"name": "Student", "discount_percent": 15, "is_active": true}'
curl -X PUT http://localhost:8080/api/v1/admin/pricing-config \
  -H "Authorization: Bearer <Admin_Token>" -H "Content-Type: application/json" \
  -d '{"half_court_rate_percent": 50}'
```
`POST /admin/pricing-rules` creates a rule; `DELETE /admin/pricing-rules/:id`
removes one. Prices are kept to 2 decimal places (satang).
`PUT /admin/pricing-config` also takes `"max_advance_days"` (default 30,
1-365): how many days ahead customers may book online; staff at the counter
aren't limited.

**Opening hours:** `"open_hour"` / `"close_hour"` (default 7 / 23, any
0 <= open < close <= 24) bound every slot - the first starts at open_hour,
the last ends at close_hour. Inside them a sport is open only in hours an
active pricing rule covers (rules may cover any part of 00:00-24:00), so
widening the hours also needs rules for the new hours. Existing bookings
outside new hours stay valid.
```bash
curl -X PUT http://localhost:8080/api/v1/admin/pricing-config \
  -H "Authorization: Bearer <Admin_Token>" -H "Content-Type: application/json" \
  -d '{"open_hour": 6, "close_hour": 24}'
```

### 8a. Courts (admin)
Courts are added and opened/closed for new bookings, never deleted (old
bookings and reports point at them). Closing a court doesn't cancel what is
already booked: the answer says how many upcoming bookings remain. Managers
can list courts; for a temporary repair they add a closure (section 7).
```bash
curl http://localhost:8080/api/v1/admin/courts -H "Authorization: Bearer <Manager_Token>"   # closed ones too
curl -X POST http://localhost:8080/api/v1/admin/courts -H "Authorization: Bearer <Admin_Token>" -H "Content-Type: application/json" \
  -d '{"name": "สนามแบดมินตัน 13", "type": "BADMINTON", "half_court": false}'
curl -X PUT http://localhost:8080/api/v1/admin/courts/<id> -H "Authorization: Bearer <Admin_Token>" -H "Content-Type: application/json" \
  -d '{"is_active": false}'          # → {"court": {...}, "upcoming_bookings": 2}
```

### 8b. Cancellations, refunds, cash, no-shows (FR-6.3)
Managers/admins cancel bookings (a reason is required and audit-logged).
`:id` is any hour of the booking; `booking_ids` limits it to some hours.
`refund: true` records the cancelled paid hours as refunded (the transfer
itself is done by staff). It only refunds money that was received - paid
hours, or hours whose slip is still waiting for review - and is ignored for
an unpaid booking, so a closure can always pass it. Each refund is a row in
the `refunds` table (amount, reason, who, when; reports and the day summary
count refunds by these rows), and the payment keeps the running total in
`refund_amount`. Points earned for cancelled hours are taken back (never
below zero). Cancelling some hours of an unpaid booking lowers its amount
and makes a new QR for the rest. Payment status becomes `REFUNDED` once
refunds cover the whole amount, or once nothing is left standing after a
refund; with nothing left and no refund, an unpaid or waiting payment
becomes `REJECTED`. A refunded payment can't be approved any more.
`/admin/payments/:id/refund` refunds at most what no standing hour still
pays for. `GET /bookings?date=` gives staff each row's group `payment`
(`method`, `status`) for receipts.
```bash
curl -X POST http://localhost:8080/api/v1/admin/bookings/<booking_id>/cancel \
  -H "Authorization: Bearer <Manager_Token>" -H "Content-Type: application/json" \
  -d '{"reason": "Court lights broken", "refund": true, "booking_ids": ["<booking_id>"]}'
# Refund a payment no booking stands for (e.g. a late payment whose slot was taken)
curl -X POST http://localhost:8080/api/v1/admin/payments/<payment_id>/refund \
  -H "Authorization: Bearer <Manager_Token>" -H "Content-Type: application/json" -d '{"reason": "..."}'
# The customer paid an unpaid booking in cash at the counter
curl -X POST http://localhost:8080/api/v1/admin/bookings/<booking_id>/mark-cash -H "Authorization: Bearer <Manager_Token>"
# Any staff: the customer didn't come for this (started) hour - takes back its point
curl -X POST http://localhost:8080/api/v1/staff/bookings/<booking_id>/no-show -H "Authorization: Bearer <Staff_Token>"
# ...and undo it: the customer came late (refused if the hour was sold again); gives the point back
curl -X POST http://localhost:8080/api/v1/staff/bookings/<booking_id>/undo-no-show -H "Authorization: Bearer <Staff_Token>"
# Booking money received today by method (cash drawer) and refunds
curl "http://localhost:8080/api/v1/staff/summary?date=2026-06-20" -H "Authorization: Bearer <Staff_Token>"
```
**Late payments:** a booking with no slip after 30 minutes becomes payment
`EXPIRED` (bookings cancelled). The customer can still upload a slip for it;
it shows in the staff queue marked late. Approving it books the same slots
again if they are all still free; otherwise the approval fails with
"refund the customer instead" and a manager records the refund.
**Statuses:** confirmed hours become `COMPLETED` automatically once their end
time has passed; `NO_SHOW` is set by staff; payments use `EXPIRED` and
`REFUNDED` as above.

### 8c. Loyalty rewards (FR-4.2/4.3)
```bash
curl http://localhost:8080/api/v1/rewards                                  # catalog
curl -X POST http://localhost:8080/api/v1/me/rewards/rw-water/redeem -H "Authorization: Bearer <Customer_Token>"
curl http://localhost:8080/api/v1/me/vouchers -H "Authorization: Bearer <Customer_Token>"
curl http://localhost:8080/api/v1/staff/vouchers/RW-123456 -H "Authorization: Bearer <Staff_Token>"
curl -X POST http://localhost:8080/api/v1/staff/vouchers/RW-123456/dispense -H "Authorization: Bearer <Staff_Token>"
```
Redeeming deducts the points (ledger `REDEEM`) and issues an `RW-XXXXXX`
voucher valid for 30 days; it can be handed out once.

The free court hour (`rw-hour`, kind `FREE_OFFPEAK_HOUR`) is not handed out
with `/dispense` (refused); staff book the hour with it as a walk-in paid by
`VOUCHER`. It must be exactly one off-peak hour; the booking goes to the
voucher's owner, costs 0, is confirmed at once, earns no points, and uses
the voucher up (`vouchers.booking_id`). Cancelling that booking gives the
voucher back instead of a refund:
```bash
curl -X POST http://localhost:8080/api/v1/staff/bookings \
  -H "Authorization: Bearer <Staff_Token>" -H "Content-Type: application/json" \
  -d '{"date": "2026-06-22", "slots": [{"court_id": "bad-3", "start_time": "09:00"}],
       "customer_name": "Somchai", "customer_phone": "0811111111",
       "payment_method": "VOUCHER", "voucher_code": "RW-123456"}'
```

### 8d. Counter shop: sales, rentals, stock (FR-5.2/5.3)
Prices always come from the catalog; stock is locked and taken in the same
transaction (the last item can't be sold twice). A registered customer's
phone earns 1 point per 100 THB. Equipment is either for sale (shuttles) or
for rent (rackets, shoes); a rental stays open (`PREPARING`) until every item
is returned. Shoes are stocked per EU size + gender (`product_variants`), so
a shoe rental needs `variant_id`. Out of stock → 409.
```bash
curl http://localhost:8080/api/v1/staff/products -H "Authorization: Bearer <Staff_Token>"
curl -X POST http://localhost:8080/api/v1/pos/order -H "Authorization: Bearer <Staff_Token>" -H "Content-Type: application/json" \
  -d '{"type": "FB", "payment_method": "CASH", "customer_phone": "0856789012",
       "items": [{"product_id": "pd-1", "qty": 3}, {"product_id": "pd-6", "qty": 2}]}'
curl -X POST http://localhost:8080/api/v1/pos/order -H "Authorization: Bearer <Staff_Token>" -H "Content-Type: application/json" \
  -d '{"type": "EQUIPMENT_RENT", "payment_method": "CASH", "customer_name": "Team A",
       "items": [{"product_id": "pd-9", "variant_id": "pd-9-42-M", "qty": 1}]}'
curl http://localhost:8080/api/v1/staff/rentals -H "Authorization: Bearer <Staff_Token>"          # items still out
curl -X POST http://localhost:8080/api/v1/staff/rentals/items/<item_id>/return -H "Authorization: Bearer <Staff_Token>"
curl "http://localhost:8080/api/v1/staff/orders?date=2026-10-20" -H "Authorization: Bearer <Staff_Token>"
```
`GET /staff/summary` (the cash drawer) includes the day's counter sales:
`orders_cash`, `orders_promptpay`, `fb_sales`, `equipment_sales`,
`rental_income`. Managers maintain the catalog; every stock change needs a
reason and is audited:
```bash
curl -X POST http://localhost:8080/api/v1/admin/products -H "Authorization: Bearer <Manager_Token>" -H "Content-Type: application/json" \
  -d '{"products": [{"name": "Orange juice", "category": "FB", "price": 35, "is_rental": false, "stock": 20}]}'
curl -X PUT http://localhost:8080/api/v1/admin/products/<id> -H "Authorization: Bearer <Manager_Token>" -H "Content-Type: application/json" \
  -d '{"name": "Orange juice", "category": "FB", "price": 39, "is_rental": false, "is_active": true}'
curl -X POST http://localhost:8080/api/v1/admin/products/pd-9/stock -H "Authorization: Bearer <Manager_Token>" -H "Content-Type: application/json" \
  -d '{"delta": 2, "variant_id": "pd-9-38-F", "reason": "bought 2 pairs"}'
```

### 8e. Reports (FR-7.2-7.4)
```bash
curl "http://localhost:8080/api/v1/admin/dashboard?date=2026-10-20" -H "Authorization: Bearer <Manager_Token>"
curl "http://localhost:8080/api/v1/admin/report?month=2026-10" -H "Authorization: Bearer <Manager_Token>"   # bookings + orders for the CSVs
curl "http://localhost:8080/api/v1/admin/audit-logs?search=refund&target_type=Payment&limit=100" -H "Authorization: Bearer <Admin_Token>"
```
The dashboard counts paid hours (confirmed, completed, no-show) by playing
date and counter sales by sale time (Bangkok day). Occupancy = sold
court-hours ÷ (physical courts × 16 h), a half court counting half. The
audit log is admin-only (RBAC table in REQUIREMENTS.md). Besides staff and
admin actions it records the customer's side: `USER_REGISTERED`,
`BOOKING_CREATED` (online booking) and `SLIP_UPLOADED` (including
replacements).

### 8f. Cash drawer shifts and voids (FR-6.1/6.2)
One drawer, so one shift is open at a time. Expected cash = opening float +
cash booking payments approved + non-voided cash counter sales while the
shift was open (refunds are transfers, not from the drawer). Cash (walk-ins,
sales, rentals, mark-cash) is refused with 409 "open the cash drawer shift
before taking cash" while no shift is open; PromptPay is not affected.
Blind count: for the STAFF role, `GET /staff/shift` (and the open response)
returns `blind: true` with the cash figures zeroed, and `/staff/summary`
withholds the cash totals; managers and admins get the real numbers.
Voiding a sale whose points were already spent cancels the customer's
ACTIVE vouchers (newest first, status `CANCELLED`, points back as
`VOUCHER_CANCELLED`) to cover them, listed in `cancelled_vouchers`; if a
used reward can't be cancelled the void is refused. Closing stores
expected, counted and variance (counted - expected); a note is required
when they differ.
```bash
curl http://localhost:8080/api/v1/staff/shift -H "Authorization: Bearer <Staff_Token>"     # open shift + running totals, or null
curl -X POST http://localhost:8080/api/v1/staff/shift/open -H "Authorization: Bearer <Staff_Token>" -H "Content-Type: application/json" -d '{"opening_float": 2000}'
curl -X POST http://localhost:8080/api/v1/staff/shift/close -H "Authorization: Bearer <Staff_Token>" -H "Content-Type: application/json" \
  -d '{"counted_cash": 4890, "notes": "gave 10 THB too much change"}'
curl http://localhost:8080/api/v1/admin/shifts -H "Authorization: Bearer <Manager_Token>"   # last 30 days, ?from=&to=
```
Managers void a counter sale from today (reason required): stock comes back
(items still out on rent too), purchase points are taken back (never below
zero), and the sale leaves the drawer, shift and reports. Audited.
```bash
curl -X POST http://localhost:8080/api/v1/admin/orders/<order_id>/void -H "Authorization: Bearer <Manager_Token>" \
  -H "Content-Type: application/json" -d '{"reason": "wrong item keyed"}'
```
Closing a court (`PUT /admin/courts/:id {"is_active": false}`) returns its
upcoming bookings in `upcoming`; the Admin panel offers to cancel them with
refunds. `GET /admin/report` is logged as `REPORT_EXPORTED`.

### 9. Admin Points Modification & Audit Recording
```bash
curl -X POST http://localhost:8080/api/v1/admin/users/<user_id>/adjust-points \
  -H "Authorization: Bearer <Manager_Token>" \
  -H "Content-Type: application/json" \
  -d '{
    "points_delta": 5,
    "reason": "Compensation for court 3 lights failing"
  }'
```
A reason is required and audit-logged; points are only for customers, and
nobody can change their own balance.

### 10. Users and Membership Tiers (manager/admin)
```bash
curl "http://localhost:8080/api/v1/admin/users?role=CUSTOMER" -H "Authorization: Bearer <Manager_Token>"
# The tier the server prices this customer's bookings with (FR-2.3)
curl -X PUT http://localhost:8080/api/v1/admin/users/<user_id>/member-type \
  -H "Authorization: Bearer <Manager_Token>" -H "Content-Type: application/json" \
  -d '{"member_type": "STUDENT"}'
```

Admins can also change roles and suspend/reactivate accounts (nobody can
change their own; accounts are never deleted through the API, so their
bookings and points history stay intact):
```bash
curl -X PUT http://localhost:8080/api/v1/admin/users/<user_id>/role \
  -H "Authorization: Bearer <Admin_Token>" -H "Content-Type: application/json" -d '{"role": "STAFF"}'
curl -X PUT http://localhost:8080/api/v1/admin/users/<user_id>/active \
  -H "Authorization: Bearer <Admin_Token>" -H "Content-Type: application/json" -d '{"is_active": false}'
```

### Login limits
Within any 15 minutes: 5 wrong passwords for one account *from one IP* lock
that account from that IP (the owner elsewhere can still log in); 20 for one
account from anywhere lock the account; 50 from one IP lock the IP. An
account's phone number and email count together (the limit is keyed by the
account, not by what was typed); an identity that isn't an account is
counted by itself. Answers
are 429 with `Retry-After`. Failures are stored (hashed) in the
`login_failures` table, so the limits survive restarts and hold across
several backend instances. Behind a reverse proxy, set `TRUSTED_PROXIES`
so the real client IP is used.
Phone numbers are stored in one form (`0812345678`); `081-234-5678` and
`+66 81 234 5678` log in to the same account.
