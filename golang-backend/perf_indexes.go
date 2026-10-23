package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// auditSearchExpr is what the audit-log search box matches (see
// ReportService.AuditLogs); the trigram index below is built on exactly
// this expression so a "contains" search doesn't read every row.
const auditSearchExpr = "lower(coalesce(user_name, '') || ' ' || coalesce(action, '') || ' ' || " +
	"coalesce(target_id, '') || ' ' || coalesce(reason, ''))"

// perfIndex speeds up a list, search or background job. Unlike the indexes
// in ensureIndexes these change no rules, so the app works without them -
// just slower once the tables are big.
type perfIndex struct {
	name, table, def string
	trigram          bool // needs the pg_trgm extension
}

// perfIndexLockKey: one instance builds the indexes at a time
// (pg_try_advisory_lock; 4201-4203 and 4205 are taken, see main.go).
const perfIndexLockKey = 4204

var perfIndexes = []perfIndex{
	{"idx_order_items_order_id", "order_items", "(order_id)", false},                                 // every sale view, return, void, day summary
	{"idx_bookings_user_date", "bookings", "(user_id, date DESC, start_time)", false},                // my bookings, unpaid-booking cap
	{"idx_bookings_confirmed_end", "bookings", "(date, end_time) WHERE status = 'CONFIRMED'", false}, // every-minute "finished" job
	{"idx_payments_slip_queue", "payments", "(slip_uploaded_at, created_at) WHERE status = 'SLIP_UPLOADED'", false},
	{"idx_payments_pending_created", "payments", "(created_at) WHERE status = 'PENDING'", false}, // unpaid-booking expiry job
	{"idx_vouchers_active_expiry", "vouchers", "(expires_at) WHERE status = 'ACTIVE'", false},
	{"idx_vouchers_user_created", "vouchers", "(user_id, created_at DESC)", false},
	{"idx_vouchers_booking", "vouchers", "(booking_id) WHERE booking_id IS NOT NULL", false},
	{"idx_orders_open_rentals", "orders", "(created_at) WHERE status = 'PREPARING'", false},
	{"idx_audit_logs_target_created", "audit_logs", "(target_type, created_at DESC)", false},
	{"idx_audit_logs_user_created", "audit_logs", "(user_id, created_at)", false}, // per-customer slip upload limit
	{"idx_users_role_created", "users", "(role, created_at DESC)", false},
	{"idx_users_phone_prefix", "users", "(phone text_pattern_ops)", false}, // member search: phone starts with
	{"idx_day_offs_date", "day_offs", "(date)", false},
	{"idx_shifts_opened_at", "shifts", "(opened_at)", false}, // open shift, shift history
	{"idx_users_name_trgm", "users", "USING gin (name gin_trgm_ops)", true},
	{"idx_audit_logs_search_trgm", "audit_logs", "USING gin ((" + auditSearchExpr + ") gin_trgm_ops)", true},
}

// buildPerfIndexes creates the missing perfIndexes. It works the same on an
// empty database (each build is instant) and on one full of data: indexes
// are built CONCURRENTLY, so bookings and sales keep writing meanwhile, and
// it runs in the background after startup on its own connection without
// the request time limits (a big table can take minutes). A build cut off
// half-way (crash, redeploy) leaves an INVALID index that IF NOT EXISTS
// would skip forever, so those are dropped and rebuilt. Failures only log:
// the app is correct without these indexes.
// Stops when ctx is cancelled (shutdown): a build cut off half-way is left
// unfinished and rebuilt on the next start (see below).
func buildPerfIndexes(ctx context.Context, dsn string) {
	db, err := openSetupDB(dsn)
	if err != nil {
		log.Printf("WARNING: performance indexes skipped - could not open a connection: %v\n", err)
		return
	}
	defer func() {
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close()
		}
	}()

	// Builds on big tables are slow by nature; report them below instead of
	// as GORM "SLOW SQL" warnings.
	db = db.Session(&gorm.Session{Logger: logger.Default.LogMode(logger.Silent), Context: ctx})

	// One connection, so the settings and the lock below hold for every
	// statement. No time limits even if DATABASE_URL sets some (a build cut
	// off by statement_timeout is left INVALID and redone on every start).
	// Only one instance builds at a time: a second one starting meanwhile
	// (two replicas, a rolling deploy) would take the first one's
	// half-built index for an interrupted build, drop it and start again.
	if sqlDB, err := db.DB(); err == nil {
		sqlDB.SetMaxOpenConns(1)
	}
	if err := db.Exec("SET statement_timeout = 0; SET lock_timeout = 0").Error; err != nil {
		log.Printf("WARNING: performance indexes skipped - %v\n", err)
		return
	}
	var locked bool
	if err := db.Raw("SELECT pg_try_advisory_lock(?)", perfIndexLockKey).Scan(&locked).Error; err != nil || !locked {
		if err != nil {
			log.Printf("WARNING: performance indexes skipped - %v\n", err)
		} else {
			log.Println("Performance indexes: another instance is building them - skipped here.")
		}
		return
	}
	// Released when the connection closes (deferred above).

	trigram := true
	if err := db.Exec("CREATE EXTENSION IF NOT EXISTS pg_trgm").Error; err != nil {
		trigram = false
		log.Printf("WARNING: pg_trgm extension not available (%v) - member-name and audit-log search stay unindexed. "+
			"A database owner can run: CREATE EXTENSION pg_trgm;\n", err)
	}

	start := time.Now()
	built, failed := 0, 0
	for _, ix := range perfIndexes {
		if ctx.Err() != nil {
			return // shutting down
		}
		if ix.trigram && !trigram {
			continue
		}
		valid, exists, err := indexState(db, ix.name)
		if err != nil {
			log.Printf("WARNING: could not check index %s: %v\n", ix.name, err)
			failed++
			continue
		}
		if exists && valid {
			continue
		}
		if exists {
			log.Printf("Index %s was left unfinished by an interrupted build - rebuilding it.\n", ix.name)
			if err := db.Exec("DROP INDEX CONCURRENTLY IF EXISTS " + ix.name).Error; err != nil {
				log.Printf("WARNING: could not drop unfinished index %s: %v\n", ix.name, err)
				failed++
				continue
			}
		}
		t := time.Now()
		if err := db.Exec("CREATE INDEX CONCURRENTLY IF NOT EXISTS " + ix.name + " ON " + ix.table + " " + ix.def).Error; err != nil {
			if ctx.Err() != nil {
				log.Printf("Index %s: build stopped by shutdown - it is rebuilt on the next start.\n", ix.name)
				return
			}
			log.Printf("WARNING: could not build index %s: %v\n", ix.name, err)
			failed++
			continue
		}
		built++
		if d := time.Since(t); d > 2*time.Second {
			log.Printf("Index %s built in %s.\n", ix.name, d.Round(time.Second))
		}
	}
	if built > 0 || failed > 0 {
		log.Printf("Performance indexes: %d built, %d failed (%s).\n", built, failed, time.Since(start).Round(time.Millisecond))
	}
}

// indexState reports whether the named index exists in the current schema
// and whether it is valid (finished building).
func indexState(db *gorm.DB, name string) (valid, exists bool, err error) {
	var v sql.NullBool
	err = db.Raw("SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = to_regclass(?)", name).Row().Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	return v.Valid && v.Bool, true, nil
}
