package service

import "testing"

func TestPartialPhone(t *testing.T) {
	for in, want := range map[string]string{"+66 845": "0845", "0066 81": "081", "084-5": "0845", "66": "66", "+66812345678": "0812345678"} {
		if got := partialPhone(in); got != want {
			t.Errorf("partialPhone(%q) = %q, want %q", in, got, want)
		}
	}
}
