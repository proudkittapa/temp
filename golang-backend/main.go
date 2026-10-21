package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
	_ "time/tzdata" // Asia/Bangkok must resolve even on hosts without tzdata

	"arena-backend/internal/handler"
	"arena-backend/internal/model"
	"arena-backend/internal/repository"
	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// loadEnv parses custom environment files line by line and registers
// key-values with os.Setenv. A variable already set in the process
// environment wins over the file, as with other dotenv loaders: dev-runner.js
// sets PORT and SEED_DEMO_USERS for `npm run dev:api`, and a .env copied
// from .env.example (SEED_DEMO_USERS=false, maybe another PORT) used to
// silently override them - no demo accounts, or a backend the Vite proxy
// can't reach.
// Reports whether the file existed.
func loadEnv(filename string) bool {
	file, err := os.Open(filename)
	if err != nil {
		return false
	}
	defer file.Close()

	log.Printf("[EnvLoader] Successfully parsing environment keys from %s...\n", filename)
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		// Ignore comment lines and blank rows
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}

		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])

		// Strip surrounding string quotes if present
		if len(val) >= 2 && ((val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'')) {
			val = val[1 : len(val)-1]
		}

		if _, alreadySet := os.LookupEnv(key); alreadySet {
			continue
		}
		os.Setenv(key, val)
	}
	if err := scanner.Err(); err != nil {
		log.Printf("[EnvLoader] Warning: error reading env file scanner: %v\n", err)
	}
	return true
}

