"use strict";

const logger = require("../utils/logger");
const crmLeadService = require("../services/crmLeadService");

/**
 * POST /api/crm/leads
 * Create a new CRM lead.
 */
exports.createLead = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const lead = await crmLeadService.createLead(req.user._id, req.body, req.user._id);
    return res.status(201).json({ success: true, lead });
  } catch (error) {
    logger.error("Error creating CRM lead", { error: error.message });
    const status = error.message.includes("is required") || error.message.includes("Invalid status") ? 400 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/crm/leads
 * Retrieve paginated, searched, filtered, and sorted leads.
 */
exports.getLeads = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const data = await crmLeadService.getLeads(req.user._id, req.query);
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    logger.error("Error retrieving CRM leads", { error: error.message });
    return res.status(500).json({ success: false, message: "Failed to retrieve leads: " + error.message });
  }
};

/**
 * GET /api/crm/leads/:id
 * Retrieve single lead details.
 */
exports.getLeadById = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const lead = await crmLeadService.getLeadById(req.user._id, req.params.id);
    return res.status(200).json({ success: true, lead });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/crm/leads/:id
 * Update lead details and trigger automated activity log entries.
 */
exports.updateLead = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const lead = await crmLeadService.updateLead(req.user._id, req.params.id, req.body, req.user._id);
    return res.status(200).json({ success: true, lead });
  } catch (error) {
    logger.error("Error updating CRM lead", { error: error.message });
    let status = error.status || 500;
    if (error.message.includes("cannot be empty") || error.message.includes("Invalid status")) status = 400;
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/crm/leads/:id/activities
 * Append a custom activity note to a lead's timeline.
 */
exports.addActivity = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const lead = await crmLeadService.addLeadActivity(req.user._id, req.params.id, req.body, req.user._id);
    return res.status(201).json({ success: true, lead });
  } catch (error) {
    logger.error("Error adding lead activity", { error: error.message });
    let status = error.status || 500;
    if (error.message.includes("is required")) status = 400;
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /api/crm/leads/:id
 * Delete a CRM lead.
 */
exports.deleteLead = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const result = await crmLeadService.deleteLead(req.user._id, req.params.id);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/crm/leads/kanban/reorder
 * Reorder leads and update stage statuses across Kanban board columns.
 */
exports.reorderKanban = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const leads = await crmLeadService.reorderKanbanLeads(req.user._id, req.body.updates || [], req.user._id);
    return res.status(200).json({ success: true, leads });
  } catch (error) {
    logger.error("Error reordering Kanban leads", { error: error.message });
    const status = error.message.includes("must be an array") ? 400 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};
