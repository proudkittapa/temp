# GOLANG BACKEND ARCHITECTURE & EXTREMELY DETAILED INTEGRATION SPECIFICATION

This manual provides an absolute, production-grade, 100% comprehensive backend plan. It is specifically designed to transition our complex Sports Court Booking & POS Arena client application into a highly performant, concurrent, and thread-safe **Go (Golang)** backend system integrated with a relational **PostgreSQL** database.

Every single feature present in our interface—including half-court basketball allocations, dynamic pricing rules, staff shift overrides, PromptPay CRC-16 calculations, shoes/racket size rentals, CRM loyalty points, and administrative audit trails—is represented here with exact Go structures, database schemas, and critical business logic templates.

---

## 1. System Topology & Request Architecture

Below is the production-grade network and process diagram of the system, illustrating TLS termination, routing, session authorization, and database pool management:

```
                                  [ Web Browser Client ] 
                               (React 18 SPA + Tailwind CSS)
                                            │
                                            ▼ HTTPS (Port 443 / 3000)
                               ┌─────────────────────────┐
                               │     Ingress / Nginx     │
                               └────────────┬────────────┘
                                            │
                     ┌──────────────────────┴──────────────────────┐
                     ▼ /api/v1/*                                   ▼ /assets & /* (Static)
         ┌──────────────────────┐                       ┌──────────────────────────┐
         │  Go REST Service     │                       │  Nginx/Vite Static Host  │
         │  (Port 8080)         │                       │  (React dist Folder)     │
         └──────────┬───────────┘                       └──────────────────────────┘
                    │
            ┌───────┴───────┐
            ▼ Routing & MW  │
    ┌───────────────────────────────┐
    │  JWT Auth Middleware          │
    │  Structured Logger & CORS     │
    │  Token Bucket Rate Limiter    │
    └───────────────┬───────────────┘
                    │
            ┌───────┴───────┐
            ▼ Layered Domain Architecture
    ┌───────────────────────────────┐
    │ 1. Handlers (HTTP Controllers)│
    │ 2. Services (Business Logic)  │
    │ 3. Repositories (Data Access) │
    └───────────────┬───────────────┘
                    │
                    ▼ SQL Transactions (pgxpool)
         ┌──────────────────────┐
         │ PostgreSQL DB        │
         │ (ACID Transactions)  │
         └──────────────────────┘
```

---

## 2. Global DB Schema Definition (PostgreSQL DDL)

This is the exact SQL definition to initialize tables, database bounds, custom ENUMs, and constraints. Let's make sure it represents all state constraints of our system.

