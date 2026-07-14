// backend/controllers/crmFollowUpController.js
"use strict";

const logger = require("../utils/logger");
const crmFollowUpService = require("../services/crmFollowUpService");

/**
 * GET /api/crm/leads/followup/config
 * Retrieve owner's CRM follow-up config.
 */
exports.getConfig = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const config = await crmFollowUpService.getOrUpdateConfig(req.user._id);
    return res.status(200).json({ success: true, config });
  } catch (error) {
    logger.error("Error retrieving CRM follow-up config", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/crm/leads/followup/config
 * Update owner's CRM follow-up config.
 */
exports.updateConfig = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const config = await crmFollowUpService.getOrUpdateConfig(req.user._id, req.body);
    return res.status(200).json({ success: true, config });
  } catch (error) {
    logger.error("Error updating CRM follow-up config", { error: error.message });
    const status = error.message.includes("min") || error.message.includes("Invalid") ? 400 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/crm/leads/followup/logs
 * Retrieve follow-up attempt & retry logs.
 */
exports.getLogs = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const data = await crmFollowUpService.getFollowUpLogs(req.user._id, req.query);
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    logger.error("Error retrieving CRM follow-up logs", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/crm/leads/followup/process
 * Manually trigger background scheduler scan across owner's eligible leads.
 */
exports.processFollowUps = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const { dryRun } = req.body || {};
    const summary = await crmFollowUpService.processAutomatedFollowUps({
      ownerId: req.user._id,
      dryRun: Boolean(dryRun),
    });
    return res.status(200).json({ success: true, summary });
  } catch (error) {
    logger.error("Error processing automated follow-ups", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/crm/leads/followup/retry
 * Manually trigger retry scan across all failed follow-up attempts for the owner.
 */
exports.retryFailed = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const summary = await crmFollowUpService.retryFailedFollowUps(req.user._id);
    return res.status(200).json({ success: true, summary });
  } catch (error) {
    logger.error("Error retrying failed follow-ups", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/crm/leads/:id/followup/trigger
 * Manually trigger a follow-up email for a specific lead.
 */
exports.triggerForLead = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const { force } = req.body || {};
    const result = await crmFollowUpService.triggerLeadFollowUp(req.user._id, req.params.id, {
      force: Boolean(force),
    });

    const status = result.success ? 200 : result.status === "skipped" ? 200 : 400;
    return res.status(status).json({ success: result.success, ...result });
  } catch (error) {
    logger.error("Error triggering follow-up for single lead", { error: error.message });
    const status = error.message.includes("not found") ? 404 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};
