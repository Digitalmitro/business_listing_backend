// backend/controllers/crmEngagementController.js
"use strict";

/**
 * CRM contact engagement API (authenticated): settings, templates, journeys, active
 * journeys, contact profiles and bulk contact imports. Everything is per business:
 * users manage their own businesses, admins act on the business owner's CRM
 * (crmScope.resolveWriteScope).
 */

const mongoose = require("mongoose");
const logger = require("../utils/logger");
const { resolveWriteScope } = require("../services/crmScope");
const CrmContact = require("../models/CrmContact");
const CrmEngagementTemplate = require("../models/CrmEngagementTemplate");
const CrmJourney = require("../models/CrmJourney");
const catalog = require("../services/crmEngagementCatalog");
const contactsService = require("../services/crmEngagementContactService");
const journeyService = require("../services/crmJourneyService");
const templateService = require("../services/crmEngagementTemplateService");
const importService = require("../services/crmContactImportService");
const signals = require("../services/crmSignalService");
const aiService = require("../services/crmEngagementAiService");
const automationService = require("../services/crmEmailAutomationService");

function sendError(res, error, event) {
  const status = error.status || 500;
  if (status >= 500) logger.error(event, "CRM engagement request failed", { error: error.message, status });
  return res.status(status).json({
    success: false,
    message: status >= 500 && !error.status ? "Something went wrong. Please try again." : error.message,
    ...(error.details ? { details: error.details } : {}),
  });
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

async function businessScope(req, businessId) {
  if (!businessId) throw badRequest("businessId is required");
  const scope = await resolveWriteScope(req, businessId);
  if (!scope.businessId) throw badRequest("A valid businessId is required");
  if (!scope.business.userId) throw badRequest("This business has no owner yet, so it has no CRM");
  return scope;
}

const businessIdOf = (req) => req.body?.businessId || req.query?.businessId;

/** Wraps a handler with scope resolution and uniform errors. */
function handler(event, fn) {
  return async (req, res) => {
    try {
      const scope = await businessScope(req, businessIdOf(req));
      return await fn(req, res, scope);
    } catch (error) {
      return sendError(res, error, event);
    }
  };
}

// ── Overview & settings ─────────────────────────────────────────────────────

exports.getCatalog = async (req, res) => {
  return res.status(200).json({
    success: true,
    catalog: catalog.getCatalog(),
    importFields: importService.FIELDS.map(({ key, label }) => ({ key, label })),
    aiEnabled: aiService.isConfigured(),
  });
};

/** GET /overview?businessId= — also copies in starter templates/journeys on first use. */
exports.getOverview = handler("crm_engagement.overview_failed", async (req, res, scope) => {
  await journeyService.seedBusiness(scope.business);
  const [settings, stats] = await Promise.all([contactsService.getSettings(scope.businessId), journeyService.overview(scope.businessId)]);
  return res.status(200).json({ success: true, settings, stats, aiEnabled: aiService.isConfigured() });
});

exports.saveSettings = handler("crm_engagement.settings_failed", async (req, res, scope) => {
  const { enabled, frequency, sendWindow, timezone, importDailyLimit, aiTriage, captureWidget } = req.body;
  const settings = await contactsService.saveSettings({
    ownerId: scope.ownerId,
    businessId: scope.businessId,
    input: { enabled, frequency, sendWindow, timezone, importDailyLimit, aiTriage, captureWidget },
    userId: req.user._id,
  });
  return res.status(200).json({ success: true, settings });
});

// ── Templates ───────────────────────────────────────────────────────────────

exports.listTemplates = handler("crm_engagement.templates_failed", async (req, res, scope) => {
  await journeyService.seedBusiness(scope.business);
  const templates = await templateService.listTemplates(scope.businessId, { includeArchived: req.query.archived === "true" });
  return res.status(200).json({ success: true, templates });
});

exports.createTemplate = handler("crm_engagement.template_save_failed", async (req, res, scope) => {
  const { name, purpose, tone, subject, body, approved, source } = req.body;
  const result = await templateService.saveTemplate({
    ownerId: scope.ownerId,
    businessId: scope.businessId,
    input: { name, purpose, tone, subject, body, approved: approved === true, source },
    userId: req.user._id,
  });
  return res.status(201).json({ success: true, ...result });
});

exports.updateTemplate = handler("crm_engagement.template_save_failed", async (req, res, scope) => {
  const { name, purpose, tone, subject, body, approved, source } = req.body;
  const result = await templateService.saveTemplate({
    ownerId: scope.ownerId,
    businessId: scope.businessId,
    templateId: req.params.id,
    input: { name, purpose, tone, subject, body, approved: approved === true, source },
    userId: req.user._id,
  });
  return res.status(200).json({ success: true, ...result });
});

exports.approveTemplate = handler("crm_engagement.template_approve_failed", async (req, res, scope) => {
  const result = await templateService.approveTemplate({ businessId: scope.businessId, templateId: req.params.id, userId: req.user._id });
  return res.status(200).json({ success: true, ...result });
});

exports.duplicateTemplate = handler("crm_engagement.template_duplicate_failed", async (req, res, scope) => {
  const result = await templateService.duplicateTemplate({ ownerId: scope.ownerId, businessId: scope.businessId, templateId: req.params.id, userId: req.user._id });
  return res.status(201).json({ success: true, ...result });
});

exports.archiveTemplate = handler("crm_engagement.template_archive_failed", async (req, res, scope) => {
  const result = await templateService.archiveTemplate({ businessId: scope.businessId, templateId: req.params.id, archived: req.body.archived !== false });
  return res.status(200).json({ success: true, ...result });
});

exports.previewTemplate = handler("crm_engagement.template_preview_failed", async (req, res, scope) => {
  const preview = await templateService.previewTemplate({
    business: scope.business,
    subject: req.body.subject,
    body: req.body.body,
    contactId: req.body.contactId,
  });
  return res.status(200).json({ success: true, preview });
});

// ── AI ──────────────────────────────────────────────────────────────────────

/** POST /ai/template — returns a draft only; never saves. */
exports.aiTemplate = handler("crm_engagement.ai_template_failed", async (req, res, scope) => {
  const { action, purpose, tone, instruction, subject, body, previousSubject } = req.body;
  const draft = await aiService.draftTemplate({ businessId: scope.businessId, action, purpose, tone, instruction, subject, body, previousSubject });
  return res.status(200).json({ success: true, draft });
});

/** POST /ai/plan — proposes journeys; nothing is saved until /ai/plan/apply. */
exports.aiPlan = handler("crm_engagement.ai_plan_failed", async (req, res, scope) => {
  await journeyService.seedBusiness(scope.business);
  const [templates, journeys] = await Promise.all([
    CrmEngagementTemplate.find({ businessId: scope.businessId, archived: false }).select("_id name purpose subject").lean(),
    CrmJourney.find({ businessId: scope.businessId }).select("name trigger isEnabled").lean(),
  ]);
  const proposal = await aiService.planJourneys({ businessId: scope.businessId, templates, existingJourneys: journeys, instruction: req.body.instruction });
  return res.status(200).json({ success: true, proposal });
});

/**
 * POST /ai/plan/apply — creates the proposed templates (unapproved) and journeys
 * (switched off). The owner still reviews, approves and switches each one on.
 */
exports.aiPlanApply = handler("crm_engagement.ai_apply_failed", async (req, res, scope) => {
  const templates = await CrmEngagementTemplate.find({ businessId: scope.businessId, archived: false }).select("_id name purpose subject").lean();
  // Re-validate the proposal as sent back by the browser.
  const plan = aiService.validatePlan(
    {
      summary: req.body.proposal?.summary,
      newTemplates: req.body.proposal?.newTemplates || [],
      journeys: (req.body.proposal?.journeys || []).map((j) => ({
        name: j.name,
        goal: j.goal,
        rationale: j.rationale,
        trigger: j.trigger?.signal || j.trigger,
        triggerParam: j.triggerParam || 0,
        triggerParams: j.trigger?.params || null,
        priority: j.priority,
        reentryDays: j.reentryDays,
        exitOn: j.exitOn,
        steps: (j.steps || []).map((s) => ({ template: s.templateId || s.template, delayAmount: s.delay?.amount ?? s.delayAmount, delayUnit: s.delay?.unit || s.delayUnit, condition: s.condition })),
      })),
    },
    templates
  );
  const refToId = {};
  const createdTemplates = [];
  for (const t of plan.newTemplates) {
    const { template } = await templateService.saveTemplate({
      ownerId: scope.ownerId,
      businessId: scope.businessId,
      input: { name: t.name, purpose: t.purpose, tone: t.tone, subject: t.subject, body: t.body, source: "ai" },
      userId: req.user._id,
    });
    refToId[t.ref] = String(template._id);
    createdTemplates.push(template);
  }
  const createdJourneys = [];
  for (const j of plan.journeys) {
    const steps = j.steps.map((s) => ({ ...s, templateId: refToId[s.templateId] || s.templateId }));
    const { journey } = await journeyService.saveJourney({
      ownerId: scope.ownerId,
      businessId: scope.businessId,
      input: { ...j, steps },
      userId: req.user._id,
      source: "ai",
    });
    createdJourneys.push(journey);
  }
  return res.status(201).json({ success: true, templates: createdTemplates, journeys: createdJourneys, warnings: plan.warnings });
});

// ── Journeys ────────────────────────────────────────────────────────────────

exports.listJourneys = handler("crm_engagement.journeys_failed", async (req, res, scope) => {
  await journeyService.seedBusiness(scope.business);
  const journeys = await journeyService.listJourneys(scope.businessId);
  return res.status(200).json({ success: true, journeys });
});

function journeyInput(body) {
  const { name, goal, trigger, steps, exitOn, priority, reentryDays } = body;
  return { name, goal, trigger, steps, exitOn, priority, reentryDays };
}

exports.createJourney = handler("crm_engagement.journey_save_failed", async (req, res, scope) => {
  const result = await journeyService.saveJourney({ ownerId: scope.ownerId, businessId: scope.businessId, input: journeyInput(req.body), userId: req.user._id });
  return res.status(201).json({ success: true, ...result });
});

exports.updateJourney = handler("crm_engagement.journey_save_failed", async (req, res, scope) => {
  const result = await journeyService.saveJourney({
    ownerId: scope.ownerId,
    businessId: scope.businessId,
    journeyId: req.params.id,
    input: journeyInput(req.body),
    userId: req.user._id,
  });
  return res.status(200).json({ success: true, ...result });
});

exports.setJourneyEnabled = handler("crm_engagement.journey_toggle_failed", async (req, res, scope) => {
  if (typeof req.body.isEnabled !== "boolean") throw badRequest("isEnabled must be true or false");
  const journey = await journeyService.setJourneyEnabled({ businessId: scope.businessId, journeyId: req.params.id, isEnabled: req.body.isEnabled, userId: req.user._id });
  return res.status(200).json({ success: true, journey });
});

exports.deleteJourney = handler("crm_engagement.journey_delete_failed", async (req, res, scope) => {
  const result = await journeyService.deleteJourney({ businessId: scope.businessId, journeyId: req.params.id });
  return res.status(200).json({ success: true, ...result });
});

// ── Active journeys ─────────────────────────────────────────────────────────

exports.listEnrollments = handler("crm_engagement.enrollments_failed", async (req, res, scope) => {
  const data = await journeyService.listEnrollments(scope.businessId, req.query);
  return res.status(200).json({ success: true, ...data });
});

exports.stopEnrollment = handler("crm_engagement.enrollment_stop_failed", async (req, res, scope) => {
  const result = await journeyService.stopEnrollment({ businessId: scope.businessId, enrollmentId: req.params.id, userName: req.user.full_name || req.user.name || "the business" });
  return res.status(200).json({ success: true, ...result });
});

exports.enrollContact = handler("crm_engagement.enroll_failed", async (req, res, scope) => {
  const result = await journeyService.enrollManually({ businessId: scope.businessId, journeyId: req.body.journeyId, contactId: req.body.contactId });
  return res.status(201).json({ success: true, ...result });
});

/** GET /emails — engagement and automation email history with delivery status. */
exports.listEmails = handler("crm_engagement.emails_failed", async (req, res, scope) => {
  const data = await automationService.listDispatches(scope.businessId, req.query);
  return res.status(200).json({ success: true, ...data });
});

// ── Contacts ────────────────────────────────────────────────────────────────

exports.getContactProfile = handler("crm_engagement.profile_failed", async (req, res, scope) => {
  const profile = await contactsService.getContactProfile({ businessId: scope.businessId }, req.params.id);
  return res.status(200).json({ success: true, ...profile });
});

/**
 * PATCH /contacts/:id/email-preferences — the owner records a contact's email
 * preference: unsubscribe, resubscribe (only with their permission), or confirm
 * permission to email them.
 */
exports.setEmailPreferences = handler("crm_engagement.preferences_failed", async (req, res, scope) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw badRequest("Invalid contact");
  const contact = await CrmContact.findOne({ _id: req.params.id, businessId: scope.businessId }).lean();
  if (!contact) {
    const err = new Error("Contact not found");
    err.status = 404;
    throw err;
  }
  const { status, permissionConfirmed } = req.body;
  if (status === "unsubscribed") {
    await signals.onContactUnsubscribed(contact._id, { reason: "Unsubscribed by the business" });
  } else if (status === "subscribed") {
    if (permissionConfirmed !== true) throw badRequest("Confirm the contact asked to receive emails again before resubscribing them");
    if (contact.emailStatus === "bounced") throw badRequest("This address bounced. Update the email address instead.");
    await contactsService.setEmailStatus(contact._id, "subscribed", { reason: "Resubscribed by the business with the contact's permission" });
    await CrmContact.updateOne({ _id: contact._id }, { $set: { consent: { basis: "manual_confirmed", capturedAt: new Date() } } });
  } else if (permissionConfirmed === true) {
    if ((contact.consent?.basis || "unknown") === "unknown") {
      await CrmContact.updateOne({ _id: contact._id }, { $set: { consent: { basis: "manual_confirmed", capturedAt: new Date() } } });
    }
  } else {
    throw badRequest("Nothing to change");
  }
  const profile = await contactsService.getContactProfile({ businessId: scope.businessId }, contact._id);
  return res.status(200).json({ success: true, ...profile });
});

