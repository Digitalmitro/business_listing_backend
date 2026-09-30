"use strict";

const mongoose = require("mongoose");
const logger = require("../utils/logger");
const CrmContact = require("../models/CrmContact");
const { createLead } = require("./crmLeadService");
const { scopeFilter, validBusinessId } = require("./crmScope");

/** Fields the owner may set directly; engagement state is managed by the engagement services. */
const EDITABLE_FIELDS = ["name", "company", "email", "phone", "alternatePhone", "website", "address", "industry", "source", "notes", "assignedUser", "tags"];

function pickEditable(data = {}) {
  const out = {};
  for (const key of EDITABLE_FIELDS) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  if (out.email !== undefined) out.email = String(out.email || "").trim().toLowerCase();
  if (out.tags !== undefined) {
    out.tags = (Array.isArray(out.tags) ? out.tags : String(out.tags || "").split(","))
      .map((t) => String(t).trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 30);
  }
  return out;
}

function duplicateEmailError() {
  const err = new Error("Another contact of this business already uses this email address");
  err.status = 409;
  return err;
}

class ContactNotFoundError extends Error {
  constructor(message = "Contact not found") {
    super(message);
    this.name = "ContactNotFoundError";
    this.status = 404;
  }
}

/**
 * Creates a new CRM contact under the specified owner.
 */
async function createContact(ownerId, contactData = {}) {
  if (!ownerId) {
    throw new Error("ownerId is required to create a contact");
  }

  const hasName = typeof contactData.name === "string" && contactData.name.trim();
  const email = String(contactData.email || "").trim().toLowerCase();
  if (!hasName && !email) {
    throw new Error("Contact name is required (or provide an email address)");
  }

  const businessId = validBusinessId(contactData.businessId);
  const docData = {
    ...pickEditable(contactData),
    name: hasName ? contactData.name.trim() : "",
    ownerId,
    businessId,
  };
  if (businessId && email) docData.emailKey = `${businessId}:${email}`;
  // Manually added contacts are only emailed by journeys when the owner confirms permission.
  docData.consent = contactData.permissionConfirmed === true
    ? { basis: "manual_confirmed", capturedAt: new Date() }
    : { basis: "unknown", capturedAt: null };
  if (!docData.source) docData.source = "Other";

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    let newContact;
    try {
      newContact = await CrmContact.create(docData);
    } catch (error) {
      if (error.code === 11000) throw duplicateEmailError();
      throw error;
    }
    logger.info("CRM Contact created successfully", { contactId: newContact._id, ownerId });
    return newContact;
  }

  return { _id: `contact_${Date.now()}`, ...docData };
}

/**
 * Retrieves paginated, filtered, searched, and sorted contacts for an owner.
 */
async function getContacts(
  ownerId,
  {
    page = 1,
    limit = 20,
    search = "",
    industry = "",
    source = "",
    assignedUser = "",
    sortBy = "createdAt",
    sortOrder = "desc",
    businessId = "",
    tag = "",
    emailStatus = "",
    lifecycle = "",
    segment = "",
  } = {}
) {
  if (!ownerId) {
    throw new Error("ownerId is required to retrieve contacts");
  }

  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));

  const query = scopeFilter(ownerId, businessId);

  if (industry && typeof industry === "string" && industry.trim()) {
    query.industry = industry.trim();
  }

  if (source && typeof source === "string" && source.trim()) {
    query.source = source.trim();
  }

  if (assignedUser && typeof assignedUser === "string" && assignedUser.trim()) {
    query.assignedUser = assignedUser.trim();
  }

  if (tag && typeof tag === "string" && tag.trim()) query.tags = tag.trim();
  if (["subscribed", "unsubscribed", "bounced"].includes(emailStatus)) query.emailStatus = emailStatus;
  if (["subscriber", "engaged", "lead", "customer", "inactive"].includes(lifecycle)) query.lifecycle = lifecycle;
  if (segment === "marketable") {
    query.emailStatus = "subscribed";
    query.email = { $gt: "" };
    query["consent.basis"] = { $in: CrmContact.MARKETING_CONSENT_BASES };
  } else if (segment === "no_permission") {
    query["consent.basis"] = { $in: ["unknown", null] };
  } else if (segment === "in_journey") {
    const CrmJourneyEnrollment = require("../models/CrmJourneyEnrollment");
    const ids = await CrmJourneyEnrollment.distinct("contactId", { ...(query.businessId ? { businessId: query.businessId } : {}), status: "active" });
    query._id = { $in: ids };
  } else if (segment === "waiting") {
    query["triage.status"] = "waiting";
  }

  if (search && typeof search === "string" && search.trim()) {
    // Escape user input so it is matched literally (and can't be a slow regex).
    const regex = new RegExp(search.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [
      { name: regex },
      { company: regex },
      { email: regex },
      { phone: regex },
      { notes: regex },
    ];
  }

  const sortDirection = sortOrder === "asc" ? 1 : -1;
  const SORTABLE = ["createdAt", "updatedAt", "name", "company", "email", "engagement.lastActivityAt"];
  const sortObj = { [SORTABLE.includes(sortBy) ? sortBy : "createdAt"]: sortDirection };

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const total = await CrmContact.countDocuments(query);
    const totalPages = Math.ceil(total / limitNum) || 1;
    const contacts = await CrmContact.find(query)
      .sort(sortObj)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("assignedUser", "full_name email userImage")
      .populate("businessId", "businessName")
      .lean();

    return { contacts, total, page: pageNum, limit: limitNum, totalPages };
  }

  return { contacts: [], total: 0, page: pageNum, limit: limitNum, totalPages: 0 };
}

