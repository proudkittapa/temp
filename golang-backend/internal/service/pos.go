package service

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"arena-backend/internal/repository"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// The counter's shop (FR-5.2/5.3): F&B and equipment sales, racket/shoe
// rentals and their returns, and the product catalog with its stock. All
// of it lives in the database so every counter sees the same stock and the
// cash drawer counts every sale.

type POSOrderItemInput struct {
	ProductID string  `json:"product_id"`
	VariantID *string `json:"variant_id,omitempty"` // required for a product with variants (shoe size/gender)
	Qty       int     `json:"qty"`
	Notes     *string `json:"notes,omitempty"` // e.g., "Racket string tension: 24lbs"
}

type CheckoutInput struct {
	// CustomerPhone credits a registered customer with the purchase points
	// (FR-4.1); unknown numbers are a plain walk-in sale.
	CustomerPhone string              `json:"customer_phone,omitempty"`
	CustomerName  string              `json:"customer_name"`
	CourtID       *string             `json:"court_id,omitempty"` // populated if linking snacks to physical courts
	Type          model.OrderType     `json:"type"`               // "FB", "EQUIPMENT_RENT", "EQUIPMENT_SALE"
	PaymentMeth   model.PaymentMethod `json:"payment_method"`
	Items         []POSOrderItemInput `json:"items"`
	// IdempotencyKey identifies one checkout attempt (the client sends a
	// fresh random id per submit): the same key again returns the order
	// already made instead of selling a second time.
	IdempotencyKey string `json:"idempotency_key,omitempty"`
	CreatedBy      string `json:"-"` // the signed-in staff member
	CreatedByName  string `json:"-"`
}

type CheckoutResult struct {
	Order        OrderView `json:"order"`
	PointsEarned int       `json:"points_earned"`
	// Replayed: this key was seen before - the original order is returned
	// and nothing was sold again.
	Replayed bool `json:"replayed,omitempty"`
}

// MaxIdempotencyKeyLen bounds the client's checkout key.
const MaxIdempotencyKeyLen = 64

// OrderView is an order with its lines, each line carrying the product
// name for receipts and lists.
type OrderView struct {
	model.Order
	Items []OrderItemView `json:"items"`
	// The staff member who made the sale (for the receipt's cashier line).
	CreatedByName string `json:"created_by_name,omitempty"`
	// Void only: rewards cancelled because their points came from this sale.
	CancelledVouchers []string `json:"cancelled_vouchers,omitempty"`
}

type OrderItemView struct {
	model.OrderItem
	ProductName string `json:"product_name"`
}

// ProductView is a product with its variants (shoe sizes).
type ProductView struct {
	model.Product
	Variants []model.ProductVariant `json:"variants,omitempty"`
}

// ErrOutOfStock: not enough of a product (or shoe size) left for the order.
var ErrOutOfStock = errors.New("out of stock")

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
	return "", ErrBusy
}

type POSService struct {
	db      *gorm.DB
	usrRepo *repository.UserRepository
	now     func() time.Time
}

func NewPOSService(db *gorm.DB, usrRepo *repository.UserRepository) *POSService {
	return &POSService{db: db, usrRepo: usrRepo, now: time.Now}
}

// ---- catalog ----

// ListProducts returns the catalog with variants; inactive products only
// when includeInactive (the admin product list).
func (s *POSService) ListProducts(ctx context.Context, includeInactive bool) ([]ProductView, error) {
	db := s.db.WithContext(ctx)
	q := db.Order("category DESC, name ASC")
	if !includeInactive {
		q = q.Where("is_active = ?", true)
	}
	var products []model.Product
	if err := q.Find(&products).Error; err != nil {
		return nil, err
	}
	return s.withVariants(db, products)
}

func (s *POSService) withVariants(db *gorm.DB, products []model.Product) ([]ProductView, error) {
	idList := make([]string, len(products))
	for i, p := range products {
		idList[i] = p.ID
	}
	var variants []model.ProductVariant
	if len(idList) > 0 {
		if err := db.Where("product_id IN ?", idList).Order("gender, label").Find(&variants).Error; err != nil {
			return nil, err
		}
	}
	byProduct := map[string][]model.ProductVariant{}
	for _, v := range variants {
		byProduct[v.ProductID] = append(byProduct[v.ProductID], v)
	}
	out := make([]ProductView, len(products))
	for i, p := range products {
		out[i] = ProductView{Product: p, Variants: byProduct[p.ID]}
	}
	return out, nil
}

// ProductInput creates or edits a catalog item (manager/admin).
type ProductInput struct {
	Name        string           `json:"name"`
	Category    model.ProductCat `json:"category"`
	SubCategory *string          `json:"sub_category,omitempty"`
	Price       float64          `json:"price"`
	IsRental    bool             `json:"is_rental"`
	Deposit     float64          `json:"deposit"` // rental products only
	Stock       int              `json:"stock"`   // initial stock (create only; use AdjustStock afterwards)
	IsActive    *bool            `json:"is_active,omitempty"`
}

