// backend/middlewares/businessAccess.js
"use strict";

const fs = require("node:fs/promises");
const mongoose = require("mongoose");
const Business = require("../models/Business");
const { hasPermission } = require("./requireAdmin");

/**
 * Restricts a business write (or private read) to the business's owner or an admin
 * holding the "business" permission (super-admins always pass).
 *
 *   router.put("/x/:id", authMiddleware, requireBusinessAccess(fromParam("id")), handler)
 *
 * `resolveBusinessId(req)` returns the target business id. Must run after
 * authMiddleware (and after multer when the id lives in a multipart field).
 * Files multer already stored for a rejected request are removed.
 */

function isBusinessOwner(business, user) {
  return Boolean(business?.userId && user?._id && String(business.userId) === String(user._id));
}

function canManageBusiness(business, req) {
  if (req.isAdmin) return hasPermission(req.user, ["business"]);
  return isBusinessOwner(business, req.user);
}

function uploadedFiles(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === "object") return Object.values(req.files).flat();
  return [];
}

async function discardUploads(req) {
  await Promise.all(
    uploadedFiles(req)
      .filter((file) => file?.path)
      .map((file) => fs.unlink(file.path).catch(() => {}))
  );
}

function requireBusinessAccess(resolveBusinessId) {
  return async (req, res, next) => {
    const reject = async (status, message) => {
      await discardUploads(req);
      return res.status(status).json({ success: false, message });
    };
    try {
      if (!req.user) return reject(401, "Authentication required");

      let businessId;
      try {
        businessId = await resolveBusinessId(req);
      } catch {
        return reject(400, "Invalid business data format");
      }
      if (!businessId) return reject(400, "Business ID is required");
      if (!mongoose.isValidObjectId(String(businessId))) return reject(404, "Business not found");

      const business = await Business.findById(businessId).select("userId").lean();
      if (!business) return reject(404, "Business not found");
      if (!canManageBusiness(business, req)) {
        return reject(403, "You are not allowed to manage this business");
      }
      req.businessAccess = { businessId: String(business._id), isOwner: isBusinessOwner(business, req.user) };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

const fromParam = (name) => (req) => req.params[name];
const fromBody = (name) => (req) => req.body?.[name];
/** Business id inside the JSON `businessData` multipart field (`{ _id, ... }`). */
const fromBusinessData = (req) => {
  const raw = req.body?.businessData;
  if (!raw) return null;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return parsed?._id || null;
};

module.exports = {
  requireBusinessAccess,
  canManageBusiness,
  isBusinessOwner,
  fromParam,
  fromBody,
  fromBusinessData,
};
