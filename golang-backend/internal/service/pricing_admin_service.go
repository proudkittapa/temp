package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// PricingAdminService manages the pricing data SlotQuoter charges from:
// pricing rules (FR-2.1/2.2), member discounts (FR-2.3) and the half-court
// rate (FR-2.4). Keeping it in the database is what makes an admin's price
// change reach real bookings - a rule edited only in one browser's
// localStorage changed the preview there but not what customers paid.
type PricingAdminService struct {
	db  *gorm.DB
	now func() time.Time
}

func NewPricingAdminService(db *gorm.DB) *PricingAdminService {
	return &PricingAdminService{db: db, now: time.Now}
}

// PricingSnapshot is everything a client needs to preview prices exactly
// as the server will charge them.
type PricingSnapshot struct {
	Rules           []model.PricingRule    `json:"rules"`
	Config          model.PricingConfig    `json:"config"`
	MemberDiscounts []model.MemberDiscount `json:"member_discounts"`
	// The no-show rules (server settings), for the screens' buttons and
	// price previews.
	NoShowGraceMinutes  int `json:"no_show_grace_minutes"`
	NoShowResalePercent int `json:"no_show_resale_percent"`
}

func (s *PricingAdminService) Snapshot(ctx context.Context) (*PricingSnapshot, error) {
	db := s.db.WithContext(ctx)
	snap := &PricingSnapshot{NoShowGraceMinutes: NoShowGraceMinutes(), NoShowResalePercent: NoShowResalePercent()}
	// A fixed order (id breaks ties): the screens cache this and other open
	// tabs reload when the cached copy changes, so a shuffled order made
	// tabs keep waking each other.
	if err := db.Order("court_type, day_type, start_hour, id").Find(&snap.Rules).Error; err != nil {
		return nil, err
	}
	if err := db.First(&snap.Config, "id = ?", "global").Error; err != nil {
		return nil, fmt.Errorf("failed to load pricing config: %w", err)
	}
	if err := db.Order("member_type").Find(&snap.MemberDiscounts).Error; err != nil {
		return nil, err
	}
	return snap, nil
}

var (
	validCourtTypes = map[model.CourtType]bool{model.CourtBadminton: true, model.CourtBasketball: true, model.CourtPickleball: true, model.CourtMeetingRoom: true}
	validDayTypes   = map[string]bool{"WEEKDAY": true, "WEEKEND": true}
	validPriceTypes = map[string]bool{"PEAK": true, "OFFPEAK": true, "NORMAL": true}
)

func validateRule(r *model.PricingRule) error {
	r.Label = strings.TrimSpace(r.Label)
	switch {
	case !validCourtTypes[r.CourtType]:
		return fmt.Errorf("%w: unknown court_type %q", ErrInvalidBooking, r.CourtType)
	case !validDayTypes[r.DayType]:
		return fmt.Errorf("%w: day_type must be WEEKDAY or WEEKEND", ErrInvalidBooking)
	case !validPriceTypes[r.PriceType]:
		return fmt.Errorf("%w: price_type must be PEAK, OFFPEAK or NORMAL", ErrInvalidBooking)
	// Rules decide which hours each sport is open inside the opening hours
	// (PricingConfig.OpenHour/CloseHour); a rule outside them is kept but
	// books nothing until the hours are widened.
	case !validHourRange(r.StartHour, r.EndHour):
		return fmt.Errorf("%w: start_hour must be before end_hour, within 00:00-24:00", ErrInvalidBooking)
	// A free hour would produce a 0.00 THB PromptPay QR, which banking
	// apps reject.
	case r.PricePerHour <= 0:
		return fmt.Errorf("%w: price_per_hour must be more than 0", ErrInvalidBooking)
	}
	if r.Label == "" {
		r.Label = fmt.Sprintf("%s %s (%s)", r.CourtType, r.DayType, r.PriceType)
	}
	return nil
}

