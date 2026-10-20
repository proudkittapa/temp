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
// that customers' QR codes pay to. It fails on an ID that can't be encoded,
// so a typo in PROMPTPAY_ID stops startup instead of producing QR codes
// nobody can pay.
func NewPaymentService(promptPayID string) (*PaymentService, error) {
	if promptPayID == "" {
		promptPayID = DefaultPromptPayID
	}
	if _, _, err := promptpay.NormalizeID(promptPayID); err != nil {
		return nil, err
	}
	return &PaymentService{promptPayID: promptPayID}, nil
}

// CreatePromptPayPayload builds the PromptPay QR payload paying `amount`
// to the configured merchant ID.
func (s *PaymentService) CreatePromptPayPayload(amount float64) (string, error) {
	return promptpay.GeneratePayload(s.promptPayID, amount)
}
