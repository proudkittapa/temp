package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	_ "time/tzdata" // Asia/Bangkok must resolve even on hosts without tzdata

	"arena-backend/internal/handler"
	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
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
	checkReleaseSettings()

	// Ctrl+C / `kill` / `docker stop` (SIGINT, SIGTERM) cancel ctx: while
	// waiting for the database the server just exits; once running it shuts
	// down gracefully (see the end of main).
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// The first signal starts a clean shutdown; after it, signals act as
	// usual again, so a second Ctrl+C / SIGTERM ends the process at once
	// (e.g. while startup work or the drain below is still running).
	go func() {
		<-ctx.Done()
		stop()
	}()

	// 1. Database configurations setup
	pgConnString := os.Getenv("DATABASE_URL")
	if pgConnString == "" {
		log.Fatalln("DATABASE_URL is not set: set it in the environment or in golang-backend/.env (see .env.example).")
	}

	// Nothing else starts until the database answers: it may still be
	// starting (e.g. both containers come up together), so wait for it.
	db, sqlDB := connectDB(ctx, withDBTimeouts(pgConnString))
	// A bounded pool: a burst of requests waits for a connection instead of
	// exhausting Postgres max_connections (which would fail every request
	// and the background jobs too). DB_MAX_OPEN_CONNS overrides.
	maxConns := envInt("DB_MAX_OPEN_CONNS", 20)
	sqlDB.SetMaxOpenConns(maxConns)
	sqlDB.SetMaxIdleConns(maxConns)
	sqlDB.SetConnMaxLifetime(30 * time.Minute)
	sqlDB.SetConnMaxIdleTime(5 * time.Minute)
	log.Println("GORM Database connection established successfully!")

	// `arena-backend make-admin <phone>` shows the account with that phone;
	// `make-admin <phone> --yes` then gives it the admin role and exits -
	// how a new installation gets its first admin (register on the site
	// first). Phones aren't verified at sign-up, so the owner checks the
	// account is really theirs before confirming. In Docker:
	//   docker compose exec backend /app/arena-backend make-admin 0812345678
	if len(os.Args) >= 3 && os.Args[1] == "make-admin" {
		confirmed := len(os.Args) == 4 && os.Args[3] == "--yes"
		if len(os.Args) > 4 || (len(os.Args) == 4 && !confirmed) {
			log.Fatalln("usage: make-admin <phone> [--yes]")
		}
		os.Exit(makeAdmin(ctx, db, os.Args[2], confirmed))
	}

	// 1b. GORM AutoMigrate to guarantee database schema is 100% complete!
	log.Println("Running GORM AutoMigrate for all system schemas...")
	// Schema setup (migrations, index builds, data fixes) can take longer
	// than the request time limits on a big database, so it runs on its own
	// connection without them, closed once the setup is done.
	setupDB, err := openSetupDB(pgConnString)
	if err != nil {
		log.Fatalf("Critical error opening the setup connection: %v\n", err)
	}
	if err := setupSchema(setupDB); err != nil {
		log.Fatalf("Database initial migration failed: %v\n", err)
	}
	if sqlSetup, err := setupDB.DB(); err == nil {
		sqlSetup.Close()
	}
	// Speed-up indexes build in the background (perf_indexes.go): on a big
	// database they can take minutes, and the server needn't wait for them.
	var background sync.WaitGroup // index builds and jobs, waited for on shutdown
	background.Add(1)
	go func() {
		defer background.Done()
		buildPerfIndexes(ctx, pgConnString)
	}()

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
	roleService := service.NewRoleService(db)
	if err := roleService.SeedBuiltins(context.Background()); err != nil {
		log.Fatalf("Could not create the built-in roles: %v\n", err)
	}
	roleHandler := handler.NewRoleHandler(roleService)
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
	// gin.Default() minus its logger, which writes each URL with its query
	// string: signed slip links (valid for an hour or two) and member
	// searches by phone would end up in the logs.
	router := gin.New()
	router.Use(gin.LoggerWithFormatter(logWithoutQuery), gin.Recovery())
	// Uploads (slips, max ~5 MB) spill to a temp file beyond 1 MB instead of
	// being held in memory.
	router.MaxMultipartMemory = 1 << 20
	router.Use(requestDeadline)
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
	// lets a frontend on another site call the API. Unset = no CORS headers:
	// the app's own frontend is same-origin (Caddy in production, the Vite
	// proxy in development), and "*" would let any site script the public
	// endpoints (sign-up, login attempts) from its visitors' browsers.
	allowedOrigins := map[string]bool{}
	for _, o := range strings.Split(os.Getenv("CORS_ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			allowedOrigins[o] = true
		}
	}
	if len(allowedOrigins) > 0 {
		router.Use(func(c *gin.Context) {
			c.Writer.Header().Add("Vary", "Origin")
			if origin := c.GetHeader("Origin"); allowedOrigins[origin] {
				c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
			}
			c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, Authorization, accept, origin, Cache-Control, X-Requested-With, Idempotency-Key")
			c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, DELETE, PATCH")

			if c.Request.Method == "OPTIONS" {
				c.AbortWithStatus(http.StatusNoContent)
				return
			}
			c.Next()
		})
	}

	// 4. API Endpoints Map layout. Authenticate only parses an optional
	// bearer token; RequireRole gates each route that needs a login.
	// Idempotency: a retried write (Idempotency-Key header) is answered from
	// the first attempt instead of running twice.
	api := router.Group("/api/v1", handler.LimitBody(), handler.Authenticate(authService, roleService), handler.Idempotency(db))
	// Each route checks a permission (model/permissions.go); roles are
	// permission sets the admin edits. can(a, b) = any one of them.
	loggedIn := handler.RequireLogin()
	can := func(p ...model.Permission) gin.HandlerFunc { return handler.RequirePermission(p...) }
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
		api.POST("/bookings", can(model.PermBookOnline), arenaHandler.CreateBooking)
		api.POST("/bookings/:id/upload-slip", can(model.PermBookOnline, model.PermCounterBookings, model.PermVerifySlips), arenaHandler.UploadSlip)
		api.GET("/me/bookings", can(model.PermBookOnline), arenaHandler.MyBookings)

		// Loyalty rewards (FR-4.2/4.3)
		api.GET("/rewards", rewardHandler.Catalog)
		api.POST("/me/rewards/:id/redeem", can(model.PermBookOnline), rewardHandler.Redeem)
		api.GET("/me/vouchers", can(model.PermBookOnline), rewardHandler.MyVouchers)
		api.GET("/staff/vouchers/:code", can(model.PermSellRent, model.PermCounterBookings), rewardHandler.Lookup)
		api.POST("/staff/vouchers/:code/dispense", can(model.PermSellRent), rewardHandler.Dispense)
		api.GET("/slips/:name", slipSigner.Serve) // signed link; see handler.SlipSigner

		// Counter walk-ins, paid on the spot
		api.POST("/staff/bookings", can(model.PermCounterBookings), arenaHandler.CreateWalkInBooking)

		// Staff slip review (FR-3.3)
		api.GET("/staff/payments", can(model.PermVerifySlips), arenaHandler.ListPaymentsForReview)
		api.POST("/staff/payments/:id/verify", can(model.PermVerifySlips), arenaHandler.VerifyPayment)
		api.POST("/staff/payments/:id/reject", can(model.PermVerifySlips), arenaHandler.RejectPayment)
		api.POST("/staff/bookings/:id/no-show", can(model.PermCounterBookings), arenaHandler.MarkNoShow)
		api.POST("/staff/bookings/:id/undo-no-show", can(model.PermCounterBookings), arenaHandler.UndoNoShow)
		api.GET("/staff/summary", can(model.PermDaySummary), shopHandler.DaySummary)

		// Cancellations, refunds and cash recorded by a manager (FR-6.3)
		api.POST("/admin/bookings/:id/cancel", can(model.PermCancelRefund), arenaHandler.CancelBooking)
		api.POST("/admin/payments/:id/refund", can(model.PermCancelRefund), arenaHandler.RefundPayment)
		api.POST("/admin/payments/:id/no-refund", can(model.PermCancelRefund), arenaHandler.DismissRefundCheck)
		api.POST("/admin/payments/:id/mark-cash", can(model.PermCancelRefund), arenaHandler.MarkPaidInCash)
		api.POST("/admin/bookings/:id/mark-cash", can(model.PermCancelRefund), arenaHandler.MarkBookingPaidInCash)

		// Counter shop (FR-5.2/5.3): catalog, sales, rentals and returns
		api.GET("/staff/products", can(model.PermSellRent), shopHandler.ListProducts(false))
		api.POST("/pos/order", can(model.PermSellRent), shopHandler.Checkout)
		api.GET("/staff/members", can(model.PermSellRent, model.PermCounterBookings), arenaHandler.SearchMembers)
		api.GET("/staff/orders", can(model.PermSellRent, model.PermCancelRefund), shopHandler.ListOrders)
		api.GET("/staff/rentals", can(model.PermSellRent), shopHandler.ActiveRentals)
		api.POST("/staff/rentals/items/:id/return", can(model.PermSellRent), shopHandler.ReturnRental)
		api.GET("/admin/products", can(model.PermManageProducts), shopHandler.ListProducts(true))
		api.POST("/admin/products", can(model.PermManageProducts), shopHandler.CreateProducts)
		api.PUT("/admin/products/:id", can(model.PermManageProducts), shopHandler.UpdateProduct)
		api.POST("/admin/products/:id/stock", can(model.PermManageProducts), shopHandler.AdjustStock)
		api.POST("/admin/orders/:id/void", can(model.PermCancelRefund), shopHandler.VoidOrder)

		// Cash drawer shifts (FR-6.1/6.2)
		api.GET("/staff/shift", can(model.PermShifts), shopHandler.CurrentShift)
		api.POST("/staff/shift/open", can(model.PermShifts), shopHandler.OpenShift)
		api.POST("/staff/shift/close", can(model.PermShifts), shopHandler.CloseShift)
		api.GET("/admin/shifts", can(model.PermViewReports), shopHandler.ListShifts)

		// Reports from the database (FR-7.2-7.4)
		api.GET("/admin/dashboard", can(model.PermViewReports), shopHandler.Dashboard)
		api.GET("/admin/report", can(model.PermViewReports), shopHandler.MonthReport)
		api.GET("/admin/audit-logs", can(model.PermViewAuditLog), shopHandler.AuditLogs)

		// Admin & CRM managers wallets configuration
		api.POST("/admin/users/:id/adjust-points", can(model.PermAdjustPoints), arenaHandler.ModifyPoints)
		api.GET("/admin/users", can(model.PermManageMembers, model.PermAdjustPoints, model.PermManageStaff), arenaHandler.ListUsers)
		api.PUT("/admin/users/:id/member-type", can(model.PermManageMembers), arenaHandler.SetMemberType)
		api.PUT("/admin/users/:id/role", can(model.PermManageStaff), arenaHandler.SetUserRole)
		api.PUT("/admin/users/:id/active", can(model.PermManageStaff), arenaHandler.SetUserActive)

		// Roles = permission sets (model/permissions.go). Anyone who assigns
		// roles can list them; only manage_roles edits them.
		api.GET("/admin/roles", can(model.PermManageRoles, model.PermManageStaff), roleHandler.List)
		api.POST("/admin/roles", can(model.PermManageRoles), roleHandler.Create)
		api.PUT("/admin/roles/:id", can(model.PermManageRoles), roleHandler.Update)
		api.DELETE("/admin/roles/:id", can(model.PermManageRoles), roleHandler.Delete)

		// Court closures (FR-1.3) - managers and admins (REQUIREMENTS.md
		// section 3); enforced by booking creation
		api.POST("/admin/days-off", can(model.PermManageClosures), dayOffHandler.Create)
		api.DELETE("/admin/days-off/:id", can(model.PermManageClosures), dayOffHandler.Delete)

		// Courts: admins add them and open/close them for booking; never
		// deleted (bookings and reports point at them)
		api.GET("/admin/courts", can(model.PermManageClosures, model.PermManageCourts), courtHandler.List)
		api.POST("/admin/courts", can(model.PermManageCourts), courtHandler.Create)
		api.PUT("/admin/courts/:id", can(model.PermManageCourts), courtHandler.Update)

		// Pricing engine (FR-2) - admin only; used by every booking price
		api.POST("/admin/pricing-rules", can(model.PermEditPricing), pricingHandler.SaveRule)
		api.PUT("/admin/pricing-rules/:id", can(model.PermEditPricing), pricingHandler.SaveRule)
		api.DELETE("/admin/pricing-rules/:id", can(model.PermEditPricing), pricingHandler.DeleteRule)
		api.PUT("/admin/member-discounts/:member_type", can(model.PermEditPricing), pricingHandler.UpdateMemberDiscount)
		api.PUT("/admin/pricing-config", can(model.PermEditPricing), pricingHandler.UpdateConfig)
		api.PUT("/admin/business", can(model.PermEditPricing), pricingHandler.UpdateBusiness)
	}

	// Health checks for Docker / the reverse proxy (outside /api/v1: no auth,
	// no body limits): /healthz = the process is up; /readyz = it serves
	// requests and the database answers (503 until startup is done, or while
	// the database is unreachable).
	var ready atomic.Bool
	router.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
	router.GET("/readyz", func(c *gin.Context) {
		pingCtx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()
		if !ready.Load() {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not ready"})
			return
		}
		if err := sqlDB.PingContext(pingCtx); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "database unreachable"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
	})

	// Cancel online bookings left unpaid past the payment hold, so abandoned
	// checkouts don't block courts forever (and the other periodic jobs).
	// Stops with ctx: a job running then is cancelled (each is one
	// transaction, rolled back and simply done again on the next run).
	background.Add(1)
	go func() {
		defer background.Done()
		expireUnpaidBookingsLoop(ctx, db, bookingService, authService, rewardService)
	}()

	// 5. Fire Up listener
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Timeouts, so slow or stalled clients can't hold connections open
	// (router.Run sets none). Slip uploads and reports get longer ones of
	// their own (requestDeadline).
	srv := &http.Server{
		Addr:              fmt.Sprintf("0.0.0.0:%s", port),
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.ListenAndServe() }()
	ready.Store(true)
	log.Printf("Sports Arena Go Backend server launching on Port %s...\n", port)

	// Run until a stop signal (or the listener fails, e.g. the port is
	// taken), then shut down in order: stop taking requests and let those in
	// flight finish (up to SHUTDOWN_TIMEOUT_SECONDS, default 30), stop the
	// background work, and only then close the database connections.
	exitCode := 0
	select {
	case err := <-serveErr:
		ready.Store(false)
		if !errors.Is(err, http.ErrServerClosed) {
			log.Printf("ERROR: HTTP server stopped: %v\n", err)
			exitCode = 1 // a failure, so restart policies (on-failure) apply
		}
		stop()
	case <-ctx.Done():
		ready.Store(false)
		log.Println("Shutdown requested - finishing requests in progress...")
	}
	grace := time.Duration(envInt("SHUTDOWN_TIMEOUT_SECONDS", 30)) * time.Second
	shutdownCtx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		srv.Close() // close the connections of requests still running
		log.Printf("WARNING: requests still running after %s were cut off: %v\n", grace, err)
	}
	log.Println("HTTP server stopped. Waiting for background jobs...")
	jobsDone := make(chan struct{})
	go func() { background.Wait(); close(jobsDone) }()
	// Its own limit: the request drain above may have used all of grace.
	// Jobs were cancelled with ctx, so they end within moments.
	select {
	case <-jobsDone:
	case <-time.After(10 * time.Second):
		log.Println("WARNING: background jobs did not stop in time.")
	}
	if err := sqlDB.Close(); err != nil {
		log.Printf("WARNING: closing the database connections: %v\n", err)
	}
	if exitCode != 0 {
		log.Println("Stopped after an error.")
		os.Exit(exitCode)
	}
	log.Println("Stopped cleanly.")
}

