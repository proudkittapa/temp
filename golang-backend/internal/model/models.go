package model

import (
	"encoding/json"
	"time"

	"gorm.io/gorm"
)

// Custom Types mirroring our Frontend Enums
type UserRole string

const (
	RoleAdmin    UserRole = "ADMIN"
	RoleManager  UserRole = "MANAGER"
	RoleStaff    UserRole = "STAFF"
	RoleCustomer UserRole = "CUSTOMER"
)

type MemberType string

const (
	MemberNormal    MemberType = "NORMAL"
	MemberStudent   MemberType = "STUDENT"
	MemberClub      MemberType = "MEMBER" // custom members
	MemberCorporate MemberType = "CORPORATE"
)

type CourtType string

const (
	CourtBasketball  CourtType = "BASKETBALL"
	CourtBadminton   CourtType = "BADMINTON"
	CourtPickleball  CourtType = "PICKLEBALL"
	CourtMeetingRoom CourtType = "MEETING_ROOM"
)

type BookingStatus string

const (
	BookingPendingPayment BookingStatus = "PENDING_PAYMENT"
	BookingConfirmed      BookingStatus = "CONFIRMED"
	BookingCancelled      BookingStatus = "CANCELLED"
	BookingCompleted      BookingStatus = "COMPLETED"
	BookingNoShow         BookingStatus = "NO_SHOW"
)

type PaymentMethod string

const (
	PaymentPromptPay PaymentMethod = "PROMPTPAY"
	PaymentCash      PaymentMethod = "CASH"
)

type PaymentStatus string

const (
	PaymentPending      PaymentStatus = "PENDING"
	PaymentSlipUploaded PaymentStatus = "SLIP_UPLOADED"
	PaymentVerified     PaymentStatus = "VERIFIED"
	PaymentRejected     PaymentStatus = "REJECTED"
	PaymentRefunded     PaymentStatus = "REFUNDED"
)

type ProductCat string

const (
	ProductFB        ProductCat = "FB"
	ProductEquipment ProductCat = "EQUIPMENT"
)

type OrderType string

const (
	OrderFB            OrderType = "FB"
	OrderEquipmentRent OrderType = "EQUIPMENT_RENT"
	OrderEquipmentSale OrderType = "EQUIPMENT_SALE"
)

type OrderStatus string

const (
	OrderPending   OrderStatus = "PENDING"
	OrderPreparing OrderStatus = "PREPARING"
	OrderReady     OrderStatus = "READY"
	OrderDelivered OrderStatus = "DELIVERED"
	OrderCancelled OrderStatus = "CANCELLED"
)

// 1. User Account Master
type User struct {
	ID         string     `json:"id" db:"id" gorm:"primaryKey;column:id"`
	Name       string     `json:"name" db:"name" gorm:"column:name"`
	Email      *string    `json:"email,omitempty" db:"email" gorm:"column:email"` // unique - see ensureUserUniqueIndexes in main.go
	Phone      string     `json:"phone" db:"phone" gorm:"column:phone"`           // unique - see ensureUserUniqueIndexes in main.go
	LineUserID *string    `json:"line_user_id,omitempty" db:"line_user_id" gorm:"column:line_user_id"`
	Role       UserRole   `json:"role" db:"role" gorm:"column:role"`
	MemberType MemberType `json:"member_type" db:"member_type" gorm:"column:member_type"`
	OrgName    *string    `json:"org_name,omitempty" db:"org_name" gorm:"column:org_name"`
	IsActive   bool       `json:"is_active" db:"is_active" gorm:"column:is_active"`
	// Cached running balance for fast reads - a derived sum of the user's
	// points_ledger rows. Every mutation must go through the ledger (see
	// PointsLedgerEntry) so the balance and the ledger never disagree.
	Points       int       `json:"points" db:"points" gorm:"column:points"`
	PasswordHash string    `json:"-" db:"password_hash" gorm:"column:password_hash"` // Never expose to public JSON
	CreatedAt    time.Time `json:"created_at" db:"created_at" gorm:"column:created_at"`
	UpdatedAt    time.Time `json:"updated_at" db:"updated_at" gorm:"column:updated_at"`
}

