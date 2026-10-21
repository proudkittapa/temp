package repository

import (
	"context"
	"fmt"

	"arena-backend/internal/model"
	"gorm.io/gorm"
)

type AuditRepository struct {
	db *gorm.DB
}

func NewAuditRepository(db *gorm.DB) *AuditRepository {
	return &AuditRepository{db: db}
}

// LogAction inserts an administrative event directly to auditing tables.
func (r *AuditRepository) LogAction(ctx context.Context, action *model.AuditLog) error {
	err := r.db.WithContext(ctx).Create(action).Error
	if err != nil {
		return fmt.Errorf("failed to record administrative security logs: %w", err)
	}
	return nil
}
