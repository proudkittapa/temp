package handler

import (
	"net/http"

	"arena-backend/internal/model"
	"arena-backend/internal/service"
	"github.com/gin-gonic/gin"
)

// RoleHandler serves roles: named permission sets the admin edits.
type RoleHandler struct {
	roles *service.RoleService
}

func NewRoleHandler(roles *service.RoleService) *RoleHandler {
	return &RoleHandler{roles: roles}
}

// GET /api/v1/admin/roles - every role with its account count, plus the
// list of permissions a role can have.
func (h *RoleHandler) List(c *gin.Context) {
	list, err := h.roles.List(c.Request.Context())
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"roles": list, "permissions": model.AllPermissions}})
}

// POST /api/v1/admin/roles {"name": "...", "permissions": [...]}
func (h *RoleHandler) Create(c *gin.Context) {
	var in service.RoleInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	actorID, actorName := actor(c)
	r, err := h.roles.Create(c.Request.Context(), in, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": r})
}

// PUT /api/v1/admin/roles/:id {"name": "...", "permissions": [...]}
func (h *RoleHandler) Update(c *gin.Context) {
	var in service.RoleInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}
	actorID, actorName := actor(c)
	r, err := h.roles.Update(c.Request.Context(), c.Param("id"), in, actorID, actorName)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": r})
}

// DELETE /api/v1/admin/roles/:id - custom roles nobody has.
func (h *RoleHandler) Delete(c *gin.Context) {
	actorID, actorName := actor(c)
	if err := h.roles.Delete(c.Request.Context(), c.Param("id"), actorID, actorName); err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}