// connectDB opens the pool and waits until the database answers, retrying
// with backoff (1 s doubling to 10 s) for up to DB_CONNECT_TIMEOUT_SECONDS
// (default 60) - a database still starting is normal, not fatal. A stop
// signal while waiting ends the wait (and the process).
func connectDB(ctx context.Context, dsn string) (*gorm.DB, *sql.DB) {
	deadline := time.Now().Add(time.Duration(envInt("DB_CONNECT_TIMEOUT_SECONDS", 60)) * time.Second)
	wait := time.Second
	for attempt := 1; ; attempt++ {
		// Quiet while retrying (this function logs each attempt itself);
		// the normal logger (slow-query warnings etc.) once connected.
		// No automatic ping: it has no time limit, so a database host that
		// accepts the connection and never answers hung startup (and
		// ignored Ctrl+C). The ping below is bounded and stops on a signal.
		db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent), DisableAutomaticPing: true})
		if err == nil {
			db.Logger = logger.Default
			var sqlDB *sql.DB
			if sqlDB, err = db.DB(); err == nil {
				pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				err = sqlDB.PingContext(pingCtx)
				cancel()
				if err == nil {
					log.Println("Database is ready.")
					return db, sqlDB
				}
				sqlDB.Close()
			}
		}
		if time.Now().Add(wait).After(deadline) {
			log.Fatalf("Database is unreachable after %d attempts: %v\n", attempt, err)
		}
		log.Printf("Waiting for the database (attempt %d): %v - retrying in %s\n", attempt, err, wait)
		select {
		case <-ctx.Done():
			log.Fatalln("Stopped while waiting for the database.")
		case <-time.After(wait):
		}
		if wait *= 2; wait > 10*time.Second {
			wait = 10 * time.Second
		}
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
	// Courts per type from BASKETBALL_COURT_COUNT etc. (default 3 basketball
	// courts A-C each full + two halves, 12 badminton, 3 pickleball, 1
	// meeting room) - see seed_courts.go.
	counts, warnings := courtCountsFromEnv(os.Getenv)
	for _, w := range warnings {
		log.Printf("WARNING: %s\n", w)
	}
	courts := seededCourts(counts)
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
	warnAboutExtraSeededCourts(db, counts)
	log.Printf("Courts: %d basketball (each full + 2 halves), %d badminton, %d pickleball, %d meeting room.\n",
		counts.Basketball, counts.Badminton, counts.Pickleball, counts.MeetingRoom)

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

