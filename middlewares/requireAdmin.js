// backend/middlewares/requireAdmin.js
"use strict";

const { authMiddleware } = require("./authMiddleware");

/**
 * Admin authorization.
 *
 *   router.get("/x", requireAdmin(), handler)               // any admin
 *   router.get("/x", requireAdmin("users"), handler)        // admin holding "users"
 *   router.get("/x", requireAdmin(["business", "crm"]), h)  // admin holding either key
 *   router.post("/x", requireSuperAdmin, handler)           // super-admin only
 *
 * Permission keys are the ones the admin panel uses (business_listing_admin/src/routes.js):
 * dashboard, cms, categories, subcategories, users, business, email_marketing, seo,
 * top_countries, packages, notifications, questions, enquiries, bookings, sub_admin, crm.
 * Super-admins hold every permission. Sub-admins (role "admin") must have the key in
 * Admin.permissions.
 *
 * Runs authMiddleware first when the request has not been authenticated yet, so it can
 * be used on its own or after authMiddleware.
 */

const SUPER_ADMIN = "super-admin";

function hasPermission(admin, permissions) {
  if (!permissions.length) return true;
  if (admin.role === SUPER_ADMIN) return true;
  const held = Array.isArray(admin.permissions) ? admin.permissions : [];
  return permissions.some((permission) => held.includes(permission));
}

function authenticated(req, res, next) {
  if (req.user) return next();
  return authMiddleware(req, res, next);
}

function check(req, res, next, { permissions, superAdminOnly, adminsOnly }) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }
  if (!req.isAdmin) {
    if (!adminsOnly) return next();
    return res.status(403).json({ success: false, message: "Admin access required" });
  }
  if (superAdminOnly && req.user.role !== SUPER_ADMIN) {
    return res.status(403).json({ success: false, message: "Super-admin access required" });
  }
  if (!hasPermission(req.user, permissions)) {
    return res.status(403).json({
      success: false,
      message: `You do not have the "${permissions.join('" or "')}" permission`,
    });
  }
  return next();
}

function build(options) {
  return (req, res, next) =>
    authenticated(req, res, () => check(req, res, next, options));
}

function toList(permission) {
  if (!permission) return [];
  return (Array.isArray(permission) ? permission : [permission]).filter(Boolean);
}

/** Requires an authenticated Admin principal, optionally holding one of `permission`. */
function requireAdmin(permission) {
  return build({ permissions: toList(permission), superAdminOnly: false, adminsOnly: true });
}

/**
 * For routes shared by business owners and admins (e.g. email templates scoped to their
 * creator): regular users pass through, admins must hold one of `permission`.
 */
requireAdmin.ifAdmin = function ifAdmin(permission) {
  return build({ permissions: toList(permission), superAdminOnly: false, adminsOnly: false });
};

/** Requires an authenticated super-admin. */
const requireSuperAdmin = build({ permissions: [], superAdminOnly: true, adminsOnly: true });

module.exports = { requireAdmin, requireSuperAdmin, hasPermission };