func main() {
	// Load the .env configuration at early startup before accessing
	// variables. Without a .env, the documented local defaults in
	// .env.example are used - the one place the local database password is
	// written down (it used to be repeated as a fallback in this file).
	if !loadEnv(".env") && loadEnv(".env.example") {
		log.Println("[EnvLoader] No .env file - using the local-development defaults from .env.example. Copy it to .env to change them.")
	}

	// 1. Database configurations setup
	pgConnString := os.Getenv("DATABASE_URL")
	if pgConnString == "" {
		log.Fatalln("DATABASE_URL is not set: set it in the environment or in golang-backend/.env (see .env.example).")
	}

	log.Printf("Connecting Go database using GORM with postgres driver...")
	db, err := gorm.Open(postgres.Open(pgConnString), &gorm.Config{})
	if err != nil {
		log.Fatalf("Critical error instantiating DB with GORM: %v\n", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		log.Fatalf("Failed to retrieve generic sql.DB engine: %v\n", err)
	}

	if err := sqlDB.Ping(); err != nil {
		log.Fatalf("Database is unreachable: %v\n", err)
	}
	log.Println("GORM Database connection established successfully!")

	// 1b. GORM AutoMigrate to guarantee database schema is 100% complete!
	log.Println("Running GORM AutoMigrate for all system schemas...")
	err = db.AutoMigrate(
		&model.User{},
		&model.Court{},
		&model.PricingRule{},
		&model.PricingConfig{},
		&model.MemberDiscount{},
		&model.DayOff{},
		&model.Booking{},
		&model.Payment{},
		&model.Product{},
		&model.ProductVariant{},
		&model.Order{},
		&model.OrderItem{},
		&model.AuditLog{},
		&model.PointsLedgerEntry{},
		&model.RewardCatalogItem{},
		&model.Voucher{},
		&model.Shift{},
		&model.LoginFailure{},
		&model.Refund{},
		&model.AppMigration{},
	)
	if err != nil {
		log.Fatalf("Database initial migration failed: %v\n", err)
	}
	log.Println("Database schemas verified and migrated successfully!")
	ensureUserUniqueIndexes(db)
	runDataMigrations(db) // before ensureIndexes: the slip index needs slip_released filled in
	ensureIndexes(db)
	warnDuplicatePhones(db)

	// 1c. Seed the config rows the pricing engine needs to not error on a
	// fresh database - AutoMigrate only creates schema, not data. FirstOrCreate
	// makes this idempotent, so it's safe to run on every startup.
	seedDefaults(db)

	// 2. Initialize Repositories & Services Slices
	bkRepo := repository.NewBookingRepository(db)
	usrRepo := repository.NewUserRepository(db)
	courtRepo := repository.NewCourtRepository(db)
	auditRepo := repository.NewAuditRepository(db)

	serverSecret := resolveJWTSecret()
	if gin.Mode() == gin.ReleaseMode && len(trustedProxies()) == 0 {
		log.Println("WARNING: TRUSTED_PROXIES is not set. Behind a reverse proxy every client then has the proxy's IP, " +
			"so the per-IP login and sign-up limits lock out everyone at once. Set it to the proxy's address.")
	}
	authService := service.NewAuthService(usrRepo, auditRepo, serverSecret, service.NewLoginThrottle(db))
	slipSigner := handler.NewSlipSigner(serverSecret)
	userService := service.NewUserService(db, usrRepo)
	membershipService := service.NewMembershipService(db, usrRepo)
	priceEngineService := service.NewPriceEngineService(courtRepo, membershipService)
	paymentService, err := service.NewPaymentService(os.Getenv("PROMPTPAY_ID"))
	if err != nil {
		log.Fatalf("PROMPTPAY_ID is invalid: %v\n", err)
	}
	bookingService := service.NewBookingService(db, bkRepo, usrRepo, courtRepo, priceEngineService, paymentService)
	posService := service.NewPOSService(db, usrRepo)
	dayOffHandler := handler.NewDayOffHandler(service.NewDayOffService(db))
	pricingHandler := handler.NewPricingHandler(service.NewPricingAdminService(db))
	rewardService := service.NewRewardService(db, usrRepo)
	rewardHandler := handler.NewRewardHandler(rewardService)
	courtHandler := handler.NewCourtHandler(service.NewCourtAdminService(db))
	shopHandler := handler.NewShopHandler(posService, service.NewReportService(db, posService), bookingService, service.NewShiftService(db))

	arenaHandler := handler.NewArenaHandler(authService, userService, membershipService, bookingService, slipSigner)

	// 3. Launch Gin Web Engine Router
	router := gin.Default()
	// c.ClientIP() feeds the login throttle, so X-Forwarded-For is only
	// believed from proxies listed in TRUSTED_PROXIES (comma-separated IPs
	// or CIDRs, e.g. your reverse proxy). Otherwise anyone could send a
	// fake header to dodge the per-IP limit.
	if err := router.SetTrustedProxies(trustedProxies()); err != nil {
		log.Fatalf("TRUSTED_PROXIES is invalid: %v\n", err)
	}

	// Ensure local uploads directory exists to avoid filesystem write errors
	if err := os.MkdirAll("./uploads/slips", 0755); err != nil {
		log.Printf("Warning: failed to create uploads directory: %v\n", err)
	}

	// Slips are NOT served as a public static directory: they show bank
	// details. They are fetched through signed, expiring links handed only
	// to the booking's owner and staff - see handler.SlipSigner.

	// CORS. The API authenticates with a bearer token, never cookies, so it
	// sends no Access-Control-Allow-Credentials (combined with
	// Allow-Origin "*" that was invalid, and browsers rejected it).
	// CORS_ALLOWED_ORIGINS (comma-separated, e.g. https://book.example.com)
	// restricts cross-site callers; unset allows any origin.
	allowedOrigins := map[string]bool{}
	for _, o := range strings.Split(os.Getenv("CORS_ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			allowedOrigins[o] = true
		}
	}
	router.Use(func(c *gin.Context) {
		if len(allowedOrigins) == 0 {
			c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		} else {
			c.Writer.Header().Add("Vary", "Origin")
			if origin := c.GetHeader("Origin"); allowedOrigins[origin] {
				c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
			}
		}
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, DELETE, PATCH")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	})

	// 4. API Endpoints Map layout. Authenticate only parses an optional
	// bearer token; RequireRole gates each route that needs a login.
	api := router.Group("/api/v1", handler.LimitBody(), handler.Authenticate(authService, userService))
	loggedIn := handler.RequireRole()
	staffOnly := handler.RequireRole(handler.StaffRoles...)
	managerOnly := handler.RequireRole(handler.ManagerRoles...)
	adminOnly := handler.RequireRole(handler.AdminRoles...)
	{
		// Authentication Ports
		api.POST("/auth/register", arenaHandler.Register)
		api.POST("/auth/login", arenaHandler.Login)
		api.GET("/auth/me", loggedIn, arenaHandler.Me)

		// Public availability
		api.GET("/courts", arenaHandler.ListCourts)
		api.GET("/courts/slots", arenaHandler.GetSlots)
		api.GET("/bookings", arenaHandler.ListBookings)
		api.GET("/days-off", dayOffHandler.List)
		api.GET("/pricing", pricingHandler.Snapshot)

		// Booking flows
		api.POST("/bookings", loggedIn, arenaHandler.CreateBooking)
		api.POST("/bookings/:id/upload-slip", loggedIn, arenaHandler.UploadSlip)
		api.GET("/me/bookings", loggedIn, arenaHandler.MyBookings)

		// Loyalty rewards (FR-4.2/4.3)
		api.GET("/rewards", rewardHandler.Catalog)
		api.POST("/me/rewards/:id/redeem", loggedIn, rewardHandler.Redeem)
		api.GET("/me/vouchers", loggedIn, rewardHandler.MyVouchers)
		api.GET("/staff/vouchers/:code", staffOnly, rewardHandler.Lookup)
		api.POST("/staff/vouchers/:code/dispense", staffOnly, rewardHandler.Dispense)
		api.GET("/slips/:name", slipSigner.Serve) // signed link; see handler.SlipSigner

		// Counter walk-ins, paid on the spot
		api.POST("/staff/bookings", staffOnly, arenaHandler.CreateWalkInBooking)

		// Staff slip review (FR-3.3)
		api.GET("/staff/payments", staffOnly, arenaHandler.ListPaymentsForReview)
		api.POST("/staff/payments/:id/verify", staffOnly, arenaHandler.VerifyPayment)
		api.POST("/staff/payments/:id/reject", staffOnly, arenaHandler.RejectPayment)
		api.POST("/staff/bookings/:id/no-show", staffOnly, arenaHandler.MarkNoShow)
		api.GET("/staff/summary", staffOnly, shopHandler.DaySummary)

		// Cancellations, refunds and cash recorded by a manager (FR-6.3)
		api.POST("/admin/bookings/:id/cancel", managerOnly, arenaHandler.CancelBooking)
		api.POST("/admin/payments/:id/refund", managerOnly, arenaHandler.RefundPayment)
		api.POST("/admin/payments/:id/mark-cash", managerOnly, arenaHandler.MarkPaidInCash)
		api.POST("/admin/bookings/:id/mark-cash", managerOnly, arenaHandler.MarkBookingPaidInCash)

		// Counter shop (FR-5.2/5.3): catalog, sales, rentals and returns
		api.GET("/staff/products", staffOnly, shopHandler.ListProducts(false))
		api.POST("/pos/order", staffOnly, shopHandler.Checkout)
		api.GET("/staff/orders", staffOnly, shopHandler.ListOrders)
		api.GET("/staff/rentals", staffOnly, shopHandler.ActiveRentals)
		api.POST("/staff/rentals/items/:id/return", staffOnly, shopHandler.ReturnRental)
		api.GET("/admin/products", managerOnly, shopHandler.ListProducts(true))
		api.POST("/admin/products", managerOnly, shopHandler.CreateProducts)
		api.PUT("/admin/products/:id", managerOnly, shopHandler.UpdateProduct)
		api.POST("/admin/products/:id/stock", managerOnly, shopHandler.AdjustStock)
		api.POST("/admin/orders/:id/void", managerOnly, shopHandler.VoidOrder)

		// Cash drawer shifts (FR-6.1/6.2)
		api.GET("/staff/shift", staffOnly, shopHandler.CurrentShift)
		api.POST("/staff/shift/open", staffOnly, shopHandler.OpenShift)
		api.POST("/staff/shift/close", staffOnly, shopHandler.CloseShift)
		api.GET("/admin/shifts", managerOnly, shopHandler.ListShifts)

		// Reports from the database (FR-7.2-7.4)
		api.GET("/admin/dashboard", managerOnly, shopHandler.Dashboard)
		api.GET("/admin/report", managerOnly, shopHandler.MonthReport)
		api.GET("/admin/audit-logs", adminOnly, shopHandler.AuditLogs)

		// Admin & CRM managers wallets configuration
		api.POST("/admin/users/:id/adjust-points", managerOnly, arenaHandler.ModifyPoints)
		api.GET("/admin/users", managerOnly, arenaHandler.ListUsers)
		api.PUT("/admin/users/:id/member-type", managerOnly, arenaHandler.SetMemberType)
		api.PUT("/admin/users/:id/role", adminOnly, arenaHandler.SetUserRole)
		api.PUT("/admin/users/:id/active", adminOnly, arenaHandler.SetUserActive)

		// Court closures (FR-1.3) - managers and admins (REQUIREMENTS.md
		// section 3); enforced by booking creation
		api.POST("/admin/days-off", managerOnly, dayOffHandler.Create)
		api.DELETE("/admin/days-off/:id", managerOnly, dayOffHandler.Delete)

		// Courts: admins add them and open/close them for booking; never
		// deleted (bookings and reports point at them)
		api.GET("/admin/courts", managerOnly, courtHandler.List)
		api.POST("/admin/courts", adminOnly, courtHandler.Create)
		api.PUT("/admin/courts/:id", adminOnly, courtHandler.Update)

		// Pricing engine (FR-2) - admin only; used by every booking price
		api.POST("/admin/pricing-rules", adminOnly, pricingHandler.SaveRule)
		api.PUT("/admin/pricing-rules/:id", adminOnly, pricingHandler.SaveRule)
		api.DELETE("/admin/pricing-rules/:id", adminOnly, pricingHandler.DeleteRule)
		api.PUT("/admin/member-discounts/:member_type", adminOnly, pricingHandler.UpdateMemberDiscount)
		api.PUT("/admin/pricing-config", adminOnly, pricingHandler.UpdateConfig)
		api.PUT("/admin/business", adminOnly, pricingHandler.UpdateBusiness)
	}

	// Cancel online bookings left unpaid past the payment hold, so abandoned
	// checkouts don't block courts forever.
	go expireUnpaidBookingsLoop(bookingService, authService, rewardService)

	// 5. Fire Up listener
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Timeouts, so slow or stalled clients can't hold connections open
	// (router.Run sets none). WriteTimeout leaves room for a 5 MB slip.
	srv := &http.Server{
		Addr:              fmt.Sprintf("0.0.0.0:%s", port),
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("Sports Arena Go Backend server launching on Port %s...\n", port)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("Failed to bind listener: %v\n", err)
	}
}

// seedDefaults inserts the config rows PriceEngineService/MembershipService
// need to compute a price at all: the global half-court rate (FR-2.4) and
// the per-tier membership discounts (FR-2.3). Percentages match
// REQUIREMENTS.md and mockData.ts's DEFAULT_MEMBER_DISCOUNTS. Uses
// FirstOrCreate so it's a no-op (and safe) on every restart once seeded -
// AutoMigrate only creates schema, never data, so without this a fresh
// database would make every half-court or discounted booking fail with
// "record not found" the first time someone tried to price one.
func seedDefaults(db *gorm.DB) {
	// Every write is checked: a failure used to be ignored while the log
	// still said "verified", hiding e.g. a missing pricing config until the
	// first booking failed.
	failures := 0
	check := func(what string, err error) {
		if err != nil {
			failures++
			log.Printf("ERROR seeding %s: %v\n", what, err)
		}
	}
	check("pricing_config", db.Where(model.PricingConfig{ID: "global"}).FirstOrCreate(&model.PricingConfig{
		ID:                   "global",
		HalfCourtRatePercent: 50,
		MaxAdvanceDays:       30,
		OpenHour:             service.DefaultOpenHour,
		CloseHour:            service.DefaultCloseHour,
	}).Error)

	discounts := []model.MemberDiscount{
		{MemberType: model.MemberNormal, Name: "ลูกค้าทั่วไป", DiscountPercent: 0, IsActive: true},
		{MemberType: model.MemberStudent, Name: "สิทธิ์นักเรียนนักศึกษาเยาวชน", DiscountPercent: 15, IsActive: true},
		{MemberType: model.MemberClub, Name: "สมาชิกร้านทั่วไป", DiscountPercent: 10, IsActive: true},
		{MemberType: model.MemberCorporate, Name: "องค์กรพันธมิตรร่วม MOU", DiscountPercent: 20, IsActive: true},
	}
	for _, d := range discounts {
		check("member discount "+string(d.MemberType), db.Where(model.MemberDiscount{MemberType: d.MemberType}).FirstOrCreate(&d).Error)
	}

	// Courts and pricing rules matching mockData.ts's DEFAULT_COURTS /
	// DEFAULT_PRICING_RULES, so a booking priced through this backend gives
	// the same number the frontend would show for the same slot - useful for
	// actually exercising the API locally instead of just seeing it boot.
	// Basketball: three courts A, B and C, each bookable as the full court
	// or as either half. Each court is one mutex group (full blocks both
	// halves, a half blocks the full court, the two halves don't block each
	// other). A keeps the original ids - b_half_b / b_half_c were its two
	// halves all along (once misnamed "B"/"C") - so existing bookings stay
	// valid; B and C are new groups.
	bballA, bballB, bballC := "bball-court-1", "bball-court-2", "bball-court-3"
	courts := []model.Court{
		{ID: "b_full_a", Name: "สนามบาสเกตบอล A (เต็มสนาม)", Type: model.CourtBasketball, MutexGroupID: &bballA, ShareOfGroup: 1, IsActive: true},
		{ID: "b_half_b", Name: "สนามบาสเกตบอล A (ครึ่งซ้าย)", Type: model.CourtBasketball, MutexGroupID: &bballA, ShareOfGroup: 0.5, OffPeakOnly: true, IsActive: true},
		{ID: "b_half_c", Name: "สนามบาสเกตบอล A (ครึ่งขวา)", Type: model.CourtBasketball, MutexGroupID: &bballA, ShareOfGroup: 0.5, OffPeakOnly: true, IsActive: true},
		{ID: "bb-b-full", Name: "สนามบาสเกตบอล B (เต็มสนาม)", Type: model.CourtBasketball, MutexGroupID: &bballB, ShareOfGroup: 1, IsActive: true},
		{ID: "bb-b-left", Name: "สนามบาสเกตบอล B (ครึ่งซ้าย)", Type: model.CourtBasketball, MutexGroupID: &bballB, ShareOfGroup: 0.5, OffPeakOnly: true, IsActive: true},
		{ID: "bb-b-right", Name: "สนามบาสเกตบอล B (ครึ่งขวา)", Type: model.CourtBasketball, MutexGroupID: &bballB, ShareOfGroup: 0.5, OffPeakOnly: true, IsActive: true},
		{ID: "bb-c-full", Name: "สนามบาสเกตบอล C (เต็มสนาม)", Type: model.CourtBasketball, MutexGroupID: &bballC, ShareOfGroup: 1, IsActive: true},
		{ID: "bb-c-left", Name: "สนามบาสเกตบอล C (ครึ่งซ้าย)", Type: model.CourtBasketball, MutexGroupID: &bballC, ShareOfGroup: 0.5, OffPeakOnly: true, IsActive: true},
		{ID: "bb-c-right", Name: "สนามบาสเกตบอล C (ครึ่งขวา)", Type: model.CourtBasketball, MutexGroupID: &bballC, ShareOfGroup: 0.5, OffPeakOnly: true, IsActive: true},
		{ID: "meet-1", Name: "ห้องประชุมเอนกประสงค์ 1", Type: model.CourtMeetingRoom, ShareOfGroup: 1, IsActive: true},
	}
	for i := 1; i <= 12; i++ {
		courts = append(courts, model.Court{ID: fmt.Sprintf("bad-%d", i), Name: fmt.Sprintf("สนามแบดมินตัน %d", i), Type: model.CourtBadminton, ShareOfGroup: 1, IsActive: true})
	}
	for i := 1; i <= 3; i++ {
		courts = append(courts, model.Court{ID: fmt.Sprintf("pick-%d", i), Name: fmt.Sprintf("สนามพิคเคิลบอล %d", i), Type: model.CourtPickleball, ShareOfGroup: 1, IsActive: true})
	}
	for _, c := range courts {
		check("court "+c.ID, db.Where(model.Court{ID: c.ID}).FirstOrCreate(&c).Error)
	}
	// Databases seeded by an earlier version got older names for these
	// courts (English, then "B"/"C" for what are court A's halves). Rename
	// them only if they still have an exact earlier seeded name, so a name
	// someone changed on purpose is left alone.
	oldSeedNames := map[string][]string{
		"b_full_a": {"Basketball Court A (Full)"},
		"b_half_b": {"Basketball Court B (Half: Left)", "สนามบาสเกตบอล B (ครึ่งสนาม: ซ้าย)"},
		"b_half_c": {"Basketball Court C (Half: Right)", "สนามบาสเกตบอล C (ครึ่งสนาม: ขวา)"},
		"bad-1":    {"Badminton Court 1"},
		"bad-2":    {"Badminton Court 2"},
		"pick-1":   {"Pickleball Court 1"},
		"meet-1":   {"Meeting Room 1"},
	}
	for _, c := range courts {
		if old, ok := oldSeedNames[c.ID]; ok {
			check("court name "+c.ID, db.Model(&model.Court{}).Where("id = ? AND name IN ?", c.ID, old).Update("name", c.Name).Error)
		}
	}

	pricingRules := []model.PricingRule{
		{ID: "p-bad-wd-op", CourtType: model.CourtBadminton, DayType: "WEEKDAY", StartHour: 7, EndHour: 17, PricePerHour: 180, PriceType: "OFFPEAK", Label: "แบดมินตัน วันธรรมดาช่วง Off-Peak", IsActive: true},
		{ID: "p-bad-wd-p", CourtType: model.CourtBadminton, DayType: "WEEKDAY", StartHour: 17, EndHour: 22, PricePerHour: 280, PriceType: "PEAK", Label: "แบดมินตัน วันธรรมดาช่วง Peak", IsActive: true},
		{ID: "p-bad-wd-op2", CourtType: model.CourtBadminton, DayType: "WEEKDAY", StartHour: 22, EndHour: 23, PricePerHour: 200, PriceType: "OFFPEAK", Label: "แบดมินตัน วันธรรมดาช่วงดึก", IsActive: true},
		{ID: "p-bad-we-p", CourtType: model.CourtBadminton, DayType: "WEEKEND", StartHour: 9, EndHour: 22, PricePerHour: 300, PriceType: "PEAK", Label: "แบดมินตัน วันหยุดช่วง Peak", IsActive: true},
		{ID: "p-bad-we-op", CourtType: model.CourtBadminton, DayType: "WEEKEND", StartHour: 7, EndHour: 9, PricePerHour: 220, PriceType: "OFFPEAK", Label: "แบดมินตัน วันหยุดช่วงเช้า Off-Peak", IsActive: true},
		{ID: "p-bad-we-op2", CourtType: model.CourtBadminton, DayType: "WEEKEND", StartHour: 22, EndHour: 23, PricePerHour: 220, PriceType: "OFFPEAK", Label: "แบดมินตัน วันหยุดช่วงดึก Off-Peak", IsActive: true},
		{ID: "p-bas-wd-op", CourtType: model.CourtBasketball, DayType: "WEEKDAY", StartHour: 7, EndHour: 17, PricePerHour: 500, PriceType: "OFFPEAK", Label: "บาสเกตบอล วันธรรมดา Off-Peak", IsActive: true},
		{ID: "p-bas-wd-p", CourtType: model.CourtBasketball, DayType: "WEEKDAY", StartHour: 17, EndHour: 22, PricePerHour: 800, PriceType: "PEAK", Label: "บาสเกตบอล วันธรรมดา Peak", IsActive: true},
		{ID: "p-bas-wd-op2", CourtType: model.CourtBasketball, DayType: "WEEKDAY", StartHour: 22, EndHour: 23, PricePerHour: 600, PriceType: "OFFPEAK", Label: "บาสเกตบอล วันธรรมดาช่วงดึก", IsActive: true},
		{ID: "p-bas-we-p", CourtType: model.CourtBasketball, DayType: "WEEKEND", StartHour: 9, EndHour: 22, PricePerHour: 900, PriceType: "PEAK", Label: "บาสเกตบอล วันหยุด Peak", IsActive: true},
		{ID: "p-bas-we-op", CourtType: model.CourtBasketball, DayType: "WEEKEND", StartHour: 7, EndHour: 9, PricePerHour: 600, PriceType: "OFFPEAK", Label: "บาสเกตบอล วันหยุด Off-Peak", IsActive: true},
		{ID: "p-bas-we-op2", CourtType: model.CourtBasketball, DayType: "WEEKEND", StartHour: 22, EndHour: 23, PricePerHour: 600, PriceType: "OFFPEAK", Label: "บาสเกตบอล วันหยุดช่วงดึก", IsActive: true},
		{ID: "p-pic-wd-op", CourtType: model.CourtPickleball, DayType: "WEEKDAY", StartHour: 7, EndHour: 17, PricePerHour: 220, PriceType: "OFFPEAK", Label: "พิคเคิลบอล วันธรรมดา Off-Peak", IsActive: true},
		{ID: "p-pic-wd-p", CourtType: model.CourtPickleball, DayType: "WEEKDAY", StartHour: 17, EndHour: 22, PricePerHour: 350, PriceType: "PEAK", Label: "พิคเคิลบอล วันธรรมดา Peak", IsActive: true},
		{ID: "p-pic-wd-op2", CourtType: model.CourtPickleball, DayType: "WEEKDAY", StartHour: 22, EndHour: 23, PricePerHour: 250, PriceType: "OFFPEAK", Label: "พิคเคิลบอล วันธรรมดาช่วงดึก", IsActive: true},
		{ID: "p-pic-we-p", CourtType: model.CourtPickleball, DayType: "WEEKEND", StartHour: 9, EndHour: 22, PricePerHour: 380, PriceType: "PEAK", Label: "พิคเคิลบอล วันหยุด Peak", IsActive: true},
		{ID: "p-pic-we-op", CourtType: model.CourtPickleball, DayType: "WEEKEND", StartHour: 7, EndHour: 9, PricePerHour: 250, PriceType: "OFFPEAK", Label: "พิคเคิลบอล วันหยุด Off-Peak", IsActive: true},
		{ID: "p-pic-we-op2", CourtType: model.CourtPickleball, DayType: "WEEKEND", StartHour: 22, EndHour: 23, PricePerHour: 250, PriceType: "OFFPEAK", Label: "พิคเคิลบอล วันหยุดช่วงดึก", IsActive: true},
		{ID: "p-meet-all", CourtType: model.CourtMeetingRoom, DayType: "WEEKDAY", StartHour: 7, EndHour: 23, PricePerHour: 400, PriceType: "NORMAL", Label: "ห้องประชุม ราคาคงที่วันธรรมดา", IsActive: true},
		{ID: "p-meet-all-we", CourtType: model.CourtMeetingRoom, DayType: "WEEKEND", StartHour: 7, EndHour: 23, PricePerHour: 500, PriceType: "NORMAL", Label: "ห้องประชุม ราคาคงที่เสาร์-อาทิตย์", IsActive: true},
	}
	for _, r := range pricingRules {
		check("pricing rule "+r.ID, db.Where(model.PricingRule{ID: r.ID}).FirstOrCreate(&r).Error)
	}

	// Databases seeded by an earlier version got English pricing-rule labels
	// and member-tier names; switch them to the Thai ones the app uses, but
	// only where they are still exactly the old seed value.
	oldRuleLabels := map[string]string{
		"p-bad-wd-op":   "Badminton weekday off-peak",
		"p-bad-wd-p":    "Badminton weekday peak",
		"p-bad-wd-op2":  "Badminton weekday late",
		"p-bad-we-p":    "Badminton weekend peak",
		"p-bad-we-op":   "Badminton weekend morning",
		"p-bad-we-op2":  "Badminton weekend late",
		"p-bas-wd-op":   "Basketball weekday off-peak",
		"p-bas-wd-p":    "Basketball weekday peak",
		"p-bas-wd-op2":  "Basketball weekday late",
		"p-bas-we-p":    "Basketball weekend peak",
		"p-bas-we-op":   "Basketball weekend morning",
		"p-bas-we-op2":  "Basketball weekend late",
		"p-pic-wd-op":   "Pickleball weekday off-peak",
		"p-pic-wd-p":    "Pickleball weekday peak",
		"p-pic-wd-op2":  "Pickleball weekday late",
		"p-pic-we-p":    "Pickleball weekend peak",
		"p-pic-we-op":   "Pickleball weekend morning",
		"p-pic-we-op2":  "Pickleball weekend late",
		"p-meet-all":    "Meeting room weekday flat rate",
		"p-meet-all-we": "Meeting room weekend flat rate",
	}
	for _, r := range pricingRules {
		if old, ok := oldRuleLabels[r.ID]; ok {
			check("pricing rule label "+r.ID, db.Model(&model.PricingRule{}).Where("id = ? AND label = ?", r.ID, old).Update("label", r.Label).Error)
		}
	}
	oldTierNames := map[model.MemberType]string{
		"NORMAL":    "Standard",
		"STUDENT":   "Student",
		"MEMBER":    "Member",
		"CORPORATE": "Corporate",
	}
	for _, d := range discounts {
		if old, ok := oldTierNames[d.MemberType]; ok {
			check("member discount name "+string(d.MemberType), db.Model(&model.MemberDiscount{}).Where("member_type = ? AND name = ?", d.MemberType, old).Update("name", d.Name).Error)
		}
	}

	// FR-4.2 rewards catalog (same items as mockData.ts DEFAULT_REWARDS_CATALOG).
	rewards := []model.RewardCatalogItem{
		{ID: "rw-water", Name: "น้ำดื่มเย็น", Emoji: "🥤", PointsCost: 5, IsActive: true},
		{ID: "rw-energy", Name: "เครื่องดื่มเกลือแร่สปอนเซอร์", Emoji: "⚡", PointsCost: 8, IsActive: true},
		{ID: "rw-towel", Name: "เช่าผ้าเย็นสะอาด", Emoji: "🧼", PointsCost: 10, IsActive: true},
		{ID: "rw-hour", Name: "สนาม Off-Peak ฟรี 1 ชั่วโมง", Emoji: "🏸", PointsCost: 25, IsActive: true, Kind: model.RewardKindFreeOffPeakHour},
	}
	for _, r := range rewards {
		if r.Kind == "" {
			r.Kind = model.RewardKindItem
		}
		check("reward "+r.ID, db.Where(model.RewardCatalogItem{ID: r.ID}).FirstOrCreate(&r).Error)
	}
	// Counter catalog, same items as mockData.ts DEFAULT_PRODUCTS.
	// FirstOrCreate by id, so admin price/stock edits are kept.
	sub := func(v string) *string { return &v }
	products := []model.Product{
		{ID: "pd-1", Name: "น้ำดื่มเนสท์เล่ 600ml", Category: model.ProductFB, SubCategory: sub("drink"), Price: 15, Stock: 120},
		{ID: "pd-2", Name: "เกลือแร่สปอนเซอร์ 250ml", Category: model.ProductFB, SubCategory: sub("drink"), Price: 20, Stock: 85},
		{ID: "pd-3", Name: "น้ำอัดลมโค้กกระป๋อง 325ml", Category: model.ProductFB, SubCategory: sub("drink"), Price: 20, Stock: 90},
		{ID: "pd-4", Name: "เลย์ มันฝรั่งอบกรอบ 50g", Category: model.ProductFB, SubCategory: sub("snack"), Price: 30, Stock: 50},
		{ID: "pd-5", Name: "ลูกแบดมินตัน RSL Silver (หลอด 12 ลูก)", Category: model.ProductEquipment, SubCategory: sub("shuttle"), Price: 650, Stock: 15},
		{ID: "pd-6", Name: "ลูกแบด RSL (แบ่งขาย/คนละลูก)", Category: model.ProductEquipment, SubCategory: sub("shuttle"), Price: 60, Stock: 45},
		{ID: "pd-7", Name: "เช่าไม้แบดมินตัน Yonex (ต่อชั่วโมง)", Category: model.ProductEquipment, SubCategory: sub("racket"), Price: 50, IsRental: true, Stock: 20},
		{ID: "pd-8", Name: "เช่าไม้พิคเคิลบอล Franklin (ต่อชั่วโมง)", Category: model.ProductEquipment, SubCategory: sub("racket"), Price: 60, IsRental: true, Stock: 10},
		{ID: "pd-9", Name: "เช่ารองเท้ากีฬาคุณภาพ (ต่อครั้ง)", Category: model.ProductEquipment, SubCategory: sub("shoes"), Price: 80, IsRental: true, Stock: 20},
	}
	for _, p := range products {
		p.IsActive, p.CreatedAt = true, time.Now()
		check("product "+p.ID, db.Where(model.Product{ID: p.ID}).FirstOrCreate(&p).Error)
	}
	// Shoes are stocked per EU size 36-45 and gender (FR-5.3), one pair each.
	for size := 36; size <= 45; size++ {
		for _, g := range []string{"M", "F"} {
			gender := g
			v := model.ProductVariant{ID: fmt.Sprintf("pd-9-%d-%s", size, g), ProductID: "pd-9", Label: fmt.Sprint(size), Gender: &gender, Stock: 1}
			check("variant "+v.ID, db.Where(model.ProductVariant{ID: v.ID}).FirstOrCreate(&v).Error)
		}
	}

	// rw-hour rows created before reward kinds existed default to ITEM.
	check("reward kind rw-hour", db.Model(&model.RewardCatalogItem{}).Where("id = ?", "rw-hour").
		Update("kind", model.RewardKindFreeOffPeakHour).Error)
	// Without the pricing config no booking can be priced at all.
	var cfgCount int64
	if err := db.Model(&model.PricingConfig{}).Where("id = ?", "global").Count(&cfgCount).Error; err != nil || cfgCount == 0 {
		log.Fatalf("pricing_config row 'global' is missing and could not be created - bookings cannot be priced (%v)\n", err)
	}
	if failures > 0 {
		log.Printf("WARNING: seeding default data finished with %d error(s) - see the ERROR lines above.\n", failures)
	} else {
		log.Println("Default pricing_config/member_discounts/courts/pricing_rules rows verified.")
	}

	if os.Getenv("SEED_DEMO_USERS") == "true" {
		seedDemoUsers(db)
	}
}

// publishedJWTSecret is the example secret committed in .env.example and
// (formerly) hard-coded here. Anyone can read it, so a server using it would
// accept forged ADMIN tokens.
const publishedJWTSecret = "SUPER_SECRET_COMPLEX_KEY_93281"

// resolveJWTSecret returns JWT_SECRET, or - if it is unset or still the
// published example value - a random per-process secret, with a warning.
// That keeps local development working (logins just don't survive a
// restart) without ever signing tokens with a key an attacker knows.
func resolveJWTSecret() []byte {
	secret := os.Getenv("JWT_SECRET")
	if secret != "" && secret != publishedJWTSecret {
		if len(secret) < 32 {
			log.Println("WARNING: JWT_SECRET is shorter than 32 characters; use e.g. `openssl rand -hex 32`.")
		}
		return []byte(secret)
	}
	// In production a random per-process secret means logins and slip
	// links break on every restart and differ between instances.
	if gin.Mode() == gin.ReleaseMode {
		log.Fatalln("JWT_SECRET must be set (and not the published example value) when GIN_MODE=release - e.g. `openssl rand -hex 32`.")
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		log.Fatalf("could not generate a JWT secret: %v", err)
	}
	log.Println("WARNING: JWT_SECRET is not set (or is the published example value) - using a random secret for this run, " +
		"so everyone is logged out on restart. Set JWT_SECRET in golang-backend/.env, e.g. `openssl rand -hex 32`.")
	return b
}

func expireUnpaidBookingsLoop(bookings *service.BookingService, auth *service.AuthService, rewards *service.RewardService) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for ; ; <-ticker.C {
		runJob("expiring unpaid bookings", func(ctx context.Context) error {
			n, err := bookings.ExpireUnpaidBookings(ctx)
			if n > 0 {
				log.Printf("Expired %d unpaid booking group(s) past the %v payment hold.\n", n, service.PaymentHoldDuration)
			}
			return err
		})
		runJob("completing finished bookings", func(ctx context.Context) error {
			n, err := bookings.CompleteFinishedBookings(ctx)
			if n > 0 {
				log.Printf("Marked %d finished booking hour(s) COMPLETED.\n", n)
			}
			return err
		})
		runJob("expiring vouchers", func(ctx context.Context) error {
			_, err := rewards.ExpireVouchers(ctx)
			return err
		})
		runJob("pruning old failed logins", auth.PruneLoginFailures)
	}
}

// runJob runs one background job with a time limit (a lock wait stuck on a
// hung request is cancelled instead of stopping every later run) and
// recovers a panic, so one bad job can't take the server down.
func runJob(name string, job func(ctx context.Context) error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("ERROR: background job %q panicked: %v\n", name, r)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if err := job(ctx); err != nil {
		log.Printf("Warning: %s failed: %v\n", name, err)
	}
}

// migrationLockKey serialises one-off migrations across instances that
// start at the same time (pg_advisory_xact_lock key).
const migrationLockKey = 4203

// runOnce runs a one-off data migration and records it in app_migrations,
// in one transaction under an advisory lock: it runs exactly once even if
// several instances start together, and a failure leaves no record (so it
// is retried on the next start) and no half-applied change. Any error is
// fatal - starting on a half-migrated database is worse than not starting.
func runOnce(db *gorm.DB, name string, run func(tx *gorm.DB) error) {
	err := db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", migrationLockKey).Error; err != nil {
			return err
		}
		var n int64
		if err := tx.Model(&model.AppMigration{}).Where("name = ?", name).Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			return nil
		}
		if err := run(tx); err != nil {
			return err
		}
		log.Printf("Data migration %s applied.\n", name)
		return tx.Create(&model.AppMigration{Name: name, RanAt: time.Now()}).Error
	})
	if err != nil {
		log.Fatalf("Data migration %s failed: %v\n", name, err)
	}
}

