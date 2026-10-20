package model

import (
	"encoding/json"
	"testing"
)

// Regression: free-text and empty before/after states used to be inserted
// as-is into jsonb columns, which Postgres rejects - dropping audit rows
// (or, for rental returns, failing the whole transaction).
func TestAuditLogBeforeCreateAlwaysProducesValidJSON(t *testing.T) {
	cases := map[string]string{
		"":                               "null",
		`{"status": "VERIFIED"}`:         `{"status": "VERIFIED"}`,
		"Rental stock unit returned: x5": `"Rental stock unit returned: x5"`,
		"bad \xff byte":                  `"bad \ufffd byte"`,
	}
	for in, want := range cases {
		a := AuditLog{BeforeState: in, AfterState: in}
		if err := a.BeforeCreate(nil); err != nil {
			t.Fatal(err)
		}
		for _, got := range []string{a.BeforeState, a.AfterState} {
			if !json.Valid([]byte(got)) {
				t.Errorf("state for %q is not valid JSON: %s", in, got)
			}
			if got != want {
				t.Errorf("state for %q = %s, want %s", in, got, want)
			}
		}
	}
}
