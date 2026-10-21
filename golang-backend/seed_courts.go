package main

import (
	"fmt"
	"log"
	"strconv"
	"strings"

	"arena-backend/internal/model"
	"gorm.io/gorm"
)

// courtCounts is how many courts of each type the seed creates. Set with
// BASKETBALL_COURT_COUNT, BADMINTON_COURT_COUNT, PICKLEBALL_COURT_COUNT and
// MEETING_ROOM_COUNT (golang-backend/.env); unset means the default below.
// Raising a count adds the missing courts on the next start. Lowering it
// never deletes a court (bookings and reports point at it) - it only logs a
// warning, and the admin closes the extra courts in Admin → บริหารสนาม.
type courtCounts struct {
	Basketball, Badminton, Pickleball, MeetingRoom int
}

var defaultCourtCounts = courtCounts{Basketball: 3, Badminton: 12, Pickleball: 3, MeetingRoom: 1}

// Upper bounds keep a typo (e.g. 300) from creating hundreds of courts;
// basketball courts are lettered A-Z.
const (
	maxBasketballCourts = 26
	maxOtherCourts      = 50
)

// courtCountsFromEnv reads the counts, falling back to the default (with a
// warning) for a value that isn't a whole number in range.
func courtCountsFromEnv(getenv func(string) string) (courtCounts, []string) {
	counts := defaultCourtCounts
	var warnings []string
	read := func(name string, def, max int, dst *int) {
		raw := strings.TrimSpace(getenv(name))
		if raw == "" {
			return
		}
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 || n > max {
			warnings = append(warnings, fmt.Sprintf("%s=%q is not a whole number from 0 to %d - using the default %d", name, raw, max, def))
			return
		}
		*dst = n
	}
	read("BASKETBALL_COURT_COUNT", defaultCourtCounts.Basketball, maxBasketballCourts, &counts.Basketball)
	read("BADMINTON_COURT_COUNT", defaultCourtCounts.Badminton, maxOtherCourts, &counts.Badminton)
	read("PICKLEBALL_COURT_COUNT", defaultCourtCounts.Pickleball, maxOtherCourts, &counts.Pickleball)
	read("MEETING_ROOM_COUNT", defaultCourtCounts.MeetingRoom, maxOtherCourts, &counts.MeetingRoom)
	return counts, warnings
}

// basketballCourtIDs returns the full / left-half / right-half ids and the
// mutex group of basketball court n (1 = A). Court A keeps its original
// ids (its halves were once misnamed "B"/"C"), so old bookings stay valid.
// Same ids as mockData.ts's basketballCourtIds.
func basketballCourtIDs(n int) (full, left, right, group string) {
	group = fmt.Sprintf("bball-court-%d", n)
	if n == 1 {
		return "b_full_a", "b_half_b", "b_half_c", group
	}
	l := strings.ToLower(basketballLetter(n))
	return "bb-" + l + "-full", "bb-" + l + "-left", "bb-" + l + "-right", group
}

func basketballLetter(n int) string {
	return string(rune('A' + n - 1))
}

// seededCourts lists the courts the seed ensures exist for these counts:
// each basketball court as a mutex group of full court + two halves (full
// blocks both halves, a half blocks the full court, the halves don't block
// each other; halves are off-peak only, FR-1.2), and numbered badminton,
// pickleball and meeting-room courts. Ids and names match mockData.ts's
// buildDefaultCourts.
func seededCourts(c courtCounts) []model.Court {
	var courts []model.Court
	for n := 1; n <= c.Basketball; n++ {
		full, left, right, g := basketballCourtIDs(n)
		group := g
		letter := basketballLetter(n)
		courts = append(courts,
			model.Court{ID: full, Name: "สนามบาสเกตบอล " + letter + " (เต็มสนาม)", Type: model.CourtBasketball, MutexGroupID: &group, ShareOfGroup: 1, IsActive: true},
			model.Court{ID: left, Name: "สนามบาสเกตบอล " + letter + " (ครึ่งซ้าย)", Type: model.CourtBasketball, MutexGroupID: &group, ShareOfGroup: 0.5, OffPeakOnly: true, IsActive: true},
			model.Court{ID: right, Name: "สนามบาสเกตบอล " + letter + " (ครึ่งขวา)", Type: model.CourtBasketball, MutexGroupID: &group, ShareOfGroup: 0.5, OffPeakOnly: true, IsActive: true},
		)
	}
	for i := 1; i <= c.Badminton; i++ {
		courts = append(courts, model.Court{ID: fmt.Sprintf("bad-%d", i), Name: fmt.Sprintf("สนามแบดมินตัน %d", i), Type: model.CourtBadminton, ShareOfGroup: 1, IsActive: true})
	}
	for i := 1; i <= c.Pickleball; i++ {
		courts = append(courts, model.Court{ID: fmt.Sprintf("pick-%d", i), Name: fmt.Sprintf("สนามพิคเคิลบอล %d", i), Type: model.CourtPickleball, ShareOfGroup: 1, IsActive: true})
	}
	for i := 1; i <= c.MeetingRoom; i++ {
		courts = append(courts, model.Court{ID: fmt.Sprintf("meet-%d", i), Name: fmt.Sprintf("ห้องประชุมเอนกประสงค์ %d", i), Type: model.CourtMeetingRoom, ShareOfGroup: 1, IsActive: true})
	}
	return courts
}

// warnAboutExtraSeededCourts logs seeded courts beyond the configured counts
// that are still open for booking - left over after a count was lowered.
// They are never deleted automatically; the admin closes them.
func warnAboutExtraSeededCourts(db *gorm.DB, c courtCounts) {
	max := courtCounts{Basketball: maxBasketballCourts, Badminton: maxOtherCourts, Pickleball: maxOtherCourts, MeetingRoom: maxOtherCourts}
	wanted := map[string]bool{}
	for _, court := range seededCourts(c) {
		wanted[court.ID] = true
	}
	var extra []string
	for _, court := range seededCourts(max) {
		if !wanted[court.ID] {
			extra = append(extra, court.ID)
		}
	}
	var open []model.Court
	if err := db.Where("id IN ? AND is_active", extra).Order("type, id").Find(&open).Error; err != nil {
		log.Printf("Warning: could not check for courts beyond the configured counts: %v\n", err)
		return
	}
	for _, court := range open {
		log.Printf("WARNING: %q (%s) is beyond the configured court count but still open for booking - close it in Admin → บริหารสนาม if it no longer exists.\n", court.Name, court.ID)
	}
}