// runDataMigrations: one-off data changes, each run once (recorded in
// app_migrations) - running them on every start could rewrite rows
// created since.
func runDataMigrations(db *gorm.DB) {
	// Payments expired by an earlier version were stored as REJECTED with an
	// "Expired: ..." reason; give them the EXPIRED status, so a late slip
	// can still be accepted for them. (Once only: a manager's reason text
	// could start with "Expired:" too.)
	runOnce(db, "2026-10-expired-payment-status", func(tx *gorm.DB) error {
		return tx.Exec("UPDATE payments SET status = ?, expired_at = COALESCE(expired_at, updated_at) "+
			"WHERE status = ? AND refund_reason LIKE 'Expired:%'", model.PaymentExpired, model.PaymentRejected).Error
	})
	// Refunds recorded before per-refund rows existed: one row each.
	runOnce(db, "2026-10-refund-rows", func(tx *gorm.DB) error {
		return tx.Exec("INSERT INTO refunds (id, payment_id, amount, reason, refunded_by, refunded_at) " +
			"SELECT 'rfd-' || id, id, refund_amount, COALESCE(refund_reason, ''), COALESCE(refunded_by, ''), COALESCE(refunded_at, updated_at) " +
			"FROM payments p WHERE refund_amount > 0 AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id)").Error
	})
	// Why each cancelled row was cancelled, from the reason text the code
	// wrote before cancel_kind existed. Late payments only bring back
	// EXPIRED rows.
	runOnce(db, "2026-10-booking-cancel-kind", func(tx *gorm.DB) error {
		return tx.Exec("UPDATE bookings SET cancel_kind = CASE "+
			"WHEN cancellation_reason LIKE 'Expired%' THEN ? "+
			"WHEN cancellation_reason LIKE 'Slip rejected:%' THEN ? "+
			"WHEN cancellation_reason LIKE 'Refunded:%' THEN ? ELSE ? END "+
			"WHERE status = ? AND cancel_kind IS NULL",
			model.CancelKindExpired, model.CancelKindSlipRejected, model.CancelKindRefunded, model.CancelKindStaff, model.BookingCancelled).Error
	})
	// Slips staff rejected may be used again; a slip whose booking was
	// cancelled some other way stays used (see Payment.SlipReleased).
	runOnce(db, "2026-10-slip-released", func(tx *gorm.DB) error {
		return tx.Exec("UPDATE payments p SET slip_released = true WHERE p.status = ? AND EXISTS "+
			"(SELECT 1 FROM audit_logs a WHERE a.target_id = p.id AND a.action = 'SLIP_REJECTED_BY_STAFF')", model.PaymentRejected).Error
	})
	// What each sold product was, for sales made before order_items kept it.
	runOnce(db, "2026-10-order-item-snapshot", func(tx *gorm.DB) error {
		return tx.Exec("UPDATE order_items i SET category = p.category, is_rental = p.is_rental " +
			"FROM products p WHERE p.id = i.product_id AND i.category IS NULL").Error
	})
}

