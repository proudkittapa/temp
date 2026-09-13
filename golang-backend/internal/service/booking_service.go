package service

import (
	"context"
	"fmt"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/repository"
	"gorm.io/gorm"
)

type BookingService struct {
	db             *gorm.DB
	bkRepo         *repository.BookingRepository
	usrRepo        *repository.UserRepository
	courtRepo      *repository.CourtRepository
	priceEngine    *PriceEngineService
	paymentService *PaymentService
}

func NewBookingService(
	db *gorm.DB,
	bkRepo *repository.BookingRepository,
	usrRepo *repository.UserRepository,
	courtRepo *repository.CourtRepository,
	priceEngine *PriceEngineService,
	paymentService *PaymentService,
) *BookingService {
	return &BookingService{
		db:             db,
		bkRepo:         bkRepo,
		usrRepo:        usrRepo,
		courtRepo:      courtRepo,
		priceEngine:    priceEngine,
		paymentService: paymentService,
	}
}

type CreateBookingInput struct {
	CourtID       string `json:"court_id"`
	Date          string `json:"date"`
	StartTime     string `json:"start_time"`
	EndTime       string `json:"end_time"`
	IsHalfCourt   bool   `json:"is_half_court"`
	HalfCourtSide string `json:"half_court_side"`
	Notes         string `json:"notes"`
	UserID        string `json:"user_id"`
}

type CreateBookingResult struct {
	BookingID        string  `json:"booking_id"`
	BookingCode      string  `json:"booking_code"`
	TotalAmount      float64 `json:"total_amount"`
	PromptPayPayload string  `json:"promptpay_payload"`
}

// FetchSlotsForGantt delegates timeline searches directly to BookingRepository
func (s *BookingService) FetchSlotsForGantt(ctx context.Context, date string, cType model.CourtType) ([]model.Booking, error) {
	return s.bkRepo.FetchSlotsForGantt(ctx, date, cType)
}

// CreateNewBooking handles overlap check, pricing calculations, and payment row attachments
func (s *BookingService) CreateNewBooking(ctx context.Context, input CreateBookingInput) (*CreateBookingResult, error) {
	// 1. Identify court type to feed price engine rules
	var court model.Court
	if err := s.db.WithContext(ctx).First(&court, "id = ?", input.CourtID).Error; err != nil {
		return nil, fmt.Errorf("court lookup error: %w", err)
	}

	// 2. Compute pricing via PriceEngineService
	calculatedAmount, descPr, err := s.priceEngine.CalculatePrice(
		ctx,
		court.Type,
		input.Date,
		input.StartTime,
		input.EndTime,
		input.IsHalfCourt,
	)
	if err != nil {
		return nil, fmt.Errorf("pricing calculation failed: %w", err)
	}

	bookingID := "b-" + time.Now().Format("02150405")
	bookingCode := "BK-" + time.Now().Format("150405")

	sideVal := input.HalfCourtSide
	if sideVal == "" {
		sideVal = "FULL"
	}

	// 3. Serialize and perform overlap block checking atomically
	err = s.bkRepo.CheckAndBlockOverlap(
		ctx,
		input.CourtID,
		input.Date,
		input.StartTime,
		input.EndTime,
		input.IsHalfCourt,
		sideVal,
		func(tx *gorm.DB) error {
			var notesVal *string
			if input.Notes != "" {
				notesVal = &input.Notes
			}

			b := model.Booking{
				ID:            bookingID,
				BookingCode:   bookingCode,
				CourtID:       input.CourtID,
				UserID:        input.UserID,
				Date:          input.Date,
				StartTime:     input.StartTime,
				EndTime:       input.EndTime,
				IsHalfCourt:   input.IsHalfCourt,
				HalfCourtSide: &sideVal,
				PriceType:     descPr,
				TotalAmount:   calculatedAmount,
				Status:        model.BookingPendingPayment,
				Notes:         notesVal,
				CreatedBy:     input.UserID,
				CreatedAt:     time.Now(),
				UpdatedAt:     time.Now(),
			}

			if err := tx.Create(&b).Error; err != nil {
				return err
			}

			// Generate EMVCo Dynamic QR Payload containing billing details
			qrString := s.paymentService.CreatePromptPayPayload("0811112222", calculatedAmount)

			pay := model.Payment{
				ID:        "pay-" + time.Now().Format("02150405"),
				BookingID: bookingID,
				Amount:    calculatedAmount,
				Method:    model.PaymentPromptPay,
				Status:    model.PaymentPending,
				QrPayload: &qrString,
				CreatedAt: time.Now(),
				UpdatedAt: time.Now(),
			}

			return tx.Create(&pay).Error
		},
	)

	if err != nil {
		return nil, err
	}

	promptPayQR := s.paymentService.CreatePromptPayPayload("0811112222", calculatedAmount)

	return &CreateBookingResult{
		BookingID:        bookingID,
		BookingCode:      bookingCode,
		TotalAmount:      calculatedAmount,
		PromptPayPayload: promptPayQR,
	}, nil
}