func (in *ProductInput) validate() error {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 200 {
		return fmt.Errorf("%w: product name is required (max 200 characters)", ErrInvalidBooking)
	}
	if in.Category != model.ProductFB && in.Category != model.ProductEquipment {
		return fmt.Errorf("%w: category must be FB or EQUIPMENT", ErrInvalidBooking)
	}
	if in.Price < 0 || in.Price > 100000 {
		return fmt.Errorf("%w: price must be between 0 and 100000", ErrInvalidBooking)
	}
	if in.Stock < 0 || in.Stock > 100000 {
		return fmt.Errorf("%w: stock must be between 0 and 100000", ErrInvalidBooking)
	}
	if in.Deposit < 0 || in.Deposit > 100000 {
		return fmt.Errorf("%w: deposit must be between 0 and 100000", ErrInvalidBooking)
	}
	if !in.IsRental {
		in.Deposit = 0
	}
	in.Price, in.Deposit = RoundBaht(in.Price), RoundBaht(in.Deposit)
	return nil
}

// CreateProducts adds catalog items (one from the form, many from an Excel
// import) in one transaction, audited.
func (s *POSService) CreateProducts(ctx context.Context, inputs []ProductInput, actorID, actorName string) ([]model.Product, error) {
	if len(inputs) == 0 || len(inputs) > 500 {
		return nil, fmt.Errorf("%w: send between 1 and 500 products", ErrInvalidBooking)
	}
	for i := range inputs {
		if err := inputs[i].validate(); err != nil {
			return nil, fmt.Errorf("row %d: %w", i+1, err)
		}
	}
	out := make([]model.Product, 0, len(inputs))
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		out = out[:0] // a retried attempt starts over
		now := s.now()
		for _, in := range inputs {
			p := model.Product{
				ID: ids.New("prd"), Name: in.Name, Category: in.Category, SubCategory: in.SubCategory,
				Price: in.Price, IsRental: in.IsRental, Deposit: in.Deposit, Stock: in.Stock, IsActive: true, CreatedAt: now,
			}
			if in.IsActive != nil {
				p.IsActive = *in.IsActive
			}
			if err := tx.Create(&p).Error; err != nil {
				return err
			}
			if err := tx.Create(&model.AuditLog{
				ID: ids.New("log"), UserID: actorID, UserName: actorName, Action: "PRODUCT_CREATED",
				TargetType: "Product", TargetID: p.ID, AfterState: model.AuditJSON(p), CreatedAt: now,
			}).Error; err != nil {
				return err
			}
			out = append(out, p)
		}
		return nil
	})
	return out, err
}

// UpdateProduct edits name/price/category/active. Stock changes go through
// AdjustStock so each one has a reason in the audit log.
func (s *POSService) UpdateProduct(ctx context.Context, id string, in ProductInput, actorID, actorName string) (*model.Product, error) {
	if err := in.validate(); err != nil {
		return nil, err
	}
	var p model.Product
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&p, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		before := p
		p.Name, p.Category, p.SubCategory, p.Price, p.IsRental, p.Deposit = in.Name, in.Category, in.SubCategory, in.Price, in.IsRental, in.Deposit
		if in.IsActive != nil {
			p.IsActive = *in.IsActive
		}
		if err := tx.Save(&p).Error; err != nil {
			return err
		}
		return tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: actorID, UserName: actorName, Action: "PRODUCT_UPDATED",
			TargetType: "Product", TargetID: p.ID, BeforeState: model.AuditJSON(before), AfterState: model.AuditJSON(p), CreatedAt: s.now(),
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// AdjustStock adds (restock) or removes (count correction, breakage) stock
// of a product or one of its variants. Stock never goes below zero. A
// variant product's own stock is kept as the sum of its variants.
func (s *POSService) AdjustStock(ctx context.Context, productID string, variantID *string, delta int, reason, actorID, actorName string) (*ProductView, error) {
	reason = strings.TrimSpace(reason)
	if delta == 0 || delta < -100000 || delta > 100000 {
		return nil, fmt.Errorf("%w: delta must be a non-zero number of units", ErrInvalidBooking)
	}
	if reason == "" {
		return nil, fmt.Errorf("%w: a reason is required for a stock change", ErrInvalidBooking)
	}
	var view *ProductView
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		var p model.Product
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&p, "id = ?", productID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		var variantCount int64
		if err := tx.Model(&model.ProductVariant{}).Where("product_id = ?", p.ID).Count(&variantCount).Error; err != nil {
			return err
		}
		before := map[string]any{"stock": p.Stock}
		after := map[string]any{}
		if variantCount > 0 {
			if variantID == nil || *variantID == "" {
				return fmt.Errorf("%w: %s is stocked per size - choose the size to adjust", ErrInvalidBooking, p.Name)
			}
			var v model.ProductVariant
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&v, "id = ? AND product_id = ?", *variantID, p.ID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrNotFound
				}
				return err
			}
			before["variant"], before["variant_stock"] = v.ID, v.Stock
			if v.Stock+delta < 0 {
				return fmt.Errorf("%w: only %d left of %s size %s", ErrInvalidBooking, v.Stock, p.Name, v.Label)
			}
			if err := tx.Model(&v).Update("stock", v.Stock+delta).Error; err != nil {
				return err
			}
			after["variant"], after["variant_stock"] = v.ID, v.Stock+delta
		} else if p.Stock+delta < 0 {
			return fmt.Errorf("%w: only %d of %s in stock", ErrInvalidBooking, p.Stock, p.Name)
		}
		p.Stock += delta
		if err := tx.Model(&p).Update("stock", p.Stock).Error; err != nil {
			return err
		}
		after["stock"] = p.Stock
		if err := tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: actorID, UserName: actorName, Action: "PRODUCT_STOCK_ADJUSTED",
			TargetType: "Product", TargetID: p.ID, BeforeState: model.AuditJSON(before), AfterState: model.AuditJSON(after),
			Reason: &reason, CreatedAt: s.now(),
		}).Error; err != nil {
			return err
		}
		views, err := s.withVariants(tx, []model.Product{p})
		if err != nil {
			return err
		}
		view = &views[0]
		return nil
	})
	return view, err
}

