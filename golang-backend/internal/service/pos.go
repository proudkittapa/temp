package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type POSOrderItemInput struct {
	ProductID  string  `json:"product_id"`
	Qty        int     `json:"qty"`
	ShoeSize   *string `json:"shoe_size,omitempty"`
	ShoeGender *string `json:"shoe_gender,omitempty"` // "M", "F", "U"
	Notes      *string `json:"notes,omitempty"`       // e.g., "Racket string tension: 24lbs"
}

type CheckoutInput struct {
	UserID       *string             `json:"user_id,omitempty"` // populated if registered member
	CustomerName string              `json:"customer_name"`
	CourtID      *string             `json:"court_id,omitempty"` // populated if linking snacks to physical courts
	Type         model.OrderType     `json:"type"`               // "FB", "EQUIPMENT_RENT", "EQUIPMENT_SALE"
	PaymentMeth  model.PaymentMethod `json:"payment_method"`
	Items        []POSOrderItemInput `json:"items"`
	CreatedBy    string              `json:"created_by"` // Cashier staff member ID
}

type CheckoutResult struct {
	OrderCode    string  `json:"order_code"`
	TotalAmount  float64 `json:"total_amount"`
	PointsEarned int     `json:"points_earned"`
}

// MaxPOSLineQty caps one order line, so a typo can't empty the stock.
const MaxPOSLineQty = 100

// uniqueOrderCode picks a receipt code ("REC20261020-7F3A9C") no order uses.
func uniqueOrderCode(tx *gorm.DB, date string) (string, error) {
	for i := 0; i < 5; i++ {
		code := ids.Code("REC", date)
		var n int64
		if err := tx.Model(&model.Order{}).Where("order_code = ?", code).Count(&n).Error; err != nil {
			return "", err
		}
		if n == 0 {
			return code, nil
		}
	}
	return "", errors.New("could not allocate a unique receipt code, please retry")
}

type POSService struct {
	db      *gorm.DB
	usrRepo *repository.UserRepository
}

func NewPOSService(db *gorm.DB, usrRepo *repository.UserRepository) *POSService {
	return &POSService{db: db, usrRepo: usrRepo}
}

// ProcessCheckout performs thread-safe inventory decrements and registers receipt transactions.
func (s *POSService) ProcessCheckout(ctx context.Context, input CheckoutInput) (*CheckoutResult, error) {
	if len(input.Items) == 0 {
		return nil, fmt.Errorf("%w: order must contain at least one item", ErrInvalidBooking)
	}
	// A zero or negative quantity used to be accepted: it added stock back
	// and recorded a negative sale (and could cancel out a real line).
	for _, item := range input.Items {
		if item.Qty < 1 || item.Qty > MaxPOSLineQty {
			return nil, fmt.Errorf("%w: quantity for %s must be between 1 and %d", ErrInvalidBooking, item.ProductID, MaxPOSLineQty)
		}
	}
	switch input.Type {
	case model.OrderFB, model.OrderEquipmentRent, model.OrderEquipmentSale:
	default:
		return nil, fmt.Errorf("%w: type must be FB, EQUIPMENT_RENT or EQUIPMENT_SALE", ErrInvalidBooking)
	}
	if input.PaymentMeth != model.PaymentCash && input.PaymentMeth != model.PaymentPromptPay {
		return nil, fmt.Errorf("%w: payment_method must be CASH or PROMPTPAY", ErrInvalidBooking)
	}

	var totalAmount float64 = 0.0
	var orderCode string
	var pointsGranted int

	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1. Walk through items, lock product records, verify stock limits
		for _, item := range input.Items {
			var p model.Product
			// SELECT FOR UPDATE
			err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&p, "id = ?", item.ProductID).Error
			if err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return fmt.Errorf("transaction abort: product %s does not exist", item.ProductID)
				}
				return err
			}

			if !p.IsActive {
				return fmt.Errorf("transaction abort: inventory item %s is labeled inactive", item.ProductID)
			}

			// Enforce inventory stock caps
			if p.Stock < item.Qty {
				return fmt.Errorf("transaction abort: product %s stock insufficient (requested %d, available %d)", item.ProductID, item.Qty, p.Stock)
			}

			// Decrement product warehouse ledger
			p.Stock -= item.Qty
			if err := tx.Save(&p).Error; err != nil {
				return fmt.Errorf("failed to decrement product stock: %w", err)
			}

			totalAmount = RoundBaht(totalAmount + p.Price*float64(item.Qty))
		}

		// 2. Insert main Order record. The code used to be the Unix time
		// mod 100000 - repeating every ~28 hours and for two sales in the
		// same second; now it is random and checked for uniqueness, like
		// booking codes.
		orderID := ids.New("ord")
		var err error
		if orderCode, err = uniqueOrderCode(tx, time.Now().In(Bangkok).Format("2006-01-02")); err != nil {
			return err
		}

		ordModel := model.Order{
			ID:            orderID,
			OrderCode:     orderCode,
			UserID:        input.UserID,
			CustomerName:  input.CustomerName,
			CourtID:       input.CourtID,
			Type:          input.Type,
			Status:        model.OrderDelivered, // direct delivered on checkout
			TotalAmount:   totalAmount,
			PaidAmount:    totalAmount,
			PaymentMethod: input.PaymentMeth,
			CreatedBy:     input.CreatedBy,
			CreatedAt:     time.Now(),
		}

		if err := tx.Create(&ordModel).Error; err != nil {
			return fmt.Errorf("failed to log receipt: %w", err)
		}

		// 3. Write individual line items (including sizing details, shoe standards, and tension attributes)
		for _, item := range input.Items {
			itemID := ids.New("itm")

			var p model.Product
			if err := tx.First(&p, "id = ?", item.ProductID).Error; err != nil {
				return err
			}

			itemModel := model.OrderItem{
				ID:         itemID,
				OrderID:    orderID,
				ProductID:  item.ProductID,
				Qty:        item.Qty,
				UnitPrice:  p.Price,
				ShoeSize:   item.ShoeSize,
				ShoeGender: item.ShoeGender,
				Notes:      item.Notes,
			}

			if err := tx.Create(&itemModel).Error; err != nil {
				return fmt.Errorf("failed to store order line items: %w", err)
			}
		}

		// 4. Update core loyalty card: 100 THB spent earns +1 membership loyalty
		// point (FR-4.1), credited through AddPointsEntry so it lands in
		// points_ledger (LedgerEarnPurchase) rather than mutating u.Points
		// directly - the same primitive UserRepository.UpdatePoints uses for
		// admin overrides, so every points-earning path is equally auditable.
		pointsGranted = 0
		if input.UserID != nil && *input.UserID != "" && totalAmount >= 100.0 {
			pointsGranted = int(totalAmount / 100.0)

			refType := "Order"
			note := fmt.Sprintf("Purchase of %.2f THB (order %s)", totalAmount, orderCode)
			if _, err := s.usrRepo.AddPointsEntry(ctx, tx, *input.UserID, model.LedgerEarnPurchase, pointsGranted, "system", &refType, &orderID, &note); err != nil {
				return fmt.Errorf("failed to credit loyalty points: %w", err)
			}
		}

		return nil
	})

	if err != nil {
		return nil, err
	}

	return &CheckoutResult{
		OrderCode:    orderCode,
		TotalAmount:  totalAmount,
		PointsEarned: pointsGranted,
	}, nil
}