// checkReleaseSettings stops a production server (GIN_MODE=release) that
// would run with development settings: demo accounts with a published
// password, or customers' QR payments going to the example PromptPay ID.
func checkReleaseSettings() {
	if gin.Mode() != gin.ReleaseMode {
		if os.Getenv("PROMPTPAY_ID") == "" {
			log.Printf("WARNING: PROMPTPAY_ID is not set - QR codes pay the example ID %s (fine for development only).\n", service.DefaultPromptPayID)
		}
		return
	}
	if os.Getenv("SEED_DEMO_USERS") == "true" {
		log.Fatalln("SEED_DEMO_USERS=true is for development only: it creates admin/staff accounts with the published password 123456. Remove it.")
	}
	if id := strings.TrimSpace(os.Getenv("PROMPTPAY_ID")); id == "" || id == service.DefaultPromptPayID {
		log.Fatalln("PROMPTPAY_ID must be set to the shop's own PromptPay number (phone or 13-digit tax ID) when GIN_MODE=release - " +
			"otherwise customers' QR payments go to the example ID.")
	}
}

// logWithoutQuery is Gin's request log line without the query string.
func logWithoutQuery(p gin.LogFormatterParams) string {
	path := p.Path
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	return fmt.Sprintf("[GIN] %v | %3d | %13v | %15s | %-7s %s\n%s",
		p.TimeStamp.Format("2006/01/02 - 15:04:05"), p.StatusCode, p.Latency, p.ClientIP, p.Method, path, p.ErrorMessage)
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
			if gin.Mode() == gin.ReleaseMode {
				log.Fatalln("JWT_SECRET is shorter than 32 characters - a short secret can be guessed and every token forged. Use e.g. `openssl rand -hex 32`.")
			}
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

func expireUnpaidBookingsLoop(ctx context.Context, db *gorm.DB, bookings *service.BookingService, auth *service.AuthService, rewards *service.RewardService) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	lease := newJobLease(db)
	defer lease.release()
	for {
		if !lease.acquire(ctx) {
			// Another server runs the jobs this minute.
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			continue
		}
		runJob(ctx, "expiring unpaid bookings", func(ctx context.Context) error {
			n, err := bookings.ExpireUnpaidBookings(ctx)
			if n > 0 {
				log.Printf("Expired %d unpaid booking group(s) past the %v payment hold.\n", n, service.PaymentHoldDuration)
			}
			return err
		})
		runJob(ctx, "completing finished bookings", func(ctx context.Context) error {
			n, err := bookings.CompleteFinishedBookings(ctx)
			if n > 0 {
				log.Printf("Marked %d finished booking hour(s) COMPLETED.\n", n)
			}
			return err
		})
		runJob(ctx, "expiring vouchers", func(ctx context.Context) error {
			_, err := rewards.ExpireVouchers(ctx)
			return err
		})
		runJob(ctx, "pruning old failed logins", auth.PruneLoginFailures)
		runJob(ctx, "pruning old idempotency keys", func(ctx context.Context) error { return handler.PruneIdempotencyKeys(ctx, db) })
		runJob(ctx, "pruning old audit log entries", func(ctx context.Context) error {
			n, err := service.PruneAuditLogs(ctx, db)
			if n > 0 {
				log.Printf("Deleted %d audit log entries older than %d days.\n", n, service.AuditRetentionDays())
			}
			return err
		})
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// runJob runs one background job with a time limit (a lock wait stuck on a
// hung request is cancelled instead of stopping every later run) and
// recovers a panic, so one bad job can't take the server down. It is
// skipped, or cancelled, once parent is (shutdown), so no job is still
// using the database when the pool is closed.
func runJob(parent context.Context, name string, job func(ctx context.Context) error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("ERROR: background job %q panicked: %v\n", name, r)
		}
	}()
	if parent.Err() != nil {
		return
	}
	ctx, cancel := context.WithTimeout(parent, 45*time.Second)
	defer cancel()
	if err := job(ctx); err != nil && parent.Err() == nil {
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
		// Backstop against double booking: one live booking per court, date
		// and start hour (bookings are whole hours). Full vs half courts are
		// different court rows - the overlap check covers those.
		// (A no-show frees its hour for resale, so it doesn't hold the slot;
		// replaces idx_bookings_live_slot, which counted no-shows.)
		// The new index first, and the old one dropped only once the new one
		// exists: if the create fails (e.g. old data violates it), the old
		// backstop stays instead of none.
		{"bookings held slot", "CREATE UNIQUE INDEX IF NOT EXISTS " + repository.LiveSlotIndex +
			" ON bookings (court_id, date, start_time) WHERE status NOT IN ('CANCELLED', 'NO_SHOW')"},
		{"old live-slot index", "DO $$ BEGIN IF to_regclass('" + repository.LiveSlotIndex + "') IS NOT NULL THEN " +
			"DROP INDEX IF EXISTS " + repository.OldLiveSlotIndex + "; END IF; END $$"},
		{"audit_logs.created_at", "CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at)"},
		{"points ledger ref", "CREATE INDEX IF NOT EXISTS idx_points_ledger_ref ON points_ledger_entries (ref_type, ref_id)"},
	}
	for _, st := range stmts {
		if err := db.Exec(st.sql).Error; err != nil {
			log.Printf("WARNING: could not create index on %s (%v).\n", st.what, err)
		}
	}
}

