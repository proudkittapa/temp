package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
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

// notResoldNoShow (one ? = paidStatuses) leaves out a no-show hour that a
// later paid booking re-used: on the same court, or a conflicting one (the
// full court over a half, a half under the full court). That booking fills
// the court-time; counting both put occupancy above 100%. Matched by court
// and hour rather than bookings.resale_of, which names only one no-show
// (both halves no-shows, then the full court sold, is one court-hour). A
// no-show nobody re-bought still counts - the hour was sold and paid.
// Revenue keeps counting both (both paid).
const notResoldNoShow = "NOT (b.status = 'NO_SHOW' AND EXISTS (SELECT 1 FROM bookings r " +
	"JOIN courts rc ON rc.id = r.court_id JOIN courts bc ON bc.id = b.court_id " +
	"WHERE r.id <> b.id AND r.date = b.date AND r.start_time = b.start_time AND r.status IN ? AND r.created_at > b.created_at " +
	"AND (r.court_id = b.court_id OR (rc.mutex_group_id = bc.mutex_group_id AND (rc.share_of_group >= 1 OR bc.share_of_group >= 1)))))"

// occupiedShare sums the court share (1, or 0.5 for a half court) of the
// paid bookings matching where/args, grouped by groupBy when set.
func (s *ReportService) occupiedShare(db *gorm.DB, where string, args ...any) (float64, error) {
	var v float64
	// Only active courts: capacity counts active courts, so hours on a
	// court closed since would push occupancy past 100%.
	err := db.Raw("SELECT COALESCE(SUM(c.share_of_group), 0) FROM bookings b JOIN courts c ON c.id = b.court_id AND c.is_active "+
		"WHERE b.status IN ? AND "+notResoldNoShow+" AND "+where, append([]any{paidStatuses, paidStatuses}, args...)...).Scan(&v).Error
	return v, err
}

func pct(part, whole float64) float64 {
	if whole <= 0 {
		return 0
	}
	return float64(int(part/whole*1000+0.5)) / 10
}

