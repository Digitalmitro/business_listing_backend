// backend/controllers/adminCrmController.js
"use strict";

const logger = require("../utils/logger");
const adminCrmService = require("../services/adminCrmService");

/**
 * GET /admin/crm/analytics
 * System-wide CRM analytics for super and sub admins.
 */
exports.getAnalytics = async (req, res) => {
  try {
    const data = await adminCrmService.getGlobalCrmAnalytics(req.query);
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    logger.error("Error retrieving admin CRM analytics", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /admin/crm/audit
 * System-wide CRM audit timeline across all users.
 */
exports.getAuditLogs = async (req, res) => {
  try {
    const data = await adminCrmService.getGlobalAuditLogs(req.query);
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    logger.error("Error retrieving admin CRM audit logs", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};
