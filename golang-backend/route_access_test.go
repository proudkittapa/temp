package main

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"arena-backend/internal/model"
)

// legacyRouteAccess is who could call each protected route before roles
// became permission sets (the old loggedIn / staffOnly / managerOnly /
// adminOnly guards in main.go). The built-in roles must keep exactly this
// access: "everyone" = any logged-in user, "staff" = STAFF+MANAGER+ADMIN,
// "manager" = MANAGER+ADMIN, "admin" = ADMIN.
var legacyRouteAccess = []struct{ route, group string }{
	{"GET /auth/me arenaHandler.Me", "everyone"},
	{"POST /bookings arenaHandler.CreateBooking", "everyone"},
	{"POST /bookings/:id/upload-slip arenaHandler.UploadSlip", "everyone"},
	{"GET /me/bookings arenaHandler.MyBookings", "everyone"},
	{"POST /me/rewards/:id/redeem rewardHandler.Redeem", "everyone"},
	{"GET /me/vouchers rewardHandler.MyVouchers", "everyone"},
	{"GET /staff/vouchers/:code rewardHandler.Lookup", "staff"},
	{"POST /staff/vouchers/:code/dispense rewardHandler.Dispense", "staff"},
	{"POST /staff/bookings arenaHandler.CreateWalkInBooking", "staff"},
	{"GET /staff/payments arenaHandler.ListPaymentsForReview", "staff"},
	{"POST /staff/payments/:id/verify arenaHandler.VerifyPayment", "staff"},
	{"POST /staff/payments/:id/reject arenaHandler.RejectPayment", "staff"},
	{"POST /staff/bookings/:id/no-show arenaHandler.MarkNoShow", "staff"},
	{"GET /staff/summary shopHandler.DaySummary", "staff"},
	{"POST /admin/bookings/:id/cancel arenaHandler.CancelBooking", "manager"},
	{"POST /admin/payments/:id/refund arenaHandler.RefundPayment", "manager"},
	{"POST /admin/payments/:id/mark-cash arenaHandler.MarkPaidInCash", "manager"},
	{"POST /admin/bookings/:id/mark-cash arenaHandler.MarkBookingPaidInCash", "manager"},
	{"GET /staff/products shopHandler.ListProducts", "staff"},
	{"POST /pos/order shopHandler.Checkout", "staff"},
	{"GET /staff/orders shopHandler.ListOrders", "staff"},
	{"GET /staff/rentals shopHandler.ActiveRentals", "staff"},
	{"POST /staff/rentals/items/:id/return shopHandler.ReturnRental", "staff"},
	{"GET /admin/products shopHandler.ListProducts", "manager"},
	{"POST /admin/products shopHandler.CreateProducts", "manager"},
	{"PUT /admin/products/:id shopHandler.UpdateProduct", "manager"},
	{"POST /admin/products/:id/stock shopHandler.AdjustStock", "manager"},
	{"POST /admin/orders/:id/void shopHandler.VoidOrder", "manager"},
	{"GET /staff/shift shopHandler.CurrentShift", "staff"},
	{"POST /staff/shift/open shopHandler.OpenShift", "staff"},
	{"POST /staff/shift/close shopHandler.CloseShift", "staff"},
	{"GET /admin/shifts shopHandler.ListShifts", "manager"},
	{"GET /admin/dashboard shopHandler.Dashboard", "manager"},
	{"GET /admin/report shopHandler.MonthReport", "manager"},
	{"GET /admin/audit-logs shopHandler.AuditLogs", "admin"},
	{"POST /admin/users/:id/adjust-points arenaHandler.ModifyPoints", "manager"},
	{"GET /admin/users arenaHandler.ListUsers", "manager"},
	{"PUT /admin/users/:id/member-type arenaHandler.SetMemberType", "manager"},
	{"PUT /admin/users/:id/role arenaHandler.SetUserRole", "admin"},
	{"PUT /admin/users/:id/active arenaHandler.SetUserActive", "admin"},
	{"POST /admin/days-off dayOffHandler.Create", "manager"},
	{"DELETE /admin/days-off/:id dayOffHandler.Delete", "manager"},
	{"GET /admin/courts courtHandler.List", "manager"},
	{"POST /admin/courts courtHandler.Create", "admin"},
	{"PUT /admin/courts/:id courtHandler.Update", "admin"},
	{"POST /admin/pricing-rules pricingHandler.SaveRule", "admin"},
	{"PUT /admin/pricing-rules/:id pricingHandler.SaveRule", "admin"},
	{"DELETE /admin/pricing-rules/:id pricingHandler.DeleteRule", "admin"},
	{"PUT /admin/member-discounts/:member_type pricingHandler.UpdateMemberDiscount", "admin"},
	{"PUT /admin/pricing-config pricingHandler.UpdateConfig", "admin"},
	{"PUT /admin/business pricingHandler.UpdateBusiness", "admin"},
}

