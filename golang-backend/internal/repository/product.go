package repository

import (
	"context"
	"fmt"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type ProductRepository struct {
	db *gorm.DB
}

func NewProductRepository(db *gorm.DB) *ProductRepository {
	return &ProductRepository{db: db}
}

// FetchAll lists active accessories, refreshments, or gear hire options.
func (r *ProductRepository) FetchAll(ctx context.Context, categoryFilter string, rentalsOnly bool) ([]model.Product, error) {
	var products []model.Product
	query := r.db.WithContext(ctx).Where("is_active = ?", true)

	if categoryFilter != "" {
		query = query.Where("category = ?", categoryFilter)
	}

	if rentalsOnly {
		query = query.Where("is_rental = ?", true)
	}

	err := query.Order("category DESC, name ASC").Find(&products).Error
	if err != nil {
		return nil, fmt.Errorf("failed to fetch product lists: %w", err)
	}
	return products, nil
}

// ReturnRentalItem updates gear inventories when rented athletic shoes/stringed rackets are returned safely.
func (r *ProductRepository) ReturnRentalItem(ctx context.Context, orderItemID string, returnedByStaff string) error {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1. Identify product reference inside order items
		var item model.OrderItem
		// SELECT FOR UPDATE
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&item, "id = ?", orderItemID).Error
		if err != nil {
			return fmt.Errorf("order item not found or unavailable: %w", err)
		}

		if item.ReturnedAt != nil {
			return fmt.Errorf("transaction cancelled: this lease unit was already returned on %s", item.ReturnedAt.Format("2006-01-02 15:04"))
		}

		// 2. Refresh return timestamps of order items line row
		now := time.Now()
		item.ReturnedAt = &now
		if err := tx.Save(&item).Error; err != nil {
			return fmt.Errorf("failed to write return updates: %w", err)
		}

		// 3. Replenish target gear inventory unit
		err = tx.Model(&model.Product{}).Where("id = ?", item.ProductID).Update("stock", gorm.Expr("stock + ?", item.Qty)).Error
		if err != nil {
			return fmt.Errorf("failed to restore stock registers: %w", err)
		}

		// 4. Trace the operation to admin's security dashboard logs
		logID := ids.New("log")
		auditMsg := model.AuditJSON(map[string]any{"order_item_id": orderItemID, "returned_qty": item.Qty})
		auditLog := model.AuditLog{
			ID:         logID,
			UserID:     returnedByStaff,
			UserName:   returnedByStaff,
			Action:     "RENTAL_RETURN_SUCCESS",
			TargetType: "OrderItem",
			TargetID:   item.OrderID,
			AfterState: auditMsg,
			CreatedAt:  time.Now(),
		}
		if err := tx.Create(&auditLog).Error; err != nil {
			return fmt.Errorf("failed to log return audit trail: %w", err)
		}

		return nil
	})

	return err
}