// ---- sales and rentals ----

// ProcessCheckout sells or rents out the items: prices come from the
// catalog (never from the client), stock is locked and decremented in the
// same transaction, a registered customer earns 1 point per 100 THB
// (FR-4.1). A rental stays open (PREPARING) until every item is returned.
// With an idempotency key, a repeat of the same checkout (double submit,
// network retry) returns the first order instead of selling again.
func (s *POSService) ProcessCheckout(ctx context.Context, input CheckoutInput) (*CheckoutResult, error) {
	if len(input.Items) == 0 || len(input.Items) > 50 {
		return nil, fmt.Errorf("%w: an order needs between 1 and 50 lines", ErrInvalidBooking)
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
	input.CustomerName = strings.TrimSpace(input.CustomerName)
	if len(input.CustomerName) > 200 {
		return nil, fmt.Errorf("%w: customer name is too long", ErrInvalidBooking)
	}
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	if len(input.IdempotencyKey) > MaxIdempotencyKeyLen {
		return nil, fmt.Errorf("%w: idempotency_key must be at most %d characters", ErrInvalidBooking, MaxIdempotencyKeyLen)
	}
	if res, err := s.replayCheckout(ctx, input.IdempotencyKey); err != nil || res != nil {
		return res, err
	}

	var customer *model.User
	if strings.TrimSpace(input.CustomerPhone) != "" {
		u, err := s.usrRepo.GetByPhone(ctx, input.CustomerPhone)
		if err != nil {
			return nil, err
		}
		if u != nil && u.Role == model.RoleCustomer && u.IsActive {
			customer = u
		}
	}
	// A member's name comes from their account, whatever was typed.
	if customer != nil {
		input.CustomerName = customer.Name
	} else if input.CustomerName == "" {
		input.CustomerName = "ลูกค้าทั่วไป (Walk-in)"
	}

	// A unique violation means either the same key raced in from another
	// request (return that order) or a receipt-code collision (try again).
	for attempt := 0; ; attempt++ {
		result, err := s.checkoutTx(ctx, input, customer)
		if err == nil || !repository.IsUniqueViolation(err) {
			return result, err
		}
		if res, rerr := s.replayCheckout(ctx, input.IdempotencyKey); rerr != nil || res != nil {
			return res, rerr
		}
		if attempt == 2 {
			return nil, ErrBusy
		}
	}
}

// replayCheckout returns the order already made with this idempotency key,
// or nil if there is none (or no key).
func (s *POSService) replayCheckout(ctx context.Context, key string) (*CheckoutResult, error) {
	if key == "" {
		return nil, nil
	}
	db := s.db.WithContext(ctx)
	var order model.Order
	err := db.Where("idempotency_key = ?", key).Take(&order).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var points int64
	if err := db.Model(&model.PointsLedgerEntry{}).Select("COALESCE(SUM(points), 0)").
		Where("ref_type = ? AND ref_id = ? AND type = ?", "Order", order.ID, model.LedgerEarnPurchase).Scan(&points).Error; err != nil {
		return nil, err
	}
	views, err := s.views(db, []model.Order{order})
	if err != nil {
		return nil, err
	}
	return &CheckoutResult{Order: views[0], PointsEarned: int(points), Replayed: true}, nil
}

// lineLockKey orders product/variant row locks the same way in every
// checkout, so two carts holding the same items in a different order can't
// deadlock.
// coverPointsWithRewards gets u (locked by the caller) up to need points
// before points are taken back: if the customer already spent them, their
// unused rewards are cancelled, newest first, and those rewards' points
// returned (owner decision 2026-10-21). It returns the cancelled voucher
// codes and how many points are still missing - spent on rewards already
// handed over, which can't be taken back.
func coverPointsWithRewards(ctx context.Context, tx *gorm.DB, usrRepo *repository.UserRepository, u *model.User, need int, actorID, why string) ([]string, int, error) {
	short := need - u.Points
	if short <= 0 {
		return nil, 0, nil
	}
	var active []model.Voucher
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("user_id = ? AND status = ?", u.ID, model.VoucherActive).
		Order("created_at DESC").Find(&active).Error; err != nil {
		return nil, 0, err
	}
	var codes []string
	for _, v := range active {
		if short <= 0 {
			break
		}
		if err := tx.Model(&model.Voucher{}).Where("id = ? AND status = ?", v.ID, model.VoucherActive).
			Update("status", model.VoucherCancelled).Error; err != nil {
			return nil, 0, err
		}
		refType, note := "Voucher", fmt.Sprintf("Voucher %s cancelled: %s", v.Code, why)
		if _, err := usrRepo.AddPointsEntry(ctx, tx, u.ID, model.LedgerVoucherCancelled, v.PointsSpent, actorID, &refType, &v.ID, &note); err != nil {
			return nil, 0, err
		}
		u.Points += v.PointsSpent
		short -= v.PointsSpent
		codes = append(codes, v.Code)
	}
	if short < 0 {
		short = 0
	}
	return codes, short, nil
}

// itemLockKey is lineLockKey for a saved order line.
func itemLockKey(l model.OrderItem) string {
	return lineLockKey(POSOrderItemInput{ProductID: l.ProductID, VariantID: l.VariantID})
}

func lineLockKey(in POSOrderItemInput) string {
	if in.VariantID != nil {
		return in.ProductID + "|" + *in.VariantID
	}
	return in.ProductID + "|"
}

func (s *POSService) checkoutTx(ctx context.Context, input CheckoutInput, customer *model.User) (*CheckoutResult, error) {
	var result *CheckoutResult
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		// Lock order everywhere: customer, then the cash drawer, then stock
		// rows (bookings take the customer before the drawer too).
		if customer != nil {
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("id").First(&model.User{}, "id = ?", customer.ID).Error; err != nil {
				return err
			}
		}
		// Cash into the drawer: needs an open shift, and waits for a shift
		// close in progress before taking the time, so the sale lands in
		// exactly one shift.
		if input.PaymentMeth == model.PaymentCash {
			if err := lockDrawerForCash(tx); err != nil {
				return err
			}
		}
		// Take every stock row lock up front, in a fixed order; the lines
		// are then processed in the cart's order (re-locking is a no-op).
		sorted := append([]POSOrderItemInput(nil), input.Items...)
		sort.Slice(sorted, func(i, j int) bool { return lineLockKey(sorted[i]) < lineLockKey(sorted[j]) })
		for _, in := range sorted {
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("id").Where("id = ?", in.ProductID).Find(&[]model.Product{}).Error; err != nil {
				return err
			}
			if in.VariantID != nil && *in.VariantID != "" {
				if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("id").Where("id = ?", *in.VariantID).Find(&[]model.ProductVariant{}).Error; err != nil {
					return err
				}
			}
		}
		now := s.now()
		orderID := ids.New("ord")
		total, deposit := 0.0, 0.0
		items := make([]OrderItemView, 0, len(input.Items))
		for _, in := range input.Items {
			var p model.Product
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&p, "id = ?", in.ProductID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return fmt.Errorf("%w: product %s does not exist", ErrInvalidBooking, in.ProductID)
				}
				return err
			}
			if !p.IsActive {
				return fmt.Errorf("%w: %s is not on sale", ErrInvalidBooking, p.Name)
			}
			// Rentals come back to stock, sales don't - so an order is one or
			// the other.
			if (input.Type == model.OrderEquipmentRent) != p.IsRental {
				if p.IsRental {
					return fmt.Errorf("%w: %s is a rental item - use the rental form", ErrInvalidBooking, p.Name)
				}
				return fmt.Errorf("%w: %s is for sale, not rental", ErrInvalidBooking, p.Name)
			}
			var variants []model.ProductVariant
			if err := tx.Where("product_id = ?", p.ID).Find(&variants).Error; err != nil {
				return err
			}
			category, isRental := p.Category, p.IsRental
			line := model.OrderItem{ID: ids.New("itm"), OrderID: orderID, ProductID: p.ID, Qty: in.Qty, UnitPrice: p.Price, Notes: in.Notes,
				Category: &category, IsRental: &isRental}
			if len(variants) > 0 {
				if in.VariantID == nil || *in.VariantID == "" {
					return fmt.Errorf("%w: choose the size of %s", ErrInvalidBooking, p.Name)
				}
				var v model.ProductVariant
				if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&v, "id = ? AND product_id = ?", *in.VariantID, p.ID).Error; err != nil {
					if errors.Is(err, gorm.ErrRecordNotFound) {
						return fmt.Errorf("%w: unknown size for %s", ErrInvalidBooking, p.Name)
					}
					return err
				}
				if v.Stock < in.Qty {
					return fmt.Errorf("%w: %s size %s: only %d left", ErrOutOfStock, p.Name, v.Label, v.Stock)
				}
				if err := tx.Model(&v).Update("stock", v.Stock-in.Qty).Error; err != nil {
					return err
				}
				line.VariantID, line.ShoeSize, line.ShoeGender = &v.ID, &v.Label, v.Gender
			} else if in.VariantID != nil && *in.VariantID != "" {
				return fmt.Errorf("%w: %s has no sizes", ErrInvalidBooking, p.Name)
			}
			if p.Stock < in.Qty {
				return fmt.Errorf("%w: %s: only %d in stock", ErrOutOfStock, p.Name, p.Stock)
			}
			if err := tx.Model(&p).Update("stock", p.Stock-in.Qty).Error; err != nil {
				return err
			}
			if err := tx.Create(&line).Error; err != nil {
				return err
			}
			total = RoundBaht(total + p.Price*float64(in.Qty))
			if p.IsRental {
				deposit = RoundBaht(deposit + p.Deposit*float64(in.Qty))
			}
			items = append(items, OrderItemView{OrderItem: line, ProductName: p.Name})
		}

		code, err := uniqueOrderCode(tx, now.In(Bangkok).Format("2006-01-02"))
		if err != nil {
			return err
		}
		status := model.OrderDelivered
		if input.Type == model.OrderEquipmentRent {
			status = model.OrderPreparing // out on rent until returned
		}
		order := model.Order{
			ID: orderID, OrderCode: code, CustomerName: input.CustomerName, CourtID: input.CourtID,
			Type: input.Type, Status: status, TotalAmount: total, PaidAmount: total,
			PaymentMethod: input.PaymentMeth, CreatedBy: input.CreatedBy, CreatedAt: now,
			DepositAmount: deposit,
		}
		// The deposit is cash in the drawer (the drawer lock above was taken
		// for cash only).
		if deposit > 0 && input.PaymentMeth != model.PaymentCash {
			return fmt.Errorf("%w: a rental with a deposit is paid in cash", ErrInvalidBooking)
		}
		if input.IdempotencyKey != "" {
			key := input.IdempotencyKey
			order.IdempotencyKey = &key
		}
		if customer != nil {
			order.UserID = &customer.ID
		}
		if err := tx.Create(&order).Error; err != nil {
			return err
		}

		points := 0
		if customer != nil && total >= 100 {
			points = int(total / 100)
			refType, note := "Order", fmt.Sprintf("Purchase of %.2f THB (order %s)", total, code)
			if _, err := s.usrRepo.AddPointsEntry(ctx, tx, customer.ID, model.LedgerEarnPurchase, points, input.CreatedBy, &refType, &orderID, &note); err != nil {
				return fmt.Errorf("failed to credit loyalty points: %w", err)
			}
		}
		view := OrderView{Order: order, Items: items}
		if err := tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: input.CreatedBy, UserName: input.CreatedByName, Action: "ORDER_CREATED",
			TargetType: "Order", TargetID: orderID, AfterState: model.AuditJSON(view), CreatedAt: now,
		}).Error; err != nil {
			return err
		}
		result = &CheckoutResult{Order: view, PointsEarned: points}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// views loads the lines (with product names) of the given orders.