// 2. Play Court Master
type Court struct {
	ID   string    `json:"id" db:"id" gorm:"primaryKey;column:id"`
	Name string    `json:"name" db:"name" gorm:"column:name"`
	Type CourtType `json:"type" db:"type" gorm:"column:type"`
	// Courts sharing MutexGroupID represent the same physical resource
	// (FR-1.2). Conflicts within a group are NOT all-vs-all: only the
	// group's "hub" (the full-court allocation, ShareOfGroup >= 1) is
	// exclusive with every other court in the group. Two non-hub
	// sub-allocations (e.g. half-court sides B and C) do NOT block each
	// other - see IsHub/ConflictingCourtIDs below.
	MutexGroupID *string `json:"mutex_group_id,omitempty" db:"mutex_group_id" gorm:"column:mutex_group_id"`
	// Fraction of the mutex group's physical resource this court represents.
	// 1 = the whole resource (or a standalone court). Less than 1 marks a
	// sub-allocation (e.g. 0.5 for a half-court side); the pricing engine
	// reads this to decide whether to apply PricingConfig.HalfCourtRatePercent,
	// which is the independently configurable business rate - ShareOfGroup
	// itself is purely structural/for mutex+display.
	ShareOfGroup float64   `json:"share_of_group" db:"share_of_group" gorm:"column:share_of_group;default:1"`
	OffPeakOnly  bool      `json:"off_peak_only" db:"off_peak_only" gorm:"column:off_peak_only"` // FR-1.2
	IsActive     bool      `json:"is_active" db:"is_active" gorm:"column:is_active"`
	CreatedAt    time.Time `json:"created_at" db:"created_at" gorm:"column:created_at"`
}

// IsHub reports whether this court is the exclusive "full" resource of its
// mutex group - booking it blocks every other court in the group, and it is
// blocked by a booking on any of them. A standalone court (no MutexGroupID)
// trivially satisfies this but it's meaningless without siblings to conflict
// with.
func (c Court) IsHub() bool {
	return c.ShareOfGroup >= 1
}

// ConflictingCourtIDs returns the court ids that could conflict with booking
// `target`, given every court in its mutex group (siblings included, target
// itself may or may not be included in groupCourts - it is always added).
// The rule is asymmetric, not all-vs-all: the group's hub (full-court
// allocation) is exclusive with every sibling, but two non-hub
// sub-allocations (e.g. half-court sides B and C) never block each other.
// A flat "any court sharing MutexGroupID blocks any other" rule would
// incorrectly prevent B and C from being booked in parallel, which
// REQUIREMENTS.md FR-1.2 explicitly allows.
func ConflictingCourtIDs(target Court, groupCourts []Court) []string {
	ids := []string{target.ID}
	for _, c := range groupCourts {
		if c.ID == target.ID {
			continue
		}
		if target.IsHub() || c.IsHub() {
			ids = append(ids, c.ID)
		}
	}
	return ids
}

// 3. Dynamic Rule Charges
type PricingRule struct {
	ID           string    `json:"id" db:"id" gorm:"primaryKey;column:id"`
	CourtType    CourtType `json:"court_type" db:"court_type" gorm:"column:court_type"`
	DayType      string    `json:"day_type" db:"day_type" gorm:"column:day_type"` // "WEEKDAY" or "WEEKEND"
	StartHour    int       `json:"start_hour" db:"start_hour" gorm:"column:start_hour"`
	EndHour      int       `json:"end_hour" db:"end_hour" gorm:"column:end_hour"`
	PricePerHour float64   `json:"price_per_hour" db:"price_per_hour" gorm:"column:price_per_hour"`
	PriceType    string    `json:"price_type" db:"price_type" gorm:"column:price_type"` // e.g. "NORMAL", "PEAK", "STUDENT"
	Label        string    `json:"label" db:"label" gorm:"column:label"`
	IsActive     bool      `json:"is_active" db:"is_active" gorm:"column:is_active"`
}

// PricingConfig is the single source of truth for business coefficients that
// were previously duplicated (and had drifted out of sync) as magic numbers
// across mockData.ts, this package, and the pricing engine sample below.
// There is exactly one active row (id = "global").
type PricingConfig struct {
	ID                   string  `json:"id" db:"id" gorm:"primaryKey;column:id"`
	HalfCourtRatePercent float64 `json:"half_court_rate_percent" db:"half_court_rate_percent" gorm:"column:half_court_rate_percent"`
}