func (s *ReportService) Dashboard(ctx context.Context, date string) (*Dashboard, error) {
	from, to, err := BangkokDay(date)
	if err != nil {
		return nil, err
	}
	db := s.db.WithContext(ctx)
	// Six months up to the date's month (Bangkok).
	monthStart := time.Date(from.Year(), from.Month(), 1, 0, 0, 0, 0, Bangkok)
	firstMonth, monthEnd := monthStart.AddDate(0, -5, 0), monthStart.AddDate(0, 1, 0)
	thisMonth := monthStart.Format("2006-01")
	// Grouped queries (one per table and grain) instead of one per figure:
	// the dashboard used to make ~33 round trips, 18 of them in a month loop.

	// Settings and the all-time figures that need no grouping.
	var head struct {
		OpenHour, CloseHour int
		PhysicalCourts      int64
		AllTimeOrderSales   float64
		AllTimeRefunds      float64
		CustomerCount       int64
	}
	res := db.Raw("SELECT c.open_hour, c.close_hour, "+
		"(SELECT COUNT(DISTINCT COALESCE(mutex_group_id, id)) FROM courts WHERE is_active) AS physical_courts, "+
		"(SELECT COALESCE(SUM(total_amount + deposit_kept), 0) FROM orders WHERE status <> ?) AS all_time_order_sales, "+ // kept deposits are income
		"(SELECT COALESCE(SUM(amount), 0) FROM refunds) AS all_time_refunds, "+
		"(SELECT COUNT(*) FROM users WHERE role = ?) AS customer_count "+
		"FROM pricing_configs c WHERE c.id = ?", model.OrderCancelled, model.RoleCustomer, "global").Scan(&head)
	if res.Error != nil {
		return nil, res.Error
	}
	if res.RowsAffected == 0 {
		return nil, fmt.Errorf("pricing config missing: %w", gorm.ErrRecordNotFound)
	}
	d := &Dashboard{Date: date, HoursPerDay: head.CloseHour - head.OpenHour, MonthBySport: map[string]float64{},
		PhysicalCourts: head.PhysicalCourts, CustomerCount: head.CustomerCount,
		AllTimeOrderSales: RoundBaht(head.AllTimeOrderSales), AllTimeRefunds: RoundBaht(head.AllTimeRefunds)}

	// Bookings: the day, unpaid holds and all-time sales in one pass.
	var bk struct {
		DayRevenue float64
		DayCount   int64
		Pending    float64
		AllPaid    float64
	}
	if err := db.Raw("SELECT "+
		"COALESCE(SUM(total_amount) FILTER (WHERE date = ? AND status IN ?), 0) AS day_revenue, "+
		"COUNT(*) FILTER (WHERE date = ? AND status IN ?) AS day_count, "+
		"COALESCE(SUM(total_amount) FILTER (WHERE status = ?), 0) AS pending, "+
		"COALESCE(SUM(total_amount) FILTER (WHERE status IN ?), 0) AS all_paid FROM bookings",
		date, paidStatuses, date, paidStatuses, model.BookingPendingPayment, paidStatuses).Scan(&bk).Error; err != nil {
		return nil, err
	}
	d.DailyBookingsRevenue, d.DailyBookingsCount = RoundBaht(bk.DayRevenue), bk.DayCount
	d.PendingRevenue, d.AllTimeBookingSales = RoundBaht(bk.Pending), RoundBaht(bk.AllPaid)

	// Paid bookings by month and sport over the six months (the monthly
	// chart sums the sports; the sport chart is the date's month).
	var bookingMonths []struct {
		Month string
		Type  *string
		Total float64
	}
	if err := db.Raw("SELECT to_char(b.date, 'YYYY-MM') AS month, c.type, COALESCE(SUM(b.total_amount), 0) AS total "+
		"FROM bookings b LEFT JOIN courts c ON c.id = b.court_id "+
		"WHERE b.status IN ? AND b.date >= ? AND b.date < ? GROUP BY 1, 2",
		paidStatuses, firstMonth.Format("2006-01-02"), monthEnd.Format("2006-01-02")).Scan(&bookingMonths).Error; err != nil {
		return nil, err
	}
	bookingsByMonth := map[string]float64{}
	for _, r := range bookingMonths {
		bookingsByMonth[r.Month] += r.Total
		if r.Month == thisMonth && r.Type != nil {
			d.MonthBySport[*r.Type] = RoundBaht(d.MonthBySport[*r.Type] + r.Total)
		}
	}

	// Counter sales lines by kind and Bangkok month, with the date's share:
	// the day's order revenue, the monthly chart and the all-time split.
	var lines []struct {
		Kind     string
		Month    string
		Total    float64
		DayTotal float64
	}
	if err := db.Raw("SELECT "+saleKindSQL+" AS kind, to_char(o.created_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') AS month, "+
		"COALESCE(SUM(i.qty * i.unit_price), 0) AS total, "+
		"COALESCE(SUM(i.qty * i.unit_price) FILTER (WHERE o.created_at >= ? AND o.created_at < ?), 0) AS day_total "+
		"FROM order_items i JOIN orders o ON o.id = i.order_id "+
		"LEFT JOIN products p ON p.id = i.product_id WHERE o.status <> ? GROUP BY 1, 2",
		model.OrderEquipmentRent, model.ProductEquipment, from, to, model.OrderCancelled).Scan(&lines).Error; err != nil {
		return nil, err
	}
	ordersByMonth := map[string]float64{}
	var dayOrders, food, equipment, rental float64
	for _, r := range lines {
		ordersByMonth[r.Month] += r.Total
		dayOrders += r.DayTotal
		switch r.Kind {
		case "rental":
			rental += r.Total
		case "equipment":
			equipment += r.Total
		default:
			food += r.Total
		}
	}
	// Kept rental deposits are income (owner 2026-10-23), in the month and
	// on the day they were kept.
	var kept []struct {
		Month    string
		Total    float64
		DayTotal float64
	}
	if err := db.Raw("SELECT to_char(deposit_settled_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') AS month, "+
		"COALESCE(SUM(deposit_kept), 0) AS total, "+
		"COALESCE(SUM(deposit_kept) FILTER (WHERE deposit_settled_at >= ? AND deposit_settled_at < ?), 0) AS day_total "+
		"FROM orders WHERE deposit_kept > 0 AND deposit_settled_at IS NOT NULL AND status <> ? GROUP BY 1",
		from, to, model.OrderCancelled).Scan(&kept).Error; err != nil {
		return nil, err
	}
	for _, r := range kept {
		ordersByMonth[r.Month] += r.Total
		dayOrders += r.DayTotal
		rental += r.Total
	}
	d.SalesSplit = SalesSplit{Food: RoundBaht(food), Equipment: RoundBaht(equipment), Rental: RoundBaht(rental)}
	d.DailyOrderRevenue = RoundBaht(dayOrders)
	d.DailyTotalRevenue = RoundBaht(d.DailyBookingsRevenue + d.DailyOrderRevenue)
	for ms := firstMonth; ms.Before(monthEnd); ms = ms.AddDate(0, 1, 0) {
		m := ms.Format("2006-01")
		d.MonthlyRevenue = append(d.MonthlyRevenue, MonthRevenue{Month: m, Bookings: RoundBaht(bookingsByMonth[m]), Orders: RoundBaht(ordersByMonth[m])})
	}

	// Occupancy: the day, and by hour over the 30 days up to it.
	occupied, err := s.occupiedShare(db, "b.date = ?", date)
	if err != nil {
		return nil, err
	}
	d.OccupancyRate = pct(occupied, float64(d.PhysicalCourts)*float64(d.HoursPerDay))
	start := from.AddDate(0, 0, -29).Format("2006-01-02")
	var hourly []struct {
		StartTime string
		Share     float64
	}
	if err := db.Raw("SELECT b.start_time, COALESCE(SUM(c.share_of_group), 0) AS share FROM bookings b "+
		"JOIN courts c ON c.id = b.court_id AND c.is_active WHERE b.status IN ? AND "+notResoldNoShow+" AND b.date >= ? AND b.date <= ? GROUP BY b.start_time",
		paidStatuses, paidStatuses, start, date).Scan(&hourly).Error; err != nil {
		return nil, err
	}
	byHour := map[string]float64{}
	for _, h := range hourly {
		byHour[h.StartTime] = h.Share
	}
	capacity := float64(d.PhysicalCourts) * 30
	for h := head.OpenHour; h < head.CloseHour; h++ {
		label := fmt.Sprintf("%02d:00", h)
		d.HourlyOccupancy = append(d.HourlyOccupancy, HourOccupancy{Hour: label, Percent: pct(byHour[label], capacity)})
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
	from, to := ms.Format("2006-01-02"), me.Format("2006-01-02")
	// The whole month - an export must not silently drop rows.
	var bookings []model.Booking
	if err := db.Where("date >= ? AND date < ?", from, to).
		Order("date, start_time, court_id").Find(&bookings).Error; err != nil {
		return nil, err
	}
	bookings = normalizeDates(bookings)

	// A group's payment hangs off one of its rows: fetch the payments of
	// the month's groups with their booking code in one query (no
	// thousands-long IN lists).
	var payments []struct {
		model.Payment
		Code string
	}
	if err := db.Raw("SELECT p.*, b.booking_code AS code FROM payments p JOIN bookings b ON b.id = p.booking_id "+
		"WHERE b.date >= ? AND b.date < ? ORDER BY p.created_at", from, to).Scan(&payments).Error; err != nil {
		return nil, err
	}
	payByCode := map[string]model.Payment{}
	for _, p := range payments {
		payByCode[p.Code] = p.Payment // latest wins
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
			PaymentMethod: string(p.Method), PaymentStatus: string(p.Status)}
		// The refund belongs to the payment, not to each hour: put it on the
		// payment's own row only, so the column adds up.
		if p.BookingID == b.ID {
			out.Bookings[i].RefundAmount = p.RefundAmount
		}
	}
	if out.Orders, err = s.pos.ListOrders(ctx, ms, me, 0); err != nil {
		return nil, err
	}
	return out, nil
}

