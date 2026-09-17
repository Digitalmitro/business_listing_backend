"use strict";

/**
 * Business-wise scoping shared by every CRM service and controller.
 *
 * Every CRM document is owned by a User (`ownerId`) and, since the business-wise
 * CRM, optionally belongs to one of that user's businesses (`businessId`). Admins
 * read across all owners; regular users only their own rows. A `businessId`
 * narrows either scope to a single business.
 */

const mongoose = require("mongoose");
const Business = require("../models/Business");
const { delCacheByPrefix } = require("../utils/cache");

/** Sentinel accepted in place of an ownerId so admin reads are not limited to one owner. */
const ALL_OWNERS = "__all_owners__";

/** Owner clause of a query: empty for ALL_OWNERS, `{ ownerId }` otherwise. */
function ownerFilter(ownerId) {
  return ownerId === ALL_OWNERS ? {} : { ownerId };
}

/** Returns the id as a string when it is a valid ObjectId, otherwise null. */
function validBusinessId(businessId) {
  if (!businessId) return null;
  const id = typeof businessId === "object" && businessId._id ? businessId._id : businessId;
  return mongoose.isValidObjectId(id) ? String(id) : null;
}

/** Business clause of a query: `{ businessId }` when a valid id is given, else empty. */
function businessFilter(businessId) {
  const id = validBusinessId(businessId);
  return id ? { businessId: id } : {};
}

/** Combined owner + business clause. */
function scopeFilter(ownerId, businessId) {
  return { ...ownerFilter(ownerId), ...businessFilter(businessId) };
}

/** Same as scopeFilter but with ObjectId values, for aggregation `$match` stages. */
function scopeMatch(ownerId, businessId) {
  const match = {};
  if (ownerId !== ALL_OWNERS) match.ownerId = new mongoose.Types.ObjectId(String(ownerId));
  const id = validBusinessId(businessId);
  if (id) match.businessId = new mongoose.Types.ObjectId(id);
  return match;
}

/** Read scope for a request: admins see every owner, users only themselves. */
function readScope(req) {
  return req.isAdmin ? ALL_OWNERS : req.user._id;
}

function scopedError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Resolves who owns a row being written for a business.
 * - user + businessId: the business must belong to that user (403 otherwise).
 * - admin + businessId: the row is written into the business owner's CRM, so the
 *   owner sees it on the customer site.
 * - no businessId: unchanged behaviour, the caller owns the row.
 */
async function resolveWriteScope(req, businessId) {
  const id = validBusinessId(businessId);
  if (!id) return { ownerId: req.user._id, businessId: null };

  const business = await Business.findById(id).select("_id userId businessName").lean();
  if (!business) throw scopedError(404, "Business not found");

  if (req.isAdmin) {
    return { ownerId: business.userId || req.user._id, businessId: id, business };
  }
  if (!business.userId || String(business.userId) !== String(req.user._id)) {
    throw scopedError(403, "You do not own this business");
  }
  return { ownerId: req.user._id, businessId: id, business };
}

/** Lead ids for a business, for log collections that only reference leads. */
async function leadIdsForBusiness(businessId) {
  const id = validBusinessId(businessId);
  if (!id) return null;
  const CrmLead = mongoose.model("CrmLead");
  const leads = await CrmLead.find({ businessId: id }).select("_id").lean();
  return leads.map((l) => l._id);
}

/**
 * Drops cached dashboard/forecast snapshots so the next read (e.g. the Refresh
 * button) reflects the write that just happened. Cheap: prefix scan on a handful
 * of keys. Never throws.
 */
async function invalidateCrmSnapshots() {
  try {
    await Promise.all([delCacheByPrefix("crm:dashboard:"), delCacheByPrefix("crm:forecast:")]);
  } catch {
    /* cache is best-effort */
  }
}

/**
 * Combines an appointment's day with its "10:30 AM" style slot into a Date.
 * Falls back to the stored day when the slot cannot be parsed.
 */
function appointmentStartTime(appointment) {
  const day = appointment?.appointmentDate ? new Date(appointment.appointmentDate) : null;
  if (!day || isNaN(day.getTime())) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(String(appointment.timeSlot || "").trim());
  if (!m) return day;
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  const period = (m[3] || "").toUpperCase();
  if (period === "PM" && hours !== 12) hours += 12;
  if (period === "AM" && hours === 12) hours = 0;
  const start = new Date(day);
  start.setHours(hours, minutes, 0, 0);
  return start;
}

module.exports = {
  invalidateCrmSnapshots,
  appointmentStartTime,
  ALL_OWNERS,
  ownerFilter,
  businessFilter,
  scopeFilter,
  scopeMatch,
  readScope,
  resolveWriteScope,
  leadIdsForBusiness,
  validBusinessId,
};
