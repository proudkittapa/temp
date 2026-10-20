package service

import (
	"context"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
)

type AuditLogService struct {
	auditRepo *repository.AuditRepository
}

func NewAuditLogService(auditRepo *repository.AuditRepository) *AuditLogService {
	return &AuditLogService{auditRepo: auditRepo}
}

// LogAdministrativeAction records security-sensitive operations
func (s *AuditLogService) LogAdministrativeAction(ctx context.Context, userID, userName, action, targetType, targetID, beforeState, afterState string) error {
	audit := &model.AuditLog{
		ID:          ids.New("log"),
		UserID:      userID,
		UserName:    userName,
		Action:      action,
		TargetType:  targetType,
		TargetID:    targetID,
		BeforeState: beforeState,
		AfterState:  afterState,
		CreatedAt:   time.Now(),
	}
	return s.auditRepo.LogAction(ctx, audit)
}

// GetSystemTrails fetches past administrative operations
func (s *AuditLogService) GetSystemTrails(ctx context.Context, limit, offset int) ([]model.AuditLog, error) {
	if limit <= 0 {
		limit = 50
	}
	return s.auditRepo.FetchLogs(ctx, limit, offset)
}
