package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/promptpay"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type PaymentService struct {
	db *gorm.DB
}

func NewPaymentService(db *gorm.DB) *PaymentService {
	return &PaymentService{db: db}
}

// CreatePromptPayPayload calls QR generation rules for Thai promptpay accounts
func (s *PaymentService) CreatePromptPayPayload(promptpayID string, amount float64) string {
	if promptpayID == "" {
		promptpayID = "0811112222" // default fallback
	}
	return promptpay.GeneratePayload(promptpayID, amount)
}

type SlipUploadResult struct {
	SlipURL string `json:"slip_url"`
	Status  string `json:"status"`
}

// SaveSlipUploadedTransaction atomically signs the slip attachment to a booking and increments payment statuses
func (s *PaymentService) SaveSlipUploadedTransaction(ctx context.Context, bookingID string, servedURL string) (*SlipUploadResult, error) {
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		slipStatus := model.PaymentSlipUploaded

		// Re-uploading is fine while the slip is still awaiting review, but
		// not once staff verified or rejected it - that would put a settled
		// payment back in the queue.
		var p model.Payment
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&p, "booking_id = ?", bookingID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		if p.Status != model.PaymentPending && p.Status != model.PaymentSlipUploaded {
			return fmt.Errorf("%w: payment is already %s", ErrInvalidState, p.Status)
		}

		// Update payment attributes
		err := tx.Model(&p).Updates(map[string]interface{}{
			"status":           slipStatus,
			"slip_url":         &servedURL,
			"slip_uploaded_at": &now,
			"updated_at":       now,
		}).Error
		if err != nil {
			return err
		}

		return nil
	})

	if err != nil {
		return nil, err
	}

	return &SlipUploadResult{
		SlipURL: servedURL,
		Status:  "SLIP_UPLOADED",
	}, nil
}
