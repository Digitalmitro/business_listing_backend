"use strict";

const logger = require("../utils/logger");
const crmContactService = require("../services/crmContactService");
const { readScope, resolveWriteScope } = require("../services/crmScope");

/**
 * POST /api/crm/contacts
 * Create a new CRM contact.
 */
exports.createContact = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const scope = await resolveWriteScope(req, req.body.businessId);
    const contact = await crmContactService.createContact(scope.ownerId, { ...req.body, businessId: scope.businessId });
    return res.status(201).json({ success: true, contact });
  } catch (error) {
    logger.error("Error creating CRM contact", { error: error.message });
    const status = error.status || (error.message.includes("is required") ? 400 : 500);
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/crm/contacts
 * Retrieve paginated, filtered, searched, and sorted contacts.
 */
exports.getContacts = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const data = await crmContactService.getContacts(readScope(req), req.query);
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    logger.error("Error retrieving CRM contacts", { error: error.message });
    return res.status(500).json({ success: false, message: "Failed to retrieve contacts: " + error.message });
  }
};

/**
 * GET /api/crm/contacts/:id
 * Retrieve single contact details.
 */
exports.getContactById = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const contact = await crmContactService.getContactById(readScope(req), req.params.id);
    return res.status(200).json({ success: true, contact });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/crm/contacts/:id
 * Update an existing CRM contact.
 */
exports.updateContact = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const contact = await crmContactService.updateContact(readScope(req), req.params.id, req.body);
    return res.status(200).json({ success: true, contact });
  } catch (error) {
    logger.error("Error updating CRM contact", { error: error.message });
    let status = error.status || 500;
    if (error.message.includes("cannot be empty")) status = 400;
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /api/crm/contacts/:id
 * Delete a CRM contact.
 */
exports.deleteContact = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const result = await crmContactService.deleteContact(readScope(req), req.params.id);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/crm/contacts/:id/convert
 * Convert a contact into a sales lead.
 */
exports.convertContactToLead = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const lead = await crmContactService.convertContactToLead(readScope(req), req.params.id, req.body);
    return res.status(201).json({ success: true, lead, message: "Contact successfully converted to lead" });
  } catch (error) {
    logger.error("Error converting contact to lead", { error: error.message });
    const status = error.status || (error.message.includes("required") ? 400 : 500);
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/crm/contacts/bulk-delete
 * Bulk delete contacts by array of IDs.
 */
exports.bulkDeleteContacts = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const { contactIds } = req.body;
    const result = await crmContactService.bulkDeleteContacts(readScope(req), contactIds);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error("Error bulk deleting CRM contacts", { error: error.message });
    return res.status(400).json({ success: false, message: error.message });
  }
};
