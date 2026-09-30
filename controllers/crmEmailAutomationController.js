// backend/controllers/crmEmailAutomationController.js
"use strict";

const logger = require("../utils/logger");
const { resolveWriteScope } = require("../services/crmScope");
const catalog = require("../services/crmEmailAutomationCatalog");
const automationService = require("../services/crmEmailAutomationService");
const aiService = require("../services/crmEmailAiService");

function sendError(res, error, event) {
  const status = error.status || 500;
  if (status >= 500) logger.error(event, "CRM email automation request failed", { error: error.message, status });
  return res.status(status).json({
    success: false,
    message: status >= 500 && !error.status ? "Something went wrong. Please try again." : error.message,
    ...(error.details ? { details: error.details } : {}),
  });
}

/**
 * Every automation belongs to one business. Users may only manage their own
 * businesses; admins act on the business owner's CRM (see resolveWriteScope).
 */
async function businessScope(req, businessId) {
  if (!businessId) {
    const err = new Error("businessId is required");
    err.status = 400;
    throw err;
  }
  const scope = await resolveWriteScope(req, businessId);
  if (!scope.businessId) {
    const err = new Error("A valid businessId is required");
    err.status = 400;
    throw err;
  }
  return scope;
}

function requireTrigger(trigger) {
  if (!catalog.TRIGGERS[trigger]) {
    const err = new Error(`Unknown trigger '${trigger}'`);
    err.status = 400;
    throw err;
  }
}

/** GET /api/crm/email-automation/catalog */
exports.getCatalog = async (req, res) => {
  return res.status(200).json({ success: true, catalog: catalog.getCatalog(), aiEnabled: aiService.isConfigured() });
};

/** GET /api/crm/email-automation?businessId= */
exports.listAutomations = async (req, res) => {
  try {
    const scope = await businessScope(req, req.query.businessId);
    const automations = await automationService.listAutomations(scope.businessId);
    return res.status(200).json({ success: true, automations, aiEnabled: aiService.isConfigured() });
  } catch (error) {
    return sendError(res, error, "crm_email_automation.list_failed");
  }
};

/** PUT /api/crm/email-automation/:trigger — save template + timing (+ approval / enable). */
exports.saveAutomation = async (req, res) => {
  try {
    requireTrigger(req.params.trigger);
    const scope = await businessScope(req, req.body.businessId);
    const { presetKey, name, tone, source, subject, body, timing, approved, isEnabled } = req.body;
    const result = await automationService.saveAutomation({
      ownerId: scope.ownerId,
      businessId: scope.businessId,
      trigger: req.params.trigger,
      input: { presetKey, name, tone, source, subject, body, timing, approved: approved === true, isEnabled },
      userId: req.user._id,
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, "crm_email_automation.save_failed");
  }
};

/** PATCH /api/crm/email-automation/:trigger/enabled */
exports.setEnabled = async (req, res) => {
  try {
    requireTrigger(req.params.trigger);
    if (typeof req.body.isEnabled !== "boolean") {
      return res.status(400).json({ success: false, message: "isEnabled must be true or false" });
    }
    const scope = await businessScope(req, req.body.businessId);
    const result = await automationService.setEnabled({
      businessId: scope.businessId,
      trigger: req.params.trigger,
      isEnabled: req.body.isEnabled,
      userId: req.user._id,
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, "crm_email_automation.toggle_failed");
  }
};

/** POST /api/crm/email-automation/preview */
exports.preview = async (req, res) => {
  try {
    requireTrigger(req.body.trigger);
    const scope = await businessScope(req, req.body.businessId);
    const preview = await automationService.previewTemplate({
      business: scope.business,
      trigger: req.body.trigger,
      subject: req.body.subject,
      body: req.body.body,
      leadId: req.body.leadId,
    });
    return res.status(200).json({ success: true, preview });
  } catch (error) {
    return sendError(res, error, "crm_email_automation.preview_failed");
  }
};

/** POST /api/crm/email-automation/ai/generate — returns a draft only; never saves. */
exports.generateWithAi = async (req, res) => {
  try {
    requireTrigger(req.body.trigger);
    const scope = await businessScope(req, req.body.businessId);
    const { trigger, action, tone, instruction, subject, body, previousSubject } = req.body;
    const draft = await aiService.generateEmail({
      trigger,
      action,
      tone,
      instruction,
      subject,
      body,
      previousSubject,
      businessName: scope.business?.businessName,
    });
    return res.status(200).json({ success: true, draft });
  } catch (error) {
    return sendError(res, error, "crm_email_automation.ai_failed");
  }
};

/** GET /api/crm/email-automation/logs?businessId=&trigger=&status=&page=&limit= */
exports.getLogs = async (req, res) => {
  try {
    const scope = await businessScope(req, req.query.businessId);
    const data = await automationService.listDispatches(scope.businessId, req.query);
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return sendError(res, error, "crm_email_automation.logs_failed");
  }
};

/**
 * POST /api/crm/email-automation/events/view — a signed-in customer opened a
 * business listing. Always 202 so callers cannot probe who is a lead.
 */
exports.recordListingView = async (req, res) => {
  const { businessId, serviceName } = req.body || {};
  if (!req.isAdmin && req.user && businessId) {
    automationService.onListingViewed({ businessId, viewer: req.user, serviceName }).catch(() => {});
  }
  return res.status(202).json({ success: true });
};
