package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"arena-backend/internal/model"
	"arena-backend/internal/pkg/ids"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// LINE messages to customers (owner decisions 2026-11-14): only slip
// approved, slip rejected and booking expired; only to customers who
// linked LINE; the free plan's ~300 messages a month to start with, so
// Settings shows this month's count.
//
// Each message is queued (model.LineOutbox) in the transaction that makes
// the change, and LineNotifier.SendPending pushes the queue from a
// background job. Nothing here can fail or slow down a booking: LINE being
// down only delays the messages.

const (
	LineKindApproved = "APPROVED"
	LineKindRejected = "REJECTED"
	LineKindExpired  = "EXPIRED"

	lineMaxAttempts = 6
	// A message not delivered within a day is dropped: news of an approval
	// or expiry that late would only confuse.
	lineMaxAge = 24 * time.Hour
)

type LineNotifier struct {
	token   string
	APIBase string // https://api.line.me (tests point it elsewhere)
	HTTP    *http.Client
	db      *gorm.DB
	now     func() time.Time
}

// LineNotifierFromEnv: on when LINE_CHANNEL_ACCESS_TOKEN (the Messaging
// API channel's long-lived token) is set; nil = no messages are queued.
func LineNotifierFromEnv(db *gorm.DB) *LineNotifier {
	token := strings.TrimSpace(os.Getenv("LINE_CHANNEL_ACCESS_TOKEN"))
	if token == "" {
		return nil
	}
	n := NewLineNotifier(db, token, "https://api.line.me")
	if v := strings.TrimSpace(os.Getenv("LINE_TEST_API_BASE")); v != "" { // testing only
		n.APIBase = strings.TrimRight(v, "/")
	}
	return n
}

func NewLineNotifier(db *gorm.DB, token, apiBase string) *LineNotifier {
	return &LineNotifier{token: token, APIBase: apiBase, HTTP: &http.Client{Timeout: 8 * time.Second}, db: db, now: time.Now}
}

// SetLineNotifier turns on LINE messages for slip reviews and expiries.
func (s *BookingService) SetLineNotifier(n *LineNotifier) { s.line = n }

func newRetryKey() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40 // UUID v4, the format LINE asks for
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// queue adds a message for the booking group's customer, in tx. Nothing is
// queued when LINE messages are off or the customer hasn't linked LINE
// (walk-ins without an account included).
func (n *LineNotifier) queue(tx *gorm.DB, userID, kind, text string, now time.Time) error {
	if n == nil || userID == "" {
		return nil
	}
	var u []model.User
	if err := tx.Select("id, line_user_id, role").Where("id = ?", userID).Limit(1).Find(&u).Error; err != nil {
		return err
	}
	if len(u) == 0 || u[0].LineUserID == nil || *u[0].LineUserID == "" || u[0].Role != model.RoleCustomer {
		return nil
	}
	key, err := newRetryKey()
	if err != nil {
		return err
	}
	return tx.Create(&model.LineOutbox{
		ID: ids.New("lm"), UserID: userID, LineUserID: *u[0].LineUserID, Kind: kind, Text: text,
		Status: model.LineOutboxPending, RetryKey: key, NextAttemptAt: now, CreatedAt: now,
	}).Error
}

var thaiMonths = [...]string{"ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."}

// thaiDate: "2026-11-13" -> "13 พ.ย. 2026" (as the screens show dates).
func thaiDate(d string) string {
	if len(d) >= 10 {
		d = d[:10]
	}
	t, err := time.Parse("2006-01-02", d)
	if err != nil {
		return d
	}
	return fmt.Sprintf("%d %s %d", t.Day(), thaiMonths[t.Month()-1], t.Year())
}

// groupLines lists a booking group's hours: "13 พ.ย. 2026\nสนามแบดมินตัน 3 · 18:00-19:00 น.".
func groupLines(tx *gorm.DB, group []model.Booking) string {
	rows := append([]model.Booking(nil), group...)
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Date != rows[j].Date {
			return rows[i].Date < rows[j].Date
		}
		if rows[i].StartTime != rows[j].StartTime {
			return rows[i].StartTime < rows[j].StartTime
		}
		return rows[i].CourtID < rows[j].CourtID
	})
	courtIDs := make([]string, 0, len(rows))
	for _, b := range rows {
		courtIDs = append(courtIDs, b.CourtID)
	}
	var courts []model.Court
	names := map[string]string{}
	if tx.Select("id, name").Where("id IN ?", courtIDs).Find(&courts).Error == nil {
		for _, c := range courts {
			names[c.ID] = c.Name
		}
	}
	var sb strings.Builder
	lastDate := ""
	for _, b := range rows {
		if d := thaiDate(b.Date); d != lastDate {
			if sb.Len() > 0 {
				sb.WriteString("\n")
			}
			sb.WriteString(d)
			lastDate = d
		}
		name := names[b.CourtID]
		if name == "" {
			name = "สนาม"
		}
		fmt.Fprintf(&sb, "\n%s · %s-%s น.", name, b.StartTime, b.EndTime)
	}
	return sb.String()
}

func approvedText(code, lines string) string {
	return fmt.Sprintf("✅ ยืนยันการจองแล้วค่ะ\nรหัสจอง %s\n%s\nพบกันที่สนามค่ะ", code, lines)
}

func rejectedText(code, lines, reason string) string {
	return fmt.Sprintf("สลิปของการจอง %s ไม่ผ่านการตรวจค่ะ\nเหตุผล: %s\n%s\nการจองนี้ถูกยกเลิกแล้ว หากโอนเงินแล้วกรุณาติดต่อเคาน์เตอร์ค่ะ", code, reason, lines)
}

