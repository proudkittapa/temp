package service

import (
	"context"
	"time"

	"gorm.io/gorm"
)

// AuditRetentionDays is how long audit log entries are kept
// (AUDIT_RETENTION_DAYS, default 730 = two years; owner 2026-10-23).
func AuditRetentionDays() int { return envIntRange("AUDIT_RETENTION_DAYS", 730, 30, 36500) }

// PruneAuditLogs deletes audit entries older than the retention, at most
// 5,000 per call (main runs it every minute, so a backlog goes in small
// steps without one long lock), and returns how many it deleted.
func PruneAuditLogs(ctx context.Context, db *gorm.DB) (int64, error) {
	cutoff := time.Now().AddDate(0, 0, -AuditRetentionDays())
	res := db.WithContext(ctx).Exec(
		"DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs WHERE created_at < ? ORDER BY created_at LIMIT 5000)", cutoff)
	return res.RowsAffected, res.Error
}
