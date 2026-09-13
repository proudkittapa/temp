package main

import (
	"bufio"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"arena-backend/internal/handler"
	"arena-backend/internal/model"
	"arena-backend/internal/repository"
	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
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
		&model.DayOff{},
		&model.Booking{},
		&model.Payment{},
		&model.Product{},
		&model.Order{},
		&model.OrderItem{},
		&model.AuditLog{},
	)
	if err != nil {
		log.Fatalf("Database initial migration failed: %v\n", err)
	}
	log.Println("Database schemas verified and migrated successfully!")

	// 2. Initialize Repositories & Services Slices
	bkRepo := repository.NewBookingRepository(db)
	usrRepo := repository.NewUserRepository(db)
	courtRepo := repository.NewCourtRepository(db)
	auditRepo := repository.NewAuditRepository(db)

	authService := service.NewAuthService(usrRepo, auditRepo)
	userService := service.NewUserService(usrRepo)
	auditLogService := service.NewAuditLogService(auditRepo)
	membershipService := service.NewMembershipService(db, usrRepo)
	priceEngineService := service.NewPriceEngineService(courtRepo)
	paymentService := service.NewPaymentService(db)
	bookingService := service.NewBookingService(db, bkRepo, usrRepo, courtRepo, priceEngineService, paymentService)
	posService := service.NewPOSService(db)

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

	// 4. API Endpoints Map layout
	api := router.Group("/api/v1")
	{
		// Authentication Ports
		api.POST("/auth/register", arenaHandler.Register)
		api.POST("/auth/login", arenaHandler.Login)

		// Public slots checker
		api.GET("/courts/slots", arenaHandler.GetSlots)

		// Booking flows
		api.POST("/bookings", arenaHandler.CreateBooking)
		api.POST("/bookings/:id/upload-slip", arenaHandler.UploadSlip)

		// POS systems
		api.POST("/pos/order", arenaHandler.ProcessPOSCheckout)

		// Admin & CRM managers wallets configuration
		api.POST("/admin/users/:id/adjust-points", arenaHandler.ModifyPoints)
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
