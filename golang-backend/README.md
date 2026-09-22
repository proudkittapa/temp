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

### 2. Prepare Database Schema
Open a terminal and run the PostgreSQL DDL commands provided in the `BACKEND_PLAN.md` file in the project root to provision tables and indices.

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
The application accepts configuration strings from the environment:
```bash
export DATABASE_URL="postgres://your_user:your_password@localhost:5432/your_database?sslmode=disable"
export PORT="8080"
```

### 6. Launch Server
Compile and start the engine using the Go toolchain:
```bash
go run main.go
```
The server will boot up and signal readiness:
```
Database connection pool established successfully!
Sports Arena Go Backend server launching on Port 8080...
```

---

## 🧪 Testing Core REST API Endpoints

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

### 2. Check Slots on Court
```bash
curl -X GET "http://localhost:8080/api/v1/courts/slots?date=2026-06-20"
```

### 3. Hold Court & Get Dynamic PromptPay Payload
Include the token returned from the registration call as a Bearer Header.
Note: `is_half_court` is NOT part of the request - it's derived server-side
from the booked court's own `share_of_group` (see `courts.mutex_group_id` in
the DDL), so pass a half-court's own id (e.g. a court with `share_of_group =
0.5`) to book it at the half-court rate:
```bash
curl -X POST http://localhost:8080/api/v1/bookings \
  -H "Authorization: Bearer <Your_Token>" \
  -H "Content-Type: application/json" \
  -d '{
    "court_id": "b_half_b",
    "date": "2026-06-20",
    "start_time": "14:00",
    "end_time": "16:00",
    "notes": "Bring half court balls"
  }'
```

### 4. Admin Points Modification & Audit Recording
```bash
curl -X POST http://localhost:8080/api/v1/admin/users/tanawat/adjust-points \
  -H "Content-Type: application/json" \
  -d '{
    "points_delta": 5
  }'
```
