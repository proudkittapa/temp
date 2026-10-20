package promptpay

import "testing"

func TestCalculateCRC16CheckValue(t *testing.T) {
	// Standard check value for CRC-16/CCITT-FALSE, the variant EMVCo uses.
	if got := CalculateCRC16("123456789"); got != "29B1" {
		t.Fatalf("CRC16(123456789) = %s, want 29B1", got)
	}
}

func TestNormalizeID(t *testing.T) {
	cases := []struct {
		in, tag, value string
	}{
		{"0812345678", "01", "0066812345678"},
		{"081-234-5678", "01", "0066812345678"},
		{"+66 81 234 5678", "01", "0066812345678"},
		{"0066812345678", "01", "0066812345678"},
		{"0105561008012", "02", "0105561008012"},
		{"1-1017-00203-45-1", "02", "1101700203451"},
		{"004999000288505", "03", "004999000288505"},
	}
	for _, c := range cases {
		tag, value, err := NormalizeID(c.in)
		if err != nil || tag != c.tag || value != c.value {
			t.Errorf("NormalizeID(%q) = %q, %q, %v; want %q, %q", c.in, tag, value, err, c.tag, c.value)
		}
	}
	for _, bad := range []string{"", "12345", "081234567", "abc0812345678", "08123456789"} {
		if _, _, err := NormalizeID(bad); err == nil {
			t.Errorf("NormalizeID(%q) should fail", bad)
		}
	}
}

// Expected payloads are the output of the promptpay-qr npm package
// (v0.5.0) for the same inputs, an independent reference implementation.
func TestGeneratePayloadMatchesReference(t *testing.T) {
	cases := []struct {
		id     string
		amount float64
		want   string
	}{
		// Mobile numbers must use sub-tag 01 - they used to be encoded as a
		// tax ID (sub-tag 02), which banking apps can't resolve.
		{"0812345678", 100, "00020101021229370016A000000677010111011300668123456785802TH53037645406100.006304BB8A"},
		{"081-234-5678", 100, "00020101021229370016A000000677010111011300668123456785802TH53037645406100.006304BB8A"},
		{"0105561008012", 1530, "00020101021229370016A000000677010111021301055610080125802TH530376454071530.006304797B"},
	}
	for _, c := range cases {
		got, err := GeneratePayload(c.id, c.amount)
		if err != nil {
			t.Fatal(err)
		}
		if got != c.want {
			t.Errorf("GeneratePayload(%q, %v)\n got %s\nwant %s", c.id, c.amount, got, c.want)
		}
		assertValidCRC(t, got)
	}
}

func TestGeneratePayloadRejectsBadID(t *testing.T) {
	if _, err := GeneratePayload("12345", 100); err == nil {
		t.Fatal("expected an error for an invalid PromptPay ID")
	}
}

func assertValidCRC(t *testing.T, payload string) {
	t.Helper()
	body, crc := payload[:len(payload)-4], payload[len(payload)-4:]
	if CalculateCRC16(body) != crc {
		t.Fatalf("CRC mismatch in %s", payload)
	}
}
