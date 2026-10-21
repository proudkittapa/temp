package main

import (
	"os"
	"strings"
	"testing"
)

// The audit search query must use exactly the indexed expression, or
// Postgres can't use idx_audit_logs_search_trgm and reads every row.
func TestAuditSearchMatchesIndexedExpression(t *testing.T) {
	src, err := os.ReadFile("internal/service/report_service.go")
	if err != nil {
		t.Fatal(err)
	}
	// The query is split over two Go string literals; join them.
	code := strings.NewReplacer("\"+\n\t\t\t\"", "", "\" +\n\t\t\t\"", "").Replace(string(src))
	if !strings.Contains(code, auditSearchExpr+" LIKE ?") {
		t.Fatalf("report_service.go's audit search no longer uses auditSearchExpr:\n%s", auditSearchExpr)
	}
}