/** POST /contacts/bulk — tag, untag, unsubscribe or confirm permission for many contacts. */
exports.bulkContacts = handler("crm_engagement.bulk_failed", async (req, res, scope) => {
  const { action, contactIds, tags } = req.body;
  const ids = (Array.isArray(contactIds) ? contactIds : []).filter((id) => mongoose.isValidObjectId(id)).slice(0, 1000);
  if (!ids.length) throw badRequest("Select at least one contact");
  const cleanTags = (Array.isArray(tags) ? tags : String(tags || "").split(",")).map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 10);
  const filter = { _id: { $in: ids }, businessId: scope.businessId };
  let affected = 0;
  if (action === "tag" || action === "untag") {
    if (!cleanTags.length) throw badRequest("Enter at least one tag");
    const update = action === "tag" ? { $addToSet: { tags: { $each: cleanTags } } } : { $pull: { tags: { $in: cleanTags } } };
    affected = (await CrmContact.updateMany(filter, update)).modifiedCount;
  } else if (action === "unsubscribe") {
    const found = await CrmContact.find({ ...filter, emailStatus: "subscribed" }).select("_id").lean();
    for (const c of found) await signals.onContactUnsubscribed(c._id, { reason: "Unsubscribed by the business" });
    affected = found.length;
  } else if (action === "confirm_permission") {
    affected = (await CrmContact.updateMany({ ...filter, "consent.basis": { $in: ["unknown", null] } }, { $set: { consent: { basis: "manual_confirmed", capturedAt: new Date() } } })).modifiedCount;
  } else {
    throw badRequest("Unknown bulk action");
  }
  return res.status(200).json({ success: true, affected });
});

