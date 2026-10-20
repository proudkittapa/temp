package service

import (
	"arena-backend/internal/pkg/promptpay"
)

// DefaultPromptPayID is the merchant PromptPay ID (13-digit tax ID) the
// frontend's local mode also uses. Override with PROMPTPAY_ID.
const DefaultPromptPayID = "0105561008012"

type PaymentService struct {
	promptPayID string
}

// NewPaymentService takes the merchant's PromptPay ID (phone or tax ID)
// that customers' QR codes pay to.
func NewPaymentService(promptPayID string) *PaymentService {
	if promptPayID == "" {
		promptPayID = DefaultPromptPayID
	}
	return &PaymentService{promptPayID: promptPayID}
}

// CreatePromptPayPayload builds the PromptPay QR payload paying `amount`
// to the configured merchant ID.
func (s *PaymentService) CreatePromptPayPayload(amount float64) string {
	return promptpay.GeneratePayload(s.promptPayID, amount)
}
