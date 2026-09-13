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

// GeneratePayload compiles the exact PromptPay EMVCo string payload from merchant's active target billing phone.
func GeneratePayload(phoneOrTaxID string, amount float64) string {
	// Sanitize phone input
	sanitized := strings.ReplaceAll(phoneOrTaxID, "+", "")
	sanitized = strings.ReplaceAll(sanitized, "-", "")
	sanitized = strings.TrimSpace(sanitized)

	// Format mobile numbers to align with standard merchant configuration (prefix with prefix '0066', ignore leading '0')
	if len(sanitized) == 10 && sanitized[0] == '0' {
		sanitized = "0066" + sanitized[1:]
	}

	// Dynamic Builder
	builder := strings.Builder{}
	builder.WriteString("000201") // Payload Format Indicator (Fixed ID)
	builder.WriteString("010212") // Point of Initiation: 12 (Dynamic QR Code)

	// Merchant Account Information Block (Tag 29 - PromptPay Specific Block)
	// Sub-Tag 00: AID representing PromptPay registry (Constant ID: A000000677010111)
	merchantAccountAID := "0016A000000677010111"
	var merchantAccountTypeAndPhone string
	if len(sanitized) == 13 {
		merchantAccountTypeAndPhone = fmt.Sprintf("0213%s", sanitized) // National ID or Tax ID Standard
	} else {
		merchantAccountTypeAndPhone = fmt.Sprintf("0113%s", sanitized) // Mobile Phone ID Standard
	}
	merchantBlockCombined := merchantAccountAID + merchantAccountTypeAndPhone
	builder.WriteString(fmt.Sprintf("29%02d%s", len(merchantBlockCombined), merchantBlockCombined))

	builder.WriteString("5303764") // Country Code Tag 53: TH (ISO code: 764)
	builder.WriteString("5802TH")  // Transaction Currency Tag 58: THB (ISO symbol: TH)

	// Invoiced Amount Tag 54
	amountStringValue := fmt.Sprintf("%.2f", amount)
	builder.WriteString(fmt.Sprintf("54%02d%s", len(amountStringValue), amountStringValue))

	// Prepared Checksum Block (Tag 63, length 04)
	builder.WriteString("6304")

	// Calculate and append CCITT-16 CRC checksum matching the compiled chunk
	checksumDigestHex := CalculateCRC16(builder.String())
	builder.WriteString(checksumDigestHex)

	return builder.String()
}