// MemberDiscount mirrors the frontend's MemberDiscountRule - one row per
// MemberType with its discount percent, so the number lives in one place
// instead of being re-literaled per language/service.
type MemberDiscount struct {
	MemberType      MemberType `json:"member_type" db:"member_type" gorm:"primaryKey;column:member_type"`
	Name            string     `json:"name" db:"name" gorm:"column:name"`
	DiscountPercent float64    `json:"discount_percent" db:"discount_percent" gorm:"column:discount_percent"`
	IsActive        bool       `json:"is_active" db:"is_active" gorm:"column:is_active"`
}

// 4. Overrides Days Off / Maintenance Blocks
type DayOff struct {
	ID        string    `json:"id" db:"id" gorm:"primaryKey;column:id"`
	Date      string    `json:"date" db:"date" gorm:"column:date;type:date"`             // "YYYY-MM-DD"
	CourtID   *string   `json:"court_id,omitempty" db:"court_id" gorm:"column:court_id"` // NULL = all courts
	Reason    string    `json:"reason" db:"reason" gorm:"column:reason"`
	IsFullDay bool      `json:"is_full_day" db:"is_full_day" gorm:"column:is_full_day;default:true"`
	StartHour *int      `json:"start_hour,omitempty" db:"start_hour" gorm:"column:start_hour"` // set when !IsFullDay
	EndHour   *int      `json:"end_hour,omitempty" db:"end_hour" gorm:"column:end_hour"`       // set when !IsFullDay
	CreatedAt time.Time `json:"created_at" db:"created_at" gorm:"column:created_at"`
}

// 5. Booking / Reservation Entry
type Booking struct {
	ID string `json:"id" db:"id" gorm:"primaryKey;column:id"`
	// Shared by every row of one booking group and unique per group (checked
	// at insert - see BookingService.uniqueBookingCode).
	BookingCode string `json:"booking_code" db:"booking_code" gorm:"column:booking_code;index"`
	CourtID     string `json:"court_id" db:"court_id" gorm:"column:court_id"`
	UserID      string `json:"user_id" db:"user_id" gorm:"column:user_id"` // WalkInUserID for counter customers without an account
	// Who the booking is for, as shown to staff: copied from the user at
	// booking time, or typed in by staff for a walk-in without an account.
	CustomerName  *string `json:"customer_name,omitempty" db:"customer_name" gorm:"column:customer_name"`
	CustomerPhone *string `json:"customer_phone,omitempty" db:"customer_phone" gorm:"column:customer_phone"`
	Date          string  `json:"date" db:"date" gorm:"column:date;type:date"`                         // "YYYY-MM-DD"
	StartTime     string  `json:"start_time" db:"start_time" gorm:"column:start_time;type:varchar(5)"` // "HH:MM"
	EndTime       string  `json:"end_time" db:"end_time" gorm:"column:end_time;type:varchar(5)"`       // "HH:MM", always StartTime+1h - one row per booked hour (see BookingRepository doc)
	// Snapshot of (court.ShareOfGroup < 1) at booking time, kept for
	// historical/receipt display even if the court's configuration later
	// changes. Availability and pricing must read the live Court via CourtID,
	// never this field. Replaces the old HalfCourtSide ("A"/"B"/"FULL") enum,
	// which duplicated what CourtID + Court.MutexGroupID already encode.
	IsHalfCourt        bool          `json:"is_half_court" db:"is_half_court" gorm:"column:is_half_court"`
	PriceType          string        `json:"price_type" db:"price_type" gorm:"column:price_type"`
	TotalAmount        float64       `json:"total_amount" db:"total_amount" gorm:"column:total_amount"`
	Status             BookingStatus `json:"status" db:"status" gorm:"column:status"`
	IsEventBlock       bool          `json:"is_event_block" db:"is_event_block" gorm:"column:is_event_block"`
	EventName          *string       `json:"event_name,omitempty" db:"event_name" gorm:"column:event_name"`
	Notes              *string       `json:"notes,omitempty" db:"notes" gorm:"column:notes"`
	CreatedBy          string        `json:"created_by" db:"created_by" gorm:"column:created_by"`
	CancellationReason *string       `json:"cancellation_reason,omitempty" db:"cancellation_reason" gorm:"column:cancellation_reason"`
	CreatedAt          time.Time     `json:"created_at" db:"created_at" gorm:"column:created_at"`
	UpdatedAt          time.Time     `json:"updated_at" db:"updated_at" gorm:"column:updated_at"`
}

// WalkInUserID is Booking.UserID for counter bookings by someone without an
// account; their name/phone live in CustomerName/CustomerPhone.
const WalkInUserID = "walk-in"

