package service

import (
	"errors"
	"testing"
	"time"

	"arena-backend/internal/model"
)

func TestCheckSlipVersion(t *testing.T) {
	seen := time.Date(2026, 10, 20, 10, 0, 0, 123000, time.UTC)
	other := seen.Add(time.Minute)

	if err := checkSlipVersion(&model.Payment{}, nil); err != nil {
		t.Errorf("a payment without a slip needs no version: %v", err)
	}
	if err := checkSlipVersion(&model.Payment{SlipUploadedAt: &seen}, &seen); err != nil {
		t.Errorf("same slip: %v", err)
	}
	if err := checkSlipVersion(&model.Payment{SlipUploadedAt: &other}, &seen); !errors.Is(err, ErrSlipChanged) {
		t.Errorf("replaced slip: err = %v, want ErrSlipChanged", err)
	}
	if err := checkSlipVersion(&model.Payment{SlipUploadedAt: &seen}, nil); !errors.Is(err, ErrInvalidBooking) {
		t.Errorf("missing version: err = %v, want ErrInvalidBooking", err)
	}
}
