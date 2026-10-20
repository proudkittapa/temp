package service

import (
	"context"
	"fmt"
	"strings"
	"time"

	"arena-backend/internal/model"
	"gorm.io/gorm"
)

// ReportService computes the admin dashboard, the monthly export and the
// audit-log listing from the database (FR-7.2/7.3/7.4), so every manager
// sees the same numbers instead of whatever one browser recorded.
type ReportService struct {
	db  *gorm.DB
	pos *POSService
}

func NewReportService(db *gorm.DB, pos *POSService) *ReportService {
	return &ReportService{db: db, pos: pos}
}

type MonthRevenue struct {
	Month    string  `json:"month"` // YYYY-MM
	Bookings float64 `json:"bookings"`
	Orders   float64 `json:"orders"`
}

type HourOccupancy struct {
	Hour    string  `json:"hour"` // HH:00
	Percent float64 `json:"percent"`
}

type SalesSplit struct {
	Food      float64 `json:"food"`
	Equipment float64 `json:"equipment"`
	Rental    float64 `json:"rental"`
}

// Dashboard is everything the admin dashboard shows for one date.
type Dashboard struct {
	Date                 string             `json:"date"`
	DailyBookingsRevenue float64            `json:"daily_bookings_revenue"`
	DailyBookingsCount   int64              `json:"daily_bookings_count"`
	DailyOrderRevenue    float64            `json:"daily_order_revenue"`
	DailyTotalRevenue    float64            `json:"daily_total_revenue"`
	OccupancyRate        float64            `json:"occupancy_rate"` // % of the day's court-hours sold
	PhysicalCourts       int64              `json:"physical_courts"`
	HoursPerDay          int                `json:"hours_per_day"`
	PendingRevenue       float64            `json:"pending_revenue"` // unpaid holds still waiting for a slip, any date
	AllTimeBookingSales  float64            `json:"all_time_booking_sales"`
	AllTimeOrderSales    float64            `json:"all_time_order_sales"`
	AllTimeRefunds       float64            `json:"all_time_refunds"`
	CustomerCount        int64              `json:"customer_count"`
	MonthlyRevenue       []MonthRevenue     `json:"monthly_revenue"`  // six months up to the date's month
	HourlyOccupancy      []HourOccupancy    `json:"hourly_occupancy"` // average over the 30 days up to the date
	SalesSplit           SalesSplit         `json:"sales_split"`      // all-time counter sales by kind
	MonthBySport         map[string]float64 `json:"month_by_sport"`   // the date's month, paid bookings by court type
}

// physicalCourts counts active courts, a full court and its half-court
// sides (one mutex group) once.
func (s *ReportService) physicalCourts(db *gorm.DB) (int64, error) {
	var n int64
	err := db.Raw("SELECT COUNT(DISTINCT COALESCE(mutex_group_id, id)) FROM courts WHERE is_active").Scan(&n).Error
	return n, err
}

// occupiedShare sums the court share (1, or 0.5 for a half court) of the
// paid bookings matching where/args, grouped by groupBy when set.
func (s *ReportService) occupiedShare(db *gorm.DB, where string, args ...any) (float64, error) {
	var v float64
	err := db.Raw("SELECT COALESCE(SUM(COALESCE(c.share_of_group, 1)), 0) FROM bookings b LEFT JOIN courts c ON c.id = b.court_id "+
		"WHERE b.status IN ? AND "+where, append([]any{paidStatuses}, args...)...).Scan(&v).Error
	return v, err
}

func pct(part, whole float64) float64 {
	if whole <= 0 {
		return 0
	}
	return float64(int(part/whole*1000+0.5)) / 10
}

