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
		return nil, errors.New("boundary check: order must contain at least one item")
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

			totalAmount += p.Price * float64(item.Qty)
		}

		// 2. Insert main Order record
		orderID := ids.New("ord")
		orderCode = fmt.Sprintf("REC-%05d", time.Now().Unix()%100000)

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