// normalizePhones stores every phone in canonical form so lookups use the
// index (repository.NormalizeStoredPhones). Accounts whose number another
// account already has keep their old format and are listed by id: login
// still works for each (it tries every match), but walk-in points go to the
// oldest, so they should be merged by hand.
func normalizePhones(db *gorm.DB) {
	fixed, leftover, err := repository.NormalizeStoredPhones(context.Background(), db)
	if err != nil {
		log.Printf("WARNING: could not normalize stored phone numbers (lookups stay on the slow path): %v\n", err)
		return
	}
	if fixed > 0 {
		log.Printf("Phone numbers: %d stored in canonical form.\n", fixed)
	}
	if len(leftover) > 0 {
		var ids []string
		for _, accounts := range leftover {
			ids = append(ids, accounts...)
		}
		sort.Strings(ids)
		log.Printf("WARNING: %d account(s) have the same phone number as an older account and kept their old format (%s); "+
			"merge them so walk-in points go to the right account. Until then phone lookups read every user row.\n",
			len(ids), strings.Join(ids, ", "))
	}
}

// schemaLockKey is held (session advisory lock) for the whole schema setup.
const schemaLockKey = 4205

// setupSchema brings the database to the current schema: tables
// (AutoMigrate), data migrations, indexes, constraints and the default rows
// the pricing engine needs. Every step is idempotent, so it runs on every
// start; the concurrency tests build their database with it too.
//
// One server at a time: two starting together (two replicas, a rolling
// update) used to both run AutoMigrate and one failed ("duplicate key ...
// pg_type", "column already exists") and exited. The lock is taken on one
// connection, which the whole setup uses; the others wait for it, then
// find nothing left to do. It is released when the setup ends (or the
// process exits).
func setupSchema(setupDB *gorm.DB) error {
	return setupDB.Connection(func(conn *gorm.DB) error {
		if err := conn.Exec("SELECT pg_advisory_lock(?)", schemaLockKey).Error; err != nil {
			return err
		}
		defer conn.Exec("SELECT pg_advisory_unlock(?)", schemaLockKey)
		// A fresh statement per call on the same connection (conn itself
		// carries one statement, which chained calls would pile up on).
		return setupSchemaLocked(conn.Session(&gorm.Session{NewDB: true}))
	})
}

