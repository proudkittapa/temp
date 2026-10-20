package promptpay

import (
	"fmt"
	"strings"
)

// CalculateCRC16 computes the ISO-13239 / CCITT Polynomial (0x1021) CRC-16 checksum
// required by PromptPay (EMVCo specification tags).
func CalculateCRC16(data string) string {
	var crc uint16 = 0xFFFF
	var polynomial uint16 = 0x1021

	for i := 0; i < len(data); i++ {
		crc ^= uint16(data[i]) << 8
		for j := 0; j < 8; j++ {
			if (crc & 0x8000) != 0 {
				crc = (crc << 1) ^ polynomial
			} else {
				crc <<= 1
			}
		}
	}
	return fmt.Sprintf("%04X", crc)
}

// PromptPay merchant-account sub-tags (inside tag 29).
const (
	tagMobile = "01" // mobile number, as 0066 + 9 digits
	tagTaxID  = "02" // 13-digit national ID / tax ID
	tagWallet = "03" // 15-digit e-wallet ID
)

// NormalizeID classifies a PromptPay ID and returns the sub-tag and value
// to encode. Spaces, dashes and a leading "+" are ignored, so "081-234-5678",
// "+66 81 234 5678" and "0812345678" are the same mobile number. The type is
// decided from the number as given, before any reformatting - a mobile
// number becomes 13 characters once written as 0066XXXXXXXXX, which is why
// classifying it by length afterwards encoded every phone as a tax ID.
func NormalizeID(id string) (subTag, value string, err error) {
	var b strings.Builder
	for _, r := range id {
		switch {
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '+':
		default:
			return "", "", fmt.Errorf("promptpay: invalid character %q in ID %q", r, id)
		}
	}
	d := b.String()
	switch {
	case len(d) == 10 && d[0] == '0':
		return tagMobile, "0066" + d[1:], nil
	case len(d) == 11 && strings.HasPrefix(d, "66"):
		return tagMobile, "00" + d, nil
	case len(d) == 13 && strings.HasPrefix(d, "0066"):
		return tagMobile, d, nil
	case len(d) == 13:
		return tagTaxID, d, nil
	case len(d) == 15:
		return tagWallet, d, nil
	}
	return "", "", fmt.Errorf("promptpay: %q is not a mobile number, 13-digit tax ID or 15-digit e-wallet ID", id)
}

// tlv encodes one EMVCo tag-length-value field.
func tlv(tag, value string) string {
	return fmt.Sprintf("%s%02d%s", tag, len(value), value)
}

// GeneratePayload builds the PromptPay (Thai QR / EMVCo) payload paying
// amount THB to the given PromptPay ID. It fails if the ID is not a valid
// mobile number, tax ID or e-wallet ID.
func GeneratePayload(promptPayID string, amount float64) (string, error) {
	subTag, value, err := NormalizeID(promptPayID)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	b.WriteString(tlv("00", "01")) // payload format indicator
	b.WriteString(tlv("01", "12")) // point of initiation: dynamic (amount included)
	b.WriteString(tlv("29", tlv("00", "A000000677010111")+tlv(subTag, value)))
	// Field order matches the widely used promptpay-qr library, so the
	// output can be checked byte-for-byte against it.
	b.WriteString(tlv("58", "TH"))  // country code
	b.WriteString(tlv("53", "764")) // transaction currency: THB
	b.WriteString(tlv("54", fmt.Sprintf("%.2f", amount)))
	b.WriteString("6304") // CRC tag + length; the CRC covers these four characters too
	b.WriteString(CalculateCRC16(b.String()))
	return b.String(), nil
}
