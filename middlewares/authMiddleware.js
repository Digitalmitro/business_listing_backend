// backend/middlewares/authMiddleware.js
"use strict";

const jwt     = require("jsonwebtoken");
const Admin   = require("../models/Admin");
const User    = require("../models/User");
const logger  = require("../utils/logger");

/**
 * JWT authentication middleware.
 * Uses the `role` field embedded in the token payload to route the single DB
 * lookup to either the User or Admin collection, avoiding the double query
 * that previously ran on every authenticated request.
 */
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "No token, authorization denied" });
    }
    const token = authHeader.replace("Bearer ", "").trim();

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

    req.user = principal;
    next();
  } catch (error) {
    logger.warn("auth.middleware_error", "JWT validation failed", {
      message: error.message,
      requestId: req.requestId,
    });
    return res.status(401).json({ success: false, message: "Token is not valid" });
  }
};

module.exports = { authMiddleware };