func (s *POSService) views(db *gorm.DB, orders []model.Order) ([]OrderView, error) {
	idList := make([]string, len(orders))
	for i, o := range orders {
		idList[i] = o.ID
	}
	var lines []model.OrderItem
	if len(idList) > 0 {
		if err := db.Where("order_id IN ?", idList).Order("id").Find(&lines).Error; err != nil {
			return nil, err
		}
	}
	// Names of just the products on these lines, not the whole catalog.
	names := map[string]string{}
	productIDs := make([]string, 0, len(lines))
	for _, l := range lines {
		if _, seen := names[l.ProductID]; !seen {
			names[l.ProductID] = ""
			productIDs = append(productIDs, l.ProductID)
		}
	}
	if len(productIDs) > 0 {
		var products []model.Product
		if err := db.Select("id, name").Where("id IN ?", productIDs).Find(&products).Error; err != nil {
			return nil, err
		}
		for _, p := range products {
			names[p.ID] = p.Name
		}
	}
	byOrder := map[string][]OrderItemView{}
	for _, l := range lines {
		byOrder[l.OrderID] = append(byOrder[l.OrderID], OrderItemView{OrderItem: l, ProductName: names[l.ProductID]})
	}
	// Who rang up each sale, for the receipt.
	staffNames := map[string]string{}
	staffIDs := make([]string, 0, len(orders))
	for _, o := range orders {
		if _, seen := staffNames[o.CreatedBy]; !seen && o.CreatedBy != "" {
			staffNames[o.CreatedBy] = ""
			staffIDs = append(staffIDs, o.CreatedBy)
		}
	}
	if len(staffIDs) > 0 {
		var staff []model.User
		if err := db.Select("id, name").Where("id IN ?", staffIDs).Find(&staff).Error; err != nil {
			return nil, err
		}
		for _, u := range staff {
			staffNames[u.ID] = u.Name
		}
	}
	out := make([]OrderView, len(orders))
	for i, o := range orders {
		out[i] = OrderView{Order: o, Items: byOrder[o.ID], CreatedByName: staffNames[o.CreatedBy]}
		if out[i].Items == nil {
			out[i].Items = []OrderItemView{}
		}
	}
	return out, nil
}

