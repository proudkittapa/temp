package service

import (
	"context"
	"fmt"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/repository"
)

type PriceEngineService struct {
	courtRepo *repository.CourtRepository
}

func NewPriceEngineService(courtRepo *repository.CourtRepository) *PriceEngineService {
	return &PriceEngineService{courtRepo: courtRepo}
}

// CalculatePrice parses starting/ending hours and maps them to dynamic PricingRules
func (s *PriceEngineService) CalculatePrice(ctx context.Context, courtType model.CourtType, dateStr string, startTimeStr string, endTimeStr string, isHalfCourt bool) (float64, string, error) {
	// 1. Determine if the selected date constitutes a Weekend day
	t, err := time.Parse("2006-01-02", dateStr)
	if err != nil {
		return 0, "NORMAL", fmt.Errorf("invalid date format: %w", err)
	}

	isWeekend := t.Weekday() == time.Saturday || t.Weekday() == time.Sunday

	// 2. Load pricing rules from repository
	rules, err := s.courtRepo.GetActivePricingRules(ctx, courtType, isWeekend)
	if err != nil {
		return 0, "NORMAL", err
	}

	// 3. Parse timing structures "HH:MM"
	startT, err := time.Parse("15:04", startTimeStr)
	if err != nil {
		return 0, "NORMAL", fmt.Errorf("invalid start time format: %w", err)
	}

	endT, err := time.Parse("15:04", endTimeStr)
	if err != nil {
		return 0, "NORMAL", fmt.Errorf("invalid end time format: %w", err)
	}

	durationHours := endT.Sub(startT).Hours()
	if durationHours <= 0 {
		return 0, "NORMAL", fmt.Errorf("end time must be strictly after start time")
	}

	// Let's sweep hourly intervals to map rules
	totalAmount := 0.0
	dominantPriceType := "NORMAL"
	var baseHourRate float64 = 400.0 // fallback rate

	// Set a standard base hourly cost based on court types if no rules configured
	switch courtType {
	case model.CourtBasketball:
		baseHourRate = 600.0
	case model.CourtBadminton:
		baseHourRate = 200.0
	case model.CourtPickleball:
		baseHourRate = 300.0
	case model.CourtMeetingRoom:
		baseHourRate = 500.0
	}

	startHourFloat := float64(startT.Hour()) + float64(startT.Minute())/60.0
	endHourFloat := float64(endT.Hour()) + float64(endT.Minute())/60.0

	// We calculate in 30-minute chunks for fine-grained resolution
	step := 0.5
	for checkHour := startHourFloat; checkHour < endHourFloat; checkHour += step {
		appliedRate := baseHourRate
		for _, r := range rules {
			if checkHour >= float64(r.StartHour) && checkHour < float64(r.EndHour) {
				appliedRate = r.PricePerHour
				dominantPriceType = r.PriceType
				break
			}
		}
		totalAmount += (appliedRate * step)
	}

	// 4. Apply half-court scaling rules
	if isHalfCourt {
		totalAmount = totalAmount * 0.60 // half-court is 60% of full rate
	}

	return totalAmount, dominantPriceType, nil
}