func (s *ReportService) Dashboard(ctx context.Context, date string) (*Dashboard, error) {
	from, to, err := bangkokDay(date)
	if err != nil {
		return nil, err
	}
	db := s.db.WithContext(ctx)
	d := &Dashboard{Date: date, HoursPerDay: ClosingHour - OpeningHour, MonthBySport: map[string]float64{}}

	// The day
	if err := db.Model(&model.Booking{}).Select("COALESCE(SUM(total_amount), 0)").
		Where("date = ? AND status IN ?", date, paidStatuses).Scan(&d.DailyBookingsRevenue).Error; err != nil {
		return nil, err
	}
	if err := db.Model(&model.Booking{}).Where("date = ? AND status IN ?", date, paidStatuses).Count(&d.DailyBookingsCount).Error; err != nil {
		return nil, err
	}
	dayOrders, err := s.pos.TotalsBetween(ctx, from, to)
	if err != nil {
		return nil, err
	}
	d.DailyOrderRevenue = RoundBaht(dayOrders.FB + dayOrders.EquipmentSales + dayOrders.Rentals)
	d.DailyBookingsRevenue = RoundBaht(d.DailyBookingsRevenue)
	d.DailyTotalRevenue = RoundBaht(d.DailyBookingsRevenue + d.DailyOrderRevenue)
	if d.PhysicalCourts, err = s.physicalCourts(db); err != nil {
		return nil, err
	}
	occupied, err := s.occupiedShare(db, "b.date = ?", date)
	if err != nil {
		return nil, err
	}
	d.OccupancyRate = pct(occupied, float64(d.PhysicalCourts)*float64(d.HoursPerDay))

	// All time
	if err := db.Model(&model.Booking{}).Select("COALESCE(SUM(total_amount), 0)").
		Where("status = ?", model.BookingPendingPayment).Scan(&d.PendingRevenue).Error; err != nil {
		return nil, err
	}
	if err := db.Model(&model.Booking{}).Select("COALESCE(SUM(total_amount), 0)").
		Where("status IN ?", paidStatuses).Scan(&d.AllTimeBookingSales).Error; err != nil {
		return nil, err
	}
	if err := db.Model(&model.Order{}).Select("COALESCE(SUM(total_amount), 0)").
		Where("status <> ?", model.OrderCancelled).Scan(&d.AllTimeOrderSales).Error; err != nil {
		return nil, err
	}
	if err := db.Model(&model.Payment{}).Select("COALESCE(SUM(refund_amount), 0)").Scan(&d.AllTimeRefunds).Error; err != nil {
		return nil, err
	}
	if err := db.Model(&model.User{}).Where("role = ?", model.RoleCustomer).Count(&d.CustomerCount).Error; err != nil {
		return nil, err
	}
	d.PendingRevenue, d.AllTimeBookingSales, d.AllTimeOrderSales, d.AllTimeRefunds =
		RoundBaht(d.PendingRevenue), RoundBaht(d.AllTimeBookingSales), RoundBaht(d.AllTimeOrderSales), RoundBaht(d.AllTimeRefunds)

	// Six months up to the date's month
	monthStart := time.Date(from.Year(), from.Month(), 1, 0, 0, 0, 0, Bangkok)
	for i := 5; i >= 0; i-- {
		ms := monthStart.AddDate(0, -i, 0)
		me := ms.AddDate(0, 1, 0)
		row := MonthRevenue{Month: ms.Format("2006-01")}
		if err := db.Model(&model.Booking{}).Select("COALESCE(SUM(total_amount), 0)").
			Where("date >= ? AND date < ? AND status IN ?", ms.Format("2006-01-02"), me.Format("2006-01-02"), paidStatuses).
			Scan(&row.Bookings).Error; err != nil {
			return nil, err
		}
		totals, err := s.pos.TotalsBetween(ctx, ms, me)
		if err != nil {
			return nil, err
		}
		row.Bookings, row.Orders = RoundBaht(row.Bookings), RoundBaht(totals.FB+totals.EquipmentSales+totals.Rentals)
		d.MonthlyRevenue = append(d.MonthlyRevenue, row)
	}

	// Hourly occupancy over 30 days
	start := from.AddDate(0, 0, -29).Format("2006-01-02")
	var hourly []struct {
		StartTime string
		Share     float64
	}
	if err := db.Raw("SELECT b.start_time, COALESCE(SUM(COALESCE(c.share_of_group, 1)), 0) AS share FROM bookings b "+
		"LEFT JOIN courts c ON c.id = b.court_id WHERE b.status IN ? AND b.date >= ? AND b.date <= ? GROUP BY b.start_time",
		paidStatuses, start, date).Scan(&hourly).Error; err != nil {
		return nil, err
	}
	byHour := map[string]float64{}
	for _, h := range hourly {
		byHour[h.StartTime] = h.Share
	}
	capacity := float64(d.PhysicalCourts) * 30
	for h := OpeningHour; h < ClosingHour; h++ {
		label := fmt.Sprintf("%02d:00", h)
		d.HourlyOccupancy = append(d.HourlyOccupancy, HourOccupancy{Hour: label, Percent: pct(byHour[label], capacity)})
	}

	// Counter sales by kind (all time)
	var split []struct {
		Kind  string
		Total float64
	}
	if err := db.Raw("SELECT CASE WHEN o.type = ? OR p.is_rental THEN 'rental' WHEN p.category = ? THEN 'equipment' ELSE 'food' END AS kind, "+
		"COALESCE(SUM(i.qty * i.unit_price), 0) AS total FROM order_items i JOIN orders o ON o.id = i.order_id "+
		"LEFT JOIN products p ON p.id = i.product_id WHERE o.status <> ? GROUP BY 1",
		model.OrderEquipmentRent, model.ProductEquipment, model.OrderCancelled).Scan(&split).Error; err != nil {
		return nil, err
	}
	for _, r := range split {
		switch r.Kind {
		case "rental":
			d.SalesSplit.Rental = RoundBaht(r.Total)
		case "equipment":
			d.SalesSplit.Equipment = RoundBaht(r.Total)
		default:
			d.SalesSplit.Food = RoundBaht(r.Total)
		}
	}

	// The month's paid bookings by sport
	var sports []struct {
		Type  string
		Total float64
	}
	me := monthStart.AddDate(0, 1, 0)
	if err := db.Raw("SELECT c.type, COALESCE(SUM(b.total_amount), 0) AS total FROM bookings b JOIN courts c ON c.id = b.court_id "+
		"WHERE b.status IN ? AND b.date >= ? AND b.date < ? GROUP BY c.type",
		paidStatuses, monthStart.Format("2006-01-02"), me.Format("2006-01-02")).Scan(&sports).Error; err != nil {
		return nil, err
	}
	for _, r := range sports {
		d.MonthBySport[r.Type] = RoundBaht(r.Total)
	}
	return d, nil
}

