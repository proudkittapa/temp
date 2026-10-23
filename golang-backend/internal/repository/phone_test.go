package repository

import "testing"

func TestNormalizePhone(t *testing.T) {
	cases := map[string]string{
		"0812345678":      "0812345678",
		"081-234-5678":    "0812345678",
		"081 234 5678":    "0812345678",
		"+66 81 234 5678": "0812345678",
		"+66812345678":    "0812345678",
		"0066812345678":   "0812345678",
		"812345678":       "0812345678", // mobile typed without its 0
		"81-234-5678":     "0812345678",
		"912345678":       "0912345678",
		"021234567":       "021234567", // Bangkok landline
		"+66 2 123 4567":  "021234567", // landline in international form
		"1234":            "1234",
		"":                "",
	}
	for in, want := range cases {
		if got := NormalizePhone(in); got != want {
			t.Errorf("NormalizePhone(%q) = %q, want %q", in, got, want)
		}
	}
}
