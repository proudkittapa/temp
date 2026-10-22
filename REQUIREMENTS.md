# Sports Complex Management System — Comprehensive Requirements & Technical Specification

**Version:** 1.0.0  
**Status:** Approved / Production Ready  
**Target Platform:** Web (React 19 + TypeScript + Tailwind CSS) & Golang Microservices Backend  

---

## Table of Contents
1. [Executive Summary & System Objectives](#1-executive-summary--system-objectives)
2. [Codebase Architecture & File Catalog](#2-codebase-architecture--file-catalog)
3. [User Roles & RBAC Matrix](#3-user-roles--rbac-matrix)
4. [Functional Requirements (FR)](#4-functional-requirements-fr)
   - [FR-1: Facility & Court Scheduling Management](#fr-1-facility--court-scheduling-management)
   - [FR-2: Dynamic Time-of-Day Pricing Engine](#fr-2-dynamic-time-of-day-pricing-engine)
   - [FR-3: Customer Self-Service Booking & Payment Verification](#fr-3-customer-self-service-booking--payment-verification)
   - [FR-4: Customer Loyalty, Gamification & Rewards Club](#fr-4-customer-loyalty-gamification--rewards-club)
   - [FR-5: Front-Desk POS, Walk-in & Equipment Rentals](#fr-5-front-desk-pos-walk-in--equipment-rentals)
   - [FR-6: Shift Management & Cash Ledger](#fr-6-shift-management--cash-ledger)
   - [FR-7: Management Intelligence & Anti-Fraud Audit Trail](#fr-7-management-intelligence--anti-fraud-audit-trail)
5. [Business Logic, Algorithms & Constraints](#5-business-logic-algorithms--constraints)
6. [Data Dictionary & Domain Models](#6-data-dictionary--domain-models)
7. [Non-Functional Requirements (NFR)](#7-non-functional-requirements-nfr)
8. [Acceptance Criteria & Verification Checklist](#8-acceptance-criteria--verification-checklist)

---

## 1. Executive Summary & System Objectives

The **Sports Complex Management System** is a mission-critical management platform designed for multi-sport arenas (Badminton, Basketball, Pickleball, and Meeting/Conference facilities). The system consolidates:
- Real-time customer reservation schedules with half-court mutual exclusion.
- Dynamic peak vs. off-peak pricing and multi-tiered membership discounts.
- Bank transfer slip verification and PromptPay EMVCo QR code generation.
- Front-desk Point-of-Sale (POS) for equipment rentals (with shoe/racket sizing) and F&B inventory.
- Loyalty rewards club where hours played translate into redeemable merchandise vouchers.
- Role-Based Access Control (Customer, Counter Staff, Manager, Admin).
- Complete tamper-evident audit trail capturing before/after operational state transitions.

---

## 2. Codebase Architecture & File Catalog

### Project Directory Tree
```
├── /
│   ├── BACKEND_PLAN.md        # Comprehensive Golang + PostgreSQL architecture blueprint
│   ├── REQUIREMENTS.md        # Official System Requirements Specification (this document)
│   ├── dev-runner.js          # Development runner & environment proxy
│   ├── index.html             # Application HTML5 shell & entry point
│   ├── metadata.json          # Platform metadata & capability declarations
│   ├── package.json           # Project manifest & dependencies
│   ├── tsconfig.json          # TypeScript strict compiler configuration
│   ├── vite.config.ts         # Vite bundler configuration with Tailwind CSS plugin
│   └── src/
│       ├── App.tsx            # Main shell, RBAC role switcher, live Bangkok clock & Audit logger
│       ├── index.css          # Global Tailwind CSS styling entry point
│       ├── main.tsx           # React DOM root entry point
│       ├── mockData.ts        # StorageService, initial seed database & core business helpers
│       ├── types.ts           # Core TypeScript types, domain interfaces & enums
│       └── components/
│           ├── CustomerPanel.tsx  # Customer portal: Bookings, PromptPay checkout, Loyalty rewards
│           ├── StaffPOS.tsx       # Counter POS: Walk-in bookings, slip verification, F&B & rental desk
│           ├── AdminPanel.tsx     # Executive portal: Heatmaps, pricing engine, day-off manager, audit log
│           ├── customer/ staff/ admin/  # per panel: use<Panel>.tsx (core state + typed context),
│           │                            # one *Actions/*Data hook per area, one file per tab
│           └── Dialog, MemberPhoneInput, RolesTab, DemoLogins  # shared pieces
```

### Source File Descriptions

| File Path | Primary Responsibilities |
| :--- | :--- |
| `src/types.ts` | Complete system type definitions: Enums (`CourtType`, `DayType`, `PriceType`, `UserRole`, `BookingStatus`, `PaymentStatus`, etc.) and Interfaces (`Court`, `Booking`, `Payment`, `PricingRule`, `DayOff`, `AuditLog`, `Product`, `OrderItem`, `Order`). |
| `src/mockData.ts` | Centralized typed local persistence layer (`StorageService`), initial state seeder, PromptPay CRC-16 QR encoder, dynamic price evaluator (`calculateSlotPrice`), and loyalty calculation engines (`addPoints`, `addPointsHour`). |
| `src/App.tsx` | Top-level application frame featuring the active Role Switcher (`CUSTOMER`, `STAFF`, `MANAGER`, `ADMIN`), live Bangkok time clock (`Asia/Bangkok`), and centralized audit log capture handler. |
| `src/components/CustomerPanel.tsx` | Customer-facing WebApp: multi-sport court filtering, visual schedule calendar, basketball half-court logic, multi-slot shopping cart, PromptPay QR payment with slip upload simulation, loyalty points rewards redemption with voucher generation, and LINE OA push simulation. |
| `src/components/StaffPOS.tsx` | Front-desk operations: real-time bank transfer slip verification queue, walk-in reservations, F&B retail checkout, sports gear rentals (badminton rackets and sized shoes 36–45 with gender), and shift cash register open/close reconciliation. |
| `src/components/AdminPanel.tsx` | Executive management: 24-hour facility utilization heatmaps, pricing rules configuration, court maintenance and Day-Off scheduler (full-day or hour-range blocking), financial revenue charts, anti-fraud audit log viewer, and Excel export. |
| `src/components/{customer,staff,admin}/` | Since 2026-10-22 each panel is split: `use<Panel>.tsx` holds its state, effects and data loading (the core) and merges the handlers of one hook per area (e.g. `staff/slipActions.tsx`, `admin/pricingActions.tsx`, `customer/bookingFlow.tsx`), each receiving what it uses from the core and earlier areas through a typed `deps` parameter; the result is provided through a typed React context; each tab (staff: Walk-in, Slips, Shop, Rentals, Vouchers, Day total; admin: Dashboard, Pricing, Courts, Products, Users, Member discounts, Reports, Audit log; customer: Account, the three booking steps, My bookings, LINE simulator) is its own component reading that context. The `*.tsx` panel files above keep only the login screen, header, tab bar and shared dialogs. |
| `BACKEND_PLAN.md` | Full transition blueprint detailing production Go microservices, PostgreSQL relational schemas, pgxpool connection handling, Redis slot lock mutexes, and JWT authentication. |

---

## 3. User Roles & RBAC Matrix

| Capability / Module | Customer (`CUSTOMER`) | Front-Desk Staff (`STAFF`) | Manager (`MANAGER`) | Administrator (`ADMIN`) |
| :--- | :---: | :---: | :---: | :---: |
| Browse Courts & Real-Time Availability | ✅ (Read) | ✅ (Full) | ✅ (Full) | ✅ (Full) |
| Book Court Online & Upload Slip | ✅ (Self) | ✅ (Walk-in) | ✅ (Full) | ✅ (Full) |
| View & Redeem Loyalty Points | ✅ (Self) | ✅ (Verify Voucher) | ✅ (Audit) | ✅ (Full) |
| Verify Payment Slips & Confirm Bookings | ❌ | ✅ | ✅ | ✅ |
| Sell F&B Products & Rent Equipment | ❌ | ✅ | ✅ | ✅ |
| Manage Equipment Rental Returns | ❌ | ✅ | ✅ | ✅ |
| Open / Close Register Shift Float | ❌ | ✅ (Current Shift) | ✅ (All Shifts) | ✅ (All Shifts) |
| Approve Cancellations & Process Refunds | ❌ | ❌ | ✅ | ✅ |
| Configure Court Pricing & Peak Hours | ❌ | ❌ | ❌ | ✅ |
| Schedule Maintenance / Day-Off Block | ❌ | ❌ | ✅ | ✅ |
| View System Financial Reports & Charts | ❌ | ❌ | ✅ (Limited) | ✅ (Full) |
| Inspect Anti-Fraud Audit Trail | ❌ | ❌ | ❌ | ✅ |
| Export Data to Excel (.xlsx) | ❌ | ❌ | ✅ | ✅ |

---

## 4. Functional Requirements (FR)

### FR-1: Facility & Court Scheduling Management
- **FR-1.1 Sports Categories**: The system shall support at least 4 distinct court types:
  1. `BADMINTON`: Standard indoor wooden/rubber courts.
  2. `BASKETBALL`: three courts **A, B and C**, each bookable as the full court or as its left or right half (clarified by the owner, 2026-10-21).
  3. `PICKLEBALL`: Specialized indoor/outdoor pickleball courts.
  4. `MEETING_ROOM`: Air-conditioned conference and event space.
- **FR-1.2 Basketball Half-Court Mutual Exclusion** (applies to each of courts A, B and C separately):
  - Reserving a full court shall automatically block both of its halves for that slot.
  - Reserving either half shall automatically block that full court for that slot; the two halves of one court can be booked at the same time.
  - Bookings on one basketball court never block another basketball court.
  - Half-court reservations shall only be bookable during **Off-Peak hours** to maximize peak court utilization.
- **FR-1.3 Maintenance & Day-Off Engine (`DayOff`)**:
  - Managers and administrators shall have the capability to schedule temporary closures for a specific court or across all courts.
  - The closure can be configured as **Full Day** or restricted to a **Specific Time Window** (e.g., 08:00 to 12:00).
  - A closure follows the same rule as FR-1.2: closing a full basketball court also closes both its halves; closing one half also closes that full court, but not the other half.
  - Customers attempting to book a blocked slot shall receive an immediate advisory dialog citing the closure reason.
  - All blocked slots must be visually color-coded as unavailable in the customer and staff calendars.

### FR-2: Dynamic Time-of-Day Pricing Engine
- **FR-2.1 Day Type Classification**:
  - `WEEKDAY`: Monday through Friday.
  - `WEEKEND`: Saturday and Sunday.
- **FR-2.2 Peak vs. Off-Peak Windows**:
  - Weekday Peak: 17:00 – 22:00 (5:00 PM – 10:00 PM).
  - Weekend Peak: 09:00 – 22:00 (9:00 AM – 10:00 PM).
  - All other operating hours (07:00–17:00 weekdays; 07:00–09:00 and 22:00–23:00 weekends) are Off-Peak.
- **FR-2.3 Membership Tier Discounts**:
  - `NORMAL`: Standard base rate (0% discount).
  - `STUDENT`: 15% discount on court rental fee.
  - `MEMBER`: 10% discount on court rental fee.
  - `CORPORATE`: 20% discount on court rental fee.
- **FR-2.4 Half-Court Rate**:
  - Half-court basketball rates shall be dynamically computed as 50% of the standard full-court rate prior to membership discount application.

### FR-3: Customer Self-Service Booking & Payment Verification
- **FR-3.1 Multi-Slot Cart**: Customers can select multiple consecutive or non-consecutive 1-hour slots across different courts in a single checkout session.
- **FR-3.2 Payment Slip Upload**:
  - Upon selecting PromptPay, the system dynamically displays a PromptPay QR code with the exact transaction total.
  - The customer can upload a bank transfer slip image.
  - Upon submission, the reservation is created with status `PENDING_PAYMENT`.
- **FR-3.3 Front-Desk Verification**:
  - Uploaded slips enter the Staff POS verification queue.
  - Staff examine the slip image, match the bank transfer amount, and click "Approve".
  - Approval immediately shifts booking status to `CONFIRMED`, triggers customer notification, and accrues loyalty points.
  - If rejected, staff provide a rejection reason and release the slots.

### FR-4: Customer Loyalty, Gamification & Rewards Club
- **FR-4.1 Point Accrual Rules**:
  - **1 Point per 1 hour** of confirmed court reservations (awarded automatically upon staff slip verification or counter payment).
  - ~~1 Point per 100 THB spent on POS retail merchandise or F&B purchases.~~ Removed 2026-10-21 (owner): counter sales (F&B, equipment, rentals) earn no points; only paid court hours do.
- **FR-4.2 Rewards Catalog**:
  - `🥤 Mineral Water`: 5 Points (Free chilled bottled mineral water).
  - `⚡ Sponsor Energy Drink`: 8 Points (Free sports electrolyte drink).
  - `🧼 Clean Towel Rental`: 10 Points (Free sanitized microfiber towel rental).
  - `🏸 1-Hour Off-Peak Court`: 25 Points (1 free hour of court booking during off-peak hours).
- **FR-4.3 Voucher Claim Code Generation**:
  - Customers with sufficient points can redeem items directly within their portal.
  - Points are deducted immediately from their profile.
  - The system generates an authentic, unique claim voucher code formatted as `RW-XXXXXX` (e.g. `RW-849201`).
  - The transaction logs to user voucher history and pushes a simulated LINE OA notification.
  - Staff verify the claim code at the counter to dispense the physical reward.

### FR-5: Front-Desk POS, Walk-in & Equipment Rentals
- **FR-5.1 Walk-in Bookings**: Staff can book available court slots directly from the POS interface for walk-in players, choosing Cash or PromptPay settlement with immediate confirmation.
- **FR-5.2 Retail F&B Sales**: Item catalog with categories, itemized cart, real-time stock deduction, and cash change calculation.
- **FR-5.3 Sports Equipment Rental**:
  - Rackets (Badminton) and Court Shoes.
  - Shoe size selection covering EU sizes 36 through 45 with gender designation (`M`/`F`).
  - Rental order items track return status (`returnedAt` timestamp) and security deposit refunding.

### FR-6: Shift Management & Cash Ledger
- **FR-6.1 Opening Float**: Staff record the initial morning drawer cash float before initiating sales.
- **FR-6.2 Shift Closing Reconciliation**:
  - At shift end, staff input actual counted cash.
  - System calculates expected cash (Opening Float + Cash Bookings + Cash Retail) versus counted cash to surface variances (Over/Short).
- **FR-6.3 Manager Refund Overrides**:
  - Only users with `MANAGER` or `ADMIN` roles can authorize booking cancellations and issue refunds.
  - Every cancellation requires a documented justification reason saved directly to the audit log.

### FR-7: Management Intelligence & Anti-Fraud Audit Trail
- **FR-7.1 Facility Utilization Heatmap**: 24-hour visual matrix covering all courts with color-coded slot states:
  - Green: Available
  - Amber: Pending Slip Verification
  - Red: Confirmed / Paid
  - Gray: Blocked / Maintenance
- **FR-7.2 Business Intelligence Analytics**:
  - Total Gross Revenue, Net Paid Revenue, and Pending Revenue.
  - Revenue breakdown by Sport Category (Recharts pie/bar charts).
  - Hourly utilization curves and peak-to-off-peak ratios.
- **FR-7.3 Comprehensive Audit Trail**:
  - Non-repudiable audit logging for sensitive actions: price updates, booking cancellations, manual point additions, and schedule overrides.
  - Each log records timestamp, actor name/role, action code, target ID, and JSON snapshots of `before` and `after` states.
- **FR-7.4 Data Export**: One-click export of booking registers and financial transactions to Microsoft Excel (`.xlsx`).

---

## 5. Business Logic, Algorithms & Constraints

### 5.1 Court Pricing Algorithm
$$\text{BaseRate} = \text{Lookup}(\text{CourtType}, \text{DayType}, \text{StartHour})$$
$$\text{AdjustedRate} = \text{BaseRate} \times (\text{isHalfCourt} \ ? \ 0.5 : 1.0)$$
$$\text{DiscountMultiplier} = 1.0 - \frac{\text{MemberDiscountPercent}}{100}$$
$$\text{FinalSlotPrice} = \text{AdjustedRate} \times \text{DiscountMultiplier}$$

### 5.2 Basketball Half-Court Mutex Rule
```typescript
function isCourtSlotAvailable(courtId: string, date: string, hour: string, bookings: Booking[]): boolean {
  if (courtId === 'court-bb-full') {
    // Check if Full Court is booked OR either Half Court is booked
    return !bookings.some(b => b.date === date && b.startTime === hour && 
      (b.courtId === 'court-bb-full' || b.courtId === 'court-bb-half-1' || b.courtId === 'court-bb-half-2') &&
      b.status !== BookingStatus.CANCELLED);
  }
  if (courtId === 'court-bb-half-1' || courtId === 'court-bb-half-2') {
    // Check if this specific half court is booked OR Full Court is booked
    return !bookings.some(b => b.date === date && b.startTime === hour && 
      (b.courtId === courtId || b.courtId === 'court-bb-full') &&
      b.status !== BookingStatus.CANCELLED);
  }
  // Standard court
  return !bookings.some(b => b.date === date && b.startTime === hour && b.courtId === courtId && b.status !== BookingStatus.CANCELLED);
}
```

### 5.3 Day-Off Time Interval Constraint
```typescript
function isSlotBlockedByDayOff(courtId: string, date: string, hourNumber: number, daysOff: DayOff[]): boolean {
  return daysOff.some(d => {
    if (d.date !== date) return false;
    if (d.courtId !== 'all' && d.courtId !== courtId) return false;
    if (d.isFullDay || d.isFullDay === undefined) return true;
    return (d.startHour !== undefined && d.endHour !== undefined && hourNumber >= d.startHour && hourNumber < d.endHour);
  });
}
```

---

## 6. Data Dictionary & Domain Models

### Core Entities

#### `Court`
- `id` (string, Primary Key): Unique court identifier (e.g., `court-bad-1`).
- `name` (string): Display name (e.g., "คอร์ทแบดมินตัน 1").
- `type` (CourtType Enum): `BADMINTON`, `BASKETBALL`, `PICKLEBALL`, `MEETING_ROOM`.
- `allowHalf` (boolean): Flag enabling half-court sub-allocations.
- `isActive` (boolean): Operational status toggle.

#### `Booking`
- `id` (string, Primary Key): Internal record ID.
- `bookingCode` (string): Human-readable reference code (e.g., `BK-171000123`).
- `courtId` (string, Foreign Key -> Court.id).
- `userId` (string, Foreign Key -> User.id).
- `date` (string): Date in ISO format `YYYY-MM-DD`.
- `startTime` (string): Slot start in `HH:00` format.
- `endTime` (string): Slot end in `HH:00` format.
- `isHalfCourt` (boolean): Indicates half-court reservation.
- `priceType` (PriceType Enum): Applied pricing category.
- `totalAmount` (number): Final calculated price in THB.
- `status` (BookingStatus Enum): `PENDING_PAYMENT`, `CONFIRMED`, `CANCELLED`, `COMPLETED`, `NO_SHOW`.

#### `Payment`
- `id` (string, Primary Key): Internal payment ID.
- `bookingId` (string, Foreign Key -> Booking.id).
- `amount` (number): Payment amount in THB.
- `method` (PaymentMethod Enum): `PROMPTPAY` or `CASH`.
- `status` (PaymentStatus Enum): `PENDING`, `SLIP_UPLOADED`, `VERIFIED`, `REJECTED`, `REFUNDED`.
- `slipUrl` (string, Optional): Uploaded payment slip reference.
- `verifiedBy` (string, Optional): Identifier of staff member who approved payment.

#### `AuditLog`
- `id` (string, Primary Key): Unique log ID.
- `userId` (string): User ID of the actor.
- `userName` (string): Display name and role of the actor.
- `action` (string): Machine-readable action code (e.g., `BOOKING_CANCELLED`).
- `targetType` (string): Entity type modified (e.g., `Booking`, `PricingRule`).
- `targetId` (string): Identifier of affected entity.
- `before` (any): Previous state snapshot.
- `after` (any): New state snapshot.
- `createdAt` (string): ISO 8601 creation timestamp.

---

## 7. Non-Functional Requirements (NFR)

- **NFR-1: Data Durability & Local Storage Resilience**:
  All transactions, ledger entries, and audit logs persist to browser `localStorage` using atomic JSON read-modify-write patterns via `StorageService`.
- **NFR-2: UI Performance & Rendering**:
  Court availability matrices and heatmaps must calculate and re-render within 100 milliseconds for seamless user interaction.
- **NFR-3: Responsive Layout**:
  - Full desktop optimization for POS split-screen terminals and executive heatmaps.
  - Touch-friendly mobile interface (minimum 44px touch targets) for customer smartphone booking and QR scanning.
- **NFR-4: Financial & Audit Integrity**:
  Financial calculations must be mathematically exact to 2 decimal places. Cancellations, refunds, and price adjustments must produce immutable audit records.
- **NFR-5: Production Backend Readiness**:
  Data structures and business rules directly mirror the production Golang + PostgreSQL architecture specified in `BACKEND_PLAN.md`.

---

## 8. Acceptance Criteria & Verification Checklist

- [x] **AC-1**: On each basketball court (A, B, C), a full-court booking blocks both halves and a half-court booking blocks the full court; the two halves don't block each other, and closures follow the same rule.
- [x] **AC-2**: Basketball Half Courts are restricted to Off-Peak hours only.
- [x] **AC-3**: Special Day-Off closures support whole-day and specified hour-range blocks, preventing conflicts.
- [x] **AC-4**: PromptPay QR generator produces valid payloads with verified EMVCo CRC-16 checksums.
- [x] **AC-5**: Uploaded payment slips appear in the Staff POS queue and trigger confirmed status and loyalty accrual upon approval.
- [x] **AC-6**: Confirmed booking hours award 1 loyalty point per hour; counter sales award none (changed 2026-10-21).
- [x] **AC-7**: Loyalty point redemption deducts points, generates a unique `RW-XXXXXX` claim code, and simulates a LINE OA message.
- [x] **AC-8**: Equipment rental tracks badminton rackets and court shoes with sizes (36–45) and return timestamps.
- [x] **AC-9**: Shift cash drawer tracks opening float, receipts, and cash variance upon register close.
- [x] **AC-10**: System audit trail captures before/after JSON diffs for sensitive actions with Excel export capability.
