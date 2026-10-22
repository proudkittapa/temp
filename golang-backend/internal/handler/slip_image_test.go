package handler

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"testing"
)

func TestCheckSlipImage(t *testing.T) {
	small := image.NewRGBA(image.Rect(0, 0, 8, 8))
	var pngBuf, jpgBuf bytes.Buffer
	if err := png.Encode(&pngBuf, small); err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(&jpgBuf, small, nil); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		data    []byte
		wantExt string
		wantErr error
	}{
		{"real png", pngBuf.Bytes(), "png", nil},
		{"real jpeg", jpgBuf.Bytes(), "jpg", nil},
		// The name doesn't matter, only the content: a chat app's JPEG
		// saved as .png is still a JPEG slip.
		{"html", []byte("<html><script>alert(1)</script></html>"), "", errBadSlipImage},
		{"svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`), "", errBadSlipImage},
		{"pdf", []byte("%PDF-1.7\n"), "", errBadSlipImage},
		{"empty", nil, "", errBadSlipImage},
		{"huge declared png", pngHeader(20000, 20000), "", errSlipTooLarge},
		{"webp signature", append([]byte("RIFF\x00\x00\x00\x00WEBPVP8 "), make([]byte, 20)...), "webp", nil},
	}
	for _, tc := range cases {
		ext, err := slipImageExt(bytes.NewReader(tc.data))
		if ext != tc.wantExt || err != tc.wantErr {
			t.Errorf("%s: got %q, %v; want %q, %v", tc.name, ext, err, tc.wantExt, tc.wantErr)
		}
	}
}

// pngHeader is a PNG signature plus an IHDR chunk declaring w×h - enough
// for image.DecodeConfig, without the memory of a real image that size.
func pngHeader(w, h uint32) []byte {
	var b bytes.Buffer
	b.WriteString("\x89PNG\r\n\x1a\n")
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], w)
	binary.BigEndian.PutUint32(ihdr[4:], h)
	ihdr[8], ihdr[9] = 8, 6 // 8-bit RGBA
	binary.Write(&b, binary.BigEndian, uint32(len(ihdr)))
	chunk := append([]byte("IHDR"), ihdr...)
	b.Write(chunk)
	binary.Write(&b, binary.BigEndian, crc32.ChecksumIEEE(chunk))
	return b.Bytes()
}
