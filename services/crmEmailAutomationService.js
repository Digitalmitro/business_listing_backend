"use strict";

/**
 * CRM email automation: per-business trigger configuration, trigger detection,
 * scheduling, sending and delivery status.
 *
 * Flow
 *   event (lead created / listing viewed / booking created)  ─┐
 *   scheduler sweep (reminders, booking day, after-booking)  ─┴─> CrmEmailDispatch (unique dedupeKey)
 *     -> BullMQ "crm-email-automation" job, or the next sweep  -> processDispatch()
 *     -> re-check automation / booking / lead / unsubscribe    -> render template -> send
 *     -> status sent | failed (retried with backoff) | skipped, plus a lead timeline entry
 *
 * Event handlers never throw, so automation problems can never break a booking,
 * an enquiry or a page view.
 */

const mongoose = require("mongoose");
const moment = require("moment");
const validator = require("validator");
const catalog = require("./crmEmailAutomationCatalog");
const CrmEmailAutomation = require("../models/CrmEmailAutomation");
const CrmEmailDispatch = require("../models/CrmEmailDispatch");
const Appointment = require("../models/Appointment");
const Business = require("../models/Business");
const Enquiry = require("../models/Enquiry");
const SenderEmail = require("../models/SenderEmail");
const UnsubscribedEmail = require("../models/UnsubscribedEmail");
const User = require("../models/User");
const { CrmLead, LEAD_STAGE, WON_STATUSES, LOST_STATUSES } = require("../models/CrmLead");
const { appointmentStartTime } = require("./crmScope");
const { getListingUrl } = require("../utils/emailPlaceholders");
const { addJob } = require("../utils/queue");
const logger = require("../utils/logger");

const QUEUE_NAME = "crm-email-automation";
const MAX_ATTEMPTS = Math.max(1, Number(process.env.CRM_EMAIL_AUTOMATION_MAX_ATTEMPTS) || 3);
const RETRY_BASE_MS = 5 * 60 * 1000;
const STALE_SENDING_MS = 15 * 60 * 1000;
const SEND_BATCH_SIZE = 200;

/** Leads in these stages have converted or dropped out, so no "come back" emails. */
const LEAD_TRIGGER_EXCLUDED_STATUSES = [LEAD_STAGE.BOOKED, ...WON_STATUSES, ...LOST_STATUSES];
const BOOKING_TRIGGERS = ["booking_created", ...catalog.SCHEDULED_TRIGGERS];

