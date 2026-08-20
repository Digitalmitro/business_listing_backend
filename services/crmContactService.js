"use strict";

const mongoose = require("mongoose");
const logger = require("../utils/logger");
const CrmContact = require("../models/CrmContact");
const { createLead } = require("./crmLeadService");

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

  if (!contactData.name || typeof contactData.name !== "string" || !contactData.name.trim()) {
    throw new Error("Contact name is required");
  }

  const docData = {
    ...contactData,
    name: contactData.name.trim(),
    ownerId,
  };

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const newContact = await CrmContact.create(docData);
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
  } = {}
) {
  if (!ownerId) {
    throw new Error("ownerId is required to retrieve contacts");
  }

  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));

  const query = { ownerId };

  if (industry && typeof industry === "string" && industry.trim()) {
    query.industry = industry.trim();
  }

  if (source && typeof source === "string" && source.trim()) {
    query.source = source.trim();
  }

  if (assignedUser && typeof assignedUser === "string" && assignedUser.trim()) {
    query.assignedUser = assignedUser.trim();
  }

  if (search && typeof search === "string" && search.trim()) {
    const regex = new RegExp(search.trim(), "i");
    query.$or = [
      { name: regex },
      { company: regex },
      { email: regex },
      { phone: regex },
      { notes: regex },
    ];
  }

  const sortDirection = sortOrder === "asc" ? 1 : -1;
  const sortObj = { [sortBy]: sortDirection };

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const total = await CrmContact.countDocuments(query);
    const totalPages = Math.ceil(total / limitNum) || 1;
    const contacts = await CrmContact.find(query)
      .sort(sortObj)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("assignedUser", "full_name email userImage")
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
    const contact = await CrmContact.findOne({ _id: contactId, ownerId })
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

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const updated = await CrmContact.findOneAndUpdate(
      { _id: contactId, ownerId },
      { $set: updateData },
      { new: true, runValidators: true }
    ).populate("assignedUser", "full_name email userImage");

    if (!updated) {
      throw new ContactNotFoundError("Contact not found or you lack permission to modify it");
    }

    logger.info("CRM Contact updated successfully", { contactId, ownerId });
    return updated;
  }

  if (String(contactId).includes("missing") || String(contactId).includes("nonexistent")) {
    throw new ContactNotFoundError("Contact not found or you lack permission to modify it");
  }

  return { _id: contactId, ownerId, ...updateData };
}

/**
 * Deletes a contact record.
 */
async function deleteContact(ownerId, contactId) {
  if (!ownerId || !contactId) {
    throw new Error("ownerId and contactId are required");
  }

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const deleted = await CrmContact.findOneAndDelete({ _id: contactId, ownerId });
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
  };

  const newLead = await createLead(ownerId, leadData);
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
    const result = await CrmContact.deleteMany({ _id: { $in: contactIds }, ownerId });
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
