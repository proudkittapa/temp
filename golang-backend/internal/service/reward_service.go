package service

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// VoucherValidDays is how long a redeemed voucher can be claimed at the
// counter before it expires.
const VoucherValidDays = 30

// RewardService is the loyalty rewards club (FR-4.2/4.3): customers spend
// points on catalog items and get an RW-XXXXXX voucher; staff look the code
// up at the counter and hand the reward over.
type RewardService struct {
	db      *gorm.DB
	usrRepo *repository.UserRepository
	now     func() time.Time
}

func NewRewardService(db *gorm.DB, usrRepo *repository.UserRepository) *RewardService {
	return &RewardService{db: db, usrRepo: usrRepo, now: time.Now}
}

// Catalog returns the active rewards, cheapest first.
func (s *RewardService) Catalog(ctx context.Context) ([]model.RewardCatalogItem, error) {
	var items []model.RewardCatalogItem
	err := s.db.WithContext(ctx).Where("is_active = ?", true).Order("points_cost, id").Find(&items).Error
	return items, err
}

// VoucherView is a voucher with its reward's name for display.
type VoucherView struct {
	model.Voucher
	RewardName  string `json:"reward_name"`
	RewardEmoji string `json:"reward_emoji"`
	RewardKind  string `json:"reward_kind"`
	UserName    string `json:"user_name,omitempty"`
	UserPhone   string `json:"user_phone,omitempty"`
}

var ErrInsufficientPointsForReward = errors.New("not enough points for this reward")

// Redeem spends the customer's points on a reward and issues a voucher, in
// one transaction (the points ledger records the REDEEM entry).
func (s *RewardService) Redeem(ctx context.Context, userID, rewardID string) (*VoucherView, error) {
	// vouchers.code is unique: two redemptions drawing the same random code
	// at once - the loser retries with a new code.
	for attempt := 0; ; attempt++ {
		out, err := s.redeemTx(ctx, userID, rewardID)
		if !repository.IsUniqueViolation(err) {
			return out, err
		}
		if attempt == 2 {
			return nil, ErrBusy
		}
	}
}

func (s *RewardService) redeemTx(ctx context.Context, userID, rewardID string) (*VoucherView, error) {
	var out *VoucherView
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var item model.RewardCatalogItem
		if err := tx.First(&item, "id = ? AND is_active = ?", rewardID, true).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		var u model.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&u, "id = ?", userID).Error; err != nil {
			return err
		}
		if u.Points < item.PointsCost {
			return fmt.Errorf("%w: it costs %d points, you have %d", ErrInsufficientPointsForReward, item.PointsCost, u.Points)
		}
		code, err := uniqueVoucherCode(tx)
		if err != nil {
			return err
		}
		now := s.now()
		v := model.Voucher{
			ID: ids.New("vch"), Code: code, UserID: userID, RewardID: item.ID, PointsSpent: item.PointsCost,
			Status: model.VoucherActive, CreatedAt: now, ExpiresAt: now.AddDate(0, 0, VoucherValidDays),
		}
		if err := tx.Create(&v).Error; err != nil {
			return err
		}
		refType, note := "Voucher", fmt.Sprintf("Redeemed %s (%s)", item.Name, code)
		if _, err := s.usrRepo.AddPointsEntry(ctx, tx, userID, model.LedgerRedeem, -item.PointsCost, userID, &refType, &v.ID, &note); err != nil {
			return err
		}
		if err := tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: userID, UserName: u.Name, Action: "LOYALTY_POINT_REDEEMED",
			TargetType: "Voucher", TargetID: v.ID,
			BeforeState: model.AuditJSON(map[string]any{"points": u.Points}),
			AfterState:  model.AuditJSON(map[string]any{"points": u.Points - item.PointsCost, "reward": item.Name, "code": code}),
			CreatedAt:   now,
		}).Error; err != nil {
			return err
		}
		out = &VoucherView{Voucher: v, RewardName: item.Name, RewardEmoji: item.Emoji, RewardKind: item.Kind}
		return nil
	})
	return out, err
}

// uniqueVoucherCode picks an unused "RW-XXXXXX" code (FR-4.3).
func uniqueVoucherCode(tx *gorm.DB) (string, error) {
	for i := 0; i < 10; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(900000))
		if err != nil {
			return "", err
		}
		code := fmt.Sprintf("RW-%06d", n.Int64()+100000)
		var c int64
		if err := tx.Model(&model.Voucher{}).Where("code = ?", code).Count(&c).Error; err != nil {
			return "", err
		}
		if c == 0 {
			return code, nil
		}
	}
	return "", ErrBusy
}