```sql
-- PostgreSQL DDL Script
-- Recommended Isolation Level for sensitive bookings: REPEATABLE READ or SERIALIZABLE

-- Create ENUMs for strict state enforcement
CREATE TYPE user_role AS ENUM ('ADMIN', 'MANAGER', 'STAFF', 'CUSTOMER');
CREATE TYPE member_type AS ENUM ('NORMAL', 'STUDENT', 'MEMBER', 'CORPORATE');
CREATE TYPE court_type AS ENUM ('BASKETBALL', 'BADMINTON', 'PICKLEBALL', 'MEETING_ROOM');
CREATE TYPE day_type AS ENUM ('WEEKDAY', 'WEEKEND');
CREATE TYPE price_type AS ENUM ('NORMAL', 'PEAK', 'OFFPEAK', 'STUDENT', 'MEMBER', 'CORPORATE');
CREATE TYPE booking_status AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');
CREATE TYPE payment_method AS ENUM ('PROMPTPAY', 'CASH');
CREATE TYPE payment_status AS ENUM ('PENDING', 'SLIP_UPLOADED', 'VERIFIED', 'REJECTED', 'REFUNDED');
CREATE TYPE product_cat AS ENUM ('FB', 'EQUIPMENT');
CREATE TYPE order_type AS ENUM ('FB', 'EQUIPMENT_RENT', 'EQUIPMENT_SALE');
CREATE TYPE order_status AS ENUM ('PENDING', 'PREPARING', 'READY', 'DELIVERED', 'CANCELLED');

-- 1. Users & Members Table
CREATE TABLE users (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE CHECK (email ~* '^[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,4}$'),
    phone VARCHAR(50) UNIQUE NOT NULL CHECK (phone ~ '^[0-9+ \-]+$'),
    line_user_id VARCHAR(100) UNIQUE,
    role user_role NOT NULL DEFAULT 'CUSTOMER',
    member_type member_type NOT NULL DEFAULT 'NORMAL',
    org_name VARCHAR(255), -- populated for CORPORATE users
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    password_hash VARCHAR(255) NOT NULL, -- bcrypted password representation
    points INT NOT NULL DEFAULT 0 CHECK (points >= 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_email ON users(email);

-- 2. Courts Master Table
CREATE TABLE courts (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type court_type NOT NULL,
    -- Courts sharing mutex_group_id are the same physical resource: an
    -- active booking on any of them blocks every other court in the group
    -- for the overlapping time range (FR-1.2). Generic replacement for
    -- hardcoding specific basketball court IDs in application code.
    mutex_group_id VARCHAR(50),
    -- Fraction of the mutex group's physical resource this court represents.
    -- 1 = the whole resource (or a standalone court). Less than 1 marks a
    -- sub-allocation (e.g. 0.5 for a half-court side). The pricing engine
    -- reads this to decide whether to apply pricing_config.half_court_rate_percent,
    -- which is the independently configurable business rate - share_of_group
    -- itself is purely structural/for mutex+display.
    share_of_group NUMERIC(3, 2) NOT NULL DEFAULT 1.0 CHECK (share_of_group > 0 AND share_of_group <= 1),
    off_peak_only BOOLEAN NOT NULL DEFAULT FALSE, -- FR-1.2
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX idx_courts_mutex_group ON courts(mutex_group_id) WHERE mutex_group_id IS NOT NULL;

-- 3. Dynamic Pricing Rules
CREATE TABLE pricing_rules (
    id VARCHAR(50) PRIMARY KEY,
    court_type court_type NOT NULL,
    day_type day_type NOT NULL,
    start_hour INT NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
    end_hour INT NOT NULL CHECK (end_hour BETWEEN 1 AND 24),
    price_per_hour NUMERIC(10, 2) NOT NULL CHECK (price_per_hour >= 0),
    price_type price_type NOT NULL,
    label VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT chk_rule_hours CHECK (end_hour > start_hour)
);

-- 3b. Single source of truth for business coefficients that used to be
-- duplicated (and had drifted out of sync) as magic numbers across the
-- frontend, this DDL's comments, and the Go service samples below. Exactly
-- one row, id = 'global'.
CREATE TABLE pricing_config (
    id VARCHAR(20) PRIMARY KEY DEFAULT 'global' CHECK (id = 'global'),
    half_court_rate_percent NUMERIC(5, 2) NOT NULL CHECK (half_court_rate_percent BETWEEN 0 AND 100) -- FR-2.4, default 50
);

-- 3c. Membership discount table (FR-2.3) - one row per member_type instead of
-- a percentage re-literaled in every service/language that needs it.
CREATE TABLE member_discounts (
    member_type member_type PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    discount_percent NUMERIC(5, 2) NOT NULL CHECK (discount_percent BETWEEN 0 AND 100),
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- 4. Calendar Overrides (Days off / Maintenance blocks)
CREATE TABLE days_off (
    id VARCHAR(50) PRIMARY KEY,
    date DATE NOT NULL,
    court_id VARCHAR(50) REFERENCES courts(id) ON DELETE CASCADE, -- NULL = all courts
    reason VARCHAR(255) NOT NULL,
    is_full_day BOOLEAN NOT NULL DEFAULT TRUE, -- FR-1.3
    start_hour INT CHECK (start_hour BETWEEN 0 AND 23), -- set when NOT is_full_day
    end_hour INT CHECK (end_hour BETWEEN 1 AND 24),      -- set when NOT is_full_day
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT chk_dayoff_hours CHECK (is_full_day OR (start_hour IS NOT NULL AND end_hour IS NOT NULL AND end_hour > start_hour))
);

-- Partial unique indexes since court_id is now nullable ("all courts" rows
-- can't collide with a NULL != NULL comparison under a plain UNIQUE index).
CREATE UNIQUE INDEX idx_days_off_date_court ON days_off(date, court_id) WHERE court_id IS NOT NULL;
CREATE UNIQUE INDEX idx_days_off_date_allcourts ON days_off(date) WHERE court_id IS NULL;

-- 5. Regular Base Week Operating Hours
CREATE TABLE operating_hours (
    id VARCHAR(50) PRIMARY KEY,
    day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sunday, 6=Saturday
    open_time TIME NOT NULL DEFAULT '07:00:00',
    close_time TIME NOT NULL DEFAULT '23:00:00',
    is_closed BOOLEAN NOT NULL DEFAULT FALSE
);

-- 6. Dynamic Reservations Table
CREATE TABLE bookings (
    id VARCHAR(50) PRIMARY KEY,
    booking_code VARCHAR(20) UNIQUE NOT NULL, -- e.g. "BB-29381"
    court_id VARCHAR(50) NOT NULL REFERENCES courts(id) ON DELETE RESTRICT,
    user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL, -- always start_time + 1h: one row per booked hour, so pricing/overlap logic has a single agreed grain
    -- Snapshot of (court.share_of_group < 1) at booking time, kept for
    -- historical/receipt display even if the court's configuration later
    -- changes. Availability and pricing must read the live court via
    -- court_id, never this column. Replaces the old half_court_side
    -- ('A'/'B'/'FULL') enum, which duplicated what court_id + courts.mutex_group_id
    -- already encode and had already drifted from the frontend's court IDs.
    is_half_court BOOLEAN NOT NULL DEFAULT FALSE,
    price_type price_type NOT NULL,
    total_amount NUMERIC(10, 2) NOT NULL CHECK (total_amount >= 0),
    status booking_status NOT NULL DEFAULT 'PENDING_PAYMENT',
    is_event_block BOOLEAN NOT NULL DEFAULT FALSE, -- True if staff locks the court for corporate matches or maintenance tournaments
    event_name VARCHAR(255),
    notes TEXT,
    created_by VARCHAR(50) NOT NULL, -- Customer ID, or Staff ID
    cancellation_reason VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT chk_times CHECK (end_time > start_time)
);

-- Speed index for schedules and checking overlap conflicts
CREATE INDEX idx_bookings_availability_check 
ON bookings (court_id, date, status) 
WHERE status NOT IN ('CANCELLED');

-- 7. Payment Transactions Table
CREATE TABLE payments (
    id VARCHAR(50) PRIMARY KEY,
    booking_id VARCHAR(50) UNIQUE NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount >= 0),
    method payment_method NOT NULL DEFAULT 'PROMPTPAY',
    status payment_status NOT NULL DEFAULT 'PENDING',
    slip_url VARCHAR(512), -- URL of uploaded receipt image
    slip_uploaded_at TIMESTAMP WITH TIME ZONE,
    verified_at TIMESTAMP WITH TIME ZONE,
    verified_by VARCHAR(50), -- Staff member ID
    refunded_at TIMESTAMP WITH TIME ZONE,
    refunded_by VARCHAR(50),
    refund_reason VARCHAR(255),
    qr_payload VARCHAR(1024), -- standard PromptPay EMVCo payload
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 8. POS Master Inventory
CREATE TABLE products (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    category product_cat NOT NULL, -- FB (snack, soda) or EQUIPMENT (sale/rent)
    sub_category VARCHAR(100), -- 'drink', 'snack', 'racket', 'shoes'
    price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    is_rental BOOLEAN NOT NULL DEFAULT FALSE,
    -- Authoritative stock ONLY for products with no rows in
    -- product_variants. A variant-tracked product (e.g. sized rentals) must
    -- decrement the matching product_variants row instead - checking this
    -- aggregate alone lets two customers both be told "in stock" for the
    -- last unit of one size while a different size sits unused.
    stock INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 8b. Sellable/rentable units tracked separately from their parent product,
-- e.g. one shoe size+gender combination (FR-5.3).
CREATE TABLE product_variants (
    id VARCHAR(50) PRIMARY KEY,
    product_id VARCHAR(50) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    label VARCHAR(20) NOT NULL, -- e.g. shoe size "42"
    gender CHAR(1) CHECK (gender IN ('M', 'F', 'U')),
    stock INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
    UNIQUE (product_id, label, gender)
);

-- 9. POS Orders Main Table
CREATE TABLE orders (
    id VARCHAR(50) PRIMARY KEY,
    order_code VARCHAR(20) UNIQUE NOT NULL, -- e.g. "REC-93821"
    user_id VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL, -- associated member if logged/registered
    customer_name VARCHAR(255) NOT NULL,
    court_id VARCHAR(50) REFERENCES courts(id) ON DELETE SET NULL, -- links snack bills to physical courts
    type order_type NOT NULL,
    status order_status NOT NULL DEFAULT 'PENDING',
    total_amount NUMERIC(10, 2) NOT NULL CHECK (total_amount >= 0),
    paid_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    payment_method payment_method,
    created_by VARCHAR(50) NOT NULL, -- checkout cashier id
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 10. POS Line Items Table including Gear Sizes/Attrs
CREATE TABLE order_items (
    id VARCHAR(50) PRIMARY KEY,
    order_id VARCHAR(50) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id VARCHAR(50) NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    variant_id VARCHAR(50) REFERENCES product_variants(id) ON DELETE RESTRICT, -- set when product_id has variants
    qty INT NOT NULL DEFAULT 1 CHECK (qty > 0),
    unit_price NUMERIC(10, 2) NOT NULL CHECK (unit_price >= 0),
    returned_at TIMESTAMP WITH TIME ZONE, -- populated when rented shoe/racket is returned
    shoe_size VARCHAR(10), -- display copy of the variant label at time of sale
    shoe_gender CHAR(1) CHECK (shoe_gender IN ('M', 'F', 'U')), -- display copy of the variant gender at time of sale
    notes VARCHAR(255) -- extra specs, e.g. racket string tension specifications
);

-- 11. Custom Audit Trail log
CREATE TABLE audit_logs (
    id VARCHAR(50) PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    user_name VARCHAR(255) NOT NULL,
    action VARCHAR(100) NOT NULL, -- USER_POINTS_ADJUSTED_BY_ADMIN, SLIP_VERIFIED, COURT_BLOCKED_FOR_MAINTENANCE etc.
    target_type VARCHAR(100) NOT NULL, -- "Booking", "Payment", "Order", "Court", "PricingRule", "PricingConfig", "User", "Product", "DayOff", "Shift", "Report"
    target_id VARCHAR(100) NOT NULL,
    before_state JSONB, -- state before changes in JSON formats
    after_state JSONB,  -- state after changes in JSON formats
    reason VARCHAR(500), -- required by FR-6.3/FR-7.3 for cancellations, refunds, manual point adjustments and price/schedule overrides
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX idx_audit_time ON audit_logs(created_at);

-- 12. Append-only loyalty history (FR-4.1/FR-4.3, AC-6/AC-7). users.points is
-- a cached sum of these rows; the ledger is what makes accrual/redemption
-- auditable and traces a manual point adjustment back to an actor.
CREATE TYPE ledger_entry_type AS ENUM ('EARN_BOOKING', 'EARN_PURCHASE', 'REDEEM', 'ADJUST_MANUAL');

CREATE TABLE points_ledger (
    id VARCHAR(50) PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type ledger_entry_type NOT NULL,
    points INT NOT NULL, -- signed: positive for earn, negative for redeem/adjustment
    ref_type VARCHAR(20) CHECK (ref_type IN ('Booking', 'Order', 'Voucher')),
    ref_id VARCHAR(50),
    note VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by VARCHAR(50) NOT NULL -- 'system' for automatic accrual
);

CREATE INDEX idx_points_ledger_user ON points_ledger(user_id);

-- 13. Rewards catalog (FR-4.2), kept separate from vouchers so it can be
-- edited without touching redemption history.
CREATE TABLE rewards_catalog (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    emoji VARCHAR(10) NOT NULL,
    points_cost INT NOT NULL CHECK (points_cost > 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TYPE voucher_status AS ENUM ('ACTIVE', 'REDEEMED', 'EXPIRED');

-- 14. A claimed reward (FR-4.3): created when a customer redeems points,
-- then looked up by code at the counter and marked REDEEMED on dispense.
CREATE TABLE vouchers (
    id VARCHAR(50) PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL, -- "RW-XXXXXX"
    user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward_id VARCHAR(50) NOT NULL REFERENCES rewards_catalog(id) ON DELETE RESTRICT,
    points_spent INT NOT NULL CHECK (points_spent > 0),
    status voucher_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    dispensed_at TIMESTAMP WITH TIME ZONE,
    dispensed_by VARCHAR(50)
);

-- 15. Front-desk cash drawer session (FR-6). Cash totals should be computed
-- from bookings/orders paid by CASH within [opened_at, closed_at), not
-- re-entered by staff, so the variance calculation has a single source of
-- truth.
CREATE TABLE shifts (
    id VARCHAR(50) PRIMARY KEY,
    staff_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    staff_name VARCHAR(255) NOT NULL,
    opened_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    opening_float NUMERIC(10, 2) NOT NULL CHECK (opening_float >= 0),
    closed_at TIMESTAMP WITH TIME ZONE,
    counted_cash NUMERIC(10, 2),
    expected_cash NUMERIC(10, 2),
    variance_cash NUMERIC(10, 2),
    notes VARCHAR(500)
);
```