// ReportBookingRow is one booked hour in the monthly export, with the
// group's payment.
type ReportBookingRow struct {
	model.Booking
	CourtName     string  `json:"court_name"`
	PaymentMethod string  `json:"payment_method"`
	PaymentStatus string  `json:"payment_status"`
	RefundAmount  float64 `json:"refund_amount"`
}

type MonthReport struct {
	Month    string             `json:"month"`
	Bookings []ReportBookingRow `json:"bookings"`
	Orders   []OrderView        `json:"orders"`
}

// MonthReport lists a month's bookings (every status, so cancellations and
// refunds are visible) and counter orders for the Excel/CSV export.
func (s *ReportService) MonthReport(ctx context.Context, month string) (*MonthReport, error) {
	ms, err := time.ParseInLocation("2006-01", month, Bangkok)
	if err != nil {
		return nil, fmt.Errorf("%w: month must be YYYY-MM", ErrInvalidBooking)
	}
	me := ms.AddDate(0, 1, 0)
	db := s.db.WithContext(ctx)
	var bookings []model.Booking
	if err := db.Where("date >= ? AND date < ?", ms.Format("2006-01-02"), me.Format("2006-01-02")).
		Order("date, start_time, court_id").Limit(20000).Find(&bookings).Error; err != nil {
		return nil, err
	}
	bookings = normalizeDates(bookings)

	// A group's payment hangs off one of its rows: map every row of the
	// month's groups to its booking code, then each code to its payment.
	codes := map[string]bool{}
	for _, b := range bookings {
		codes[b.BookingCode] = true
	}
	codeList := make([]string, 0, len(codes))
	for c := range codes {
		codeList = append(codeList, c)
	}
	payByCode := map[string]model.Payment{}
	if len(codeList) > 0 {
		var groupRows []model.Booking
		if err := db.Select("id, booking_code").Where("booking_code IN ?", codeList).Find(&groupRows).Error; err != nil {
			return nil, err
		}
		codeOf := map[string]string{}
		rowIDs := make([]string, len(groupRows))
		for i, r := range groupRows {
			codeOf[r.ID], rowIDs[i] = r.BookingCode, r.ID
		}
		var payments []model.Payment
		if err := db.Where("booking_id IN ?", rowIDs).Order("created_at").Find(&payments).Error; err != nil {
			return nil, err
		}
		for _, p := range payments {
			payByCode[codeOf[p.BookingID]] = p // latest wins
		}
	}
	var courts []model.Court
	if err := db.Find(&courts).Error; err != nil {
		return nil, err
	}
	courtName := map[string]string{}
	for _, c := range courts {
		courtName[c.ID] = c.Name
	}
	out := &MonthReport{Month: month, Bookings: make([]ReportBookingRow, len(bookings))}
	for i, b := range bookings {
		p := payByCode[b.BookingCode]
		out.Bookings[i] = ReportBookingRow{Booking: b, CourtName: courtName[b.CourtID],
			PaymentMethod: string(p.Method), PaymentStatus: string(p.Status), RefundAmount: p.RefundAmount}
	}
	if out.Orders, err = s.pos.ListOrders(ctx, ms, me); err != nil {
		return nil, err
	}
	return out, nil
}

type AuditQuery struct {
	Search     string
	TargetType string
	Limit      int
	Offset     int
}

// AuditLogs lists the audit trail newest first, filtered by target type
// and a search over actor, action and target id, with the total count.
func (s *ReportService) AuditLogs(ctx context.Context, q AuditQuery) ([]model.AuditLog, int64, error) {
	if q.Limit <= 0 || q.Limit > 500 {
		q.Limit = 200
	}
	if q.Offset < 0 {
		q.Offset = 0
	}
	db := s.db.WithContext(ctx).Model(&model.AuditLog{})
	if q.TargetType != "" {
		db = db.Where("target_type = ?", q.TargetType)
	}
	if term := strings.TrimSpace(q.Search); term != "" {
		like := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(strings.ToLower(term)) + "%"
		db = db.Where("LOWER(user_name) LIKE ? OR LOWER(action) LIKE ? OR LOWER(target_id) LIKE ? OR LOWER(COALESCE(reason, '')) LIKE ?", like, like, like, like)
	}
	var total int64
	if err := db.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var logs []model.AuditLog
	if err := db.Order("created_at DESC").Limit(q.Limit).Offset(q.Offset).Find(&logs).Error; err != nil {
		return nil, 0, err
	}
	return logs, total, nil
}