func setupSchemaLocked(setupDB *gorm.DB) error {
	if err := convertMoneyColumns(setupDB); err != nil {
		return err
	}
	err := setupDB.AutoMigrate(
		&model.IdempotencyKey{},
		&model.User{},
		&model.Role{},
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
		&model.JobLease{},
	)
	if err != nil {
		return err
	}
	log.Println("Database schemas verified and migrated successfully!")
	ensureUserUniqueIndexes(setupDB)
	runDataMigrations(setupDB) // before ensureIndexes: the slip index needs slip_released filled in
	ensureIndexes(setupDB)
	ensureConstraints(setupDB)
	normalizePhones(setupDB)

	// Seed the config rows the pricing engine needs to not error on a fresh
	// database - AutoMigrate only creates schema, not data. FirstOrCreate
	// makes this idempotent, so it's safe to run on every startup.
	seedDefaults(setupDB)
	return nil
}

// openSetupDB opens a connection for schema work (migrations, index
// builds) without the request time limits withDBTimeouts adds.
func openSetupDB(dsn string) (*gorm.DB, error) {
	return gorm.Open(postgres.Open(dsn), &gorm.Config{})
}

// withDBTimeouts adds server-side limits to the connection string unless it
// already sets them: a statement running longer than DB_STATEMENT_TIMEOUT_MS
// (default 90 s, a backstop: each request's own deadline - 30 s, 90 s for
// reports - cancels its queries first) or waiting for a row lock longer than DB_LOCK_TIMEOUT_MS
// (default 5 s) is cancelled, and a transaction left idle is closed. One
// stuck request then fails on its own instead of piling every request up
// behind its locks. pgx sends unknown connection parameters to the server
// as runtime settings.
//
// jit=off: Postgres compiles a query to machine code (JIT) once its cost
// estimate passes a threshold - worth it for reports running for seconds,
// but here it added ~0.5 s of compiling to millisecond queries (the
// dashboard's hourly occupancy: 500 ms with JIT, 5 ms without, on two
// years of bookings), and more queries cross the threshold as data grows.
func withDBTimeouts(dsn string) string {
	params := [][2]string{
		{"statement_timeout", strconv.Itoa(envInt("DB_STATEMENT_TIMEOUT_MS", 90000))},
		{"lock_timeout", strconv.Itoa(envInt("DB_LOCK_TIMEOUT_MS", 5000))},
		{"idle_in_transaction_session_timeout", "30000"},
		{"jit", "off"},
	}
	if strings.Contains(dsn, "://") {
		u, err := url.Parse(dsn)
		if err != nil {
			return dsn
		}
		q := u.Query()
		for _, p := range params {
			if q.Get(p[0]) == "" {
				q.Set(p[0], p[1])
			}
		}
		u.RawQuery = q.Encode()
		return u.String()
	}
	for _, p := range params {
		if !strings.Contains(dsn, p[0]+"=") {
			dsn += " " + p[0] + "=" + p[1]
		}
	}
	return dsn
}

