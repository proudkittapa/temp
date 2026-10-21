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
// BasePrice is the rule's hourly price for the sport and hour with no
// member or half-court adjustment (the no-show resale price starts here).
func (q *SlotQuoter) BasePrice(courtType model.CourtType, hour int) (float64, error) {
	rules, ok := q.rules[courtType]
	if !ok {
		var err error
		if rules, err = q.engine.courtRepo.GetActivePricingRules(q.ctx, courtType, q.isWeekend); err != nil {
			return 0, err
		}
		q.rules[courtType] = rules
	}
	rule := RuleForHour(rules, hour)
	if rule == nil {
		return 0, fmt.Errorf("no price for %s at %02d:00", courtType, hour)
	}
	return rule.PricePerHour, nil
}

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
	// To the satang (2 decimals, REQUIREMENTS.md NFR-4), matching the
	// frontend's calculatePrice.
	amount = RoundBaht(ApplyRateAdjustments(rule.PricePerHour, isHalfCourt, q.halfCourtRate, q.discountPercent))
	return amount, rule.PriceType, true, nil
}

// RoundBaht rounds an amount to 2 decimal places (satang), half away from
// zero - the same result as the frontend's Math.round(x * 100) / 100 for the
// positive amounts used here.
func RoundBaht(x float64) float64 {
	return math.Round(x*100) / 100
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