---

## 3. Go Core Modules & Packages Layout

Below is the standard Golang production directory architecture. Place this in your repository root:

```
/arena-backend
├── cmd
│   └── api
│       └── main.go                 # System entrypoint, bootloaders, db connection pool startup
├── internal
│   ├── config
│   │   └── config.go               # Environment configurations (.env) loader 
│   ├── middleware
│   │   ├── auth.go                 # JWT validation claims extractor & session context injection
│   │   ├── audit.go                # Interceptor logging administrative mutations
│   │   ├── cors.go                 # Security headers and CORS configs
│   │   └── rate_limiter.go         # Per-IP token bucket limits
│   ├── model
│   │   ├── user.go                 # Struct representations of DDL with standard JSON/DB tags
│   │   ├── court.go
│   │   ├── booking.go
│   │   ├── pos.go
│   │   └── audit.go
│   ├── repository
│   │   ├── postgres_user.go        # pgx database layer for user reads, updates and points modifiers
│   │   ├── postgres_court.go       # Gantt grid slot math calculations 
│   │   ├── postgres_booking.go     # Concurrency locked transactions (SELECT FOR UPDATE)
│   │   └── postgres_pos.go         # Transactional inventory decrements and gear rentals ledger
│   └── service
│       ├── auth_service.go         # Bcrypt hash validators and JWT creators
│       ├── pricing_engine.go       # Dynamically calculates court rental charges based on schedule, rules, and memberships
│       ├── booking_service.go      # Pre-reservation validator and scheduling lock initiator
│       ├── pos_service.go          # POS transactions handler with real-time stock and CRM updates
│       └── slip_validator.go       # Handles manual and automatic payment slip confirmation
├── pkg
│   ├── promptpay
│   │   └── promptpay.go            # EMVCo PromptPay ISO generator with integrated CRC-16 checksum
│   └── response
│       └── response.go             # Helper utilities to emit standard REST JSON envelopes
├── go.mod                          # Golang Module list
└── go.sum
```