// requestDeadline gives every request a deadline (reports and exports get
// longer), so a request whose client has gone, or that waits on a lock,
// stops instead of holding a database connection.
func requestDeadline(c *gin.Context) {
	limit := 30 * time.Second
	switch p := c.Request.URL.Path; {
	case strings.HasSuffix(p, "/upload-slip"):
		limit = 2 * time.Minute // the photo may come over a slow phone connection
	case strings.Contains(p, "/admin/report") || strings.Contains(p, "/admin/dashboard") || strings.Contains(p, "/export"):
		limit = 90 * time.Second
	}
	// The server's ReadTimeout/WriteTimeout (60 s, from the start of the
	// request) would cut a longer one off first - a slow slip upload read
	// as "missing file", a finished report never sent. Give such a request
	// its own connection limits a little past its deadline.
	if limit > 30*time.Second {
		rc := http.NewResponseController(c.Writer)
		until := time.Now().Add(limit + 15*time.Second)
		_ = rc.SetReadDeadline(until) // not supported in tests' recorders - fine
		_ = rc.SetWriteDeadline(until)
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), limit)
	defer cancel()
	c.Request = c.Request.WithContext(ctx)
	c.Next()
}

// envInt reads a positive integer setting, or def.
func envInt(name string, def int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name))); err == nil && n > 0 {
		return n
	}
	return def
}

