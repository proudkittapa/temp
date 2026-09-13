package service

import (
	"context"
	"fmt"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/promptpay"
	"gorm.io/gorm"
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

		// Update payment attributes
		err := tx.Model(&model.Payment{}).Where("booking_id = ?", bookingID).Updates(map[string]interface{}{
			"status":           slipStatus,
			"slip_url":         &servedURL,
			"slip_uploaded_at": &now,
			"updated_at":       now,
		}).Error
		if err != nil {
			return err
		}

		// Update booking status
		return tx.Model(&model.Booking{}).Where("id = ?", bookingID).Update("status", model.BookingPendingPayment).Error
	})

	if err != nil {
		return nil, err
	}

	return &SlipUploadResult{
		SlipURL: servedURL,
		Status:  "SLIP_UPLOADED",
	}, nil
}