type AuditQuery struct {
	Search     string
	TargetType string
	Limit      int
	Offset     int
	// BeforeID continues a page: entries older than this one (keyset - as
	// fast on page 100 as on page 1, unlike Offset).
	BeforeID string
}

// AuditLogs lists the audit trail newest first, filtered by target type
// and a search over actor, action and target id, with the total count.
// AuditLogs returns one page, newest first, and whether more entries match.
// There is no total: counting every matching row cost as much as the page
// itself on each request, and the screens only need "more?".
func (s *ReportService) AuditLogs(ctx context.Context, q AuditQuery) ([]model.AuditLog, bool, error) {
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
		// Same expression as the trigram index idx_audit_logs_search_trgm
		// (auditSearchExpr in perf_indexes.go) - keep the two identical.
		db = db.Where("lower(coalesce(user_name, '') || ' ' || coalesce(action, '') || ' ' || "+
			"coalesce(target_id, '') || ' ' || coalesce(reason, '')) LIKE ?", like)
	}
	if q.BeforeID != "" {
		var cur model.AuditLog
		if err := s.db.WithContext(ctx).Select("id", "created_at").Take(&cur, "id = ?", q.BeforeID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, false, fmt.Errorf("%w: before_id is not an audit entry", ErrInvalidBooking)
			}
			return nil, false, err
		}
		db = db.Where("(created_at, id) < (?, ?)", cur.CreatedAt, cur.ID)
		q.Offset = 0
	}
	var logs []model.AuditLog
	if err := db.Order("created_at DESC, id DESC").Limit(q.Limit + 1).Offset(q.Offset).Find(&logs).Error; err != nil {
		return nil, false, err
	}
	if len(logs) > q.Limit {
		return logs[:q.Limit], true, nil
	}
	return logs, false, nil
}

// LogExport records that someone downloaded a month's report (it carries
// customer names and phone numbers).
func (s *ReportService) LogExport(ctx context.Context, month, kind, actorID, actorName string) error {
	return s.db.WithContext(ctx).Create(&model.AuditLog{
		ID: ids.New("log"), UserID: actorID, UserName: actorName, Action: "REPORT_EXPORTED", TargetType: "Report", TargetID: month,
		AfterState: model.AuditJSON(map[string]any{"month": month, "kind": kind}), CreatedAt: time.Now(),
	}).Error
}
