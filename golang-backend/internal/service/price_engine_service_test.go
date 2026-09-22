package service

import "testing"

// TestApplyRateAdjustments locks in the FR-2 pricing order: half-court rate
// first, then membership discount, both read from config rather than
// hardcoded (values here match REQUIREMENTS.md: half-court 50%, student 15%,
// member 10%, corporate 20%).
func TestApplyRateAdjustments(t *testing.T) {
	tests := []struct {
		name                 string
		baseAmount           float64
		isHalfCourt          bool
		halfCourtRatePercent float64
		discountPercent      float64
		want                 float64
	}{
		{
			name:                 "full court, no discount",
			baseAmount:           800,
			isHalfCourt:          false,
			halfCourtRatePercent: 50,
			discountPercent:      0,
			want:                 800,
		},
		{
			name:                 "half court, no discount: exactly the configured rate",
			baseAmount:           800,
			isHalfCourt:          true,
			halfCourtRatePercent: 50,
			discountPercent:      0,
			want:                 400,
		},
		{
			name:                 "full court with student discount (15%)",
			baseAmount:           800,
			isHalfCourt:          false,
			halfCourtRatePercent: 50,
			discountPercent:      15,
			want:                 680,
		},
		{
			name:                 "half court with corporate discount (20%): rate applied before discount",
			baseAmount:           800,
			isHalfCourt:          true,
			halfCourtRatePercent: 50,
			discountPercent:      20,
			want:                 320, // 800 * 0.5 = 400, then 400 * 0.8 = 320
		},
		{
			name:                 "half court is NOT the fixed 60% coefficient this used to hardcode",
			baseAmount:           800,
			isHalfCourt:          true,
			halfCourtRatePercent: 50,
			discountPercent:      0,
			want:                 400, // NOT 480 (which 60% would have produced)
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ApplyRateAdjustments(tt.baseAmount, tt.isHalfCourt, tt.halfCourtRatePercent, tt.discountPercent)
			if got != tt.want {
				t.Errorf("ApplyRateAdjustments(%v, %v, %v, %v) = %v, want %v",
					tt.baseAmount, tt.isHalfCourt, tt.halfCourtRatePercent, tt.discountPercent, got, tt.want)
			}
		})
	}
}