// checkNoOverlap rejects an active rule that overlaps another active rule
// for the same court and day type: SlotQuoter takes the first match, so
// overlapping rules would make the price depend on row order.
func checkNoOverlap(tx *gorm.DB, r model.PricingRule) error {
	if !r.IsActive {
		return nil
	}
	var clash model.PricingRule
	err := tx.Where("id <> ? AND is_active AND court_type = ? AND day_type = ? AND start_hour < ? AND end_hour > ?",
		r.ID, r.CourtType, r.DayType, r.EndHour, r.StartHour).First(&clash).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return fmt.Errorf("%w: overlaps the active rule %q (%02d:00-%02d:00) - adjust or deactivate it first",
		ErrInvalidState, clash.Label, clash.StartHour, clash.EndHour)
}

// SaveRule creates a rule (empty ID) or replaces an existing one.
func (s *PricingAdminService) SaveRule(ctx context.Context, r model.PricingRule, actorID, actorName string) (*model.PricingRule, error) {
	if err := validateRule(&r); err != nil {
		return nil, err
	}
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		// Serialize rule edits so two concurrent saves can't both pass the
		// overlap check.
		if err := tx.Exec("LOCK TABLE pricing_rules IN SHARE ROW EXCLUSIVE MODE").Error; err != nil {
			return err
		}
		var before *model.PricingRule
		action := "PRICING_CREATED"
		if r.ID == "" {
			r.ID = ids.New("rule")
		} else {
			var existing model.PricingRule
			if err := tx.First(&existing, "id = ?", r.ID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrNotFound
				}
				return err
			}
			before, action = &existing, "PRICING_UPDATED"
		}
		if err := checkNoOverlap(tx, r); err != nil {
			return err
		}
		if err := tx.Clauses(clause.OnConflict{UpdateAll: true}).Create(&r).Error; err != nil {
			return err
		}
		return s.audit(tx, actorID, actorName, action, "PricingRule", r.ID, before, r)
	})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *PricingAdminService) DeleteRule(ctx context.Context, id, actorID, actorName string) error {
	return repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		var existing model.PricingRule
		if err := tx.First(&existing, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		if err := tx.Delete(&existing).Error; err != nil {
			return err
		}
		return s.audit(tx, actorID, actorName, "PRICING_DELETED", "PricingRule", id, existing, nil)
	})
}

// UpdateMemberDiscount edits one membership tier's name/percent/active flag.
func (s *PricingAdminService) UpdateMemberDiscount(ctx context.Context, d model.MemberDiscount, actorID, actorName string) (*model.MemberDiscount, error) {
	d.Name = strings.TrimSpace(d.Name)
	if d.Name == "" {
		return nil, fmt.Errorf("%w: name is required", ErrInvalidBooking)
	}
	// Below 100: a free booking would need a 0.00 THB QR, which banking
	// apps reject.
	if d.DiscountPercent < 0 || d.DiscountPercent >= 100 {
		return nil, fmt.Errorf("%w: discount_percent must be at least 0 and below 100", ErrInvalidBooking)
	}
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		var existing model.MemberDiscount
		if err := tx.First(&existing, "member_type = ?", d.MemberType).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		if err := tx.Model(&existing).Updates(map[string]interface{}{
			"name": d.Name, "discount_percent": d.DiscountPercent, "is_active": d.IsActive,
		}).Error; err != nil {
			return err
		}
		return s.audit(tx, actorID, actorName, "MEMBER_DISCOUNT_UPDATED", "MemberDiscount", string(d.MemberType), existing, d)
	})
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// validHourRange: [start, end) is a non-empty range of whole hours within
// one day - pricing rules, opening hours and partial closures.
func validHourRange(start, end int) bool { return start >= 0 && end <= 24 && start < end }

// MaxAdvanceDaysLimit bounds PricingConfig.MaxAdvanceDays.
const MaxAdvanceDaysLimit = 365