---

## 4. In-Depth Golang Go Code Implementations for Core Arena Operations

### 4.1 Feature 1: The Booking Schedule Overlap Engine (Generic Mutex-Group Locking)

Courts that share `mutex_group_id` are the same physical resource (FR-1.2) - e.g. one physical basketball court exposed as a full-court booking option plus two half-court sides. A booking on any court in the group blocks every other court in that group for the overlapping time range. This is resolved generically instead of a hardcoded "is this basketball, and is it side A/B/FULL" conflict matrix, which only worked for one sport and had to be extended by hand for every new shared-resource court (and had already drifted from the frontend's own court IDs - an earlier version of this doc used `half_court_side` in ways the frontend and `internal/model/models.go` never agreed on).

Here is the transaction pattern using pgx's connection pool (the actual implementation, using gorm, lives in `internal/repository/booking.go`):

```go
package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type BookingRepository struct {
	pool *pgxpool.Pool
}

func NewBookingRepository(pool *pgxpool.Pool) *BookingRepository {
	return &BookingRepository{pool: pool}
}

// CheckAndCreateBooking handles mutex-group overlap logic atomically with row locks
func (r *BookingRepository) CheckAndCreateBooking(
	ctx context.Context,
	courtID string,
	date time.Time,
	start, end string,
	insertFunc func(tx pgx.Tx) error,
) error {
	txOpts := pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadWrite,
	}

	tx, err := r.pool.BeginTx(ctx, txOpts)
	if err != nil {
		return fmt.Errorf("failed to begin booking transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// 1. Acquire row lock on the Master Court record to sequentialize parallel bookings for this court
	var isCourtActive bool
	var mutexGroupID *string
	err = tx.QueryRow(ctx, "SELECT is_active, mutex_group_id FROM courts WHERE id = $1 FOR UPDATE", courtID).Scan(&isCourtActive, &mutexGroupID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errors.New("error: court does not exist")
		}
		return err
	}
	if !isCourtActive {
		return errors.New("error: court is currently inactive")
	}

	// 2. Resolve every court that shares this court's mutex group (itself
	// included), then query overlapping active reservations across all of them.
	mutexCourtIDs := []string{courtID}
	if mutexGroupID != nil {
		rows, err := tx.Query(ctx, "SELECT id FROM courts WHERE mutex_group_id = $1", *mutexGroupID)
		if err != nil {
			return fmt.Errorf("failed to resolve mutex group: %w", err)
		}
		mutexCourtIDs = nil
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			mutexCourtIDs = append(mutexCourtIDs, id)
		}
		rows.Close()
	}

	overlapQuery := `
		SELECT id, start_time, end_time
		FROM bookings
		WHERE court_id = ANY($1)
		  AND date = $2
		  AND status NOT IN ('CANCELLED')
		  AND NOT (end_time <= $3::TIME OR start_time >= $4::TIME)
	`
	rows, err := tx.Query(ctx, overlapQuery, mutexCourtIDs, date, start, end)
	if err != nil {
		return err
	}
	defer rows.Close()

	if rows.Next() {
		var bID string
		var bStart, bEnd time.Time
		if err := rows.Scan(&bID, &bStart, &bEnd); err != nil {
			return err
		}
		return fmt.Errorf("conflict: court timing already reserved by active booking %s (%s-%s)", bID, bStart.Format("15:04"), bEnd.Format("15:04"))
	}

	// 3. Perform actual row insert inside calling boundary logic
	if err := insertFunc(tx); err != nil {
		return err
	}

	return tx.Commit(ctx)
}
```

---

### 4.2 Feature 2: High-Performance PromptPay QR Payload Generator with Integrated CRC-16 Checksum

PromptPay utilizes the **EMVCo Co-Branded Quick Response standard**. The payload ends with a precise high-integrity CRC-16 (Cyclic Redundancy Check) calculation of polynomial `0x1021` (CCITT). 

Our React client expects a seamless dynamic QR payload immediately in the booking payload response. This Go module calculates and outputs the payload instantly:

```go
package promptpay

import (
	"fmt"
	"strings"
)

// CalculateCRC16 calculates CCITT (0x1021) standard checksum for PromptPay
func CalculateCRC16(data string) string {
	var crc uint16 = 0xFFFF
	var polynomial uint16 = 0x1021

	for i := 0; i < len(data); i++ {
		crc ^= uint16(data[i]) << 8
		for j := 0; j < 8; j++ {
			if (crc & 0x8000) != 0 {
				crc = (crc << 1) ^ polynomial
			} else {
				crc <<= 1
			}
		}
	}
	return fmt.Sprintf("%04X", crc)
}

// GeneratePayload creates compliant dynamic promptpay EMVCo string
func GeneratePayload(merchantPhoneOrTaxID string, amount float64) string {
	// Sanitize phone input
	sanitized := strings.ReplaceAll(merchantPhoneOrTaxID, "+", "")
	sanitized = strings.ReplaceAll(sanitized, "-", "")
	sanitized = strings.TrimSpace(sanitized)

	// Format mobile number to match internal PromptPay Standard (prefix with 0066, ignore leading '0')
	if len(sanitized) == 10 && sanitized[0] == '0' {
		sanitized = "0066" + sanitized[1:]
	}

	// Build EMVCo String components
	builder := strings.Builder{}
	builder.WriteString("000201") // Payload Format Indicator
	builder.WriteString("010212") // Point of Initiation: 12 (Dynamic QR Code)

	// Merchant Account Information Block (Tag 29 - PromptPay Specific)
	// Sub-Tag 00: AID representing PromptPay registry (fixed string constant: A000000677010111)
	aid := "0016A000000677010111"
	var phoneID string
	if len(sanitized) == 13 {
		phoneID = fmt.Sprintf("0213%s", sanitized) // Tax ID or National ID Mode
	} else {
		phoneID = fmt.Sprintf("0113%s", sanitized) // Mobile Phone ID Mode
	}
	merchantBlock := aid + phoneID
	builder.WriteString(fmt.Sprintf("29%02d%s", len(merchantBlock), merchantBlock))

	builder.WriteString("5303764") // Country Code Tag 53: TH (iso code 764)
	builder.WriteString("5802TH")  // Currency Code Tag 58: TH (iso code TH)

	// Amount Tag 54
	formattedAmount := fmt.Sprintf("%.2f", amount)
	builder.WriteString(fmt.Sprintf("54%02d%s", len(formattedAmount), formattedAmount))

	// Prepared CRC-16 Checksum Block (Tag 63 length 04)
	builder.WriteString("6304")

	// Calculate and append CRC checksum of the entire string up to the checksum tag
	checksum := CalculateCRC16(builder.String())
	builder.WriteString(checksum)

	return builder.String()
}
```

---

### 4.3 Feature 3: Dynamic Multi-Tier Pricing Computation Engine

Charges are calculated dynamically. The backend retrieves the operating timeline, weekdays vs weekends, peak periods, client membership tiers (NORMAL, STUDENT, MEMBER, CORPORATE), and computes coefficients (like half-court division multipliers):

```go
package service

import (
	"context"
	"math"
	"time"

	"github.com/shopspring/decimal" // Best practice for exact financial math!
)

type PricingEngine struct {
	// dependencies to repository rules interfaces
}

// User Membership parameters
type MemberType string
const (
	Normal    MemberType = "NORMAL"
	Student   MemberType = "STUDENT"
	Member    MemberType = "MEMBER"
	Corporate MemberType = "CORPORATE"
)

func (e *PricingEngine) ComputeBookingPrice(
	ctx context.Context,
	courtType string,
	bookingDate time.Time,
	startHour int, // 0 - 23 represent timelines
	endHour int,
	isHalf bool,
	memberType MemberType,
) (decimal.Decimal, error) {
	
	// Determine if date falls during weekend (Sat or Sun)
	dayOfWeek := bookingDate.Weekday()
	isWeekend := dayOfWeek == time.Saturday || dayOfWeek == time.Sunday
	
	dayRuleType := "WEEKDAY"
	if isWeekend {
		dayRuleType = "WEEKEND"
	}

	// 1. Fetch pricing rules from PostgreSQL rule ledger
	// Query rule rates matching courtType and dayRuleType
	// e.g. SQL: SELECT start_hour, end_hour, price_per_hour, price_type FROM pricing_rules WHERE court_type = $1 AND day_type = $2 AND is_active = true
	
	totalBasePrice := decimal.NewFromFloat(0.0)

	// Loop over hours incrementaly to match changing periods (e.g. crossing peak boundary: 17:00-19:00 matches peak and normal rule buckets)
	for hour := startHour; hour < endHour; hour++ {
		hourRate := decimal.NewFromFloat(200.0) // default fallback rate
		
		// Find matching hour range inside pricing_rules array...
		// If hour falls inside peak rate rules -> Set rule-specific rate (e.g. Peak BADMINTON is 250 THB, Offpeak is 180 THB)
		totalBasePrice = totalBasePrice.Add(hourRate)
	}

	// 2. Match loyalty membership discount profiles. Read from the
	// member_discounts table (FR-2.3) instead of hardcoding percentages here -
	// this switch previously disagreed with both REQUIREMENTS.md and the
	// frontend's own DEFAULT_MEMBER_DISCOUNTS (20/10/15 here vs the spec's
	// 15/10/20), which is exactly the kind of drift a single config table
	// prevents.
	// e.g. SQL: SELECT discount_percent FROM member_discounts WHERE member_type = $1 AND is_active = true
	discountPercent := lookupMemberDiscountPercent(ctx, memberType) // decimal, e.g. 0.15 for STUDENT

	discountAmount := totalBasePrice.Mul(discountPercent)
	chargeAmount := totalBasePrice.Sub(discountAmount)

	// 3. Apply half-court multiplier if active (FR-2.4), read from the single
	// pricing_config.half_court_rate_percent row instead of a hardcoded
	// coefficient (previously 0.60 here vs the spec's 50%).
	// e.g. SQL: SELECT half_court_rate_percent FROM pricing_config WHERE id = 'global'
	if isHalf {
		halfCourtRatePercent := lookupHalfCourtRatePercent(ctx) // decimal, e.g. 0.50
		chargeAmount = chargeAmount.Mul(halfCourtRatePercent)
	}

	// Return rounded final total ready for PromptPay invoicing
	return chargeAmount.Round(2), nil
}
```

---

### 4.4 Feature 4: Front-Desk POS Shop Checkout & Inventory Stock Lock Engine

Snacks, refreshments, and racket/shoe rentals are calculated inside the POS module. Rentals require shoe sizes, racket models, custom string tension records, and return logs in the database.

Here is the exact Go service implementation:

```go
package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type POSOrderItemInput struct {
	ProductID  string  `json:"product_id"`
	Qty        int     `json:"qty"`
	ShoeSize   *string `json:"shoe_size"`   // optional gear details
	ShoeGender *string `json:"shoe_gender"` // 'M', 'F', 'U'
	Notes      *string `json:"notes"`       // custom notes, e.g. "String tension: 26lbs"
}

type CheckoutPOSOrder struct {
	UserID       *string              `json:"user_id"` // Optional linked member (CRM point updates)
	CustomerName string               `json:"customer_name"`
	CourtID      *string              `json:"court_id"` // Link bill to specific court lane
	OrderType    string               `json:"type"`     // "FB", "EQUIPMENT_RENT", "EQUIPMENT_SALE"
	PaymentMeth  string               `json:"payment_method"`
	Items        []POSOrderItemInput `json:"items"`
	CreatedBy    string               `json:"created_by"` // staff handling cashier
}

type POSService struct {
	pool *pgxpool.Pool
}

func (s *POSService) ProcessCheckout(ctx context.Context, input CheckoutPOSOrder) (string, int, error) {
	var createdOrderCode string
	var pointsEarned int

	txOpts := pgx.TxOptions{
		IsoLevel:   pgx.Serializable, // Strict serialization for stock checks
		AccessMode: pgx.ReadWrite,
	}

	tx, err := s.pool.BeginTx(ctx, txOpts)
	if err != nil {
		return "", 0, err
	}
	defer tx.Rollback(ctx)

	var totalAmount float64 = 0.0

	// 1. Process items and decrements stock records
	for _, item := range input.Items {
		var productPrice float64
		var currentStock int
		var isRental bool
		var isActive bool

		// Thread-safe row selection for products updates
		pQuery := "SELECT price, stock, is_rental, is_active FROM products WHERE id = $1 FOR UPDATE"
		err = tx.QueryRow(ctx, pQuery, item.ProductID).Scan(&productPrice, &currentStock, &isRental, &isActive)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return "", 0, fmt.Errorf("error: product ID %s does not exist", item.ProductID)
			}
			return "", 0, err
		}

		if !isActive {
			return "", 0, fmt.Errorf("error: item %s is out-of-bounds or inactive", item.ProductID)
		}

		// Verify stock limits (skip check only for digital/no-medium services, but check strictly for drinks and athletic shoes)
		if currentStock < item.Qty {
			return "", 0, fmt.Errorf("error: product stock insufficient (requested: %d, available: %d)", item.Qty, currentStock)
		}

		// Decrement product inventory ledger
		_, err = tx.Exec(ctx, "UPDATE products SET stock = stock - $1 WHERE id = $2", item.Qty, item.ProductID)
		if err != nil {
			return "", 0, err
		}

		linePrice := productPrice * float64(item.Qty)
		totalAmount += linePrice
	}

	// 2. Generate transaction receipts order records
	orderID := fmt.Sprintf("ord-%d", time.Now().UnixNano())
	createdOrderCode = fmt.Sprintf("REC-%05d", time.Now().Unix()%100000)

	orderQuery := `
		INSERT INTO orders (id, order_code, user_id, customer_name, court_id, type, total_amount, paid_amount, payment_method, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9)
	`
	_, err = tx.Exec(ctx, orderQuery, orderID, createdOrderCode, input.UserID, input.CustomerName, input.CourtID, input.OrderType, totalAmount, input.PaymentMeth, input.CreatedBy)
	if err != nil {
		return "", 0, err
	}

	// 3. Populate transaction line items with sizing and tension specs
	for _, item := range input.Items {
		itemID := fmt.Sprintf("item-%d", time.Now().UnixNano())
		
		// Query product price to lock records
		var itemPrice float64
		tx.QueryRow(ctx, "SELECT price FROM products WHERE id = $1", item.ProductID).Scan(&itemPrice)

		itemQuery := `
			INSERT INTO order_items (id, order_id, product_id, qty, unit_price, shoe_size, shoe_gender, notes)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		`
		_, err = tx.Exec(ctx, itemQuery, itemID, orderID, item.ProductID, item.Qty, itemPrice, item.ShoeSize, item.ShoeGender, item.Notes)
		if err != nil {
			return "", 0, err
		}
	}

	// 4. CRM Points adjustment: Every 100 THB spent earns +1 membership loyalty points
	if input.UserID != nil && *input.UserID != "" && totalAmount >= 100.0 {
		pointsEarned = int(totalAmount / 100.0)
		pointsQuery := "UPDATE users SET points = points + $1 WHERE id = $2"
		_, err = tx.Exec(ctx, pointsQuery, pointsEarned, *input.UserID)
		if err != nil {
			return "", 0, err
		}

		// Log CRM point change audittrails
		auditID := fmt.Sprintf("log-%d", time.Now().UnixNano())
		auditQuery := `
			INSERT INTO audit_logs (id, user_id, user_name, action, target_type, target_id, after_state)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
		`
		logMsg := fmt.Sprintf("Loyalty points accrued by customer system: +%d points from purchase %s", pointsEarned, createdOrderCode)
		tx.Exec(ctx, auditQuery, auditID, "system", "SYSTEM_CRM_ENGINE", logMsg, "User", *input.UserID, map[string]interface{}{"added_points": pointsEarned})
	}

	// Commit POS and stock ledger atomically
	if err := tx.Commit(ctx); err != nil {
		return "", 0, err
	}

	return createdOrderCode, pointsEarned, nil
}
```

---

## 5. Complete JSON REST API Directory Specification

Every route starts with prefix `/api/v1` and follows structured JWT validation.

---

### 5.1 AUTHENTICATION ROUTE MODULES

#### 5.1.1 `POST /api/v1/auth/register`
*   **Permissions**: Public
*   **Request Params**:
    ```json
    {
      "name": "Kittisak Badpro",
      "email": "kittisak@example.com",
      "phone": "0811112222",
      "password": "Password123"
    }
    ```
*   **StatusCodes**: `201 Created`, `400 Bad Request`, `409 Conflict` (Duplicate Phone)
*   **Response (`201 Created`)**:
    ```json
    {
      "success": true,
      "message": "Registration successful",
      "data": {
        "user": {
          "id": "u-k7281f",
          "name": "Kittisak Badpro",
          "phone": "0811112222",
          "role": "CUSTOMER",
          "member_type": "NORMAL",
          "points": 0
        },
        "token": "eyJhbGciOiJIUzI1NiInR5cCI6IkpXVC..."
      }
    }
    ```

#### 5.1.2 `POST /api/v1/auth/login`
*   **Permissions**: Public
*   **Request Params**:
    ```json
    {
      "identity": "0811112222",
      "password": "Password123"
    }
    ```
*   **StatusCodes**: `200 OK`, `401 Unauthorized`
*   **Response (`200 OK`)**:
    ```json
    {
      "success": true,
      "message": "Login successful",
      "data": {
        "user": {
          "id": "u-k7281f",
          "name": "Kittisak Badpro",
          "phone": "0811112222",
          "role": "CUSTOMER",
          "member_type": "NORMAL",
          "points": 21
        },
        "token": "eyJhbGciOiJIUzI1NiInR5cCI6IkpXVC..."
      }
    }
    ```

#### 5.1.3 `POST /api/v1/auth/me`
*   **Permissions**: Authenticated (JWT Header matching: `Authorization: Bearer <Token>`)
*   **Response (`200 OK`)**:
    ```json
    {
      "success": true,
      "data": {
        "id": "u-k7281f",
        "name": "Kittisak Badpro",
        "email": "kittisak@example.com",
        "phone": "0811112222",
        "role": "CUSTOMER",
        "member_type": "NORMAL",
        "points": 21,
        "is_active": true
      }
    }
    ```

---

### 5.2 COURTS & RESERVATION SLOTS

#### 5.2.1 `GET /api/v1/courts/slots`
*   **Permissions**: Public
*   **Query Strings**: `date=2026-06-20`, `court_type=BASKETBALL` (optional filter)
*   **Response (`200 OK`)**:
    ```json
    {
      "success": true,
      "data": {
        "date": "2026-06-20",
        "is_arena_closed": false,
        "courts_slots": [
          {
            "id": "c-bball01",
            "name": "Basketball Main Hall",
            "type": "BASKETBALL",
            "mutex_group_id": "bball-court-1",
            "share_of_group": 1.0,
            "timelines": [
              {
                "hour": "10:00",
                "is_booked": true,
                "booking_meta": {
                  "booking_id": "b-9281a",
                  "booker_name": "Satit ArenaGuy",
                  "is_half": true
                },
                "hourly_rate": 450.00
              },
              {
                "hour": "11:00",
                "is_booked": false,
                "booking_meta": null,
                "hourly_rate": 450.00
              }
            ]
          }
        ]
      }
    }
    ```

---

### 5.3 INTEGRATED BOOKINGS MANAGEMENT

#### 5.3.1 `POST /api/v1/bookings`
*   **Permissions**: Authenticated (Customer or Staff)
*   **Request Params** (note: `is_half_court` is NOT accepted here - it's derived server-side from the booked court's own `share_of_group`, so a caller can't request full-court pricing on a half-court booking or vice versa by lying about the flag):
    ```json
    {
      "court_id": "c-bball-half-b",
      "date": "2026-06-20",
      "start_time": "11:00",
      "end_time": "13:00",
      "notes": "Bring customized basketball balls"
    }
    ```
*   **Response (`211 Created`)**:
    ```json
    {
      "success": true,
      "message": "Temporary hold placed successfully",
      "data": {
        "booking_id": "b-hold298",
        "booking_code": "BB-49281",
        "total_amount": 540.00,
        "status": "PENDING_PAYMENT",
        "promptpay_payload": "00020101021230380016A00000067701011101130066845678901020340004540.0053037645802TH6304ED2B"
      }
    }
    ```

#### 5.3.2 `POST /api/v1/bookings/:id/upload-slip`
*   **Permissions**: Authenticated (User uploads their payment slip)
*   **Request Body**: Multipart binary uploaded under key parameter: `slip`
*   **Response (`200 OK`)**:
    ```json
    {
      "success": true,
      "message": "Receipt receipt slip received and logged inside review queue",
      "data": {
        "booking_id": "b-hold298",
        "status": "SLIP_UPLOADED",
        "slip_url": "https://arena-bucket.s3.ap-southeast-1.amazonaws.com/slips/2026/06/b-hold298_slip.png",
        "uploaded_at": "2026-06-20T08:52:11Z"
      }
    }
    ```

---

### 5.4 POS PRODUCTS & CHECKOUTS

#### 5.4.1 `GET /api/v1/pos/products`
*   **Permissions**: Authenticated (Staff)
*   **Response (`200 OK`)**:
    ```json
    {
      "success": true,
      "data": [
        {
          "id": "p-shoe01",
          "name": "Yonex Court Pro Badminton Shoe",
          "category": "EQUIPMENT",
          "sub_category": "shoes",
          "price": 100.00,
          "is_rental": true,
          "stock": 5
        }
      ]
    }
    ```

#### 5.4.2 `POST /api/v1/pos/order`
*   **Permissions**: Authenticated (Staff processing frontdesk sales)
*   **Request Params**:
    ```json
    {
      "user_id": "u-k7281f",
      "customer_name": "Kittisak Badpro",
      "court_id": "c-bball01",
      "type": "EQUIPMENT_RENT",
      "payment_method": "CASH",
      "items": [
        {
          "product_id": "p-shoe01",
          "qty": 1,
          "shoe_size": "42",
          "shoe_gender": "M",
          "notes": "Rental for court session Yonex standard"
        }
      ],
      "created_by": "staff-u382"
    }
    ```
*   **Response (`200 OK`)**:
    ```json
    {
      "success": true,
      "message": "POS Order registered",
      "data": {
        "order_code": "REC-92817",
        "total_amount": 100.00,
        "points_granted": 1
      }
    }
    ```

---

### 5.5 MANAGER AUDIT CONTROL PANEL (Staff passwords, shifts, CRM adjustments)

#### 5.5.1 `POST /api/v1/admin/users/:id/adjust-points`
*   **Permissions**: Authenticated (Manager/Admin Only)
*   **Request Params**:
    ```json
    {
      "points_delta": 1 // Supports -1 or 1 increments
    }
    ```
*   **Response (`200 OK`)**:
    ```json
    {
      "success": true,
      "message": "User loyalty balance point modified",
      "data": {
        "user_id": "u-k7281f",
        "adjusted_delta": 1,
        "new_balance": 22
      }
    }
    ```

#### 5.5.2 `GET /api/v1/admin/audit-logs`
*   **Permissions**: Authenticated (Manager/Admin Only)
*   **Response (`200 OK`)**:
    ```json
    {
      "success": true,
      "data": [
        {
          "id": "log-7281fca",
          "user_id": "staff-u382",
          "user_name": "Master Counter Staff",
          "action": "USER_POINTS_ADJUSTED_BY_ADMIN",
          "target_type": "User",
          "target_id": "u-k7281f",
          "before_state": { "points": 21 },
          "after_state": { "points": 22 },
          "created_at": "2026-06-20T08:55:00Z"
        }
      ]
    }
    ```

---

## 6. Phase-by-Phase Go-to-Market Deployment Blueprint

This plan outlines clean integration slices to change client mocks to the Go Backend server in 5 sequential sprints:

### Phase 1: Initialize Go-Runtime Environment & DB Pools (Duration: 3 Days)
*   Set up Postgres clusters and execute the absolute DDL migration schema provided in Section 2.
*   Initialize Go package environments with standard commands:
    ```bash
    go mod init arena-backend
    go get github.com/gin-gonic/gin
    go get github.com/jackc/pgx/v5/pgxpool
    go get github.com/golang-jwt/jwt/v5
    go get golang.org/crypto/bcrypt
    go get github.com/shopspring/decimal
    ```
*   Configure Go connection pools handling connection pool properties (`MaxConns`, `MinConns`, `MaxConnIdleTime`) inside `/internal/config/config.go`.

### Phase 2: Deploy User Security Layers (Duration: 3 Days)
*   Implement standard `auth` controllers in `/internal/service/auth_service.go` checking passwords via `bcrypt.CompareHashAndPassword`.
*   Deploy JWT parsing middleware checking security credentials at `/internal/middleware/auth.go`.
*   Develop user model data bindings ensuring passwords remain strictly masked (`json:"-"` struct tags) unless queried under separate administrative parameters.

### Phase 3: Deliver High-Isolation Schedule Engine (Duration: 5 Days)
*   Write Gin handler routes for `/api/v1/courts/slots` connecting the interface's Gantt visual schedules directly to real-time reservation indices.
*   Integrate half-court Basketball isolation blocks within the SQL transactional handlers (`FOR UPDATE`), protecting the system against overlaps on peak weekday schedules.
*   Compile PromptPay dynamic payload generators instantly on pre-reservation returns, mapping correct EMVCo strings and verifying Thai QR standards.

### Phase 4: Construct Cashier Front-Desk POS & Gear Hub (Duration: 4 Days)
*   Code transactional stock-deduct triggers inside the database layer, checking boundaries to avoid concurrent double purchases of drinks or renting unavailable badminton rackets.
*   Capture shoe rentals with specific size attributes (`shoe_size`, `shoe_gender`), linking checkout ledgers directly to CRM customer records.
*   Track loyalty wallets atomically using the standard point logic ($100 \text{ THB} = 1 \text{ Point}$).

### Phase 5: Implement Manager Auditing & System Telemetry (Duration: 3 Days)
*   Build audit interceptor middleware logging events, and before/after states into `audit_logs` in a JSONB formatting style.
*   Perform Stress-testing checks utilizing standard Go load generator tools (e.g. `hey` or `vegeta`) to guarantee the server successfully handles rapid parallel checkout operations.

---

## 7. Client Integration (React Client Configuration)

To route client requests to the new Go REST endpoint, initialize the React dynamic handler below:

### 7.1 Dynamic Axios Handler Setup (`/src/lib/goApi.ts`)
```typescript
import axios from 'axios';

// Pull host endpoint dynamically from environment
const GO_API_URL = import.meta.env.VITE_GO_BACKEND_URL || 'http://localhost:8080/api/v1';

export const goApiClient = axios.create({
  baseURL: GO_API_URL,
  timeout: 12000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Outgoing middleware inserts authentication tokens automatically
goApiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
}, (error) => {
  return Promise.reject(error);
});
```

### 7.2 Connecting Gantt Schedules to Live Go Services
```typescript
import { goApiClient } from '../lib/goApi';

export const fetchLiveGanttSlots = async (targetDate: string, courtType?: string) => {
  try {
    const response = await goApiClient.get('/courts/slots', {
      params: { date: targetDate, court_type: courtType }
    });
    if (response.data.success) {
      return response.data.data.courts_slots; // Instant transition from Mocks to high-performance Go!
    }
  } catch (error) {
    console.error("Critical error connecting to dynamic Go backend: ", error);
    throw error;
  }
};
```