// ensureUserUniqueIndexes makes phone and email unique, so Register can't
// create two accounts that log in with the same identity. Done outside
// AutoMigrate on purpose: a database that already holds duplicates (the
// constraint used to be missing) would make AutoMigrate - and so startup -
// fail outright, whereas this only warns until the duplicates are cleaned up.
func ensureUserUniqueIndexes(db *gorm.DB) {
	// Email is unique ignoring case (logins compare it that way).
	for name, expr := range map[string]string{"phone": "phone", "email": "email", "email_lower": "lower(email)"} {
		stmt := fmt.Sprintf("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_%s ON users (%s)", name, expr)
		if err := db.Exec(stmt).Error; err != nil {
			log.Printf("WARNING: users.%s has duplicate values, so it is not unique-indexed yet and duplicate sign-ups are still possible. "+
				"Find them with: SELECT %s, count(*) FROM users GROUP BY %s HAVING count(*) > 1; then restart. (%v)\n", expr, expr, expr, err)
		}
	}
}

// seedDemoUsers creates the same demo accounts as mockData.ts's DEFAULT_USERS
// (password "123456") so the role switcher has someone to log in as. Opt-in
// via SEED_DEMO_USERS=true - dev-runner.js sets it - because these are
// well-known credentials that must never exist in a real deployment.
func seedDemoUsers(db *gorm.DB) {
	hash, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.DefaultCost)
	if err != nil {
		log.Printf("Warning: could not hash demo password: %v\n", err)
		return
	}
	email := func(s string) *string { return &s }
	users := []model.User{
		{ID: "u-admin", Name: "สมชาย ผู้บริหาร", Email: email("admin@sportscomplex.com"), Phone: "0812345678", Role: model.RoleAdmin, MemberType: model.MemberNormal},
		{ID: "u-mgr-1", Name: "วิชัย ผู้จัดการ", Email: email("manager@sportscomplex.com"), Phone: "0823456789", Role: model.RoleManager, MemberType: model.MemberNormal},
		{ID: "u-staff-1", Name: "กิตติ สตาฟเวรเช้า", Email: email("staff1@sportscomplex.com"), Phone: "0834567890", Role: model.RoleStaff, MemberType: model.MemberNormal},
		{ID: "u-cust-mbr", Name: "ประเสริฐ รักกีฬา (สมาชิกร้าน)", Email: email("prasert@gmail.com"), Phone: "0845678901", Role: model.RoleCustomer, MemberType: model.MemberClub},
		{ID: "u-cust-std", Name: "น้องพีเดอร์ นักเรียน", Email: email("student@school.ac.th"), Phone: "0856789012", Role: model.RoleCustomer, MemberType: model.MemberStudent},
	}
	now := time.Now()
	var failed []string
	for _, u := range users {
		u.IsActive = true
		u.PasswordHash = string(hash)
		u.CreatedAt, u.UpdatedAt = now, now
		if err := db.Where(model.User{ID: u.ID}).FirstOrCreate(&u).Error; err != nil {
			failed = append(failed, u.Phone)
			log.Printf("ERROR creating demo account %s (%s): %v\n", u.Phone, u.Name, err)
		}
	}
	if len(failed) > 0 {
		log.Printf("WARNING: SEED_DEMO_USERS=true but %d demo account(s) could not be created: %s\n", len(failed), strings.Join(failed, ", "))
		return
	}
	log.Println("SEED_DEMO_USERS=true: demo accounts verified (password 123456).")
}

