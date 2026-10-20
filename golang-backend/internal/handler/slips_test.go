package handler

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestSlipLinks(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	wd, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(wd)
	if err := os.MkdirAll(slipDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(slipDir, "slip_pay-1_x.png"), []byte("png"), 0o644); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 10, 20, 10, 30, 0, 0, time.UTC)
	s := NewSlipSigner([]byte("secret"))
	s.now = func() time.Time { return now }
	r := gin.New()
	r.GET("/api/v1/slips/:name", s.Serve)
	get := func(link string) int {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, link, nil))
		return w.Code
	}

	link := s.Sign("/uploads/slips/slip_pay-1_x.png")
	if code := get(link); code != http.StatusOK {
		t.Fatalf("signed link: %d", code)
	}
	if again := s.Sign("/uploads/slips/slip_pay-1_x.png"); again != link {
		t.Errorf("links should be stable within the hour: %s vs %s", link, again)
	}

	u, _ := url.Parse(link)
	q := u.Query()
	q.Set("sig", "00"+q.Get("sig")[2:])
	if code := get(u.Path + "?" + q.Encode()); code != http.StatusForbidden {
		t.Errorf("tampered signature: %d, want 403", code)
	}
	if code := get("/api/v1/slips/slip_pay-1_x.png"); code != http.StatusForbidden {
		t.Errorf("unsigned: %d, want 403", code)
	}
	if code := get(NewSlipSigner([]byte("other")).Sign("/uploads/slips/slip_pay-1_x.png")); code != http.StatusForbidden {
		t.Errorf("signed with another key: %d, want 403", code)
	}

	now = now.Add(3 * time.Hour)
	if code := get(link); code != http.StatusForbidden {
		t.Errorf("expired link: %d, want 403", code)
	}

	if s.Sign("/elsewhere/x.png") != "" || s.Sign("/uploads/slips/../x.png") != "" {
		t.Error("only plain names under /uploads/slips/ may be signed")
	}
}
