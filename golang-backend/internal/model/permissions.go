package model

import "time"

// Permission is one thing a role may do. Every protected API route checks a
// permission (handler.RequirePermission) instead of a fixed role, so the
// admin can build roles such as "cashier" from these pieces. The frontend
// mirrors this list (src/permissions.ts) for labels and which screens/tabs
// to show; the server is what enforces it.
type Permission string

const (
	PermBookOnline      Permission = "book_online"      // book courts, upload slips, redeem rewards as a customer
	PermCounterBookings Permission = "counter_bookings" // walk-in bookings, no-shows, customer details in the grid
	PermVerifySlips     Permission = "verify_slips"     // approve / reject payment slips
	PermSellRent        Permission = "sell_rent"        // counter sales, rentals, returns, hand out reward vouchers
	PermShifts          Permission = "shifts"           // open / close the cash drawer shift
	PermDaySummary      Permission = "day_summary"      // today's totals at the counter
	PermCancelRefund    Permission = "cancel_refund"    // cancel bookings, refunds, record cash / late payment, void sales
	PermManageProducts  Permission = "manage_products"  // add products, edit prices, adjust stock
	PermManageMembers   Permission = "manage_members"   // customer list and membership tiers
	PermAdjustPoints    Permission = "adjust_points"    // manual loyalty point changes
	PermManageClosures  Permission = "manage_closures"  // court closures (days off)
	PermViewReports     Permission = "view_reports"     // dashboard, monthly report, past shifts; see expected cash at shift close
	PermManageCourts    Permission = "manage_courts"    // add / rename / open / close courts
	PermEditPricing     Permission = "edit_pricing"     // pricing rules, member discounts, half-court rate, business details
	PermManageStaff     Permission = "manage_staff"     // give accounts a role, suspend / reactivate accounts
	PermManageRoles     Permission = "manage_roles"     // create / edit / delete roles
	PermViewAuditLog    Permission = "view_audit_log"   // audit log
)

// AllPermissions in display order.
var AllPermissions = []Permission{
	PermBookOnline, PermCounterBookings, PermVerifySlips, PermSellRent, PermShifts, PermDaySummary,
	PermCancelRefund, PermManageProducts, PermManageMembers, PermAdjustPoints, PermManageClosures,
	PermViewReports, PermManageCourts, PermEditPricing, PermManageStaff, PermManageRoles, PermViewAuditLog,
}

// IsValidPermission reports whether p is a known permission.
func IsValidPermission(p Permission) bool {
	for _, k := range AllPermissions {
		if k == p {
			return true
		}
	}
	return false
}

var staffPermissions = []Permission{
	PermBookOnline, PermCounterBookings, PermVerifySlips, PermSellRent, PermShifts, PermDaySummary,
}

var managerPermissions = append(append([]Permission{}, staffPermissions...),
	PermCancelRefund, PermManageProducts, PermManageMembers, PermAdjustPoints, PermManageClosures, PermViewReports,
)

// BuiltinRoles are created on startup with exactly the rights the fixed
// roles had before roles became configurable, so nothing changes until the
// admin edits them. Their ids are the old role names, which users.role
// already holds.
var BuiltinRoles = []Role{
	{ID: string(RoleCustomer), Name: "ลูกค้า", IsBuiltin: true, Permissions: []Permission{PermBookOnline}},
	{ID: string(RoleStaff), Name: "พนักงานเคาน์เตอร์", IsBuiltin: true, Permissions: staffPermissions},
	{ID: string(RoleManager), Name: "ผู้จัดการ", IsBuiltin: true, Permissions: managerPermissions},
	{ID: string(RoleAdmin), Name: "ผู้บริหาร (Admin)", IsBuiltin: true, Permissions: AllPermissions},
}

// Role is a named set of permissions; users.role holds its id. Built-in
// roles can be edited but not deleted, and ADMIN always keeps
// PermManageRoles so nobody can lock everyone out of role management.
type Role struct {
	ID          string       `json:"id" gorm:"primaryKey;column:id"`
	Name        string       `json:"name" gorm:"column:name"`
	Permissions []Permission `json:"permissions" gorm:"column:permissions;type:text;serializer:json"`
	IsBuiltin   bool         `json:"is_builtin" gorm:"column:is_builtin"`
	CreatedAt   time.Time    `json:"created_at" gorm:"column:created_at"`
	UpdatedAt   time.Time    `json:"updated_at" gorm:"column:updated_at"`
}
