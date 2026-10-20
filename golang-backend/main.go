package main

import (
	"bufio"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"arena-backend/internal/handler"
	"arena-backend/internal/model"
	"arena-backend/internal/repository"
	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// loadEnv parses custom environment files line by line and registers key-values with os.Setenv
func loadEnv(filename string) {
	file, err := os.Open(filename)
	if err != nil {
		log.Printf("[EnvLoader] No %s file discovered. Proceeding with system environment configurations.\n", filename)
		return
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

		os.Setenv(key, val)
	}
	if err := scanner.Err(); err != nil {
		log.Printf("[EnvLoader] Warning: error reading env file scanner: %v\n", err)
	}
}

func main() {
	// Load the .env configuration at early startup before accessing variables
	loadEnv(".env")

	// 1. Database configurations setup
	pgConnString := os.Getenv("DATABASE_URL")
	if pgConnString == "" {
		// Production PostgreSQL fallback connection parameters
		pgConnString = "postgres://arena_user:ArenaSecurePass99@localhost:5432/arena_db?sslmode=disable"
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
	)
	if err != nil {
		log.Fatalf("Database initial migration failed: %v\n", err)
	}
	log.Println("Database schemas verified and migrated successfully!")
	ensureUserUniqueIndexes(db)

	// 1c. Seed the config rows the pricing engine needs to not error on a
	// fresh database - AutoMigrate only creates schema, not data. FirstOrCreate
	// makes this idempotent, so it's safe to run on every startup.
	seedDefaults(db)

	// 2. Initialize Repositories & Services Slices
	bkRepo := repository.NewBookingRepository(db)
	usrRepo := repository.NewUserRepository(db)
	courtRepo := repository.NewCourtRepository(db)
	auditRepo := repository.NewAuditRepository(db)

	authService := service.NewAuthService(usrRepo, auditRepo)
	userService := service.NewUserService(usrRepo)
	auditLogService := service.NewAuditLogService(auditRepo)
	membershipService := service.NewMembershipService(db, usrRepo)
	priceEngineService := service.NewPriceEngineService(courtRepo, membershipService)
	paymentService := service.NewPaymentService(db)
	bookingService := service.NewBookingService(db, bkRepo, usrRepo, courtRepo, priceEngineService, paymentService)
	posService := service.NewPOSService(db, usrRepo)

	arenaHandler := handler.NewArenaHandler(
		authService,
		userService,
		membershipService,
		priceEngineService,
		paymentService,
		bookingService,
		auditLogService,
		posService,
	)

	// 3. Launch Gin Web Engine Router
	router := gin.Default()

	// Ensure local uploads directory exists to avoid filesystem write errors
	if err := os.MkdirAll("./uploads/slips", 0755); err != nil {
		log.Printf("Warning: failed to create uploads directory: %v\n", err)
	}

	// Serve the static uploads directory to allow clients to download/view physical receipt slips
	router.Static("/uploads", "./uploads")

	// Apply standard robust CORS handler rules to authorize our React Frontend Origins
	router.Use(func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*") // customizable to client origin in production
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, DELETE, PATCH")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	})

	// 4. API Endpoints Map layout. Authenticate only parses an optional
	// bearer token; RequireRole gates each route that needs a login.
	api := router.Group("/api/v1", handler.Authenticate(authService))
	loggedIn := handler.RequireRole()
	staffOnly := handler.RequireRole(handler.StaffRoles...)
	managerOnly := handler.RequireRole(handler.ManagerRoles...)
	{
		// Authentication Ports
		api.POST("/auth/register", arenaHandler.Register)
		api.POST("/auth/login", arenaHandler.Login)
		api.GET("/auth/me", loggedIn, arenaHandler.Me)

		// Public availability
		api.GET("/courts", arenaHandler.ListCourts)
		api.GET("/courts/slots", arenaHandler.GetSlots)
		api.GET("/bookings", arenaHandler.ListBookings)

		// Booking flows
		api.POST("/bookings", loggedIn, arenaHandler.CreateBooking)
		api.POST("/bookings/:id/upload-slip", loggedIn, arenaHandler.UploadSlip)
		api.GET("/me/bookings", loggedIn, arenaHandler.MyBookings)

		// Staff slip review (FR-3.3)
		api.GET("/staff/payments", staffOnly, arenaHandler.ListPaymentsForReview)
		api.POST("/staff/payments/:id/verify", staffOnly, arenaHandler.VerifyPayment)
		api.POST("/staff/payments/:id/reject", staffOnly, arenaHandler.RejectPayment)

		// POS systems
		api.POST("/pos/order", staffOnly, arenaHandler.ProcessPOSCheckout)

		// Admin & CRM managers wallets configuration
		api.POST("/admin/users/:id/adjust-points", managerOnly, arenaHandler.ModifyPoints)
	}

	// 5. Fire Up listener
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("Sports Arena Go Backend server launching on Port %s...\n", port)
	if err := router.Run(fmt.Sprintf("0.0.0.0:%s", port)); err != nil {
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
	db.Where(model.PricingConfig{ID: "global"}).FirstOrCreate(&model.PricingConfig{
		ID:                   "global",
		HalfCourtRatePercent: 50,
	})

	discounts := []model.MemberDiscount{
		{MemberType: model.MemberNormal, Name: "Standard", DiscountPercent: 0, IsActive: true},
		{MemberType: model.MemberStudent, Name: "Student", DiscountPercent: 15, IsActive: true},
		{MemberType: model.MemberClub, Name: "Member", DiscountPercent: 10, IsActive: true},
		{MemberType: model.MemberCorporate, Name: "Corporate", DiscountPercent: 20, IsActive: true},
	}
	for _, d := range discounts {
		db.Where(model.MemberDiscount{MemberType: d.MemberType}).FirstOrCreate(&d)
	}

	// Courts and pricing rules matching mockData.ts's DEFAULT_COURTS /
	// DEFAULT_PRICING_RULES, so a booking priced through this backend gives
	// the same number the frontend would show for the same slot - useful for
	// actually exercising the API locally instead of just seeing it boot.
	bballGroup := "bball-court-1"
	courts := []model.Court{
		{ID: "b_full_a", Name: "สนามบาสเกตบอล A (เต็มสนาม)", Type: model.CourtBasketball, MutexGroupID: &bballGroup, ShareOfGroup: 1, IsActive: true},
		{ID: "b_half_b", Name: "สนามบาสเกตบอล B (ครึ่งสนาม: ซ้าย)", Type: model.CourtBasketball, MutexGroupID: &bballGroup, ShareOfGroup: 0.5, OffPeakOnly: true, IsActive: true},
		{ID: "b_half_c", Name: "สนามบาสเกตบอล C (ครึ่งสนาม: ขวา)", Type: model.CourtBasketball, MutexGroupID: &bballGroup, ShareOfGroup: 0.5, OffPeakOnly: true, IsActive: true},
		{ID: "meet-1", Name: "ห้องประชุมเอนกประสงค์ 1", Type: model.CourtMeetingRoom, ShareOfGroup: 1, IsActive: true},
	}
	for i := 1; i <= 12; i++ {
		courts = append(courts, model.Court{ID: fmt.Sprintf("bad-%d", i), Name: fmt.Sprintf("สนามแบดมินตัน %d", i), Type: model.CourtBadminton, ShareOfGroup: 1, IsActive: true})
	}
	for i := 1; i <= 3; i++ {
		courts = append(courts, model.Court{ID: fmt.Sprintf("pick-%d", i), Name: fmt.Sprintf("สนามพิคเคิลบอล %d", i), Type: model.CourtPickleball, ShareOfGroup: 1, IsActive: true})
	}
	for _, c := range courts {
		db.Where(model.Court{ID: c.ID}).FirstOrCreate(&c)
	}

	pricingRules := []model.PricingRule{
		{ID: "p-bad-wd-op", CourtType: model.CourtBadminton, DayType: "WEEKDAY", StartHour: 7, EndHour: 17, PricePerHour: 180, PriceType: "OFFPEAK", Label: "Badminton weekday off-peak", IsActive: true},
		{ID: "p-bad-wd-p", CourtType: model.CourtBadminton, DayType: "WEEKDAY", StartHour: 17, EndHour: 22, PricePerHour: 280, PriceType: "PEAK", Label: "Badminton weekday peak", IsActive: true},
		{ID: "p-bad-wd-op2", CourtType: model.CourtBadminton, DayType: "WEEKDAY", StartHour: 22, EndHour: 23, PricePerHour: 200, PriceType: "OFFPEAK", Label: "Badminton weekday late", IsActive: true},
		{ID: "p-bad-we-p", CourtType: model.CourtBadminton, DayType: "WEEKEND", StartHour: 9, EndHour: 22, PricePerHour: 300, PriceType: "PEAK", Label: "Badminton weekend peak", IsActive: true},
		{ID: "p-bad-we-op", CourtType: model.CourtBadminton, DayType: "WEEKEND", StartHour: 7, EndHour: 9, PricePerHour: 220, PriceType: "OFFPEAK", Label: "Badminton weekend morning", IsActive: true},
		{ID: "p-bad-we-op2", CourtType: model.CourtBadminton, DayType: "WEEKEND", StartHour: 22, EndHour: 23, PricePerHour: 220, PriceType: "OFFPEAK", Label: "Badminton weekend late", IsActive: true},
		{ID: "p-bas-wd-op", CourtType: model.CourtBasketball, DayType: "WEEKDAY", StartHour: 7, EndHour: 17, PricePerHour: 500, PriceType: "OFFPEAK", Label: "Basketball weekday off-peak", IsActive: true},
		{ID: "p-bas-wd-p", CourtType: model.CourtBasketball, DayType: "WEEKDAY", StartHour: 17, EndHour: 22, PricePerHour: 800, PriceType: "PEAK", Label: "Basketball weekday peak", IsActive: true},
		{ID: "p-bas-wd-op2", CourtType: model.CourtBasketball, DayType: "WEEKDAY", StartHour: 22, EndHour: 23, PricePerHour: 600, PriceType: "OFFPEAK", Label: "Basketball weekday late", IsActive: true},
		{ID: "p-bas-we-p", CourtType: model.CourtBasketball, DayType: "WEEKEND", StartHour: 9, EndHour: 22, PricePerHour: 900, PriceType: "PEAK", Label: "Basketball weekend peak", IsActive: true},
		{ID: "p-bas-we-op", CourtType: model.CourtBasketball, DayType: "WEEKEND", StartHour: 7, EndHour: 9, PricePerHour: 600, PriceType: "OFFPEAK", Label: "Basketball weekend morning", IsActive: true},
		{ID: "p-bas-we-op2", CourtType: model.CourtBasketball, DayType: "WEEKEND", StartHour: 22, EndHour: 23, PricePerHour: 600, PriceType: "OFFPEAK", Label: "Basketball weekend late", IsActive: true},
		{ID: "p-pic-wd-op", CourtType: model.CourtPickleball, DayType: "WEEKDAY", StartHour: 7, EndHour: 17, PricePerHour: 220, PriceType: "OFFPEAK", Label: "Pickleball weekday off-peak", IsActive: true},
		{ID: "p-pic-wd-p", CourtType: model.CourtPickleball, DayType: "WEEKDAY", StartHour: 17, EndHour: 22, PricePerHour: 350, PriceType: "PEAK", Label: "Pickleball weekday peak", IsActive: true},
		{ID: "p-pic-wd-op2", CourtType: model.CourtPickleball, DayType: "WEEKDAY", StartHour: 22, EndHour: 23, PricePerHour: 250, PriceType: "OFFPEAK", Label: "Pickleball weekday late", IsActive: true},
		{ID: "p-pic-we-p", CourtType: model.CourtPickleball, DayType: "WEEKEND", StartHour: 9, EndHour: 22, PricePerHour: 380, PriceType: "PEAK", Label: "Pickleball weekend peak", IsActive: true},
		{ID: "p-pic-we-op", CourtType: model.CourtPickleball, DayType: "WEEKEND", StartHour: 7, EndHour: 9, PricePerHour: 250, PriceType: "OFFPEAK", Label: "Pickleball weekend morning", IsActive: true},
		{ID: "p-pic-we-op2", CourtType: model.CourtPickleball, DayType: "WEEKEND", StartHour: 22, EndHour: 23, PricePerHour: 250, PriceType: "OFFPEAK", Label: "Pickleball weekend late", IsActive: true},
		{ID: "p-meet-all", CourtType: model.CourtMeetingRoom, DayType: "WEEKDAY", StartHour: 7, EndHour: 23, PricePerHour: 400, PriceType: "NORMAL", Label: "Meeting room weekday flat rate", IsActive: true},
		{ID: "p-meet-all-we", CourtType: model.CourtMeetingRoom, DayType: "WEEKEND", StartHour: 7, EndHour: 23, PricePerHour: 500, PriceType: "NORMAL", Label: "Meeting room weekend flat rate", IsActive: true},
	}
	for _, r := range pricingRules {
		db.Where(model.PricingRule{ID: r.ID}).FirstOrCreate(&r)
	}

	log.Println("Default pricing_config/member_discounts/courts/pricing_rules rows verified.")

	if os.Getenv("SEED_DEMO_USERS") == "true" {
		seedDemoUsers(db)
	}
}

// ensureUserUniqueIndexes makes phone and email unique, so Register can't
// create two accounts that log in with the same identity. Done outside
// AutoMigrate on purpose: a database that already holds duplicates (the
// constraint used to be missing) would make AutoMigrate - and so startup -
// fail outright, whereas this only warns until the duplicates are cleaned up.
func ensureUserUniqueIndexes(db *gorm.DB) {
	for _, col := range []string{"phone", "email"} {
		stmt := fmt.Sprintf("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_%s ON users (%s)", col, col)
		if err := db.Exec(stmt).Error; err != nil {
			log.Printf("WARNING: users.%s has duplicate values, so it is not unique-indexed yet and duplicate sign-ups are still possible. "+
				"Find them with: SELECT %s, count(*) FROM users GROUP BY %s HAVING count(*) > 1; then restart. (%v)\n", col, col, col, err)
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
	for _, u := range users {
		u.IsActive = true
		u.PasswordHash = string(hash)
		u.CreatedAt, u.UpdatedAt = now, now
		db.Where(model.User{ID: u.ID}).FirstOrCreate(&u)
	}
	log.Println("SEED_DEMO_USERS=true: demo accounts verified (password 123456).")
}
