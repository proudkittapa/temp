package service

import "testing"

func TestPartialPhone(t *testing.T) {
	for in, want := range map[string]string{"+66 845": "0845", "0066 81": "081", "084-5": "0845", "66": "66", "+66812345678": "0812345678"} {
		if got := partialPhone(in); got != want {
			t.Errorf("partialPhone(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPhoneLike(t *testing.T) {
	for q, want := range map[string]bool{
		"081-234-5678": true, "+66 81 234": true, "(02) 123": true, "0812": true,
		"somchai1": false, "john2@gmail.com": false, "สมชาย": false, "": false, "  ": false, "08+1": false,
	} {
		if got := phoneLike(q); got != want {
			t.Errorf("phoneLike(%q) = %v, want %v", q, got, want)
		}
	}
}