// 6. Linked Payment Slip Information
type Payment struct {
	ID             string        `json:"id" db:"id" gorm:"primaryKey;column:id"`
	BookingID      string        `json:"booking_id" db:"booking_id" gorm:"column:booking_id"`
	Amount         float64       `json:"amount" db:"amount" gorm:"column:amount"`
	Method         PaymentMethod `json:"method" db:"method" gorm:"column:method"`
	Status         PaymentStatus `json:"status" db:"status" gorm:"column:status"`
	SlipURL        *string       `json:"slip_url,omitempty" db:"slip_url" gorm:"column:slip_url"`
	SlipUploadedAt *time.Time    `json:"slip_uploaded_at,omitempty" db:"slip_uploaded_at" gorm:"column:slip_uploaded_at"`
	VerifiedAt     *time.Time    `json:"verified_at,omitempty" db:"verified_at" gorm:"column:verified_at"`
	VerifiedBy     *string       `json:"verified_by,omitempty" db:"verified_by" gorm:"column:verified_by"`
	RefundedAt     *time.Time    `json:"refunded_at,omitempty" db:"refunded_at" gorm:"column:refunded_at"`
	RefundedBy     *string       `json:"refunded_by,omitempty" db:"refunded_by" gorm:"column:refunded_by"`
	RefundReason   *string       `json:"refund_reason,omitempty" db:"refund_reason" gorm:"column:refund_reason"`
	QrPayload      *string       `json:"qr_payload,omitempty" db:"qr_payload" gorm:"column:qr_payload"`
	CreatedAt      time.Time     `json:"created_at" db:"created_at" gorm:"column:created_at"`
	UpdatedAt      time.Time     `json:"updated_at" db:"updated_at" gorm:"column:updated_at"`
}

// 7. Inventory Items (Drinks, sales, rental shoes/rackets)
type Product struct {
	ID          string     `json:"id" db:"id" gorm:"primaryKey;column:id"`
	Name        string     `json:"name" db:"name" gorm:"column:name"`
	Category    ProductCat `json:"category" db:"category" gorm:"column:category"`
	SubCategory *string    `json:"sub_category,omitempty" db:"sub_category" gorm:"column:sub_category"`
	Price       float64    `json:"price" db:"price" gorm:"column:price"`
	IsRental    bool       `json:"is_rental" db:"is_rental" gorm:"column:is_rental"`
	// Authoritative stock ONLY for products with no rows in product_variants.
	// A variant-tracked product (e.g. sized rentals) must decrement the
	// matching ProductVariant row instead - checking/decrementing this
	// aggregate alone lets two customers both be told "in stock" for the
	// last unit of one particular size while a different size sits unused.
	Stock     int       `json:"stock" db:"stock" gorm:"column:stock"`
	IsActive  bool      `json:"is_active" db:"is_active" gorm:"column:is_active"`
	CreatedAt time.Time `json:"created_at" db:"created_at" gorm:"column:created_at"`
}

// ProductVariant is a sellable/rentable unit tracked separately from its
// parent Product, e.g. one shoe size+gender combination (FR-5.3).
type ProductVariant struct {
	ID        string  `json:"id" db:"id" gorm:"primaryKey;column:id"`
	ProductID string  `json:"product_id" db:"product_id" gorm:"column:product_id"`
	Label     string  `json:"label" db:"label" gorm:"column:label"`              // e.g. shoe size "42"
	Gender    *string `json:"gender,omitempty" db:"gender" gorm:"column:gender"` // 'M', 'F', 'U'
	Stock     int     `json:"stock" db:"stock" gorm:"column:stock"`
}

// 8. Frontdesk Checkout Order Master
type Order struct {
	ID            string        `json:"id" db:"id" gorm:"primaryKey;column:id"`
	OrderCode     string        `json:"order_code" db:"order_code" gorm:"column:order_code"`
	UserID        *string       `json:"user_id,omitempty" db:"user_id" gorm:"column:user_id"`
	CustomerName  string        `json:"customer_name" db:"customer_name" gorm:"column:customer_name"`
	CourtID       *string       `json:"court_id,omitempty" db:"court_id" gorm:"column:court_id"`
	Type          OrderType     `json:"type" db:"type" gorm:"column:type"`
	Status        OrderStatus   `json:"status" db:"status" gorm:"column:status"`
	TotalAmount   float64       `json:"total_amount" db:"total_amount" gorm:"column:total_amount"`
	PaidAmount    float64       `json:"paid_amount" db:"paid_amount" gorm:"column:paid_amount"`
	PaymentMethod PaymentMethod `json:"payment_method" db:"payment_method" gorm:"column:payment_method"`
	CreatedBy     string        `json:"created_by" db:"created_by" gorm:"column:created_by"`
	CreatedAt     time.Time     `json:"created_at" db:"created_at" gorm:"column:created_at"`
}