// BangkokToday is today's date at the complex (YYYY-MM-DD).
func BangkokToday() string { return time.Now().In(Bangkok).Format("2006-01-02") }

// BangkokDay returns the [start, end) instants of a YYYY-MM-DD Bangkok day.
func BangkokDay(date string) (time.Time, time.Time, error) {
	day, err := time.ParseInLocation("2006-01-02", date, Bangkok)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("%w: date must be YYYY-MM-DD", ErrInvalidBooking)
	}
	return day, day.AddDate(0, 0, 1), nil
}

// ListOrders returns the orders made between from (inclusive) and to
// (exclusive), newest first; at most limit of them (0 = all, for exports).
func (s *POSService) ListOrders(ctx context.Context, from, to time.Time, limit int) ([]OrderView, error) {
	db := s.db.WithContext(ctx)
	q := db.Where("created_at >= ? AND created_at < ?", from, to).Order("created_at DESC")
	if limit > 0 {
		q = q.Limit(limit)
	}
	var orders []model.Order
	if err := q.Find(&orders).Error; err != nil {
		return nil, err
	}
	return s.views(db, orders)
}

// OrdersOnDate is ListOrders for one Bangkok day.
func (s *POSService) OrdersOnDate(ctx context.Context, date string) ([]OrderView, error) {
	from, to, err := BangkokDay(date)
	if err != nil {
		return nil, err
	}
	return s.ListOrders(ctx, from, to, 5000)
}

