// backend/controllers/crmReplyController.js
"use strict";

const logger = require("../utils/logger");
const crmReplyTrackingService = require("../services/crmReplyTrackingService");

/**
 * POST /api/crm/leads/replies/reply-webhook
 * Inbound webhook endpoint for mail servers / external integrations to submit incoming email replies.
 * Accepts { fromEmail, subject, body, leadId, ownerId }.
 */
exports.handleInboundWebhook = async (req, res) => {
  try {
    const { fromEmail, from, subject, body, text, leadId, ownerId } = req.body || {};
    const resolvedBody = body || text || "";
    const resolvedFromEmail = fromEmail || from || null;

    if (!resolvedBody.trim()) {
      return res.status(400).json({ success: false, message: "Reply body text is required" });
    }

    if (!leadId && !resolvedFromEmail) {
      return res.status(400).json({
        success: false,
        message: "Either leadId or fromEmail must be provided to identify target lead",
      });
    }

    const result = await crmReplyTrackingService.processIncomingReply({
      ownerId: ownerId || null,
      leadId: leadId || null,
      fromEmail: resolvedFromEmail,
      subject: subject || "",
      body: resolvedBody,
      receivedAt: new Date(),
    });

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error("Error processing inbound email reply webhook", { error: error.message });
    const status = error.message.includes("not found") ? 404 : error.message.includes("required") ? 400 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/crm/leads/replies/:id/reply
 * Authenticated endpoint allowing sales reps or integrations to log/process an incoming reply for a specific lead.
 */
exports.handleManualReply = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const { subject, body, fromEmail } = req.body || {};

    if (!body || !body.trim()) {
      return res.status(400).json({ success: false, message: "Reply body text is required" });
    }

    const result = await crmReplyTrackingService.processIncomingReply({
      ownerId: req.user._id,
      leadId: req.params.id,
      fromEmail: fromEmail || null,
      subject: subject || "",
      body: body,
      receivedAt: new Date(),
    });

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error("Error processing manual lead reply", { error: error.message });
    const status = error.message.includes("not found") ? 404 : error.message.includes("required") ? 400 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/crm/leads/replies/logs
 * Retrieve paginated email reply logs and classification outcomes.
 */
exports.getLogs = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const data = await crmReplyTrackingService.getReplyLogs(req.user._id, req.query);
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    logger.error("Error retrieving CRM reply logs", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};
