package service

import (
	"errors"
	"testing"

	"arena-backend/internal/model"
)

func TestValidateRule(t *testing.T) {
	good := model.PricingRule{CourtType: model.CourtBadminton, DayType: "WEEKDAY", StartHour: 17, EndHour: 22, PricePerHour: 280, PriceType: "PEAK", IsActive: true}
	r := good
	if err := validateRule(&r); err != nil {
		t.Fatalf("valid rule rejected: %v", err)
	}
	if r.Label == "" {
		t.Errorf("an empty label should get a generated default")
	}

	bad := map[string]func(*model.PricingRule){
		"unknown court type": func(r *model.PricingRule) { r.CourtType = "TENNIS" },
		"unknown day type":   func(r *model.PricingRule) { r.DayType = "HOLIDAY" },
		"unknown price type": func(r *model.PricingRule) { r.PriceType = "SUPER_PEAK" },
		"start after end":    func(r *model.PricingRule) { r.StartHour, r.EndHour = 22, 17 },
		"empty window":       func(r *model.PricingRule) { r.EndHour = r.StartHour },
		"past midnight":      func(r *model.PricingRule) { r.EndHour = 25 },
		"negative price":     func(r *model.PricingRule) { r.PricePerHour = -1 },
	}
	for name, mutate := range bad {
		r := good
		mutate(&r)
		if err := validateRule(&r); !errors.Is(err, ErrInvalidBooking) {
			t.Errorf("%s: err = %v, want ErrInvalidBooking", name, err)
		}
	}
}