// trustedProxies reads TRUSTED_PROXIES; unset means trust no proxy headers.
func trustedProxies() []string {
	var out []string
	for _, p := range strings.Split(os.Getenv("TRUSTED_PROXIES"), ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// ensureIndexes creates the indexes GORM tags can't express (partial and
// expression indexes) plus the ones reports and lookups filter on. Like
// ensureUserUniqueIndexes it only warns if one can't be built (e.g. old
// duplicate data), so startup never fails on it.
func ensureIndexes(db *gorm.DB) {
	stmts := []struct{ what, sql string }{
		// One slip file (by SHA-256) can't be attached to two payments
		// unless staff rejected it (slip_released). Replaces the earlier
		// index, which freed a slip whenever its payment became REJECTED -
		// also by a cancellation, when the money may still be refunded.
		{"old slip index", "DROP INDEX IF EXISTS idx_payments_slip_hash_live"},
		{"payments.slip_hash", "CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_slip_hash_used ON payments (slip_hash) " +
			"WHERE slip_hash IS NOT NULL AND NOT slip_released"},
		// Codes staff look up and print; the generators retry on a clash.
		{"orders.order_code", "CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_code ON orders (order_code)"},
		{"vouchers.code", "CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers (code)"},
		// A checkout key is used once (see POSService.ProcessCheckout).
		{"orders.idempotency_key", "CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key ON orders (idempotency_key) " +
			"WHERE idempotency_key IS NOT NULL"},
		// What shifts, reports, the drawer summary and voids filter on.
		{"orders.created_at", "CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at)"},
		{"payments.verified_at", "CREATE INDEX IF NOT EXISTS idx_payments_verified_at ON payments (verified_at)"},
		{"payments.booking_id", "CREATE INDEX IF NOT EXISTS idx_payments_booking_id ON payments (booking_id)"},
		{"bookings.date,status", "CREATE INDEX IF NOT EXISTS idx_bookings_date_status ON bookings (date, status)"},
		{"audit_logs.created_at", "CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at)"},
		{"points ledger ref", "CREATE INDEX IF NOT EXISTS idx_points_ledger_ref ON points_ledger_entries (ref_type, ref_id)"},
	}
	for _, st := range stmts {
		if err := db.Exec(st.sql).Error; err != nil {
			log.Printf("WARNING: could not create index on %s (%v).\n", st.what, err)
		}
	}
}

// warnDuplicatePhones lists phone numbers held by more than one account -
// possible from before phones were stored in one canonical form. Login
// still works for each (it tries every match), but walk-in points go to
// the oldest, so these should be merged by hand.
func warnDuplicatePhones(db *gorm.DB) {
	phones, err := repository.NewUserRepository(db).DuplicatePhones(context.Background())
	if err != nil {
		log.Printf("WARNING: could not check for duplicate phone numbers: %v\n", err)
		return
	}
	if len(phones) > 0 {
		log.Printf("WARNING: %d phone number(s) belong to more than one account (%s); merge them so walk-in points go to the right account.\n",
			len(phones), strings.Join(phones, ", "))
	}
}
