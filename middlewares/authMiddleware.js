// backend/middlewares/authMiddleware.js
"use strict";

const jwt     = require("jsonwebtoken");
const Admin   = require("../models/Admin");
const User    = require("../models/User");
const logger  = require("../utils/logger");
const Tenant  = require("../models/Tenant");

/**
 * JWT authentication middleware.
 * Uses the `role` field embedded in the token payload to route the single DB
 * lookup to either the User or Admin collection, avoiding the double query
 * that previously ran on every authenticated request.
 */
/**
 * The JWT from `Authorization: Bearer <token>`; older admin screens send the raw token
 * in a `token` (or `x-access-token`) header instead, which CORS already allows.
 */
function extractToken(req) {
  const authHeader = req.header("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.replace("Bearer ", "").trim() || null;
  }
  const legacy = req.header("token") || req.header("x-access-token");
  if (typeof legacy === "string" && legacy.trim()) {
    return legacy.replace(/^Bearer\s+/i, "").trim() || null;
  }
  return null;
}

const authMiddleware = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ success: false, message: "No token, authorization denied" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Use the role stored in the JWT to avoid a speculative dual-DB lookup.
    // If role is missing (legacy tokens), fall back to checking both collections.
    let principal = null;

    if (decoded.role === "admin") {
      principal = await Admin.findById(decoded.id).select("-password");
    } else if (decoded.role === "user") {
      principal = await User.findById(decoded.id).select("-password");
    } else {
      // Legacy fallback: try User first, then Admin
      principal = await User.findById(decoded.id).select("-password")
                  || await Admin.findById(decoded.id).select("-password");
    }

    if (!principal) {
      return res.status(401).json({ success: false, message: "User not found or account removed" });
    }

    if (!principal.tenantId) {
      const tenant = await Tenant.findOneAndUpdate(
        { ownerUserId: principal._id },
        { $setOnInsert: { ownerUserId: principal._id, name: principal.full_name || principal.email || "Tenant" } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      principal.tenantId = tenant._id;
      await principal.save();
    }
    req.tenantId = principal.tenantId;

    req.user = principal;
    // Admins operate across every tenant's CRM data; regular users are scoped to their own.
    req.isAdmin = principal instanceof Admin;
    next();
  } catch (error) {
    logger.warn("auth.middleware_error", "JWT validation failed", {
      message: error.message,
      requestId: req.requestId,
    });
    return res.status(401).json({ success: false, message: "Token is not valid" });
  }
};

/**
 * Authenticates when a token is present, but never rejects: anonymous requests and
 * invalid tokens continue without req.user. For public reads that show more to the
 * owner or an admin (e.g. KYC documents on a business).
 */
const optionalAuth = (req, res, next) => {
  if (!extractToken(req)) return next();
  const passthrough = {
    status: () => ({ json: () => next() }),
  };
  return authMiddleware(req, passthrough, next);
};

module.exports = { authMiddleware, optionalAuth, extractToken };