// 9. Order Specific Line Item
type OrderItem struct {
	ID         string     `json:"id" db:"id" gorm:"primaryKey;column:id"`
	OrderID    string     `json:"order_id" db:"order_id" gorm:"column:order_id"`
	ProductID  string     `json:"product_id" db:"product_id" gorm:"column:product_id"`
	VariantID  *string    `json:"variant_id,omitempty" db:"variant_id" gorm:"column:variant_id"` // set when ProductID has variants
	Qty        int        `json:"qty" db:"qty" gorm:"column:qty"`
	UnitPrice  float64    `json:"unit_price" db:"unit_price" gorm:"column:unit_price"`
	ReturnedAt *time.Time `json:"returned_at,omitempty" db:"returned_at" gorm:"column:returned_at"` // filled when customer returns rental goods
	ShoeSize   *string    `json:"shoe_size,omitempty" db:"shoe_size" gorm:"column:shoe_size"`       // display copy of the variant label at time of sale
	ShoeGender *string    `json:"shoe_gender,omitempty" db:"shoe_gender" gorm:"column:shoe_gender"` // display copy of the variant gender at time of sale
	Notes      *string    `json:"notes,omitempty" db:"notes" gorm:"column:notes"`
}

// 10. Admin Audit Logs Tracer
type AuditLog struct {
	ID          string `json:"id" db:"id" gorm:"primaryKey;column:id"`
	UserID      string `json:"user_id" db:"user_id" gorm:"column:user_id"`
	UserName    string `json:"user_name" db:"user_name" gorm:"column:user_name"`
	Action      string `json:"action" db:"action" gorm:"column:action"`
	TargetType  string `json:"target_type" db:"target_type" gorm:"column:target_type"` // "Booking", "Payment", "Order", "Court", "PricingRule", "PricingConfig", "User", "Product", "DayOff", "Shift", "Report"
	TargetID    string `json:"target_id" db:"target_id" gorm:"column:target_id"`
	BeforeState string `json:"before_state" db:"before_state" gorm:"column:before_state;type:jsonb"` // serialized JSON data
	AfterState  string `json:"after_state" db:"after_state" gorm:"column:after_state;type:jsonb"`    // serialized JSON data
	// Required by FR-6.3/FR-7.3 for cancellations, refunds, manual point
	// adjustments and price/schedule overrides.
	Reason    *string   `json:"reason,omitempty" db:"reason" gorm:"column:reason"`
	CreatedAt time.Time `json:"created_at" db:"created_at" gorm:"column:created_at"`
}

// BeforeCreate guarantees Before/AfterState are valid JSON for their jsonb
// columns. Postgres rejects an empty string or free text there, and since
// most callers ignore LogAction errors (or, worse, abort their whole
// transaction on it - e.g. rental returns), an invalid state used to drop the
// audit row silently or break the operation being audited. Empty becomes
// JSON null; other non-JSON text is stored as a JSON string.
func (a *AuditLog) BeforeCreate(_ *gorm.DB) error {
	a.BeforeState = normalizeAuditJSON(a.BeforeState)
	a.AfterState = normalizeAuditJSON(a.AfterState)
	return nil
}

func normalizeAuditJSON(s string) string {
	if s == "" {
		return "null"
	}
	if json.Valid([]byte(s)) {
		return s
	}
	return AuditJSON(s)
}

// AuditJSON marshals v for AuditLog.Before/AfterState. Use it instead of
// hand-formatting JSON with fmt (%q is Go quoting, not JSON escaping).
func AuditJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

// LedgerEntryType mirrors the frontend's LedgerEntryType enum.
type LedgerEntryType string

const (
	LedgerEarnBooking  LedgerEntryType = "EARN_BOOKING"
	LedgerEarnPurchase LedgerEntryType = "EARN_PURCHASE"
	LedgerRedeem       LedgerEntryType = "REDEEM"
	LedgerAdjustManual LedgerEntryType = "ADJUST_MANUAL"
)

