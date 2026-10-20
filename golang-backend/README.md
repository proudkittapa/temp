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
    │   └── pos.go             # Stock lock decrements and loyalty updates
    └── handler
        └── handlers.go        # HTTP controllers exposing Register/Login, Slots, Payments, and POS checkouts
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
`.env` in this directory already has values matching step 2's Homebrew
setup. If you used Docker/a hosted DB instead, or a different local
user/password, edit it to match:
```bash
cat .env
# DATABASE_URL=postgres://arena_user:ArenaSecurePass99@localhost:5432/arena_db?sslmode=disable
# PORT=8080
# JWT_SECRET=<output of: openssl rand -hex 32>   # unset = random per run (logins reset on restart)
# PROMPTPAY_ID=0105561008012                      # merchant PromptPay ID for customer QR codes
# SEED_DEMO_USERS=true   # local dev only: demo accounts, password 123456
```

### 6. Launch Server
Compile and start the engine using the Go toolchain:
```bash
go run main.go
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
Phone and email must be unique. Log in later with
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
half-court side at a peak hour (FR-1.2), nothing is booked (409/400). An
unpaid booking holds its slots for 30 minutes: if no slip is uploaded by
then it is cancelled automatically. A customer can hold at most 3 unpaid
booking groups at once (429).
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
`<booking_id>` is the first booking id from step 3:
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
# 1 loyalty point per booked hour written to the points ledger
curl -X POST http://localhost:8080/api/v1/staff/payments/<payment_id>/verify -H "Authorization: Bearer <Staff_Token>"
# Reject: payment REJECTED, bookings CANCELLED so the slots free up
curl -X POST http://localhost:8080/api/v1/staff/payments/<payment_id>/reject \
  -H "Authorization: Bearer <Staff_Token>" -H "Content-Type: application/json" \
  -d '{"reason": "amount mismatch"}'
```

### 6. Staff Walk-in Booking
Paid at the counter, so it is created CONFIRMED with a VERIFIED payment.
It goes through the same availability checks as online bookings, and is
credited (with loyalty points) to the registered customer with that phone:
```bash
curl -X POST http://localhost:8080/api/v1/staff/bookings \
  -H "Authorization: Bearer <Staff_Token>" -H "Content-Type: application/json" \
  -d '{"date": "2026-06-20", "slots": [{"court_id": "bad-3", "start_time": "19:00"}],
       "customer_name": "Somchai", "customer_phone": "0811111111", "payment_method": "CASH"}'
```

### 7. Admin Points Modification & Audit Recording
```bash
curl -X POST http://localhost:8080/api/v1/admin/users/<user_id>/adjust-points \
  -H "Authorization: Bearer <Manager_Token>" \
  -H "Content-Type: application/json" \
  -d '{
    "points_delta": 5
  }'
```
