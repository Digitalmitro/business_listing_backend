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

module.exports = {
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
