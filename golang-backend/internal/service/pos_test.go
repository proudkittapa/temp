package service

import (
	"errors"
	"testing"

	"arena-backend/internal/model"
)

func TestProductInputValidate(t *testing.T) {
	ok := ProductInput{Name: "  น้ำส้ม  ", Category: model.ProductFB, Price: 35.555, Stock: 10}
	if err := ok.validate(); err != nil {
		t.Fatalf("valid product refused: %v", err)
	}
	if ok.Name != "น้ำส้ม" || ok.Price != 35.56 {
		t.Fatalf("name/price not normalised: %q %v", ok.Name, ok.Price)
	}
	bad := []ProductInput{
		{Name: "", Category: model.ProductFB, Price: 10},
		{Name: "x", Category: "FOOD", Price: 10},
		{Name: "x", Category: model.ProductFB, Price: -1},
		{Name: "x", Category: model.ProductFB, Price: 10, Stock: -5},
	}
	for i, in := range bad {
		if err := in.validate(); !errors.Is(err, ErrInvalidBooking) {
			t.Errorf("case %d: want ErrInvalidBooking, got %v", i, err)
		}
	}
}

func TestPct(t *testing.T) {
	cases := []struct{ part, whole, want float64 }{
		{1, 272, 0.4}, {0, 10, 0}, {5, 0, 0}, {136, 272, 50}, {272, 272, 100},
	}
	for _, c := range cases {
		if got := pct(c.part, c.whole); got != c.want {
			t.Errorf("pct(%v, %v) = %v, want %v", c.part, c.whole, got, c.want)
		}
	}
}

func TestBangkokDay(t *testing.T) {
	from, to, err := BangkokDay("2026-10-20")
	if err != nil {
		t.Fatal(err)
	}
	if got := from.UTC().Format("2006-01-02 15:04"); got != "2026-10-19 17:00" {
		t.Errorf("day starts %s UTC, want 2026-10-19 17:00", got)
	}
	if to.Sub(from).Hours() != 24 {
		t.Errorf("day is %v long", to.Sub(from))
	}
	if _, _, err := BangkokDay("20/10/2026"); !errors.Is(err, ErrInvalidBooking) {
		t.Errorf("bad date accepted: %v", err)
	}
}