// ActiveRentals returns rental orders that still have items out, any day.
func (s *POSService) ActiveRentals(ctx context.Context) ([]OrderView, error) {
	db := s.db.WithContext(ctx)
	var orders []model.Order
	if err := db.Where("type = ? AND status = ?", model.OrderEquipmentRent, model.OrderPreparing).Order("created_at").Find(&orders).Error; err != nil {
		return nil, err
	}
	return s.views(db, orders)
}

// ReturnRentalItem puts a rented item back in stock (its size, for shoes)
// and closes the rental once every item is back. Returning twice fails.
// When that is the last item out and the rental has a deposit, the deposit
// is settled: keep (0..deposit, with a note) stays in the drawer for damage
// or loss, the rest is given back from the drawer (needs an open shift).
func (s *POSService) ReturnRentalItem(ctx context.Context, itemID string, keep float64, note, actorID, actorName string) (*OrderView, error) {
	note = strings.TrimSpace(note)
	keep = RoundBaht(keep)
	if keep < 0 || len(note) > 500 {
		return nil, fmt.Errorf("%w: invalid deposit amount or note", ErrInvalidBooking)
	}
	var view *OrderView
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		// Lock order: the order, then its item, then the drawer, then stock -
		// the same as VoidOrder (order -> items) and checkout (drawer ->
		// products), so a return racing a void or a sale can't deadlock.
		var item model.OrderItem
		if err := tx.First(&item, "id = ?", itemID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		var order model.Order
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&order, "id = ?", item.OrderID).Error; err != nil {
			return err
		}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&item, "id = ?", itemID).Error; err != nil {
			return err
		}
		if order.Type != model.OrderEquipmentRent {
			return fmt.Errorf("%w: %s is a sale, not a rental", ErrInvalidState, order.OrderCode)
		}
		// A voided rental was already put back in stock by the void.
		if order.Status == model.OrderCancelled {
			return fmt.Errorf("%w: %s was voided - its items are already back in stock", ErrInvalidState, order.OrderCode)
		}
		if item.ReturnedAt != nil {
			return fmt.Errorf("%w: already returned on %s", ErrInvalidState, item.ReturnedAt.In(Bangkok).Format("2006-01-02 15:04"))
		}
		// Is this the last item out? Then it settles the deposit.
		var out int64
		if err := tx.Model(&model.OrderItem{}).Where("order_id = ? AND returned_at IS NULL AND id <> ?", order.ID, item.ID).Count(&out).Error; err != nil {
			return err
		}
		settle := out == 0 && order.DepositAmount > 0 && order.DepositSettledAt == nil
		if keep > 0 && !settle {
			return fmt.Errorf("%w: the deposit is settled when the last item comes back", ErrInvalidBooking)
		}
		back := 0.0
		if settle {
			if keep > order.DepositAmount {
				return fmt.Errorf("%w: at most %.2f THB of the deposit can be kept", ErrInvalidBooking, order.DepositAmount)
			}
			if keep > 0 && note == "" {
				return fmt.Errorf("%w: say why the deposit is kept", ErrInvalidBooking)
			}
			back = RoundBaht(order.DepositAmount - keep)
			// Cash out of the drawer: needs an open shift, and the time is
			// taken after the lock so it lands in exactly one shift.
			if back > 0 {
				if err := lockDrawerForCash(tx); err != nil {
					return err
				}
			}
		}
		now := s.now()
		if err := tx.Model(&item).Update("returned_at", now).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.Product{}).Where("id = ?", item.ProductID).Update("stock", gorm.Expr("stock + ?", item.Qty)).Error; err != nil {
			return err
		}
		if item.VariantID != nil {
			if err := tx.Model(&model.ProductVariant{}).Where("id = ?", *item.VariantID).Update("stock", gorm.Expr("stock + ?", item.Qty)).Error; err != nil {
				return err
			}
		}
		if out == 0 {
			if err := tx.Model(&model.Order{}).Where("id = ? AND status = ?", order.ID, model.OrderPreparing).Update("status", model.OrderDelivered).Error; err != nil {
				return err
			}
		}
		if settle {
			upd := map[string]any{"deposit_returned": back, "deposit_kept": keep, "deposit_settled_at": now}
			if note != "" {
				upd["deposit_note"] = note
			}
			if err := tx.Model(&model.Order{}).Where("id = ?", order.ID).Updates(upd).Error; err != nil {
				return err
			}
			order.DepositReturned, order.DepositKept, order.DepositSettledAt = back, keep, &now
			if note != "" {
				order.DepositNote = &note
			}
		}
		if err := tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: actorID, UserName: actorName, Action: "RENTAL_RETURNED",
			TargetType: "Order", TargetID: order.ID,
			BeforeState: model.AuditJSON(map[string]any{"item": item.ID, "returned": false}),
			AfterState: model.AuditJSON(map[string]any{"item": item.ID, "returned": true, "qty": item.Qty, "order_closed": out == 0,
				"deposit_returned": order.DepositReturned, "deposit_kept": order.DepositKept, "deposit_note": note}),
			CreatedAt: now,
		}).Error; err != nil {
			return err
		}
		views, err := s.views(tx, []model.Order{order})
		if err != nil {
			return err
		}
		if out == 0 {
			views[0].Status = model.OrderDelivered
		}
		view = &views[0]
		return nil
	})
	return view, err
}

