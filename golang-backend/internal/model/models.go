package model

import "time"

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
	ID           string     `json:"id" db:"id" gorm:"primaryKey;column:id"`
	Name         string     `json:"name" db:"name" gorm:"column:name"`
	Email        *string    `json:"email,omitempty" db:"email" gorm:"column:email"`
	Phone        string     `json:"phone" db:"phone" gorm:"column:phone"`
	LineUserID   *string    `json:"line_user_id,omitempty" db:"line_user_id" gorm:"column:line_user_id"`
	Role         UserRole   `json:"role" db:"role" gorm:"column:role"`
	MemberType   MemberType `json:"member_type" db:"member_type" gorm:"column:member_type"`
	OrgName      *string    `json:"org_name,omitempty" db:"org_name" gorm:"column:org_name"`
	IsActive     bool       `json:"is_active" db:"is_active" gorm:"column:is_active"`
	Points       int        `json:"points" db:"points" gorm:"column:points"`
	PasswordHash string     `json:"-" db:"password_hash" gorm:"column:password_hash"` // Never expose to public JSON
	CreatedAt    time.Time  `json:"created_at" db:"created_at" gorm:"column:created_at"`
	UpdatedAt    time.Time  `json:"updated_at" db:"updated_at" gorm:"column:updated_at"`
}