// 11. Append-only loyalty history (FR-4.1/FR-4.3, AC-6/AC-7). users.points is
// a cached sum of these rows; the ledger is what makes accrual/redemption
// auditable and traces a manual point adjustment back to an actor.
type PointsLedgerEntry struct {
	ID        string          `json:"id" db:"id" gorm:"primaryKey;column:id"`
	UserID    string          `json:"user_id" db:"user_id" gorm:"column:user_id"`
	Type      LedgerEntryType `json:"type" db:"type" gorm:"column:type"`
	Points    int             `json:"points" db:"points" gorm:"column:points"`                 // signed
	RefType   *string         `json:"ref_type,omitempty" db:"ref_type" gorm:"column:ref_type"` // "Booking", "Order", "Voucher"
	RefID     *string         `json:"ref_id,omitempty" db:"ref_id" gorm:"column:ref_id"`
	Note      *string         `json:"note,omitempty" db:"note" gorm:"column:note"`
	CreatedAt time.Time       `json:"created_at" db:"created_at" gorm:"column:created_at"`
	CreatedBy string          `json:"created_by" db:"created_by" gorm:"column:created_by"` // 'system' for automatic accrual
}

// 12. Rewards catalog (FR-4.2), kept separate from Voucher so it can be
// edited without touching redemption history.
type RewardCatalogItem struct {
	ID         string `json:"id" db:"id" gorm:"primaryKey;column:id"`
	Name       string `json:"name" db:"name" gorm:"column:name"`
	Emoji      string `json:"emoji" db:"emoji" gorm:"column:emoji"`
	PointsCost int    `json:"points_cost" db:"points_cost" gorm:"column:points_cost"`
	IsActive   bool   `json:"is_active" db:"is_active" gorm:"column:is_active"`
}

type VoucherStatus string

const (
	VoucherActive   VoucherStatus = "ACTIVE"
	VoucherRedeemed VoucherStatus = "REDEEMED"
	VoucherExpired  VoucherStatus = "EXPIRED"
)

// 13. A claimed reward (FR-4.3): created when a customer redeems points,
// then looked up by Code at the counter and marked REDEEMED on dispense.
type Voucher struct {
	ID          string        `json:"id" db:"id" gorm:"primaryKey;column:id"`
	Code        string        `json:"code" db:"code" gorm:"column:code"` // "RW-XXXXXX"
	UserID      string        `json:"user_id" db:"user_id" gorm:"column:user_id"`
	RewardID    string        `json:"reward_id" db:"reward_id" gorm:"column:reward_id"`
	PointsSpent int           `json:"points_spent" db:"points_spent" gorm:"column:points_spent"`
	Status      VoucherStatus `json:"status" db:"status" gorm:"column:status"`
	CreatedAt   time.Time     `json:"created_at" db:"created_at" gorm:"column:created_at"`
	DispensedAt *time.Time    `json:"dispensed_at,omitempty" db:"dispensed_at" gorm:"column:dispensed_at"`
	DispensedBy *string       `json:"dispensed_by,omitempty" db:"dispensed_by" gorm:"column:dispensed_by"`
}

// 14. Front-desk cash drawer session (FR-6). Cash totals are computed from
// bookings/orders paid by CASH within [OpenedAt, ClosedAt), not re-entered by
// staff, so the variance calculation has a single source of truth.
type Shift struct {
	ID           string     `json:"id" db:"id" gorm:"primaryKey;column:id"`
	StaffID      string     `json:"staff_id" db:"staff_id" gorm:"column:staff_id"`
	StaffName    string     `json:"staff_name" db:"staff_name" gorm:"column:staff_name"`
	OpenedAt     time.Time  `json:"opened_at" db:"opened_at" gorm:"column:opened_at"`
	OpeningFloat float64    `json:"opening_float" db:"opening_float" gorm:"column:opening_float"`
	ClosedAt     *time.Time `json:"closed_at,omitempty" db:"closed_at" gorm:"column:closed_at"`
	CountedCash  *float64   `json:"counted_cash,omitempty" db:"counted_cash" gorm:"column:counted_cash"`
	ExpectedCash *float64   `json:"expected_cash,omitempty" db:"expected_cash" gorm:"column:expected_cash"`
	VarianceCash *float64   `json:"variance_cash,omitempty" db:"variance_cash" gorm:"column:variance_cash"`
	Notes        *string    `json:"notes,omitempty" db:"notes" gorm:"column:notes"`
}