// ensureConstraints adds database-level backstops for rules the code already
// enforces under locks, so a future bug fails loudly instead of saving bad
// data: points and stock never below zero, refunds within the payment,
// deposits settled within what was taken, one open cash-drawer shift.
// Each is added NOT VALID (no table scan, no long lock) and then validated;
// if old data breaks one it stays unvalidated (still enforced for new
// writes) and a warning names it.
func ensureConstraints(db *gorm.DB) {
	checks := []struct{ table, name, expr string }{
		{"users", "chk_users_points_nonneg", "points >= 0"},
		{"products", "chk_products_stock_nonneg", "stock >= 0"},
		{"product_variants", "chk_variants_stock_nonneg", "stock >= 0"},
		{"payments", "chk_payments_refund_within", "refund_amount >= 0 AND refund_amount <= amount + 0.005"},
		{"orders", "chk_orders_deposit_within", "deposit_returned >= 0 AND deposit_kept >= 0 AND deposit_returned + deposit_kept <= deposit_amount + 0.005"},
	}
	for _, c := range checks {
		var n int64
		if err := db.Raw("SELECT count(*) FROM pg_constraint WHERE conname = ?", c.name).Scan(&n).Error; err != nil {
			log.Printf("WARNING: could not check constraint %s: %v\n", c.name, err)
			continue
		}
		if n == 0 {
			if err := db.Exec(fmt.Sprintf("ALTER TABLE %s ADD CONSTRAINT %s CHECK (%s) NOT VALID", c.table, c.name, c.expr)).Error; err != nil {
				log.Printf("WARNING: could not add constraint %s: %v\n", c.name, err)
				continue
			}
		}
		if err := db.Exec(fmt.Sprintf("ALTER TABLE %s VALIDATE CONSTRAINT %s", c.table, c.name)).Error; err != nil {
			log.Printf("WARNING: existing rows break %s (%s) - it holds for new writes only until they are fixed: %v\n", c.name, c.expr, err)
		}
	}
	if err := db.Exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_open ON shifts ((true)) WHERE closed_at IS NULL").Error; err != nil {
		log.Printf("WARNING: could not enforce one open shift (more than one is open?): %v\n", err)
	}
}