var groupRoles = map[string][]model.UserRole{
	"everyone": {model.RoleCustomer, model.RoleStaff, model.RoleManager, model.RoleAdmin},
	"staff":    {model.RoleStaff, model.RoleManager, model.RoleAdmin},
	"manager":  {model.RoleManager, model.RoleAdmin},
	"admin":    {model.RoleAdmin},
}

// TestBuiltinRolesKeepTheirRouteAccess reads the route table in main.go and
// checks, for every protected route that existed before, that each built-in
// role is allowed exactly when its old role group was.
func TestBuiltinRolesKeepTheirRouteAccess(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	re := regexp.MustCompile(`api\.(GET|POST|PUT|DELETE)\("([^"]+)", (loggedIn|can\(([^)]*)\)), ([\w.]+)`)
	guards := map[string][]model.Permission{} // route -> permissions (nil = any login)
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		key := m[1] + " " + m[2] + " " + m[5]
		var perms []model.Permission
		if m[3] != "loggedIn" {
			for _, p := range strings.Split(m[4], ",") {
				name := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(p), "model."))
				perms = append(perms, permByConst[name])
			}
		}
		guards[key] = perms
	}
	rolePerms := map[model.UserRole]map[model.Permission]bool{}
	for _, r := range model.BuiltinRoles {
		set := map[model.Permission]bool{}
		for _, p := range r.Permissions {
			set[p] = true
		}
		rolePerms[model.UserRole(r.ID)] = set
	}
	for _, lr := range legacyRouteAccess {
		perms, ok := guards[lr.route]
		if !ok {
			t.Errorf("route %s is missing or no longer guarded", lr.route)
			continue
		}
		allowed := map[model.UserRole]bool{}
		for _, r := range groupRoles[lr.group] {
			allowed[r] = true
		}
		for role, set := range rolePerms {
			got := perms == nil
			for _, p := range perms {
				got = got || set[p]
			}
			if got != allowed[role] {
				t.Errorf("%s: role %s allowed=%v, before it was %v (%s only)", lr.route, role, got, allowed[role], lr.group)
			}
		}
	}
}

var permByConst = map[string]model.Permission{
	"PermBookOnline":      model.PermBookOnline,
	"PermCounterBookings": model.PermCounterBookings,
	"PermVerifySlips":     model.PermVerifySlips,
	"PermSellRent":        model.PermSellRent,
	"PermShifts":          model.PermShifts,
	"PermDaySummary":      model.PermDaySummary,
	"PermCancelRefund":    model.PermCancelRefund,
	"PermManageProducts":  model.PermManageProducts,
	"PermManageMembers":   model.PermManageMembers,
	"PermAdjustPoints":    model.PermAdjustPoints,
	"PermManageClosures":  model.PermManageClosures,
	"PermViewReports":     model.PermViewReports,
	"PermManageCourts":    model.PermManageCourts,
	"PermEditPricing":     model.PermEditPricing,
	"PermManageStaff":     model.PermManageStaff,
	"PermManageRoles":     model.PermManageRoles,
	"PermViewAuditLog":    model.PermViewAuditLog,
}
