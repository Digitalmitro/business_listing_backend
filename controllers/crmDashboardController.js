// backend/controllers/crmDashboardController.js
"use strict";

const logger = require("../utils/logger");
const { readScope } = require("../services/crmScope");
const crmDashboardService = require("../services/crmDashboardService");

/**
 * GET /api/crm/dashboard/summary
 * Retrieve unified executive summary covering social accounts, posts, leads, revenue, pipeline, calendar, follow-ups, and activity feed.
 */
exports.getDashboardSummary = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }
    const summary = await crmDashboardService.getDashboardSummary(readScope(req), { businessId: req.query?.businessId });
    return res.status(200).json(summary);
  } catch (error) {
    logger.error("Error retrieving CRM dashboard summary", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};