// VoidOrder cancels a counter sale (managers): stock comes back (items
// still out on rent too), the purchase points are taken back (never below
// zero), and the order drops out of the drawer and reports. Only a sale
// from today (Bangkok) - an older one belongs to a closed day's count.
func (s *POSService) VoidOrder(ctx context.Context, orderID, reason, actorID, actorName string) (*OrderView, error) {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return nil, fmt.Errorf("%w: a reason is required to void a sale", ErrInvalidBooking)
	}
	var view *OrderView
	err := repository.RetryTx(s.db.WithContext(ctx), func(tx *gorm.DB) error {
		var order model.Order
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&order, "id = ?", orderID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}
		if order.Status == model.OrderCancelled {
			return fmt.Errorf("%w: %s is already voided", ErrInvalidState, order.OrderCode)
		}
		// Same lock order as a sale: customer, then the drawer. The drawer
		// lock (shared) makes a shift close wait for this void - or this
		// void wait for the close, and then see the shift as closed below.
		if order.UserID != nil {
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("id").Where("id = ?", *order.UserID).Find(&[]model.User{}).Error; err != nil {
				return err
			}
		}
		if order.PaymentMethod == model.PaymentCash {
			if err := lockDrawerShared(tx); err != nil {
				return err
			}
		}
		now := s.now()
		if order.CreatedAt.In(Bangkok).Format("2006-01-02") != now.In(Bangkok).Format("2006-01-02") {
			return fmt.Errorf("%w: only today's sales can be voided", ErrInvalidState)
		}
		// A cash sale from a shift already counted and closed: giving the
		// money back now would leave the current drawer short.
		if order.PaymentMethod == model.PaymentCash {
			var closed int64
			if err := tx.Model(&model.Shift{}).Where("closed_at IS NOT NULL AND opened_at <= ? AND closed_at > ?", order.CreatedAt, order.CreatedAt).Count(&closed).Error; err != nil {
				return err
			}
			if closed > 0 {
				return fmt.Errorf("%w: %s was paid in a shift that is already closed - it can't be voided now", ErrInvalidState, order.OrderCode)
			}
		}
		// Items locked (order -> items, as ReturnRentalItem) and restocked in
		// the order checkout locks stock in, so a void can't deadlock a sale.
		var lines []model.OrderItem
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("order_id = ?", order.ID).Order("id").Find(&lines).Error; err != nil {
			return err
		}
		sort.Slice(lines, func(i, j int) bool { return itemLockKey(lines[i]) < itemLockKey(lines[j]) })
		for _, l := range lines {
			if l.ReturnedAt != nil {
				continue // a returned rental item is already back in stock
			}
			// Restocked now: mark a rental line returned so it can't be
			// "returned" (restocked) again later.
			if order.Type == model.OrderEquipmentRent {
				if err := tx.Model(&model.OrderItem{}).Where("id = ?", l.ID).Update("returned_at", now).Error; err != nil {
					return err
				}
			}
			if err := tx.Model(&model.Product{}).Where("id = ?", l.ProductID).Update("stock", gorm.Expr("stock + ?", l.Qty)).Error; err != nil {
				return err
			}
			if l.VariantID != nil {
				if err := tx.Model(&model.ProductVariant{}).Where("id = ?", *l.VariantID).Update("stock", gorm.Expr("stock + ?", l.Qty)).Error; err != nil {
					return err
				}
			}
		}
		// A voided rental gives its deposit back (from the drawer, which this
		// void already holds).
		if order.DepositAmount > 0 && order.DepositSettledAt == nil {
			if err := tx.Model(&model.Order{}).Where("id = ?", order.ID).Updates(map[string]any{
				"deposit_returned": order.DepositAmount, "deposit_settled_at": now, "deposit_note": "voided",
			}).Error; err != nil {
				return err
			}
			voided := "voided"
			order.DepositReturned, order.DepositSettledAt, order.DepositNote = order.DepositAmount, &now, &voided
		}
		taken := 0
		var cancelledVouchers []string
		if order.UserID != nil {
			var earned int64
			if err := tx.Model(&model.PointsLedgerEntry{}).Select("COALESCE(SUM(points), 0)").
				Where("ref_type = ? AND ref_id = ?", "Order", order.ID).Scan(&earned).Error; err != nil {
				return err
			}
			if earned > 0 {
				var u model.User
				// Locked, so a redemption at the same moment can't make the
				// clamped reversal fail.
				if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&u, "id = ?", *order.UserID).Error; err != nil {
					return err
				}
				taken = int(earned)
				// Points already spent: unused rewards are cancelled to cover
				// them. A reward already handed over can't be taken back, so
				// then the sale can't be voided.
				codes, short, err := coverPointsWithRewards(ctx, tx, s.usrRepo, &u, taken, actorID, "sale "+order.OrderCode+" voided")
				if err != nil {
					return err
				}
				cancelledVouchers = codes
				if short > 0 {
					return fmt.Errorf("%w: the points from %s were already spent on a reward that was handed over - the sale can't be voided", ErrInvalidState, order.OrderCode)
				}
				if taken > 0 {
					refType, note := "Order", fmt.Sprintf("Sale %s voided: %s", order.OrderCode, reason)
					if _, err := s.usrRepo.AddPointsEntry(ctx, tx, u.ID, model.LedgerReversePurchase, -taken, actorID, &refType, &order.ID, &note); err != nil {
						return err
					}
				}
			}
		}
		before := order.Status
		if err := tx.Model(&order).Updates(map[string]interface{}{"status": model.OrderCancelled, "voided_at": now, "void_reason": reason}).Error; err != nil {
			return err
		}
		order.Status, order.VoidedAt, order.VoidReason = model.OrderCancelled, &now, &reason
		if err := tx.Create(&model.AuditLog{
			ID: ids.New("log"), UserID: actorID, UserName: actorName, Action: "ORDER_VOIDED", TargetType: "Order", TargetID: order.ID,
			BeforeState: model.AuditJSON(map[string]any{"status": before, "total": order.TotalAmount}),
			AfterState:  model.AuditJSON(map[string]any{"status": order.Status, "points_reversed": taken, "vouchers_cancelled": cancelledVouchers}),
			Reason:      &reason, CreatedAt: now,
		}).Error; err != nil {
			return err
		}
		views, err := s.views(tx, []model.Order{order})
		if err != nil {
			return err
		}
		view = &views[0]
		view.CancelledVouchers = cancelledVouchers
		return nil
	})
	return view, err
}

