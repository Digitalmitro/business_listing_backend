"use strict";

/**
 * A business's engagement email template library: starter copies, the owner's own
 * templates, duplicates and AI drafts. Same approval rule as email automations: an
 * edit clears the approval, and journeys that use an unapproved template are
 * switched off until the owner previews and approves it again.
 */

const mongoose = require("mongoose");
const CrmEngagementTemplate = require("../models/CrmEngagementTemplate");
const CrmJourney = require("../models/CrmJourney");
const CrmContact = require("../models/CrmContact");
const automationCatalog = require("./crmEmailAutomationCatalog");
const catalog = require("./crmEngagementCatalog");
const journeys = require("./crmJourneyService");
const { getListingUrl } = require("../utils/emailPlaceholders");
const logger = require("../utils/logger");

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function frontendUrl() {
  return (process.env.FRONTEND_URL || "https://urbancitations.com").replace(/\/+$/, "");
}

async function listTemplates(businessId, { includeArchived = false } = {}) {
  const filter = { businessId };
  if (!includeArchived) filter.archived = false;
  const [templates, usage] = await Promise.all([
    CrmEngagementTemplate.find(filter).sort({ archived: 1, createdAt: 1 }).lean(),
    CrmJourney.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(String(businessId)) } },
      { $unwind: "$steps" },
      { $group: { _id: "$steps.templateId", journeys: { $addToSet: { id: "$_id", name: "$name", isEnabled: "$isEnabled" } } } },
    ]),
  ]);
  const usedBy = Object.fromEntries(usage.map((u) => [String(u._id), u.journeys]));
  return templates.map((t) => ({ ...t, usedBy: usedBy[String(t._id)] || [] }));
}

async function findTemplate(businessId, templateId) {
  if (!mongoose.isValidObjectId(templateId)) throw httpError(404, "Template not found");
  const doc = await CrmEngagementTemplate.findOne({ _id: templateId, businessId });
  if (!doc) throw httpError(404, "Template not found");
  return doc;
}

function cleanMeta(input, existing = {}) {
  const name = String(input.name ?? existing.name ?? "").trim().slice(0, 100);
  if (!name) throw httpError(400, "Template name is required");
  const purpose = catalog.TEMPLATE_PURPOSES[input.purpose] ? input.purpose : existing.purpose || "other";
  const tone = automationCatalog.TONES.includes(input.tone) ? input.tone : input.tone === null ? null : existing.tone ?? null;
  return { name, purpose, tone };
}

/**
 * Creates or updates a template. `approved: true` records approval of exactly this
 * wording; changing the wording otherwise clears approval and switches off the
 * journeys that use it. Returns { template, notices }.
 */
async function saveTemplate({ ownerId, businessId, templateId, input = {}, userId }) {
  const { subject, body } = catalog.validateEngagementTemplate(input);
  const notices = [];
  let doc;
  if (templateId) {
    doc = await findTemplate(businessId, templateId);
  } else {
    doc = new CrmEngagementTemplate({ ownerId, businessId, source: input.source === "ai" ? "ai" : "custom" });
  }
  const meta = cleanMeta(input, doc);
  const wordingChanged = doc.isNew || doc.subject !== subject || doc.body !== body;
  Object.assign(doc, meta, { subject, body, updatedBy: userId || null });
  if (wordingChanged && !doc.isNew && input.source === "ai") doc.source = "ai";
  else if (wordingChanged && !doc.isNew && doc.source === "starter") doc.source = "custom";

  if (input.approved === true) {
    doc.approvedAt = new Date();
    doc.approvedBy = userId || null;
  } else if (wordingChanged) {
    const wasApproved = Boolean(doc.approvedAt);
    doc.approvedAt = null;
    doc.approvedBy = null;
    if (wasApproved) notices.push("The wording changed, so this template needs approval again before it is sent.");
  }
  await doc.save();
  if (!doc.approvedAt) {
    const switchedOff = await journeys.disableJourneysUsingTemplate(businessId, doc._id);
    if (switchedOff) notices.push(`${switchedOff} journey(s) using this template were switched off until it is approved.`);
  }
  logger.info("crm_engagement.template_saved", "Engagement template saved", { businessId: String(businessId), templateId: String(doc._id), approved: Boolean(doc.approvedAt) });
  return { template: doc.toObject(), notices };
}

async function approveTemplate({ businessId, templateId, userId }) {
  const doc = await findTemplate(businessId, templateId);
  if (doc.archived) throw httpError(400, "Restore this template before approving it");
  catalog.validateEngagementTemplate(doc);
  doc.approvedAt = new Date();
  doc.approvedBy = userId || null;
  await doc.save();
  return { template: doc.toObject() };
}

async function duplicateTemplate({ ownerId, businessId, templateId, userId }) {
  const source = await findTemplate(businessId, templateId);
  const copy = await CrmEngagementTemplate.create({
    ownerId,
    businessId,
    name: `${source.name} (copy)`.slice(0, 100),
    purpose: source.purpose,
    tone: source.tone,
    source: "duplicate",
    subject: source.subject,
    body: source.body,
    updatedBy: userId || null,
  });
  return { template: copy.toObject() };
}

/** Archives a template. Templates used by a journey can't be archived. */
async function archiveTemplate({ businessId, templateId, archived = true }) {
  const doc = await findTemplate(businessId, templateId);
  if (archived) {
    const inUse = await CrmJourney.find({ businessId, "steps.templateId": doc._id }).select("name").lean();
    if (inUse.length) {
      throw httpError(400, `This template is used by: ${inUse.map((j) => j.name).join(", ")}. Change those journeys first.`);
    }
  }
  doc.archived = Boolean(archived);
  await doc.save();
  return { template: doc.toObject() };
}

/**
 * Renders a template as a contact would receive it: sample values (or a real
 * contact's own name and viewed items when `contactId` is given), the real business
 * name and links, and an unsubscribe footer.
 */
async function previewTemplate({ business, subject, body, contactId }) {
  const clean = catalog.validateEngagementTemplate({ subject, body });
  let contact = {
    name: automationCatalog.VARIABLES.lead_name.sample,
    interests: [{ kind: "service", name: automationCatalog.VARIABLES.service_name.sample, lastViewedAt: new Date() }],
  };
  if (contactId) {
    if (!mongoose.isValidObjectId(contactId)) throw httpError(404, "Contact not found");
    const real = await CrmContact.findOne({ _id: contactId, businessId: business._id }).select("name interests bookings").lean();
    if (!real) throw httpError(404, "Contact not found for this business");
    contact = real;
  }
  const values = catalog.buildEngagementValues({
    business,
    contact,
    enrollment: null,
    appointment: null,
    listingUrl: getListingUrl(business),
    bookingPageUrl: `${frontendUrl()}/booking?businessId=${business._id}`,
    bookingHistoryUrl: `${frontendUrl()}/bookinghistory`,
  });
  const rendered = automationCatalog.renderTemplate(clean, values);
  const footer = `<p style="color:#888;font-size:12px;margin-top:24px;">You're receiving this because you're in touch with ${automationCatalog.escapeHtml(business.businessName)}.</p><br><br><a href="#" style="color:#888;font-size:12px;">Unsubscribe</a>`;
  return { subject: rendered.subject, html: `${rendered.body}${footer}`, warnings: clean.warnings };
}

module.exports = {
  listTemplates,
  findTemplate,
  saveTemplate,
  approveTemplate,
  duplicateTemplate,
  archiveTemplate,
  previewTemplate,
};
