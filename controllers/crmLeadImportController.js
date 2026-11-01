// backend/controllers/crmLeadImportController.js
"use strict";

const path = require("node:path");
const logger = require("../utils/logger");
const crmLeadImportService = require("../services/crmLeadImportService");
const { resolveWriteScope } = require("../services/crmScope");

/**
 * POST /api/crm/leads/import
 * Handle CSV or Excel file upload to import leads into the CRM.
 */
exports.importLeads = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded. Please upload a CSV or Excel (.xlsx) file." });
    }

    const ext = path.extname(req.file.originalname || req.file.path).toLowerCase().replace(".", "");
    const fileType = ext === "xlsx" || ext === "xls" ? "xlsx" : "csv";

    // Leads belong to one business's CRM (owner, or an admin acting for the owner).
    let scope;
    try {
      scope = await resolveWriteScope(req, req.body?.businessId || req.query?.businessId);
    } catch (scopeError) {
      require("node:fs").promises.unlink(req.file.path).catch(() => {});
      throw scopeError;
    }
    const result = await crmLeadImportService.importLeads(scope.ownerId, req.file.path, fileType, {
      businessId: scope.businessId,
      performedBy: req.user._id,
    });
    return res.status(200).json(result);
  } catch (error) {
    logger.error("Controller error importing leads", { error: error.message });
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};