// saleKindSQL classifies an order line (aliases i = order_items, o =
// orders, p = products) as 'rental', 'equipment' or 'food' by what the
// product was when sold - the line's snapshot, or the product for rows
// from before snapshots. Takes two args: OrderEquipmentRent, ProductEquipment.
const saleKindSQL = "CASE WHEN o.type = ? OR COALESCE(i.is_rental, p.is_rental) THEN 'rental' " +
	"WHEN COALESCE(i.category, p.category) = ? THEN 'equipment' ELSE 'food' END"

// OrderTotals is the counter-sales part of the day's drawer report.
type OrderTotals struct {
	Cash           float64 `json:"orders_cash"`
	PromptPay      float64 `json:"orders_promptpay"`
	FB             float64 `json:"fb_sales"`
	EquipmentSales float64 `json:"equipment_sales"`
	Rentals        float64 `json:"rental_income"`
	Count          int64   `json:"orders_count"`
}

// TotalsBetween sums the non-cancelled orders made in [from, to): money by
// payment method (whole orders) and sales by what was sold (each line by its
// product: rental, equipment, or food & drink) - so a mixed cart is split
// correctly and agrees with the dashboard's sales split.
func (s *POSService) TotalsBetween(ctx context.Context, from, to time.Time) (*OrderTotals, error) {
	db := s.db.WithContext(ctx)
	var byMethod []struct {
		PaymentMethod model.PaymentMethod
		Total         float64
		N             int64
	}
	if err := db.Model(&model.Order{}).
		Select("payment_method, COALESCE(SUM(total_amount), 0) AS total, COUNT(*) AS n").
		Where("created_at >= ? AND created_at < ? AND status <> ?", from, to, model.OrderCancelled).
		Group("payment_method").Scan(&byMethod).Error; err != nil {
		return nil, err
	}
	var byKind []struct {
		Kind  string
		Total float64
	}
	// Each line by what the product was when sold (snapshot on the line;
	// rows from before the snapshot existed fall back to the product).
	if err := db.Raw("SELECT "+saleKindSQL+" AS kind, "+
		"COALESCE(SUM(i.qty * i.unit_price), 0) AS total FROM order_items i JOIN orders o ON o.id = i.order_id "+
		"LEFT JOIN products p ON p.id = i.product_id WHERE o.created_at >= ? AND o.created_at < ? AND o.status <> ? GROUP BY 1",
		model.OrderEquipmentRent, model.ProductEquipment, from, to, model.OrderCancelled).Scan(&byKind).Error; err != nil {
		return nil, err
	}
	t := &OrderTotals{}
	for _, r := range byMethod {
		switch r.PaymentMethod {
		case model.PaymentCash:
			t.Cash += r.Total
		case model.PaymentPromptPay:
			t.PromptPay += r.Total
		}
		t.Count += r.N
	}
	for _, r := range byKind {
		switch r.Kind {
		case "rental":
			t.Rentals += r.Total
		case "equipment":
			t.EquipmentSales += r.Total
		default:
			t.FB += r.Total
		}
	}
	t.Cash, t.PromptPay, t.FB, t.EquipmentSales, t.Rentals = RoundBaht(t.Cash), RoundBaht(t.PromptPay), RoundBaht(t.FB), RoundBaht(t.EquipmentSales), RoundBaht(t.Rentals)
	return t, nil
}
