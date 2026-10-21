package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
)

func TestRespondErrorHidesInternalDetails(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, c := range []struct {
		err    error
		status int
		msg    string
	}{
		{errors.New(`pq: duplicate key value violates unique constraint "idx_secret"`), http.StatusInternalServerError, msgInternal},
		{service.ErrBusy, http.StatusConflict, msgBusy},
		{fmt.Errorf("%w: payment is REFUNDED", service.ErrInvalidState), http.StatusConflict, "invalid state for this action: payment is REFUNDED"},
		{fmt.Errorf("%w: points change must be between -10000 and 10000", service.ErrInvalidBooking), http.StatusBadRequest, "invalid booking request: points change must be between -10000 and 10000"},
	} {
		w := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(w)
		ctx.Request = httptest.NewRequest(http.MethodGet, "/x", nil)
		respondError(ctx, c.err)
		var body struct{ Error string }
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		if w.Code != c.status || body.Error != c.msg {
			t.Errorf("%v: got %d %q, want %d %q", c.err, w.Code, body.Error, c.status, c.msg)
		}
	}
}