// makeAdmin sets the role of the account with this phone number to ADMIN
// (audit-logged as done by the command line) and returns the exit code.
func makeAdmin(ctx context.Context, db *gorm.DB, phone string, confirmed bool) int {
	u, err := repository.NewUserRepository(db).GetByPhone(ctx, phone)
	if err != nil {
		log.Printf("make-admin: %v\n", err)
		return 1
	}
	if u == nil {
		log.Printf("make-admin: no account with phone %s - register it on the site first.\n", phone)
		return 1
	}
	if u.Role == model.RoleAdmin {
		log.Printf("make-admin: %s (%s) is already an admin.\n", u.Name, u.Phone)
		return 0
	}
	if !confirmed {
		email := "-"
		if u.Email != nil {
			email = *u.Email
		}
		log.Printf("make-admin: found %q, phone %s, email %s, role %s, registered %s (Bangkok time).\n",
			u.Name, u.Phone, email, u.Role, u.CreatedAt.In(service.Bangkok).Format("2006-01-02 15:04"))
		log.Printf("make-admin: if this is your account, run again with --yes: make-admin %s --yes\n", phone)
		return 0
	}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.User{}).Where("id = ?", u.ID).Update("role", model.RoleAdmin).Error; err != nil {
			return err
		}
		return tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: "cli", UserName: "make-admin (server command line)",
			Action: "USER_ROLE_CHANGED", TargetType: "User", TargetID: u.ID,
			BeforeState: model.AuditJSON(map[string]any{"role": u.Role}),
			AfterState:  model.AuditJSON(map[string]any{"role": model.RoleAdmin}),
			CreatedAt:   time.Now(),
		}).Error
	})
	if err != nil {
		log.Printf("make-admin: %v\n", err)
		return 1
	}
	log.Printf("make-admin: %s (%s) is now an admin.\n", u.Name, u.Phone)
	return 0
}
