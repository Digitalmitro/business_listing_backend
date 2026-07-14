// backend/controllers/crmAuditController.js
"use strict";

const logger = require("../utils/logger");
const crmAuditService = require("../services/crmAuditService");

/**
 * GET /api/crm/audit
 * Retrieve paginated audit logs for the authenticated user.
 */
exports.getAuditLogs = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const data = await crmAuditService.getAuditLogs(req.user._id, req.query);
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    logger.error("Error retrieving CRM audit logs", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/crm/audit/export
 * Export audit logs as a downloadable CSV.
 */
exports.exportAuditLogs = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const csvData = await crmAuditService.exportAuditLogs(req.user._id, req.query);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="crm_audit_logs_${new Date().toISOString().split("T")[0]}.csv"`);
    return res.status(200).send(csvData);
  } catch (error) {
    logger.error("Error exporting CRM audit logs", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/crm/audit/:leadId
 * Retrieve paginated audit timeline for a specific lead.
 */
exports.getAuditLogsForLead = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const data = await crmAuditService.getAuditLogsForLead(req.user._id, req.params.leadId, req.query);
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    logger.error("Error retrieving lead audit logs", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};
