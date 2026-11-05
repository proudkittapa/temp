package model

import (
	"encoding/json"
	"reflect"
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
			// Compared decoded: Go 1.27's encoding/json writes U+FFFD for a
			// bad byte as the character itself, older versions as \ufffd -
			// the same JSON.
			var g, w any
			_ = json.Unmarshal([]byte(got), &g)
			_ = json.Unmarshal([]byte(want), &w)
			if !reflect.DeepEqual(g, w) {
				t.Errorf("state for %q = %s, want %s", in, got, want)
			}
		}
	}
}