func expiredText(code, lines string, minutes int) string {
	return fmt.Sprintf("การจอง %s ถูกยกเลิกค่ะ เนื่องจากไม่ได้รับสลิปภายใน %d นาที\n%s\nหากโอนเงินแล้ว ส่งสลิปได้ที่ \"การจองของฉัน\" หรือติดต่อเคาน์เตอร์ค่ะ", code, minutes, lines)
}

// SendPending pushes due messages (a few at a time; the job calls it every
// few seconds). Rows are claimed with SKIP LOCKED, so several servers can
// run it at once without sending one message twice.
func (n *LineNotifier) SendPending(ctx context.Context) (int, error) {
	if n == nil {
		return 0, nil
	}
	sent := 0
	err := n.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := n.now()
		var due []model.LineOutbox
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}).
			Where("status = ? AND next_attempt_at <= ?", model.LineOutboxPending, now).
			Order("next_attempt_at, created_at").Limit(5).Find(&due).Error; err != nil {
			return err
		}
		for i := range due {
			m := &due[i]
			upd := map[string]any{"attempts": m.Attempts + 1}
			if now.Sub(m.CreatedAt) > lineMaxAge {
				upd["status"], upd["last_error"] = model.LineOutboxFailed, "not delivered within a day - dropped"
			} else {
				retry, err := n.push(ctx, m)
				switch {
				case err == nil:
					upd["status"], upd["sent_at"], upd["last_error"] = model.LineOutboxSent, now, nil
					sent++
				case retry && m.Attempts+1 < lineMaxAttempts:
					// 1, 2, 4, 8, 16 minutes.
					upd["next_attempt_at"] = now.Add(time.Minute << m.Attempts)
					upd["last_error"] = err.Error()
				default:
					upd["status"], upd["last_error"] = model.LineOutboxFailed, err.Error()
				}
			}
			if err := tx.Model(&model.LineOutbox{}).Where("id = ?", m.ID).Updates(upd).Error; err != nil {
				return err
			}
		}
		return nil
	})
	return sent, err
}

// push sends one message. retry: the outcome is unknown or temporary
// (network, 5xx, 429), so it may be sent again with the same retry key.
func (n *LineNotifier) push(ctx context.Context, m *model.LineOutbox) (retry bool, err error) {
	body, _ := json.Marshal(map[string]any{
		"to":       m.LineUserID,
		"messages": []map[string]string{{"type": "text", "text": m.Text}},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.APIBase+"/v2/bot/message/push", bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+n.token)
	req.Header.Set("X-Line-Retry-Key", m.RetryKey)
	resp, err := n.HTTP.Do(req)
	if err != nil {
		return true, fmt.Errorf("LINE push: %v", err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusOK:
		return false, nil
	case resp.StatusCode == http.StatusConflict:
		// Already accepted under this retry key (an earlier attempt whose
		// answer was lost): sent.
		return false, nil
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		return true, fmt.Errorf("LINE push: %s", lineError(resp))
	default:
		return false, fmt.Errorf("LINE push: %s", lineError(resp))
	}
}

// LineUsage is this month's LINE message count, for Settings.
type LineUsage struct {
	Enabled bool `json:"enabled"`
	// Counted here (Bangkok month): messages sent, and waiting or failed.
	SentThisMonth int64 `json:"sent_this_month"`
	Pending       int64 `json:"pending"`
	FailedMonth   int64 `json:"failed_this_month"`
	// From LINE, when it answers: this month's usage and the plan's limit
	// (0 = unknown or unlimited).
	LineUsed  *int64 `json:"line_used,omitempty"`
	LineLimit *int64 `json:"line_limit,omitempty"`
}

func (n *LineNotifier) Usage(ctx context.Context) (*LineUsage, error) {
	u := &LineUsage{Enabled: n != nil}
	if n == nil {
		return u, nil
	}
	bkk := time.FixedZone("ICT", 7*3600)
	t := n.now().In(bkk)
	start := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, bkk)
	db := n.db.WithContext(ctx).Model(&model.LineOutbox{})
	if err := db.Where("status = ? AND sent_at >= ?", model.LineOutboxSent, start).Count(&u.SentThisMonth).Error; err != nil {
		return nil, err
	}
	if err := n.db.WithContext(ctx).Model(&model.LineOutbox{}).Where("status = ?", model.LineOutboxPending).Count(&u.Pending).Error; err != nil {
		return nil, err
	}
	if err := n.db.WithContext(ctx).Model(&model.LineOutbox{}).Where("status = ? AND created_at >= ?", model.LineOutboxFailed, start).Count(&u.FailedMonth).Error; err != nil {
		return nil, err
	}
	var consumption struct {
		TotalUsage *int64 `json:"totalUsage"`
	}
	if n.get(ctx, "/v2/bot/message/quota/consumption", &consumption) == nil {
		u.LineUsed = consumption.TotalUsage
	}
	var quota struct {
		Type  string `json:"type"`
		Value *int64 `json:"value"`
	}
	if n.get(ctx, "/v2/bot/message/quota", &quota) == nil && quota.Type == "limited" {
		u.LineLimit = quota.Value
	}
	return u, nil
}

func (n *LineNotifier) get(ctx context.Context, path string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, n.APIBase+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+n.token)
	resp, err := n.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("LINE %s: HTTP %s", path, strconv.Itoa(resp.StatusCode))
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(out)
}