/** POST /contacts/sync-existing — bring leads with emails and booking customers into Contacts. */
exports.syncExisting = handler("crm_engagement.sync_failed", async (req, res, scope) => {
  const summary = await contactsService.syncExistingPeople(scope.business);
  return res.status(200).json({ success: true, summary });
});

// ── Imports ─────────────────────────────────────────────────────────────────

exports.analyzeImport = async (req, res) => {
  try {
    const scope = await businessScope(req, req.body?.businessId);
    const result = await importService.analyzeImport({ business: scope.business, file: req.file, userId: req.user._id, useAi: req.body?.useAi !== "false" });
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    if (req.file?.path) require("node:fs").rm(req.file.path, { force: true }, () => {});
    return sendError(res, error, "crm_engagement.import_analyze_failed");
  }
};

exports.validateImport = handler("crm_engagement.import_validate_failed", async (req, res, scope) => {
  const dryRun = await importService.validateMapping({ businessId: scope.businessId, importId: req.params.id, mapping: req.body.mapping });
  return res.status(200).json({ success: true, dryRun });
});

exports.commitImport = handler("crm_engagement.import_commit_failed", async (req, res, scope) => {
  const result = await importService.commitImport({ business: scope.business, importId: req.params.id, mapping: req.body.mapping, options: req.body.options, userId: req.user._id });
  return res.status(200).json({ success: true, ...result });
});

exports.listImports = handler("crm_engagement.imports_failed", async (req, res, scope) => {
  const data = await importService.listImports(scope.businessId, req.query);
  return res.status(200).json({ success: true, ...data });
});

exports.getImport = handler("crm_engagement.import_failed", async (req, res, scope) => {
  const doc = await importService.getImport(scope.businessId, req.params.id);
  return res.status(200).json({ success: true, import: { ...doc, rowErrors: (doc.rowErrors || []).slice(0, 200) } });
});

exports.importErrorsCsv = handler("crm_engagement.import_errors_failed", async (req, res, scope) => {
  const { fileName, csv } = await importService.errorsCsv(scope.businessId, req.params.id);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  return res.status(200).send(csv);
});

exports.retriageImport = handler("crm_engagement.import_retriage_failed", async (req, res, scope) => {
  const result = await importService.retriage({ businessId: scope.businessId, importId: req.params.id });
  return res.status(200).json({ success: true, ...result });
});