// UpdateConfig changes the global pricing settings: the half-court rate
// (FR-2.4) and/or how many days ahead customers may book online. A nil
// field is left as it is.
func (s *PricingAdminService) UpdateConfig(ctx context.Context, halfCourtPercent *float64, maxAdvanceDays *int, openHour, closeHour *int, actorID, actorName string) (*model.PricingConfig, error) {
	if halfCourtPercent != nil && (*halfCourtPercent <= 0 || *halfCourtPercent > 100) {
		return nil, fmt.Errorf("%w: half_court_rate_percent must be between 1 and 100", ErrInvalidBooking)
	}
	if maxAdvanceDays != nil && (*maxAdvanceDays < 1 || *maxAdvanceDays > MaxAdvanceDaysLimit) {
		return nil, fmt.Errorf("%w: max_advance_days must be between 1 and %d", ErrInvalidBooking, MaxAdvanceDaysLimit)
	}
	var cfg model.PricingConfig
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		// Locked: two admins saving at once each change their own fields,
		// and Save writes every column - unlocked, the second would put
		// back the first one's old values.
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&cfg, "id = ?", "global").Error; err != nil {
			return err
		}
		before := cfg
		if halfCourtPercent != nil {
			cfg.HalfCourtRatePercent = *halfCourtPercent
		}
		if maxAdvanceDays != nil {
			cfg.MaxAdvanceDays = *maxAdvanceDays
		}
		if openHour != nil {
			cfg.OpenHour = *openHour
		}
		if closeHour != nil {
			cfg.CloseHour = *closeHour
		}
		if !validHourRange(cfg.OpenHour, cfg.CloseHour) {
			return fmt.Errorf("%w: opening hours must satisfy 0 <= open_hour < close_hour <= 24", ErrInvalidBooking)
		}
		if err := tx.Save(&cfg).Error; err != nil {
			return err
		}
		return s.audit(tx, actorID, actorName, "PRICING_CONFIG_UPDATED", "PricingConfig", cfg.ID, before, cfg)
	})
	if err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (s *PricingAdminService) audit(tx *gorm.DB, actorID, actorName, action, targetType, targetID string, before, after any) error {
	b, a := "", ""
	if before != nil {
		b = model.AuditJSON(before)
	}
	if after != nil {
		a = model.AuditJSON(after)
	}
	return tx.Create(&model.AuditLog{
		ID:          ids.New("log"),
		UserID:      actorID,
		UserName:    actorName,
		Action:      action,
		TargetType:  targetType,
		TargetID:    targetID,
		BeforeState: b,
		AfterState:  a,
		CreatedAt:   s.now(),
	}).Error
}

// BusinessInfo is the business shown on receipts and the payment screen.
type BusinessInfo struct {
	Name          string `json:"business_name"`
	Address       string `json:"business_address"`
	Phone         string `json:"business_phone"`
	TaxID         string `json:"business_tax_id"`
	VatRegistered bool   `json:"vat_registered"`
}

// UpdateBusiness saves the business details (admin). A VAT-registered
// business must give its name, address and 13-digit tax ID - what an
// abbreviated tax invoice has to show.
func (s *PricingAdminService) UpdateBusiness(ctx context.Context, in BusinessInfo, actorID, actorName string) (*model.PricingConfig, error) {
	in.Name, in.Address, in.Phone = strings.TrimSpace(in.Name), strings.TrimSpace(in.Address), strings.TrimSpace(in.Phone)
	in.TaxID = strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, in.TaxID)
	switch {
	case utf8.RuneCountInString(in.Name) > 200 || utf8.RuneCountInString(in.Address) > 500 || utf8.RuneCountInString(in.Phone) > 50:
		return nil, fmt.Errorf("%w: business name, address or phone is too long", ErrInvalidBooking)
	case in.TaxID != "" && len(in.TaxID) != 13:
		return nil, fmt.Errorf("%w: the tax ID must have 13 digits", ErrInvalidBooking)
	case in.VatRegistered && (in.Name == "" || in.Address == "" || in.TaxID == ""):
		return nil, fmt.Errorf("%w: a VAT-registered business needs its name, address and tax ID", ErrInvalidBooking)
	}
	var cfg model.PricingConfig
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&cfg, "id = ?", "global").Error; err != nil {
			return err
		}
		before := cfg
		cfg.BusinessName, cfg.BusinessAddress, cfg.BusinessPhone, cfg.BusinessTaxID, cfg.VatRegistered =
			in.Name, in.Address, in.Phone, in.TaxID, in.VatRegistered
		if err := tx.Save(&cfg).Error; err != nil {
			return err
		}
		return s.audit(tx, actorID, actorName, "BUSINESS_INFO_UPDATED", "PricingConfig", cfg.ID, before, cfg)
	})
	if err != nil {
		return nil, err
	}
	return &cfg, nil
}
