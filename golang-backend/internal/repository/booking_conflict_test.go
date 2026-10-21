package repository

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestIsLiveSlotConflict(t *testing.T) {
	hit := fmt.Errorf("insert: %w", &pgconn.PgError{Code: "23505", ConstraintName: LiveSlotIndex})
	other := &pgconn.PgError{Code: "23505", ConstraintName: "idx_orders_order_code"}
	if !IsLiveSlotConflict(hit) || IsLiveSlotConflict(other) || IsLiveSlotConflict(errors.New("x")) {
		t.Fatal("IsLiveSlotConflict should match only the live-slot index")
	}
}