function dbReady() {
  return Boolean(mongoose.connection && mongoose.connection.readyState === 1);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function frontendUrl() {
  return (process.env.FRONTEND_URL || "https://urbancitations.com").replace(/\/+$/, "");
}

function backendUrl() {
  return (process.env.BACKEND_URL || "https://server.urbancitations.com").replace(/\/+$/, "");
}

/** Public unsubscribe endpoint (see unsubscribeController); adds the address to UnsubscribedEmail. */
function buildUnsubscribeLink(email) {
  return `${backendUrl()}/api/unsubscribe?email=${encodeURIComponent(email)}&source=crm_followup&format=html`;
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

function buildDedupeKey(trigger, { leadId, appointmentId, now = new Date() } = {}) {
  if (catalog.TRIGGERS[trigger]?.anchor !== "event" || trigger === "booking_created") {
    return `${trigger}:appt:${appointmentId}`;
  }
  if (trigger === "lead_viewed") {
    // At most one "you viewed us" email per lead per calendar month.
    return `${trigger}:lead:${leadId}:${moment(now).format("YYYY-MM")}`;
  }
  return `${trigger}:lead:${leadId}`;
}

/** Exponential backoff for failed deliveries: 5, 10, 20 ... minutes. */
function nextRetryAt(attempts, now = new Date()) {
  return new Date(now.getTime() + RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * Appointment date window to scan for a scheduled trigger, from the send window
 * [now - lateness, now]. Appointment dates are stored as the start of the day.
 */
function appointmentScanWindow(trigger, timing, now = new Date()) {
  const def = catalog.TRIGGERS[trigger];
  const lateness = catalog.LATENESS[def.anchor];
  const offset = catalog.timingOffsetMs(timing);
  let startMin;
  let startMax;
  if (def.anchor === "before_booking") {
    startMin = now.getTime() - lateness + offset;
    startMax = now.getTime() + offset;
  } else if (def.anchor === "after_booking") {
    startMin = now.getTime() - lateness - offset;
    startMax = now.getTime() - offset;
  } else {
    startMin = now.getTime() - lateness;
    startMax = moment(now).endOf("day").valueOf();
  }
  return {
    from: moment(startMin).startOf("day").subtract(1, "day").toDate(),
    to: new Date(startMax),
  };
}

/** Values for the template variables. */
function buildVariableValues({ business, lead, customer, appointment, context } = {}) {
  const fullName = lead?.leadName || customer?.full_name || "";
  const viewed = appointment?.serviceName || context?.serviceName || business?.businessName || "";
  return {
    name: String(fullName).trim().split(/\s+/)[0] || "there",
    viewed_item: viewed,
    viewed_items: viewed,
    lead_name: fullName || "there",
    business_name: business?.businessName || "",
    store_name: business?.businessName || "",
    service_name: appointment?.serviceName || context?.serviceName || "",
    booking_date: appointment?.appointmentDate ? moment(appointment.appointmentDate).format("dddd, MMMM Do YYYY") : "",
    booking_time: appointment?.timeSlot || "",
    booking_link: `${frontendUrl()}/bookinghistory`,
    listing_url: business ? getListingUrl(business) : frontendUrl(),
  };
}

/**
 * Reason a claimed dispatch must not be sent, or null to send it. Re-checked at
 * send time because bookings get canceled and automations get switched off after
 * an email was scheduled.
 */
function skipReason(dispatch, { automation, business, lead, appointment }, now = new Date()) {
  if (!automation || !automation.isEnabled) return "Automation is switched off";
  if (!automation.template?.approvedAt) return "Template is not approved";
  if (!business) return "Business no longer exists";

  if (BOOKING_TRIGGERS.includes(dispatch.trigger)) {
    if (!appointment) return "Booking no longer exists";
    if (appointment.status === "Canceled") return "Booking was canceled";
    if (appointment.status === "Rescheduled") return "Booking was rescheduled (the new booking gets its own emails)";
    const anchor = catalog.TRIGGERS[dispatch.trigger].anchor;
    if (anchor === "before_booking" || anchor === "booking_day") {
      const start = appointmentStartTime(appointment);
      if (start && start <= now) return "Booking has already started";
    }
  } else {
    if (!lead) return "Lead no longer exists";
    if (dispatch.trigger === "lead_viewed" && LEAD_TRIGGER_EXCLUDED_STATUSES.includes(lead.status)) {
      return `Lead is already ${lead.status}`;
    }
  }
  return null;
}

// ── Configuration ───────────────────────────────────────────────────────────

/** Stored timing, or the trigger default if it is missing or no longer valid. */
function safeTiming(trigger, timing) {
  try {
    return catalog.normalizeTiming(trigger, timing);
  } catch {
    return catalog.TRIGGERS[trigger].defaultTiming;
  }
}

function toView(trigger, doc, stats) {
  const def = catalog.TRIGGERS[trigger];
  const preset = catalog.defaultPreset(trigger);
  const template = doc?.template
    ? {
        presetKey: doc.template.presetKey,
        name: doc.template.name,
        tone: doc.template.tone,
        source: doc.template.source,
        subject: doc.template.subject,
        body: doc.template.body,
        approvedAt: doc.template.approvedAt,
      }
    : {
        presetKey: preset.key,
        name: preset.name,
        tone: preset.tone,
        source: "preset",
        subject: preset.subject,
        body: preset.body,
        approvedAt: null,
      };
  const timing = safeTiming(trigger, doc?.timing);
  return {
    trigger,
    label: def.label,
    description: def.description,
    anchor: def.anchor,
    saved: Boolean(doc),
    isEnabled: Boolean(doc?.isEnabled),
    activatedAt: doc?.activatedAt || null,
    updatedAt: doc?.updatedAt || null,
    template,
    timing,
    timingLabel: catalog.describeTiming(trigger, timing),
    stats: stats || { sent: 0, failed: 0, skipped: 0, scheduled: 0, lastSentAt: null },
  };
}

/** Per-trigger delivery counters for a business. */
async function dispatchStats(businessId) {
  const rows = await CrmEmailDispatch.aggregate([
    { $match: { businessId: new mongoose.Types.ObjectId(String(businessId)) } },
    {
      $group: {
        _id: { trigger: "$trigger", status: "$status" },
        count: { $sum: 1 },
        lastSentAt: { $max: "$sentAt" },
      },
    },
  ]);
  const stats = {};
  for (const row of rows) {
    const key = row._id.trigger;
    stats[key] = stats[key] || { sent: 0, failed: 0, skipped: 0, scheduled: 0, lastSentAt: null };
    const bucket = row._id.status === "sending" ? "scheduled" : row._id.status;
    stats[key][bucket] = (stats[key][bucket] || 0) + row.count;
    if (row._id.status === "sent" && row.lastSentAt) stats[key].lastSentAt = row.lastSentAt;
  }
  return stats;
}

/** All triggers for a business, with saved settings or defaults, plus counters. */
async function listAutomations(businessId) {
  const [docs, stats] = await Promise.all([
    CrmEmailAutomation.find({ businessId }).lean(),
    dispatchStats(businessId),
  ]);
  const byTrigger = Object.fromEntries(docs.map((d) => [d.trigger, d]));
  return catalog.TRIGGER_KEYS.map((trigger) => toView(trigger, byTrigger[trigger], stats[trigger]));
}

/**
 * Saves the template and timing for a trigger.
 *
 * Approval rules (AI or hand-edited wording is never sent unreviewed):
 * - `approved: true` records the owner's approval of exactly this wording.
 * - Changing the wording without approving it clears the approval and switches
 *   the automation off.
 * - An automation can only be enabled with an approved template.
 */
async function saveAutomation({ ownerId, businessId, trigger, input = {}, userId }) {
  if (!catalog.TRIGGERS[trigger]) throw httpError(400, `Unknown trigger '${trigger}'`);
  const timing = catalog.normalizeTiming(trigger, input.timing);
  const { subject, body, warnings } = catalog.validateTemplate(trigger, input);

  let preset = null;
  if (input.presetKey) {
    preset = catalog.getPreset(input.presetKey);
    if (!preset || preset.trigger !== trigger) throw httpError(400, "Template does not belong to this trigger");
  }
  const tone = catalog.TONES.includes(input.tone) ? input.tone : preset?.tone || null;
  let source = "custom";
  if (input.source === "ai") source = "ai";
  else if (preset && preset.subject === subject && catalog.sanitizeHtml(preset.body).trim() === body) source = "preset";

  const existing = await CrmEmailAutomation.findOne({ businessId, trigger });
  const wordingChanged = !existing || existing.template.subject !== subject || existing.template.body !== body;
  const now = new Date();

  let approvedAt = existing?.template?.approvedAt || null;
  let approvedBy = existing?.template?.approvedBy || null;
  if (input.approved === true) {
    approvedAt = now;
    approvedBy = userId;
  } else if (wordingChanged) {
    approvedAt = null;
    approvedBy = null;
  }

  const wasEnabled = Boolean(existing?.isEnabled);
  let isEnabled = input.isEnabled === undefined ? wasEnabled : Boolean(input.isEnabled);
  const notices = [];
  if (isEnabled && !approvedAt) {
    if (input.isEnabled === true) {
      throw httpError(400, "Preview and approve the template before enabling this automation");
    }
    isEnabled = false;
    notices.push("The template changed and was not approved, so this automation was switched off.");
  }

  const doc = existing || new CrmEmailAutomation({ ownerId, businessId, trigger });
  doc.ownerId = ownerId;
  doc.template = {
    presetKey: preset?.key || (input.presetKey === null ? null : existing?.template?.presetKey || null),
    name: String(input.name || preset?.name || existing?.template?.name || catalog.TRIGGERS[trigger].label).slice(0, 100),
    tone,
    source: wordingChanged ? source : existing.template.source,
    subject,
    body,
    approvedAt,
    approvedBy,
  };
  doc.timing = timing;
  doc.isEnabled = isEnabled;
  if (isEnabled && !wasEnabled) doc.activatedAt = now;
  doc.updatedBy = userId || null;
  await doc.save();

  logger.info("crm_email_automation.saved", "Email automation saved", {
    businessId: String(businessId),
    trigger,
    isEnabled,
    approved: Boolean(approvedAt),
    source: doc.template.source,
  });
  const stats = (await dispatchStats(businessId))[trigger];
  return { automation: toView(trigger, doc.toObject(), stats), warnings, notices };
}

/** Switches a saved automation on or off. Enabling requires an approved template. */
async function setEnabled({ businessId, trigger, isEnabled, userId }) {
  if (!catalog.TRIGGERS[trigger]) throw httpError(400, `Unknown trigger '${trigger}'`);
  const doc = await CrmEmailAutomation.findOne({ businessId, trigger });
  if (isEnabled) {
    if (!doc) throw httpError(400, "Choose and save a template before enabling this automation");
    if (!doc.template?.approvedAt) throw httpError(400, "Preview and approve the template before enabling this automation");
  }
  if (!doc) return { automation: toView(trigger, null, (await dispatchStats(businessId))[trigger]) };

  if (isEnabled && !doc.isEnabled) doc.activatedAt = new Date();
  doc.isEnabled = Boolean(isEnabled);
  doc.updatedBy = userId || null;
  await doc.save();
  logger.info("crm_email_automation.toggled", "Email automation switched", { businessId: String(businessId), trigger, isEnabled: doc.isEnabled });
  return { automation: toView(trigger, doc.toObject(), (await dispatchStats(businessId))[trigger]) };
}

/**
 * Renders a template exactly as it would be sent, using sample lead/booking data
 * and the real business name and listing link. With `leadId`, uses that lead's name.
 */
async function previewTemplate({ business, trigger, subject, body, leadId }) {
  const { subject: s, body: b, warnings } = catalog.validateTemplate(trigger, { subject, body });
  const values = { ...catalog.sampleValues() };
  if (business) {
    values.business_name = business.businessName || values.business_name;
    values.store_name = business.businessName || values.store_name;
    values.listing_url = getListingUrl(business);
  }
  if (leadId && mongoose.isValidObjectId(leadId)) {
    const lead = await CrmLead.findOne({ _id: leadId, businessId: business._id }).select("leadName").lean();
    if (!lead) throw httpError(404, "Lead not found for this business");
    values.lead_name = lead.leadName;
  }
  const rendered = catalog.renderTemplate({ subject: s, body: b }, values);
  const footer = '<br><br><a href="#" style="color:#888;font-size:12px;">Unsubscribe</a>';
  return { subject: rendered.subject, html: `${rendered.body}${footer}`, warnings };
}

// ── Trigger detection ───────────────────────────────────────────────────────

async function activeAutomation(businessId, trigger) {
  return CrmEmailAutomation.findOne({
    businessId,
    trigger,
    isEnabled: true,
    "template.approvedAt": { $ne: null },
  }).lean();
}

/**
 * Inserts a dispatch unless one with the same dedupeKey exists. Returns the new
 * dispatch, or null when it was a duplicate.
 */
async function createDispatch(fields) {
  try {
    const res = await CrmEmailDispatch.updateOne(
      { dedupeKey: fields.dedupeKey },
      { $setOnInsert: { ...fields, status: "scheduled", attempts: 0 } },
      { upsert: true }
    );
    if (!res.upsertedId) return null;
    return { _id: res.upsertedId, ...fields };
  } catch (error) {
    if (error && error.code === 11000) return null; // concurrent duplicate
    throw error;
  }
}

/** Queues a send job; the scheduler sweep picks the dispatch up if queueing fails. */
async function enqueueSend(dispatch, now = new Date()) {
  try {
    await addJob(
      QUEUE_NAME,
      { action: "send", dispatchId: String(dispatch._id) },
      { delay: Math.max(0, new Date(dispatch.scheduledFor).getTime() - now.getTime()), jobId: `crm-email-${dispatch._id}` }
    );
  } catch (error) {
    logger.warn("crm_email_automation.enqueue_failed", "Could not queue automated email; scheduler will pick it up", { dispatchId: String(dispatch._id), error: error.message });
  }
}

async function scheduleEventDispatch(automation, fields, now = new Date()) {
  const offset = catalog.timingOffsetMs(safeTiming(automation.trigger, automation.timing));
  const dispatch = await createDispatch({
    ownerId: automation.ownerId,
    businessId: automation.businessId,
    automationId: automation._id,
    trigger: automation.trigger,
    scheduledFor: new Date(now.getTime() + offset),
    ...fields,
  });
  if (!dispatch) {
    logger.debug("crm_email_automation.duplicate_skipped", "Duplicate automated email ignored", { trigger: automation.trigger, dedupeKey: fields.dedupeKey });
    return null;
  }
  logger.info("crm_email_automation.scheduled", "Automated email scheduled", {
    dispatchId: String(dispatch._id),
    trigger: automation.trigger,
    businessId: String(automation.businessId),
    scheduledFor: new Date(dispatch.scheduledFor).toISOString(),
  });
  await enqueueSend(dispatch, now);
  return dispatch;
}

async function findLeadForAppointment(businessId, appointmentId) {
  return CrmLead.findOne({
    businessId,
    $or: [{ "sourceRef.model": "Appointment", "sourceRef.id": appointmentId }, { appointmentIds: appointmentId }],
  })
    .select("_id")
    .lean();
}

/**
 * A lead entered a business's CRM. Leads created straight into Booked (from a
 * booking) or a closed stage are left to the booking emails.
 */
async function onLeadCreated(lead) {
  try {
    if (!dbReady() || !lead || !lead.businessId || !lead._id) return null;
    if (LEAD_TRIGGER_EXCLUDED_STATUSES.includes(lead.status)) return null;
    const automation = await activeAutomation(lead.businessId, "new_lead");
    if (!automation) return null;
    return await scheduleEventDispatch(automation, {
      dedupeKey: buildDedupeKey("new_lead", { leadId: lead._id }),
      leadId: lead._id,
    });
  } catch (error) {
    logger.error("crm_email_automation.new_lead_failed", "New-lead automation failed", { leadId: String(lead?._id), error: error.message });
    return null;
  }
}

/**
 * A signed-in customer opened a business listing. Only existing leads of that
 * business (matched by email, then phone) are emailed; the owner is ignored.
 */
async function onListingViewed({ businessId, viewer, serviceName } = {}) {
  try {
    if (!dbReady() || !viewer || !businessId || !mongoose.isValidObjectId(businessId)) return null;
    const automation = await activeAutomation(businessId, "lead_viewed");
    if (!automation) return null;
    if (String(automation.ownerId) === String(viewer._id)) return null;

    const email = String(viewer.email || "").trim().toLowerCase();
    const phone = String(viewer.phone || "").trim();
    const match = [];
    if (email) match.push({ email });
    if (phone) match.push({ phone });
    if (!match.length) return null;
    const lead = await CrmLead.findOne({ businessId, $or: match }).sort({ updatedAt: -1 }).select("_id status").lean();
    if (!lead || LEAD_TRIGGER_EXCLUDED_STATUSES.includes(lead.status)) return null;

    const context = serviceName ? { serviceName: String(serviceName).slice(0, 120) } : undefined;
    return await scheduleEventDispatch(automation, {
      dedupeKey: buildDedupeKey("lead_viewed", { leadId: lead._id }),
      leadId: lead._id,
      customerId: viewer._id,
      category: "marketing",
      context,
    });
  } catch (error) {
    logger.error("crm_email_automation.lead_viewed_failed", "Listing-view automation failed", { businessId: String(businessId), error: error.message });
    return null;
  }
}

/** A booking was made. Reschedules are not re-confirmed here; their reminders still follow. */
async function onBookingCreated(appointment, customer = null) {
  try {
    if (!dbReady() || !appointment || !appointment._id || !appointment.businessId) return null;
    if (appointment.rescheduledFrom) return null;
    const businessId = appointment.businessId._id || appointment.businessId;
    const automation = await activeAutomation(businessId, "booking_created");
    if (!automation) return null;
    const lead = await findLeadForAppointment(businessId, appointment._id);
    return await scheduleEventDispatch(automation, {
      dedupeKey: buildDedupeKey("booking_created", { appointmentId: appointment._id }),
      appointmentId: appointment._id,
      leadId: lead?._id || null,
      customerId: customer?._id || appointment.userId || null,
    });
  } catch (error) {
    logger.error("crm_email_automation.booking_created_failed", "Booking automation failed", { appointmentId: String(appointment?._id), error: error.message });
    return null;
  }
}

/**
 * Creates dispatches for bookings whose reminder / booking-day / after-booking
 * email is due now. Runs on every scheduler sweep; the dedupeKey makes it safe
 * to evaluate the same booking many times.
 */
async function evaluateScheduledTriggers(now = new Date()) {
  const automations = await CrmEmailAutomation.find({
    trigger: { $in: catalog.SCHEDULED_TRIGGERS },
    isEnabled: true,
    "template.approvedAt": { $ne: null },
  }).lean();

  let created = 0;
  for (const automation of automations) {
    try {
      const trigger = automation.trigger;
      const timing = safeTiming(trigger, automation.timing);
      const window = appointmentScanWindow(trigger, timing, now);
      const anchor = catalog.TRIGGERS[trigger].anchor;
      const statuses = anchor === "after_booking" ? ["Scheduled", "Completed"] : ["Scheduled"];
      const appointments = await Appointment.find({
        businessId: automation.businessId,
        status: { $in: statuses },
        appointmentDate: { $gte: window.from, $lte: window.to },
      })
        .select("_id userId businessId appointmentDate timeSlot status")
        .lean();

      const due = [];
      for (const appointment of appointments) {
        const start = appointmentStartTime(appointment);
        const sendAt = catalog.computeBookingSendAt(trigger, timing, start);
        if (catalog.isBookingSendDue(trigger, { sendAt, start, now, activatedAt: automation.activatedAt })) {
          due.push({ appointment, sendAt, dedupeKey: buildDedupeKey(trigger, { appointmentId: appointment._id }) });
        }
      }
      if (!due.length) continue;

      const existing = await CrmEmailDispatch.find({ dedupeKey: { $in: due.map((d) => d.dedupeKey) } })
        .select("dedupeKey")
        .lean();
      const seen = new Set(existing.map((d) => d.dedupeKey));
      for (const item of due) {
        if (seen.has(item.dedupeKey)) continue;
        const dispatch = await createDispatch({
          ownerId: automation.ownerId,
          businessId: automation.businessId,
          automationId: automation._id,
          trigger,
          dedupeKey: item.dedupeKey,
          appointmentId: item.appointment._id,
          customerId: item.appointment.userId || null,
          scheduledFor: item.sendAt,
        });
        if (dispatch) created++;
      }
    } catch (error) {
      logger.error("crm_email_automation.evaluate_failed", "Scheduled trigger evaluation failed", {
        automationId: String(automation._id),
        trigger: automation.trigger,
        error: error.message,
      });
    }
  }
  return { automations: automations.length, created };
}

// ── Sending ─────────────────────────────────────────────────────────────────

async function resolveRecipient({ lead, customer }) {
  const candidates = [lead?.email, customer?.email];
  if (!candidates.some(Boolean) && lead?.sourceRef?.model === "Enquiry" && lead.sourceRef.id) {
    const enquiry = await Enquiry.findById(lead.sourceRef.id).select("userId").lean();
    if (enquiry?.userId) {
      const user = await User.findById(enquiry.userId).select("email").lean();
      candidates.push(user?.email);
    }
  }
  const email = candidates.map((e) => String(e || "").trim().toLowerCase()).find((e) => e && validator.isEmail(e));
  return email || null;
}

async function loadContext(dispatch) {
  const [automation, business, appointment, customer] = await Promise.all([
    CrmEmailAutomation.findOne({ businessId: dispatch.businessId, trigger: dispatch.trigger }).lean(),
    Business.findById(dispatch.businessId).select("_id businessName userId").lean(),
    dispatch.appointmentId ? Appointment.findById(dispatch.appointmentId).lean() : null,
    dispatch.customerId ? User.findById(dispatch.customerId).select("full_name email phone subscribedToEmails").lean() : null,
  ]);
  let lead = null;
  if (dispatch.leadId) {
    lead = await CrmLead.findById(dispatch.leadId).select("_id leadName email status sourceRef businessId").lean();
  } else if (dispatch.appointmentId && business) {
    const linked = await findLeadForAppointment(business._id, dispatch.appointmentId);
    if (linked) lead = await CrmLead.findById(linked._id).select("_id leadName email status sourceRef businessId").lean();
  }
  const owner = business?.userId ? await User.findById(business.userId).select("full_name email").lean() : null;
  return { automation, business, appointment, customer, lead, owner };
}

/**
 * Sends through the configured SenderEmail (SMTP) or, if none, the Gmail fallback.
 * Journey emails pass their own per-business `unsubscribeLink` and one-click
 * List-Unsubscribe `headers`; automation emails use the global unsubscribe link.
 */
async function deliver({ to, subject, html, business, owner, unsubscribeLink = buildUnsubscribeLink(to), headers }) {
  const sender = await SenderEmail.findOne({ isActive: true }).select("email").lean();
  const replyTo = owner?.email && validator.isEmail(String(owner.email)) ? owner.email : undefined;
  if (sender) {
    const nodemailerUtil = require("../utils/nodemailer");
    return nodemailerUtil.sendMail(sender.email, to, subject, html, unsubscribeLink, {
      senderName: business?.businessName || undefined,
      replyTo,
      headers,
    });
  }
  const sendMailService = require("./sendMail");
  const footer = `<br><br><a href="${unsubscribeLink}" style="color:#888;font-size:12px;">Unsubscribe</a>`;
  return sendMailService(to, subject, `${html}${footer}`, { headers, replyTo });
}

async function addLeadTimelineEntry(leadId, description) {
  if (!leadId) return;
  const now = new Date();
  try {
    await CrmLead.updateOne(
      { _id: leadId },
      { $push: { activities: { action: "email_sent", type: "email_sent", description, timestamp: now, performedAt: now } } }
    );
  } catch (error) {
    logger.warn("crm_email_automation.timeline_failed", "Could not add automated email to lead timeline", { leadId: String(leadId), error: error.message });
  }
}

async function finish(dispatch, status, fields = {}) {
  await CrmEmailDispatch.updateOne({ _id: dispatch._id }, { $set: { status, lockedAt: null, ...fields } });
  return { dispatchId: String(dispatch._id), status, ...fields };
}

/**
 * Claims and sends one due dispatch. Safe to call concurrently from the queue job
 * and the scheduler sweep: only the caller that flips it to "sending" proceeds.
 */
async function processDispatch(dispatchId, { now = new Date() } = {}) {
  if (!dbReady() || !mongoose.isValidObjectId(dispatchId)) return { status: "ignored" };
  const dispatch = await CrmEmailDispatch.findOneAndUpdate(
    { _id: dispatchId, status: "scheduled", scheduledFor: { $lte: now } },
    { $set: { status: "sending", lockedAt: now }, $inc: { attempts: 1 } },
    { new: true }
  ).lean();
  if (!dispatch) return { status: "not_due" };
  if (dispatch.trigger === "journey") {
    // Engagement journey emails share the claim/retry pipeline but render and
    // re-check differently (contact consent, frequency, journey state).
    return require("./crmJourneyService").processJourneyDispatch(dispatch, { now });
  }

  const label = catalog.TRIGGERS[dispatch.trigger]?.label || dispatch.trigger;
  let ctx;
  try {
    ctx = await loadContext(dispatch);
    const reason = skipReason(dispatch, ctx, now);
    const leadId = ctx.lead?._id || dispatch.leadId || null;
    if (reason) {
      logger.info("crm_email_automation.skipped", "Automated email skipped", { dispatchId: String(dispatch._id), trigger: dispatch.trigger, reason });
      return finish(dispatch, "skipped", { lastError: reason, leadId });
    }

    const to = await resolveRecipient(ctx);
    if (!to) return finish(dispatch, "skipped", { lastError: "No valid email address for this lead", leadId });
    const unsubscribed =
      ctx.customer?.subscribedToEmails === false || Boolean(await UnsubscribedEmail.exists({ email: to }));
    if (unsubscribed) return finish(dispatch, "skipped", { lastError: "Recipient has unsubscribed", to, leadId });

    const values = buildVariableValues({ ...ctx, context: dispatch.context });
    const { subject, body } = catalog.renderTemplate(ctx.automation.template, values);
    const result = await deliver({ to, subject, html: body, business: ctx.business, owner: ctx.owner });

    if (result && result.success) {
      logger.info("crm_email_automation.sent", "Automated email sent", {
        dispatchId: String(dispatch._id),
        trigger: dispatch.trigger,
        businessId: String(dispatch.businessId),
        messageId: result.info?.messageId,
      });
      await addLeadTimelineEntry(leadId, `Automated email (${label}) sent: ${subject}`);
      return finish(dispatch, "sent", {
        to,
        subject,
        body,
        leadId,
        sentAt: new Date(),
        messageId: result.info?.messageId || null,
        lastError: null,
      });
    }
    throw result?.error || new Error("Unknown email delivery failure");
  } catch (error) {
    const message = error?.message || String(error);
    const leadId = ctx?.lead?._id || dispatch.leadId || null;
    if (dispatch.attempts < MAX_ATTEMPTS) {
      const retryAt = nextRetryAt(dispatch.attempts, now);
      logger.warn("crm_email_automation.retry_scheduled", "Automated email failed; retry scheduled", {
        dispatchId: String(dispatch._id),
        trigger: dispatch.trigger,
        attempt: dispatch.attempts,
        retryAt: retryAt.toISOString(),
        error: message,
      });
      return finish(dispatch, "scheduled", { scheduledFor: retryAt, lastError: message, leadId });
    }
    logger.error("crm_email_automation.failed", "Automated email failed permanently", {
      dispatchId: String(dispatch._id),
      trigger: dispatch.trigger,
      attempts: dispatch.attempts,
      error: message,
    });
    await addLeadTimelineEntry(leadId, `Automated email (${label}) failed: ${message}`);
    return finish(dispatch, "failed", { lastError: message, leadId });
  }
}

/**
 * A dispatch left in "sending" (worker crashed mid-send) may or may not have gone
 * out. It is marked failed rather than retried, so a customer never gets it twice.
 */
async function recoverStaleSending(now = new Date()) {
  const res = await CrmEmailDispatch.updateMany(
    { status: "sending", lockedAt: { $lt: new Date(now.getTime() - STALE_SENDING_MS) } },
    { $set: { status: "failed", lockedAt: null, lastError: "Delivery was interrupted; not retried to avoid a duplicate email" } }
  );
  return res.modifiedCount || 0;
}

async function sendDueDispatches(now = new Date()) {
  const due = await CrmEmailDispatch.find({ status: "scheduled", scheduledFor: { $lte: now } })
    .sort({ scheduledFor: 1 })
    .limit(SEND_BATCH_SIZE)
    .select("_id")
    .lean();
  const summary = { processed: 0, sent: 0, failed: 0, skipped: 0, retrying: 0 };
  for (const { _id } of due) {
    const res = await processDispatch(_id, { now });
    if (res.status === "not_due") continue;
    summary.processed++;
    if (res.status === "sent") summary.sent++;
    else if (res.status === "failed") summary.failed++;
    else if (res.status === "skipped") summary.skipped++;
    else if (res.status === "scheduled") summary.retrying++;
  }
  return summary;
}

/**
 * Builds this feature's indexes. The app connects with autoIndex disabled, and the
 * unique dedupeKey index is what guarantees one email per lead/booking and trigger,
 * so the worker ensures it on startup instead of relying on a manual script run.
 */
async function ensureIndexes() {
  await Promise.all([CrmEmailAutomation.createIndexes(), CrmEmailDispatch.createIndexes()]);
  await require("./crmJourneyService").ensureIndexes();
}

/** One scheduler sweep: recover, detect time-based triggers, send what is due. */
async function runScheduler({ now = new Date() } = {}) {
  if (!dbReady()) return { skipped: true };
  const recovered = await recoverStaleSending(now);
  const evaluated = await evaluateScheduledTriggers(now);
  // Engagement journeys: derived signals, due steps, import triage. Creates
  // dispatches that the send below picks up in the same sweep.
  let engagement = null;
  try {
    engagement = await require("./crmJourneyService").runSweep({ now });
  } catch (error) {
    logger.error("crm_engagement.sweep_failed", "Engagement journey sweep failed", { error: error.message });
  }
  const sent = await sendDueDispatches(now);
  return { recovered, evaluated, engagement, ...sent };
}

// ── Delivery log ────────────────────────────────────────────────────────────

async function listDispatches(businessId, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 20));
  const filter = { businessId };
  if (query.trigger && (catalog.TRIGGERS[query.trigger] || query.trigger === "journey")) filter.trigger = query.trigger;
  if (query.journeyId && mongoose.isValidObjectId(query.journeyId)) filter.journeyId = query.journeyId;
  if (query.contactId && mongoose.isValidObjectId(query.contactId)) filter.contactId = query.contactId;
  if (query.status && CrmEmailDispatch.DISPATCH_STATUSES.includes(query.status)) filter.status = query.status;

  const [total, logs] = await Promise.all([
    CrmEmailDispatch.countDocuments(filter),
    CrmEmailDispatch.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("-body -dedupeKey")
      .populate("leadId", "leadName email status")
      .populate("contactId", "name email")
      .populate("journeyId", "name")
      .lean(),
  ]);
  return { logs, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

module.exports = {
  QUEUE_NAME,
  MAX_ATTEMPTS,
  createDispatch,
  enqueueSend,
  deliver,
  finish,
  buildDedupeKey,
  nextRetryAt,
  appointmentScanWindow,
  buildVariableValues,
  buildUnsubscribeLink,
  skipReason,
  listAutomations,
  saveAutomation,
  setEnabled,
  previewTemplate,
  onLeadCreated,
  onListingViewed,
  onBookingCreated,
  evaluateScheduledTriggers,
  processDispatch,
  sendDueDispatches,
  recoverStaleSending,
  runScheduler,
  ensureIndexes,
  listDispatches,
  dispatchStats,
};