func (s *RewardService) views(db *gorm.DB, vouchers []model.Voucher, withUser bool) ([]VoucherView, error) {
	rewardIDs, userIDs := []string{}, []string{}
	for _, v := range vouchers {
		rewardIDs = append(rewardIDs, v.RewardID)
		userIDs = append(userIDs, v.UserID)
	}
	items := map[string]model.RewardCatalogItem{}
	if len(rewardIDs) > 0 {
		var list []model.RewardCatalogItem
		if err := db.Where("id IN ?", rewardIDs).Find(&list).Error; err != nil {
			return nil, err
		}
		for _, it := range list {
			items[it.ID] = it
		}
	}
	users := map[string]model.User{}
	if withUser && len(userIDs) > 0 {
		var list []model.User
		if err := db.Where("id IN ?", userIDs).Find(&list).Error; err != nil {
			return nil, err
		}
		for _, u := range list {
			users[u.ID] = u
		}
	}
	out := make([]VoucherView, len(vouchers))
	for i, v := range vouchers {
		out[i] = VoucherView{Voucher: v, RewardName: items[v.RewardID].Name, RewardEmoji: items[v.RewardID].Emoji, RewardKind: items[v.RewardID].Kind}
		if withUser {
			out[i].UserName, out[i].UserPhone = users[v.UserID].Name, users[v.UserID].Phone
		}
	}
	return out, nil
}

// MyVouchers lists a customer's vouchers, newest first.
func (s *RewardService) MyVouchers(ctx context.Context, userID string) ([]VoucherView, error) {
	db := s.db.WithContext(ctx)
	var list []model.Voucher
	if err := db.Where("user_id = ?", userID).Order("created_at DESC").Limit(200).Find(&list).Error; err != nil {
		return nil, err
	}
	return s.views(db, list, false)
}

// Lookup finds a voucher by code for the counter.
func (s *RewardService) Lookup(ctx context.Context, code string) (*VoucherView, error) {
	db := s.db.WithContext(ctx)
	var v model.Voucher
	if err := db.First(&v, "code = ?", strings.ToUpper(strings.TrimSpace(code))).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	views, err := s.views(db, []model.Voucher{v}, true)
	if err != nil {
		return nil, err
	}
	return &views[0], nil
}

// Dispense marks a voucher handed over at the counter. Only an ACTIVE,
// unexpired voucher can be dispensed, and only once.
func (s *RewardService) Dispense(ctx context.Context, code, staffID, staffName string) (*VoucherView, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var v model.Voucher
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&v, "code = ?", code).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		now := s.now()
		if v.Status == model.VoucherActive && now.After(v.ExpiresAt) {
			v.Status = model.VoucherExpired
			if err := tx.Model(&v).Update("status", v.Status).Error; err != nil {
				return err
			}
		}
		if v.Status != model.VoucherActive {
			return fmt.Errorf("%w: voucher %s is %s", ErrInvalidState, code, v.Status)
		}
		// A free court hour isn't handed over: staff use the code to book
		// the hour (walk-in with payment_method VOUCHER), which uses it up.
		var item model.RewardCatalogItem
		if err := tx.First(&item, "id = ?", v.RewardID).Error; err != nil {
			return err
		}
		if item.Kind == model.RewardKindFreeOffPeakHour {
			return fmt.Errorf("%w: %s is a free court hour - book the hour with it in the walk-in form", ErrInvalidState, code)
		}
		if err := tx.Model(&v).Updates(map[string]interface{}{
			"status": model.VoucherRedeemed, "dispensed_at": now, "dispensed_by": staffID,
		}).Error; err != nil {
			return err
		}
		return tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: staffID, UserName: staffName, Action: "VOUCHER_DISPENSED",
			TargetType: "Voucher", TargetID: v.ID,
			BeforeState: model.AuditJSON(map[string]any{"status": model.VoucherActive}),
			AfterState:  model.AuditJSON(map[string]any{"status": model.VoucherRedeemed, "code": code}),
			CreatedAt:   now,
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return s.Lookup(ctx, code)
}

// ExpireVouchers marks unclaimed vouchers past their date EXPIRED (the
// points are not returned). main runs it every minute.
func (s *RewardService) ExpireVouchers(ctx context.Context) (int64, error) {
	res := s.db.WithContext(ctx).Model(&model.Voucher{}).
		Where("status = ? AND expires_at < ?", model.VoucherActive, s.now()).
		Update("status", model.VoucherExpired)
	return res.RowsAffected, res.Error
}