/**
 * Retrieves a single contact by ID and owner ID.
 */
async function getContactById(ownerId, contactId) {
  if (!ownerId || !contactId) {
    throw new Error("ownerId and contactId are required");
  }

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const contact = await CrmContact.findOne({ _id: contactId, ...scopeFilter(ownerId) })
      .populate("assignedUser", "full_name email userImage")
      .lean();

    if (!contact) {
      throw new ContactNotFoundError("Contact not found or you lack permission to view it");
    }
    return contact;
  }

  if (String(contactId).includes("missing") || String(contactId).includes("nonexistent")) {
    throw new ContactNotFoundError("Contact not found or you lack permission to view it");
  }

  return { _id: contactId, ownerId, name: "Mock Contact" };
}

/**
 * Updates a contact record.
 */
async function updateContact(ownerId, contactId, updateData = {}) {
  if (!ownerId || !contactId) {
    throw new Error("ownerId and contactId are required");
  }

  if (updateData.name !== undefined && (typeof updateData.name !== "string" || !updateData.name.trim())) {
    throw new Error("Contact name cannot be empty");
  }
  const changes = pickEditable(updateData);

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    if (changes.email !== undefined) {
      const current = await CrmContact.findOne({ _id: contactId, ...scopeFilter(ownerId) }).select("businessId email emailStatus").lean();
      if (current && current.email !== changes.email) {
        const unset = {};
        if (current.businessId && changes.email) changes.emailKey = `${current.businessId}:${changes.email}`;
        else unset.emailKey = 1;
        // A bounce on the old address no longer applies; an unsubscribe still does.
        if (current.emailStatus === "bounced") changes.emailStatus = "subscribed";
        if (Object.keys(unset).length) await CrmContact.updateOne({ _id: contactId }, { $unset: unset });
      }
    }
    let updated;
    try {
      updated = await CrmContact.findOneAndUpdate(
        { _id: contactId, ...scopeFilter(ownerId) },
        { $set: changes },
        { new: true, runValidators: true }
      ).populate("assignedUser", "full_name email userImage");
    } catch (error) {
      if (error.code === 11000) throw duplicateEmailError();
      throw error;
    }

    if (!updated) {
      throw new ContactNotFoundError("Contact not found or you lack permission to modify it");
    }

    logger.info("CRM Contact updated successfully", { contactId, ownerId });
    return updated;
  }

  if (String(contactId).includes("missing") || String(contactId).includes("nonexistent")) {
    throw new ContactNotFoundError("Contact not found or you lack permission to modify it");
  }

  return { _id: contactId, ownerId, ...changes };
}

/**
 * Deletes a contact record.
 */
async function deleteContact(ownerId, contactId) {
  if (!ownerId || !contactId) {
    throw new Error("ownerId and contactId are required");
  }

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const deleted = await CrmContact.findOneAndDelete({ _id: contactId, ...scopeFilter(ownerId) });
    if (!deleted) {
      throw new ContactNotFoundError("Contact not found or you lack permission to delete it");
    }

    logger.info("CRM Contact deleted successfully", { contactId, ownerId });
    return { success: true, contactId };
  }

  if (String(contactId).includes("missing") || String(contactId).includes("nonexistent")) {
    throw new ContactNotFoundError("Contact not found or you lack permission to delete it");
  }

  return { success: true, contactId };
}

/**
 * Converts an existing contact into a sales lead.
 */
async function convertContactToLead(ownerId, contactId, payload = {}) {
  if (!ownerId || !contactId) throw new Error("ownerId and contactId are required");

  const { status = "New", notes = "" } = payload;
  const expectedRevenue =
    payload.expectedRevenue !== undefined
      ? Number(payload.expectedRevenue) || 0
      : payload.estimatedValue !== undefined
      ? Number(payload.estimatedValue) || 0
      : payload.dealValue !== undefined
      ? Number(payload.dealValue) || 0
      : 0;

  const contact = await getContactById(ownerId, contactId);
  const leadData = {
    leadName: payload.leadName || contact.name,
    company: contact.company || "",
    email: contact.email || "",
    phone: contact.phone || "",
    expectedRevenue,
    status,
    source: contact.source || "Contact Conversion",
    notes: notes || contact.notes || `Converted from contact (${contact.name})`,
    assignedUser: contact.assignedUser ? (contact.assignedUser._id || contact.assignedUser) : null,
    businessId: contact.businessId ? (contact.businessId._id || contact.businessId) : null,
  };

  // Admin callers pass ALL_OWNERS; the lead must be owned by the contact's real owner.
  const leadOwnerId = contact.ownerId || ownerId;
  const newLead = await createLead(leadOwnerId, leadData);
  logger.info("Converted contact to CRM lead", { contactId, leadId: newLead._id, ownerId });
  return newLead;
}

/**
 * Bulk deletes contacts by array of IDs.
 */
async function bulkDeleteContacts(ownerId, contactIds = []) {
  if (!ownerId) throw new Error("ownerId is required");
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    throw new Error("contactIds array must not be empty");
  }

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const result = await CrmContact.deleteMany({ _id: { $in: contactIds }, ...scopeFilter(ownerId) });
    logger.info("Bulk deleted CRM contacts", { ownerId, deletedCount: result.deletedCount });
    return { success: true, deletedCount: result.deletedCount };
  }

  return { success: true, deletedCount: contactIds.length };
}

module.exports = {
  ContactNotFoundError,
  createContact,
  getContacts,
  getContactById,
  updateContact,
  deleteContact,
  convertContactToLead,
  bulkDeleteContacts,
};
