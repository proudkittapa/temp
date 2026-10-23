package main

import (
	"fmt"
	"log"
	"sort"
	"strings"

	"gorm.io/gorm"
)

// moneyColumns hold baht amounts. They are numeric(12,2) - exact satang,
// so sums and the CHECK constraints in the database don't drift the way
// floating point does (0.1 + 0.2). The Go side keeps float64 rounded with
// RoundBaht; reads and writes convert exactly at 2 decimals. The model tags
// say numeric(12,2) too, so a new database is created that way.
var moneyColumns = map[string][]string{
	"bookings":      {"total_amount"},
	"payments":      {"amount", "refund_amount"},
	"refunds":       {"amount"},
	"orders":        {"total_amount", "paid_amount", "deposit_amount", "deposit_returned", "deposit_kept"},
	"order_items":   {"unit_price"},
	"products":      {"price", "deposit"},
	"pricing_rules": {"price_per_hour"},
	"shifts": {"opening_float", "counted_cash", "banked_cash", "expected_cash", "variance_cash",
		"cash_bookings_at_close", "cash_orders_at_close", "cash_deposits_at_close"},
}

// convertMoneyColumns turns money columns not yet numeric(12,2) - GORM
// created them as numeric without a scale (any number of decimals), older
// setups may have double precision - into numeric(12,2), each value
// rounded to the satang - which every amount already was, as the code
// rounds before writing; any that wasn't is counted in the log first. One
// ALTER per table, so each table is rewritten once; under the migration
// lock, so two servers starting together don't both do it. It runs before
// AutoMigrate, which then finds the types it expects (on a new database
// there is nothing to convert). A failure stops the start: AutoMigrate
// would otherwise try the same change column by column.
func convertMoneyColumns(db *gorm.DB) error {
	tables := make([]string, 0, len(moneyColumns))
	for t := range moneyColumns {
		tables = append(tables, t)
	}
	sort.Strings(tables)
	for _, table := range tables {
		err := db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", migrationLockKey).Error; err != nil {
				return err
			}
			var cols []string
			if err := tx.Raw(`SELECT column_name FROM information_schema.columns
				WHERE table_schema = current_schema() AND table_name = ? AND column_name IN ?
				  AND (data_type IN ('double precision', 'real')
				       OR (data_type = 'numeric' AND (numeric_precision IS DISTINCT FROM 12 OR numeric_scale IS DISTINCT FROM 2)))
				ORDER BY column_name`, table, moneyColumns[table]).Scan(&cols).Error; err != nil {
				return err
			}
			if len(cols) == 0 {
				return nil
			}
			var odd []string
			alters := make([]string, len(cols))
			for i, c := range cols {
				var n int64
				if err := tx.Raw(fmt.Sprintf("SELECT count(*) FROM %s WHERE %s::numeric <> round(%s::numeric, 2)", table, c, c)).Scan(&n).Error; err != nil {
					return err
				}
				if n > 0 {
					odd = append(odd, fmt.Sprintf("%s: %d", c, n))
				}
				alters[i] = fmt.Sprintf("ALTER COLUMN %s TYPE numeric(12,2) USING round(%s::numeric, 2)", c, c)
			}
			if len(odd) > 0 {
				log.Printf("Money columns: %s has amounts below a satang, rounded to 2 decimals (%s).\n", table, strings.Join(odd, ", "))
			}
			if err := tx.Exec(fmt.Sprintf("ALTER TABLE %s %s", table, strings.Join(alters, ", "))).Error; err != nil {
				return err
			}
			log.Printf("Money columns: %s.%s now numeric(12,2).\n", table, strings.Join(cols, ", "))
			return nil
		})
		if err != nil {
			return fmt.Errorf("converting the money columns of %s to numeric(12,2): %w", table, err)
		}
	}
	return nil
}
