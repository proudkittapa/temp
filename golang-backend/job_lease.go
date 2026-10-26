package main

import (
	"context"
	"log"
	"os"
	"time"

	"arena-backend/internal/pkg/ids"
	"gorm.io/gorm"
)

// jobLeaseTTL is how long a lease lasts without renewal: the jobs tick every
// minute, so a stopped holder is replaced within about two minutes. A run
// that outlasts it (six jobs of at most 45 s) may overlap the next server's
// - harmless, every job is safe to run twice at once (each takes its own
// row locks); the lease only stops every server doing the same work.
const jobLeaseTTL = 2 * time.Minute

// jobLease elects one server to run the background jobs. It is a row, not a
// session advisory lock: a lock would hold a pooled connection while the
// jobs run, which deadlocks with DB_MAX_OPEN_CONNS=1, and is lost silently
// when that connection drops. Expiry uses the database's clock, so servers
// with different clocks agree.
type jobLease struct {
	db     *gorm.DB
	holder string
	held   bool
}

func newJobLease(db *gorm.DB) *jobLease {
	host, _ := os.Hostname()
	if len(host) > 40 {
		host = host[:40]
	}
	return &jobLease{db: db, holder: ids.New(host)}
}

// acquire takes the lease if it is free or expired, or renews it if this
// server holds it; false means another server has it (or the database
// can't be reached - the jobs would fail anyway).
func (l *jobLease) acquire(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var holder string
	err := l.db.WithContext(ctx).Raw(`INSERT INTO job_leases (name, holder, expires_at)
		VALUES ('background', ?, now() + make_interval(secs => ?))
		ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
		WHERE job_leases.holder = EXCLUDED.holder OR job_leases.expires_at < now()
		RETURNING holder`, l.holder, jobLeaseTTL.Seconds()).Scan(&holder).Error
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("Warning: background job lease: %v\n", err)
		}
		l.held = false
		return false
	}
	got := holder == l.holder
	if got != l.held {
		if got {
			log.Println("This server now runs the background jobs.")
		} else {
			log.Println("Another server runs the background jobs now.")
		}
	}
	l.held = got
	return got
}

// release ends the lease at shutdown, so another server takes over at its
// next tick instead of after the lease runs out (e.g. a rolling update).
func (l *jobLease) release() {
	if !l.held {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := l.db.WithContext(ctx).Exec("DELETE FROM job_leases WHERE name = 'background' AND holder = ?", l.holder).Error; err != nil {
		log.Printf("Warning: releasing the background job lease: %v\n", err)
	}
	l.held = false
}