// 2. Play Court Master
type Court struct {
	ID        string    `json:"id" db:"id" gorm:"primaryKey;column:id"`
	Name      string    `json:"name" db:"name" gorm:"column:name"`
	Type      CourtType `json:"type" db:"type" gorm:"column:type"`
	AllowHalf bool      `json:"allow_half" db:"allow_half" gorm:"column:allow_half"`
	IsActive  bool      `json:"is_active" db:"is_active" gorm:"column:is_active"`
	CreatedAt time.Time `json:"created_at" db:"created_at" gorm:"column:created_at"`
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

// 4. Overrides Days Off / Maintenance Blocks
type DayOff struct {
	ID        string    `json:"id" db:"id" gorm:"primaryKey;column:id"`
	Date      string    `json:"date" db:"date" gorm:"column:date;type:date"` // "YYYY-MM-DD"
	CourtID   string    `json:"court_id" db:"court_id" gorm:"column:court_id"` // "all" or Court ID
	Reason    string    `json:"reason" db:"reason" gorm:"column:reason"`
	CreatedAt time.Time `json:"created_at" db:"created_at" gorm:"column:created_at"`
}

// 5. Booking / Reservation Entry
type Booking struct {
	ID                 string        `json:"id" db:"id" gorm:"primaryKey;column:id"`
	BookingCode        string        `json:"booking_code" db:"booking_code" gorm:"column:booking_code"`
	CourtID            string        `json:"court_id" db:"court_id" gorm:"column:court_id"`
	UserID             string        `json:"user_id" db:"user_id" gorm:"column:user_id"`
	Date               string        `json:"date" db:"date" gorm:"column:date;type:date"` // "YYYY-MM-DD"
	StartTime          string        `json:"start_time" db:"start_time" gorm:"column:start_time;type:time"` // "HH:MM"
	EndTime            string        `json:"end_time" db:"end_time" gorm:"column:end_time;type:time"` // "HH:MM"
	IsHalfCourt        bool          `json:"is_half_court" db:"is_half_court" gorm:"column:is_half_court"`
	HalfCourtSide      *string       `json:"half_court_side,omitempty" db:"half_court_side" gorm:"column:half_court_side"` // "A", "B", "FULL"
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

// 6. Linked Payment Slip Information
type Payment struct {
	ID            string        `json:"id" db:"id" gorm:"primaryKey;column:id"`
	BookingID     string        `json:"booking_id" db:"booking_id" gorm:"column:booking_id"`
	Amount        float64       `json:"amount" db:"amount" gorm:"column:amount"`
	Method        PaymentMethod `json:"method" db:"method" gorm:"column:method"`
	Status        PaymentStatus `json:"status" db:"status" gorm:"column:status"`
	SlipURL       *string       `json:"slip_url,omitempty" db:"slip_url" gorm:"column:slip_url"`
	SlipUploadedAt *time.Time    `json:"slip_uploaded_at,omitempty" db:"slip_uploaded_at" gorm:"column:slip_uploaded_at"`
	VerifiedAt    *time.Time    `json:"verified_at,omitempty" db:"verified_at" gorm:"column:verified_at"`
	VerifiedBy    *string       `json:"verified_by,omitempty" db:"verified_by" gorm:"column:verified_by"`
	RefundedAt    *time.Time    `json:"refunded_at,omitempty" db:"refunded_at" gorm:"column:refunded_at"`
	RefundedBy    *string       `json:"refunded_by,omitempty" db:"refunded_by" gorm:"column:refunded_by"`
	RefundReason  *string       `json:"refund_reason,omitempty" db:"refund_reason" gorm:"column:refund_reason"`
	QrPayload     *string       `json:"qr_payload,omitempty" db:"qr_payload" gorm:"column:qr_payload"`
	CreatedAt     time.Time     `json:"created_at" db:"created_at" gorm:"column:created_at"`
	UpdatedAt     time.Time     `json:"updated_at" db:"updated_at" gorm:"column:updated_at"`
}

// 7. Inventory Items (Drinks, sales, rental shoes/rackets)
type Product struct {
	ID          string     `json:"id" db:"id" gorm:"primaryKey;column:id"`
	Name        string     `json:"name" db:"name" gorm:"column:name"`
	Category    ProductCat `json:"category" db:"category" gorm:"column:category"`
	SubCategory *string    `json:"sub_category,omitempty" db:"sub_category" gorm:"column:sub_category"`
	Price       float64    `json:"price" db:"price" gorm:"column:price"`
	IsRental    bool       `json:"is_rental" db:"is_rental" gorm:"column:is_rental"`
	Stock       int        `json:"stock" db:"stock" gorm:"column:stock"`
	IsActive    bool       `json:"is_active" db:"is_active" gorm:"column:is_active"`
	CreatedAt   time.Time  `json:"created_at" db:"created_at" gorm:"column:created_at"`
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
	Qty        int        `json:"qty" db:"qty" gorm:"column:qty"`
	UnitPrice  float64    `json:"unit_price" db:"unit_price" gorm:"column:unit_price"`
	ReturnedAt *time.Time `json:"returned_at,omitempty" db:"returned_at" gorm:"column:returned_at"` // filled when customer returns rental goods
	ShoeSize   *string    `json:"shoe_size,omitempty" db:"shoe_size" gorm:"column:shoe_size"`
	ShoeGender *string    `json:"shoe_gender,omitempty" db:"shoe_gender" gorm:"column:shoe_gender"` // "M" or "F" or "U"
	Notes      *string    `json:"notes,omitempty" db:"notes" gorm:"column:notes"`
}

// 10. Admin Audit Logs Tracer
type AuditLog struct {
	ID          string    `json:"id" db:"id" gorm:"primaryKey;column:id"`
	UserID      string    `json:"user_id" db:"user_id" gorm:"column:user_id"`
	UserName    string    `json:"user_name" db:"user_name" gorm:"column:user_name"`
	Action      string    `json:"action" db:"action" gorm:"column:action"`
	TargetType  string    `json:"target_type" db:"target_type" gorm:"column:target_type"`
	TargetID    string    `json:"target_id" db:"target_id" gorm:"column:target_id"`
	BeforeState string    `json:"before_state" db:"before_state" gorm:"column:before_state;type:jsonb"` // serialized JSON data
	AfterState  string    `json:"after_state" db:"after_state" gorm:"column:after_state;type:jsonb"`   // serialized JSON data
	CreatedAt   time.Time `json:"created_at" db:"created_at" gorm:"column:created_at"`
}
