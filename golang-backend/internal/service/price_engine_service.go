package service

import (
	"context"
	"fmt"
	"math"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/repository"
)

type PriceEngineService struct {
	courtRepo         *repository.CourtRepository
	membershipService *MembershipService
}

func NewPriceEngineService(courtRepo *repository.CourtRepository, membershipService *MembershipService) *PriceEngineService {
	return &PriceEngineService{courtRepo: courtRepo, membershipService: membershipService}
}

// CalculatePrice parses starting/ending hours, maps them to dynamic
// PricingRules, and applies the half-court rate and membership discount
// (FR-2) for the given member type.
func (s *PriceEngineService) CalculatePrice(ctx context.Context, courtType model.CourtType, dateStr string, startTimeStr string, endTimeStr string, isHalfCourt bool, memberType model.MemberType) (float64, string, error) {
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

	// 4. Apply half-court rate (FR-2.4) and membership discount (FR-2.3).
	// Coefficients come from PricingConfig/member_discounts instead of
	// hardcoded literals, so this and mockData.ts's calculatePrice read the
	// same business rules (previously 60%/20%/10%/15% here vs 50%/15%/10%/20%
	// in REQUIREMENTS.md).
	halfCourtRatePercent := 100.0
	if isHalfCourt {
		cfg, err := s.courtRepo.GetPricingConfig(ctx)
		if err != nil {
			return 0, "NORMAL", fmt.Errorf("failed to load half-court rate: %w", err)
		}
		halfCourtRatePercent = cfg.HalfCourtRatePercent
	}

	discount, err := s.membershipService.CalculateDiscount(ctx, memberType)
	if err != nil {
		return 0, "NORMAL", fmt.Errorf("failed to load membership discount: %w", err)
	}

	totalAmount = ApplyRateAdjustments(totalAmount, isHalfCourt, halfCourtRatePercent, discount.PercentageDiscount)

	return totalAmount, dominantPriceType, nil
}

// ApplyRateAdjustments applies the half-court coefficient and then the
// membership discount to a base amount, in the order specified by
// REQUIREMENTS.md 5.1: AdjustedRate = BaseRate * (isHalfCourt ? halfCourtCoefficient : 1),
// FinalPrice = AdjustedRate * (1 - discountPercent/100). Pulled out as a pure
// function (no DB access) so the arithmetic itself is unit-testable
// independent of PricingConfig/member_discounts lookups.
func ApplyRateAdjustments(baseAmount float64, isHalfCourt bool, halfCourtRatePercent float64, discountPercent float64) float64 {
	amount := baseAmount
	if isHalfCourt {
		amount = amount * (halfCourtRatePercent / 100.0)
	}
	amount = amount * (1 - discountPercent/100.0)
	return amount
}

// SlotQuoter prices one-hour slots for a single booking request. It loads
// the half-court rate and member discount once and each court type's rules
// on first use, instead of CalculatePrice's three queries per slot, so a
// multi-slot booking doesn't repeat identical lookups (and can do them all
// before its transaction starts rather than while holding row locks).
type SlotQuoter struct {
	engine          *PriceEngineService
	ctx             context.Context
	isWeekend       bool
	halfCourtRate   float64
	discountPercent float64
	rules           map[model.CourtType][]model.PricingRule
}

// NewSlotQuoter prepares a quoter for one date and member tier.
func (s *PriceEngineService) NewSlotQuoter(ctx context.Context, date string, memberType model.MemberType) (*SlotQuoter, error) {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return nil, fmt.Errorf("invalid date format: %w", err)
	}
	cfg, err := s.courtRepo.GetPricingConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to load half-court rate: %w", err)
	}
	discount, err := s.membershipService.CalculateDiscount(ctx, memberType)
	if err != nil {
		return nil, fmt.Errorf("failed to load membership discount: %w", err)
	}
	return &SlotQuoter{
		engine:          s,
		ctx:             ctx,
		isWeekend:       t.Weekday() == time.Saturday || t.Weekday() == time.Sunday,
		halfCourtRate:   cfg.HalfCourtRatePercent,
		discountPercent: discount.PercentageDiscount,
		rules:           map[model.CourtType][]model.PricingRule{},
	}, nil
}

// Quote prices the one-hour slot starting at `hour`. open is false when no
// active pricing rule covers that hour - the pricing rules double as the
// operating hours, so an uncovered hour is a closed hour rather than
// something to price at a fallback rate (which also let a 03:00 half-court
// booking slip past the off-peak-only check as priceType NORMAL).
func (q *SlotQuoter) Quote(courtType model.CourtType, hour int, isHalfCourt bool) (amount float64, priceType string, open bool, err error) {
	rules, ok := q.rules[courtType]
	if !ok {
		rules, err = q.engine.courtRepo.GetActivePricingRules(q.ctx, courtType, q.isWeekend)
		if err != nil {
			return 0, "", false, err
		}
		q.rules[courtType] = rules
	}
	rule := RuleForHour(rules, hour)
	if rule == nil {
		return 0, "", false, nil
	}
	// Whole baht per hour, matching the frontend's calculatePrice rounding.
	amount = math.Round(ApplyRateAdjustments(rule.PricePerHour, isHalfCourt, q.halfCourtRate, q.discountPercent))
	return amount, rule.PriceType, true, nil
}

// RuleForHour returns the active rule covering [hour, hour+1), or nil.
func RuleForHour(rules []model.PricingRule, hour int) *model.PricingRule {
	for i := range rules {
		if rules[i].IsActive && hour >= rules[i].StartHour && hour < rules[i].EndHour {
			return &rules[i]
		}
	}
	return nil
}
