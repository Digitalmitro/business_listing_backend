"use strict";

/**
 * Engagement journeys: automated, multi-step email sequences for CRM contacts.
 *
 * Flow
 *   signal (crmSignalService.emit, or derived by the sweep)
 *     -> handleSignal: exit journeys the signal stops, enrol in the best matching journey
 *     -> enrolment waits for its step delay (nextRunAt)
 *     -> advanceEnrollment (sweep or immediately): conditions, consent, frequency cap,
 *        send window, import pacing -> CrmEmailDispatch (trigger "journey")
 *     -> crmEmailAutomationService.processDispatch claims it -> processJourneyDispatch
 *        re-checks everything, renders, adds tracked links + unsubscribe, sends
 *     -> onDispatchOutcome: next step, completed, or exited
 *
 * Safety rules
 *   - Nothing is sent unless the business switched engagement on, the journey is
 *     enabled, and every template in it was approved by the owner.
 *   - Only contacts with a marketing consent basis, subscribed, not bounced and not
 *     globally opted out are emailed.
 *   - One active journey per contact per business; frequency caps and a send window
 *     apply across all journeys (and lead_viewed automation emails).
 *   - Event paths never throw: engagement problems can't break a booking or page view.
 */

const mongoose = require("mongoose");
const moment = require("moment-timezone");
const CrmJourney = require("../models/CrmJourney");
const CrmJourneyEnrollment = require("../models/CrmJourneyEnrollment");
const CrmEngagementTemplate = require("../models/CrmEngagementTemplate");
const CrmEngagementSettings = require("../models/CrmEngagementSettings");
const CrmContact = require("../models/CrmContact");
const CrmContactActivity = require("../models/CrmContactActivity");
const CrmContactImport = require("../models/CrmContactImport");
const CrmEmailDispatch = require("../models/CrmEmailDispatch");
const Business = require("../models/Business");
const Appointment = require("../models/Appointment");
const User = require("../models/User");
const catalog = require("./crmEngagementCatalog");
const automationCatalog = require("./crmEmailAutomationCatalog");
const automation = require("./crmEmailAutomationService");
const contacts = require("./crmEngagementContactService");
const links = require("./crmEngagementLinks");
const { getListingUrl } = require("../utils/emailPlaceholders");
const logger = require("../utils/logger");

const LEASE_MS = 10 * 60 * 1000;
const PAUSE_MS = 6 * catalog.HOUR;
const RECONCILE_AFTER_MS = 20 * 60 * 1000;
const DUE_BATCH = 200;
const DERIVED_BATCH = 100;
/** Platform-wide: marketing emails any one address may get per 24 hours, across businesses. */
const GLOBAL_DAILY_CAP = Math.max(1, Number(process.env.CRM_ENGAGEMENT_GLOBAL_DAILY_CAP) || 3);
/** Derived-signal scans (abandoned bookings, inactivity) run at most this often. */
const DERIVED_INTERVAL_MS = 15 * 60 * 1000;
let lastDerivedRunAt = 0;

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

async function ensureIndexes() {
  await Promise.all([
    CrmJourney.createIndexes(),
    CrmJourneyEnrollment.createIndexes(),
    CrmEngagementTemplate.createIndexes(),
    CrmEngagementSettings.createIndexes(),
    CrmContact.createIndexes(),
    CrmContactActivity.createIndexes(),
    CrmContactImport.createIndexes(),
  ]);
}

// ── Seeding ─────────────────────────────────────────────────────────────────

/**
 * Copies the starter templates and journeys into a business (once). Templates start
 * unapproved and journeys switched off: the owner reviews before anything is sent.
 */
async function seedBusiness(business) {
  const settings = await contacts.ensureSettingsDoc(business);
  if (settings?.seededAt) return false;
  const ownerId = business.userId;

  for (const t of catalog.STARTER_TEMPLATES) {
    await CrmEngagementTemplate.updateOne(
      { businessId: business._id, starterKey: t.starterKey },
      {
        $setOnInsert: {
          ownerId,
          businessId: business._id,
          starterKey: t.starterKey,
          name: t.name,
          purpose: t.purpose,
          tone: t.tone,
          source: "starter",
          subject: t.subject,
          body: t.body,
        },
      },
      { upsert: true }
    );
  }
  const templates = await CrmEngagementTemplate.find({ businessId: business._id, starterKey: { $exists: true } }).select("_id starterKey").lean();
  const byKey = Object.fromEntries(templates.map((t) => [t.starterKey, t._id]));

  for (const j of catalog.STARTER_JOURNEYS) {
    const steps = j.steps.map((s) => ({ templateId: byKey[s.template], delay: s.delay, condition: s.condition }));
    if (steps.some((s) => !s.templateId)) continue;
    await CrmJourney.updateOne(
      { businessId: business._id, starterKey: j.starterKey },
      {
        $setOnInsert: {
          ownerId,
          businessId: business._id,
          starterKey: j.starterKey,
          name: j.name,
          goal: j.goal,
          trigger: { signal: j.trigger.signal, params: catalog.normalizeTriggerParams(j.trigger.signal, j.trigger.params) },
          steps,
          exitOn: j.exitOn,
          priority: j.priority,
          reentryDays: j.reentryDays,
          isEnabled: false,
          source: "starter",
        },
      },
      { upsert: true }
    );
  }
  await CrmEngagementSettings.updateOne({ businessId: business._id }, { $set: { seededAt: new Date() } });
  logger.info("crm_engagement.seeded", "Starter templates and journeys added", { businessId: String(business._id) });
  return true;
}

// ── Journey management ──────────────────────────────────────────────────────

async function journeyStats(businessId) {
  const [enrollmentRows, emailRows] = await Promise.all([
    CrmJourneyEnrollment.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(String(businessId)) } },
      { $group: { _id: { journeyId: "$journeyId", status: "$status" }, count: { $sum: 1 } } },
    ]),
    CrmEmailDispatch.aggregate([
      { $match: { businessId: new mongoose.Types.ObjectId(String(businessId)), trigger: "journey" } },
      {
        $group: {
          _id: "$journeyId",
          sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $gt: ["$clickCount", 0] }, 1, 0] } },
        },
      },
    ]),
  ]);
  const stats = {};
  const blank = () => ({ active: 0, completed: 0, converted: 0, exited: 0, total: 0, sent: 0, failed: 0, clicked: 0 });
  for (const row of enrollmentRows) {
    const key = String(row._id.journeyId);
    stats[key] = stats[key] || blank();
    stats[key][row._id.status] = row.count;
    stats[key].total += row.count;
  }
  for (const row of emailRows) {
    const key = String(row._id);
    stats[key] = stats[key] || blank();
    Object.assign(stats[key], { sent: row.sent, failed: row.failed, clicked: row.clicked });
  }
  return { stats, blank };
}

function journeyView(journey, templatesById, stats) {
  const steps = (journey.steps || []).map((s) => {
    const t = templatesById[String(s.templateId)];
    return {
      templateId: s.templateId,
      templateName: t?.name || "(missing template)",
      templateApproved: Boolean(t?.approvedAt && !t?.archived),
      subject: t?.subject || "",
      delay: s.delay,
      delayLabel: catalog.describeDelay(s.delay),
      condition: s.condition,
    };
  });
  return {
    ...journey,
    triggerLabel: catalog.SIGNALS[journey.trigger?.signal]?.label || journey.trigger?.signal,
    steps,
    readyToEnable: steps.length > 0 && steps.every((s) => s.templateApproved),
    stats,
  };
}

async function listJourneys(businessId) {
  const [journeys, templates, { stats, blank }] = await Promise.all([
    CrmJourney.find({ businessId }).sort({ priority: -1, createdAt: 1 }).lean(),
    CrmEngagementTemplate.find({ businessId }).select("_id name subject approvedAt archived").lean(),
    journeyStats(businessId),
  ]);
  const byId = Object.fromEntries(templates.map((t) => [String(t._id), t]));
  return journeys.map((j) => journeyView(j, byId, stats[String(j._id)] || blank()));
}

async function assertTemplatesBelong(businessId, steps) {
  const ids = [...new Set(steps.map((s) => s.templateId))];
  if (ids.some((id) => !mongoose.isValidObjectId(id))) throw httpError(400, "Unknown template in journey steps");
  const found = await CrmEngagementTemplate.find({ _id: { $in: ids }, businessId, archived: false }).select("_id approvedAt").lean();
  if (found.length !== ids.length) throw httpError(400, "Every step must use one of this business's templates");
  return found;
}

async function saveJourney({ ownerId, businessId, journeyId, input, userId, source }) {
  const normalized = catalog.normalizeJourney(input);
  const templates = await assertTemplatesBelong(businessId, normalized.steps);
  let doc;
  if (journeyId) {
    if (!mongoose.isValidObjectId(journeyId)) throw httpError(404, "Journey not found");
    doc = await CrmJourney.findOne({ _id: journeyId, businessId });
    if (!doc) throw httpError(404, "Journey not found");
  } else {
    doc = new CrmJourney({ ownerId, businessId, source: source || "custom", isEnabled: false });
  }
  Object.assign(doc, normalized, { updatedBy: userId || null });
  if (input.rationale !== undefined) doc.rationale = String(input.rationale || "").slice(0, 600);
  const notices = [];
  if (doc.isEnabled && templates.some((t) => !t.approvedAt)) {
    doc.isEnabled = false;
    notices.push("A step uses a template that is not approved yet, so this journey was switched off.");
  }
  await doc.save();
  logger.info("crm_engagement.journey_saved", "Journey saved", { businessId: String(businessId), journeyId: String(doc._id), isEnabled: doc.isEnabled });
  return { journey: await getJourneyView(businessId, doc._id), notices };
}

async function getJourneyView(businessId, journeyId) {
  const journey = await CrmJourney.findOne({ _id: journeyId, businessId }).lean();
  if (!journey) throw httpError(404, "Journey not found");
  const templates = await CrmEngagementTemplate.find({ _id: { $in: journey.steps.map((s) => s.templateId) } }).select("_id name subject approvedAt archived").lean();
  const { stats, blank } = await journeyStats(businessId);
  return journeyView(journey, Object.fromEntries(templates.map((t) => [String(t._id), t])), stats[String(journeyId)] || blank());
}

async function setJourneyEnabled({ businessId, journeyId, isEnabled, userId }) {
  if (!mongoose.isValidObjectId(journeyId)) throw httpError(404, "Journey not found");
  const doc = await CrmJourney.findOne({ _id: journeyId, businessId });
  if (!doc) throw httpError(404, "Journey not found");
  if (isEnabled) {
    const templates = await assertTemplatesBelong(businessId, doc.steps.map((s) => ({ templateId: String(s.templateId) })));
    if (templates.some((t) => !t.approvedAt)) {
      throw httpError(400, "Preview and approve every template in this journey before switching it on");
    }
    if (!doc.isEnabled) doc.enabledAt = new Date();
  }
  doc.isEnabled = Boolean(isEnabled);
  doc.updatedBy = userId || null;
  await doc.save();
  logger.info("crm_engagement.journey_toggled", "Journey switched", { businessId: String(businessId), journeyId: String(journeyId), isEnabled: doc.isEnabled });
  return getJourneyView(businessId, doc._id);
}

/** Deletes a journey; its active contacts leave it. */
async function deleteJourney({ businessId, journeyId }) {
  if (!mongoose.isValidObjectId(journeyId)) throw httpError(404, "Journey not found");
  const doc = await CrmJourney.findOne({ _id: journeyId, businessId });
  if (!doc) throw httpError(404, "Journey not found");
  const active = await CrmJourneyEnrollment.find({ journeyId: doc._id, status: "active" }).select("_id awaitingDispatchId").lean();
  for (const e of active) await endEnrollment(e, "exited", "Journey was deleted");
  await doc.deleteOne();
  return { deleted: true, exited: active.length };
}

/** Called when a template's approval is cleared: journeys using it are switched off. */
async function disableJourneysUsingTemplate(businessId, templateId) {
  const res = await CrmJourney.updateMany(
    { businessId, isEnabled: true, "steps.templateId": templateId },
    { $set: { isEnabled: false } }
  );
  return res.modifiedCount || 0;
}

// ── Enrolment ───────────────────────────────────────────────────────────────

function pushHistory(entry) {
  return { $push: { history: { $each: [{ at: new Date(), ...entry }], $slice: -50 } } };
}

/** Ends an enrolment and cancels its queued email, if any. Idempotent. */
async function endEnrollment(enrollment, status, reason, now = new Date()) {
  const res = await CrmJourneyEnrollment.updateOne(
    { _id: enrollment._id, status: "active" },
    {
      $set: { status, exitReason: reason, endedAt: now, nextRunAt: null, awaitingDispatchId: null },
      ...pushHistory({ type: status === "active" ? "exited" : status, note: reason }),
    }
  );
  if (enrollment.awaitingDispatchId) {
    await CrmEmailDispatch.updateOne(
      { _id: enrollment.awaitingDispatchId, status: "scheduled" },
      { $set: { status: "skipped", lastError: `Journey ended: ${reason}` } }
    );
  }
  return res.modifiedCount > 0;
}

/**
 * Enrols a contact in a journey if they qualify. Returns { enrollment } or
 * { skipped: reason }. Never sends directly; the first step is advanced right away
 * when it has no delay.
 */
async function enroll(contact, journey, { signal, context = {}, now = new Date(), advance = true } = {}) {
  const blocked = contacts.marketingBlockReason(contact);
  if (blocked) return { skipped: blocked };
  if (!journey.isEnabled) return { skipped: "Journey is switched off" };

  const active = await CrmJourneyEnrollment.find({ contactId: contact._id, status: "active" }).populate("journeyId", "priority name").lean();
  for (const current of active) {
    if (String(current.journeyId?._id) === String(journey._id)) return { skipped: "Already in this journey" };
    if ((current.journeyId?.priority ?? 0) >= journey.priority) {
      return { skipped: `Already in "${current.journeyId?.name || "another journey"}"` };
    }
  }
  const since = new Date(now.getTime() - (journey.reentryDays || 30) * catalog.DAY);
  const recent = await CrmJourneyEnrollment.exists({ journeyId: journey._id, contactId: contact._id, enrolledAt: { $gte: since } });
  if (recent) return { skipped: `Was in this journey in the last ${journey.reentryDays} days` };

  for (const current of active) {
    await endEnrollment(current, "exited", `Moved to "${journey.name}"`, now);
  }

  let enrollment;
  try {
    enrollment = await CrmJourneyEnrollment.create({
      ownerId: journey.ownerId,
      businessId: journey.businessId,
      journeyId: journey._id,
      contactId: contact._id,
      trigger: { signal, at: now },
      context: {
        itemName: context.itemName ? String(context.itemName).slice(0, 120) : undefined,
        serviceName: context.serviceName ? String(context.serviceName).slice(0, 120) : undefined,
        importId: context.importId || undefined,
        decidedBy: context.decidedBy || undefined,
        reason: context.reason ? String(context.reason).slice(0, 300) : undefined,
      },
      enrolledAt: now,
      currentStep: 0,
      nextRunAt: new Date(now.getTime() + catalog.delayMs(journey.steps[0]?.delay)),
      history: [{ at: now, type: "enrolled", note: catalog.SIGNALS[signal]?.label || signal }],
    });
  } catch (error) {
    if (error.code === 11000) return { skipped: "Already in this journey" };
    throw error;
  }
  await contacts.recordActivity(contact, {
    type: "journey_enrolled",
    summary: `Started journey "${journey.name}"`,
    meta: { journeyId: journey._id, enrollmentId: enrollment._id },
    at: now,
    countsAsActivity: false,
  });
  logger.info("crm_engagement.enrolled", "Contact entered journey", {
    businessId: String(journey.businessId),
    journeyId: String(journey._id),
    enrollmentId: String(enrollment._id),
    signal,
  });
  if (advance && enrollment.nextRunAt <= now) {
    await advanceEnrollment(enrollment._id, { now });
  }
  return { enrollment };
}

/**
 * Reacts to a signal for a contact: stops journeys that exit on it, then enrols the
 * contact in the highest-priority enabled journey it triggers. Never throws.
 */
async function handleSignal({ contact, signal, context = {}, now = new Date(), onlyJourneyId = null } = {}) {
  const result = { exited: 0, enrolled: null, skipped: [] };
  try {
    if (!dbReady() || !contact || !catalog.SIGNALS[signal]) return result;
    const def = catalog.SIGNALS[signal];

    const active = await CrmJourneyEnrollment.find({ contactId: contact._id, status: "active" }).populate("journeyId", "exitOn name").lean();
    for (const enrollment of active) {
      const exitOn = enrollment.journeyId?.exitOn || [];
      if (signal === "unsubscribed" || exitOn.includes(signal)) {
        const status = def.conversion ? "converted" : "exited";
        const reason = status === "converted" ? `Converted: ${def.label}` : def.label;
        if (await endEnrollment(enrollment, status, reason, now)) result.exited++;
      }
    }
    if (!def.journeyTrigger) return result;

    const settings = await contacts.getSettings(contact.businessId);
    if (!settings.enabled) return result;
    const filter = { businessId: contact.businessId, "trigger.signal": signal, isEnabled: true };
    if (onlyJourneyId) filter._id = onlyJourneyId;
    const journeys = await CrmJourney.find(filter).sort({ priority: -1 }).lean();
    for (const journey of journeys) {
      if (!(await journeyParamsMatch(journey, contact, now))) continue;
      const res = await enroll(contact, journey, { signal, context, now });
      if (res.enrollment) {
        result.enrolled = res.enrollment;
        break;
      }
      result.skipped.push({ journeyId: journey._id, reason: res.skipped });
    }
  } catch (error) {
    logger.error("crm_engagement.signal_failed", "Journey signal handling failed", { signal, contactId: String(contact?._id), error: error.message });
  }
  return result;
}

/** Trigger parameters checked at signal time (derived signals check theirs when detected). */
async function journeyParamsMatch(journey, contact, now = new Date()) {
  if (journey.trigger.signal === "repeat_visit") {
    const params = catalog.normalizeTriggerParams("repeat_visit", journey.trigger.params);
    const visits = await contacts.countRecentVisits(contact._id, params.withinDays, now);
    return visits >= params.minVisits;
  }
  return true;
}

// ── Advancing ───────────────────────────────────────────────────────────────

async function recentMarketingTimes(contact, now) {
  const weekAgo = new Date(now.getTime() - 7 * catalog.DAY);
  const rows = await CrmEmailDispatch.find({
    contactId: contact._id,
    category: "marketing",
    status: { $in: ["scheduled", "sending", "sent"] },
    scheduledFor: { $gte: weekAgo },
  })
    .select("scheduledFor sentAt")
    .lean();
  // lead_viewed automation emails are marketing too, but are keyed by address.
  const byAddress = contact.email
    ? await CrmEmailDispatch.find({
        businessId: contact.businessId,
        to: contact.email,
        category: "marketing",
        contactId: null,
        status: { $in: ["scheduled", "sending", "sent"] },
        scheduledFor: { $gte: weekAgo },
      })
        .select("scheduledFor sentAt")
        .lean()
    : [];
  return [...rows, ...byAddress].map((d) => d.sentAt || d.scheduledFor);
}

/** Earliest time the platform-wide per-address cap allows another marketing email. */
async function globalCapAllowedAt(email, now) {
  if (!email) return now;
  const dayAgo = new Date(now.getTime() - catalog.DAY);
  const rows = await CrmEmailDispatch.find({
    to: email,
    category: "marketing",
    status: { $in: ["scheduled", "sending", "sent"] },
    scheduledFor: { $gte: dayAgo },
  })
    .sort({ scheduledFor: 1 })
    .select("scheduledFor")
    .lean();
  if (rows.length < GLOBAL_DAILY_CAP) return now;
  return new Date(new Date(rows[rows.length - GLOBAL_DAILY_CAP].scheduledFor).getTime() + catalog.DAY);
}

/** First emails to imported contacts are paced to `importDailyLimit` per business day. */
async function importPacingAllowedAt(businessId, settings, now) {
  const tz = settings.timezone || catalog.DEFAULT_SETTINGS.timezone;
  const dayStart = moment.tz(now, tz).startOf("day").toDate();
  const count = await CrmEmailDispatch.countDocuments({
    businessId,
    trigger: "journey",
    "context.fromImport": true,
    scheduledFor: { $gte: dayStart },
  });
  if (count < settings.importDailyLimit) return now;
  return moment.tz(now, tz).add(1, "day").startOf("day").add(settings.sendWindow.startHour, "hours").toDate();
}

async function deferEnrollment(enrollment, until, note) {
  const last = enrollment.history?.[enrollment.history.length - 1];
  const update = { $set: { nextRunAt: until } };
  // One "deferred" history entry per step, so waiting doesn't flood the timeline.
  if (!(last?.type === "deferred" && last.stepIndex === enrollment.currentStep)) {
    Object.assign(update, pushHistory({ type: "deferred", stepIndex: enrollment.currentStep, note }));
  }
  await CrmJourneyEnrollment.updateOne({ _id: enrollment._id, status: "active" }, update);
  return { deferred: until, note };
}

/**
 * Moves one due enrolment forward: sends its next step (as a dispatch), skips a step
 * whose condition no longer holds, defers under caps, or ends the journey.
 */
async function advanceEnrollment(enrollmentId, { now = new Date() } = {}) {
  const enrollment = await CrmJourneyEnrollment.findOneAndUpdate(
    { _id: enrollmentId, status: "active", nextRunAt: { $lte: now }, awaitingDispatchId: null },
    { $set: { nextRunAt: new Date(now.getTime() + LEASE_MS) } },
    { new: true }
  ).lean();
  if (!enrollment) return { status: "not_due" };

  try {
    const [journey, contact, settings] = await Promise.all([
      CrmJourney.findById(enrollment.journeyId).lean(),
      CrmContact.findById(enrollment.contactId).lean(),
      contacts.getSettings(enrollment.businessId),
    ]);
    if (!journey) {
      await endEnrollment(enrollment, "exited", "Journey no longer exists", now);
      return { status: "exited" };
    }
    if (!settings.enabled || !journey.isEnabled) {
      // Paused: resumes when the business or journey is switched back on.
      await CrmJourneyEnrollment.updateOne({ _id: enrollment._id, status: "active" }, { $set: { nextRunAt: new Date(now.getTime() + PAUSE_MS) } });
      return { status: "paused" };
    }
    const blocked = contacts.marketingBlockReason(contact);
    if (blocked) {
      await endEnrollment(enrollment, "exited", blocked, now);
      return { status: "exited", reason: blocked };
    }

    const step = journey.steps[enrollment.currentStep];
    if (!step) {
      await endEnrollment(enrollment, "completed", "All emails sent", now);
      return { status: "completed" };
    }
    if (!catalog.stepConditionMet(step.condition, { contact, enrollment })) {
      return skipStep(enrollment, journey, `Condition not met: ${catalog.STEP_CONDITIONS[step.condition]?.label || step.condition}`, now);
    }
    const template = await CrmEngagementTemplate.findOne({ _id: step.templateId, businessId: journey.businessId }).lean();
    if (!template || template.archived || !template.approvedAt) {
      await endEnrollment(enrollment, "exited", "Template is missing or not approved", now);
      return { status: "exited" };
    }

    let allowedAt = catalog.frequencyAllowedAt(await recentMarketingTimes(contact, now), settings.frequency, now);
    const globalAt = await globalCapAllowedAt(contact.email, now);
    if (globalAt > allowedAt) allowedAt = globalAt;
    let note = allowedAt > now ? "Waiting for the email frequency limit" : "";
    const fromImport = Boolean(enrollment.context?.importId) && enrollment.currentStep === 0;
    if (fromImport) {
      const pacedAt = await importPacingAllowedAt(journey.businessId, settings, now);
      if (pacedAt > allowedAt) {
        allowedAt = pacedAt;
        note = "Paced: daily limit for imported contacts reached";
      }
    }
    const sendAt = catalog.nextSendWindowTime(allowedAt, settings);
    if (sendAt.getTime() - now.getTime() > 60 * 1000) {
      return { status: "deferred", ...(await deferEnrollment(enrollment, sendAt, note || "Outside the send window")) };
    }

    const dispatch = await automation.createDispatch({
      ownerId: journey.ownerId,
      businessId: journey.businessId,
      trigger: "journey",
      category: "marketing",
      dedupeKey: `journey:${enrollment._id}:${enrollment.currentStep}`,
      contactId: contact._id,
      journeyId: journey._id,
      enrollmentId: enrollment._id,
      templateId: template._id,
      stepIndex: enrollment.currentStep,
      customerId: contact.userId || null,
      leadId: contact.leadId || null,
      to: contact.email,
      subject: template.subject,
      context: fromImport ? { fromImport: true } : undefined,
      scheduledFor: now,
    });
    const dispatchId =
      dispatch?._id ||
      (await CrmEmailDispatch.findOne({ dedupeKey: `journey:${enrollment._id}:${enrollment.currentStep}` }).select("_id").lean())?._id;
    await CrmJourneyEnrollment.updateOne(
      { _id: enrollment._id, status: "active" },
      {
        $set: { awaitingDispatchId: dispatchId, nextRunAt: null },
        ...pushHistory({ type: "scheduled", stepIndex: enrollment.currentStep, note: template.name, dispatchId }),
      }
    );
    if (dispatch) await automation.enqueueSend(dispatch, now);
    return { status: "scheduled", dispatchId };
  } catch (error) {
    logger.error("crm_engagement.advance_failed", "Could not advance journey", { enrollmentId: String(enrollmentId), error: error.message });
    return { status: "error", error: error.message };
  }
}

async function skipStep(enrollment, journey, reason, now) {
  const nextIndex = enrollment.currentStep + 1;
  const nextStep = journey.steps[nextIndex];
  if (!nextStep) {
    await CrmJourneyEnrollment.updateOne({ _id: enrollment._id }, pushHistory({ type: "skipped", stepIndex: enrollment.currentStep, note: reason }));
    await endEnrollment(enrollment, "completed", "Finished (last step skipped)", now);
    return { status: "completed" };
  }
  await CrmJourneyEnrollment.updateOne(
    { _id: enrollment._id, status: "active" },
    {
      $set: { currentStep: nextIndex, nextRunAt: new Date(now.getTime() + catalog.delayMs(nextStep.delay)) },
      ...pushHistory({ type: "skipped", stepIndex: enrollment.currentStep, note: reason }),
    }
  );
  return { status: "skipped" };
}

/** Applies a finished journey email to its enrolment. */
async function onDispatchOutcome(dispatch, outcome, { reason = "", now = new Date() } = {}) {
  if (!dispatch.enrollmentId) return;
  const enrollment = await CrmJourneyEnrollment.findOne({ _id: dispatch.enrollmentId, status: "active" }).lean();
  if (!enrollment || String(enrollment.awaitingDispatchId) !== String(dispatch._id)) return;
  if (outcome === "sent") {
    const journey = await CrmJourney.findById(enrollment.journeyId).select("steps").lean();
    const nextIndex = (dispatch.stepIndex ?? enrollment.currentStep) + 1;
    const nextStep = journey?.steps?.[nextIndex];
    const set = {
      awaitingDispatchId: null,
      currentStep: nextIndex,
      lastSentAt: now,
      nextRunAt: nextStep ? new Date(now.getTime() + catalog.delayMs(nextStep.delay)) : null,
    };
    await CrmJourneyEnrollment.updateOne(
      { _id: enrollment._id },
      { $set: set, $inc: { emailsSent: 1 }, ...pushHistory({ type: "sent", stepIndex: dispatch.stepIndex, dispatchId: dispatch._id, note: reason }) }
    );
    if (!nextStep) await endEnrollment({ _id: enrollment._id }, "completed", "All emails sent", now);
    return;
  }
  await CrmJourneyEnrollment.updateOne({ _id: enrollment._id }, pushHistory({ type: outcome === "failed" ? "failed" : "skipped", stepIndex: dispatch.stepIndex, dispatchId: dispatch._id, note: reason }));
  await endEnrollment({ _id: enrollment._id }, "exited", reason || "Email was not sent", now);
}

// ── Sending ─────────────────────────────────────────────────────────────────

/** SMTP answers that mean the address does not exist: stop emailing it. */
function isHardBounce(error) {
  const code = Number(error?.responseCode);
  if ([550, 551, 553].includes(code)) return true;
  return /\b5\.1\.[0-3]\b|user unknown|no such user|mailbox unavailable|does not exist/i.test(String(error?.response || error?.message || ""));
}

/**
 * Sends a claimed journey dispatch (status "sending"). Called by
 * crmEmailAutomationService.processDispatch, which owns claiming and retries.
 */
async function processJourneyDispatch(dispatch, { now = new Date() } = {}) {
  const skip = async (reason, outcome = "skipped") => {
    if (outcome === "paused") {
      // Keep the email queued (same step, same dedupe key) and look again later.
      return automation.finish(dispatch, "scheduled", { scheduledFor: new Date(now.getTime() + PAUSE_MS), lastError: `Waiting: ${reason}` });
    }
    logger.info("crm_engagement.email_skipped", "Journey email skipped", { dispatchId: String(dispatch._id), reason });
    const res = await automation.finish(dispatch, "skipped", { lastError: reason });
    await onDispatchOutcome(dispatch, outcome, { reason, now });
    return res;
  };

  let contact;
  try {
    const [enrollment, journey, template, business, settings] = await Promise.all([
      CrmJourneyEnrollment.findById(dispatch.enrollmentId).lean(),
      CrmJourney.findById(dispatch.journeyId).lean(),
      CrmEngagementTemplate.findById(dispatch.templateId).lean(),
      Business.findById(dispatch.businessId).select("_id businessName userId isBlocked").lean(),
      contacts.getSettings(dispatch.businessId),
    ]);
    contact = await CrmContact.findById(dispatch.contactId).lean();

    if (!enrollment || enrollment.status !== "active") return skip("Journey already ended for this contact", "ignored");
    if (!business) return skip("Business no longer exists");
    if (business.isBlocked) return skip("Business is blocked");
    if (!settings.enabled) return skip("Engagement emails are switched off for this business", "paused");
    if (!journey || !journey.isEnabled) return skip("Journey is switched off", "paused");
    if (!template || template.archived || !template.approvedAt) return skip("Template is missing or not approved");
    const blocked = contacts.marketingBlockReason(contact);
    if (blocked) return skip(blocked);
    if (await contacts.globallySuppressed(contact.email, contact.userId)) return skip("Recipient has unsubscribed from all emails");

    const owner = business.userId ? await User.findById(business.userId).select("email").lean() : null;
    const nextBooking = contact.userId
      ? await Appointment.findOne({ businessId: business._id, userId: contact.userId, status: "Scheduled", appointmentDate: { $gte: moment(now).startOf("day").toDate() } })
          .sort({ appointmentDate: 1 })
          .select("appointmentDate timeSlot serviceName")
          .lean()
      : null;
    const values = catalog.buildEngagementValues({
      business,
      contact,
      enrollment,
      appointment: nextBooking,
      listingUrl: getListingUrl(business),
      bookingPageUrl: `${frontendUrl()}/booking?businessId=${business._id}`,
      bookingHistoryUrl: `${frontendUrl()}/bookinghistory`,
    });
    const rendered = automationCatalog.renderTemplate(template, values);
    const unsubscribeLink = links.unsubscribeUrl({ contactId: contact._id, businessId: business._id, email: contact.email });
    const reasonLine = `<p style="color:#888;font-size:12px;margin-top:24px;">You're receiving this because you're in touch with ${automationCatalog.escapeHtml(business.businessName)}.</p>`;
    const html = `${links.trackLinks(rendered.body, dispatch._id)}${reasonLine}`;
    const result = await automation.deliver({
      to: contact.email,
      subject: rendered.subject,
      html,
      business,
      owner,
      unsubscribeLink,
      headers: {
        "List-Unsubscribe": `<${unsubscribeLink}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    if (result && result.success) {
      const sentAt = now;
      const res = await automation.finish(dispatch, "sent", {
        to: contact.email,
        subject: rendered.subject,
        body: rendered.body,
        sentAt,
        messageId: result.info?.messageId || null,
        lastError: null,
      });
      await CrmContact.updateOne({ _id: contact._id }, { $set: { "engagement.lastEmailSentAt": sentAt }, $inc: { "engagement.emailsSent": 1 } });
      await contacts.recordActivity(contact, {
        type: "email_sent",
        summary: `Email sent: ${rendered.subject}`,
        meta: { dispatchId: dispatch._id, journeyId: journey._id },
        countsAsActivity: false,
      });
      await onDispatchOutcome(dispatch, "sent", { reason: template.name, now: sentAt });
      logger.info("crm_engagement.email_sent", "Journey email sent", { dispatchId: String(dispatch._id), journeyId: String(journey._id), businessId: String(business._id) });
      return res;
    }
    throw result?.error || new Error("Unknown email delivery failure");
  } catch (error) {
    const message = error?.message || String(error);
    if (isHardBounce(error) && contact) {
      await contacts.setEmailStatus(contact._id, "bounced", { reason: `Email bounced: ${message}`.slice(0, 280) });
      const res = await automation.finish(dispatch, "failed", { lastError: `Bounced: ${message}` });
      await onDispatchOutcome(dispatch, "failed", { reason: "Email address bounced", now });
      return res;
    }
    if (dispatch.attempts < automation.MAX_ATTEMPTS) {
      const retryAt = automation.nextRetryAt(dispatch.attempts, now);
      logger.warn("crm_engagement.retry_scheduled", "Journey email failed; retry scheduled", { dispatchId: String(dispatch._id), attempt: dispatch.attempts, error: message });
      return automation.finish(dispatch, "scheduled", { scheduledFor: retryAt, lastError: message });
    }
    logger.error("crm_engagement.email_failed", "Journey email failed permanently", { dispatchId: String(dispatch._id), error: message });
    const res = await automation.finish(dispatch, "failed", { lastError: message });
    await onDispatchOutcome(dispatch, "failed", { reason: `Delivery failed: ${message}`.slice(0, 200), now });
    return res;
  }
}

// ── Sweep ───────────────────────────────────────────────────────────────────

/** Enrolments whose email outcome was never applied (worker crash, stale sending). */
async function reconcileEnrollments(now) {
  const stuck = await CrmJourneyEnrollment.find({
    status: "active",
    awaitingDispatchId: { $ne: null },
    updatedAt: { $lt: new Date(now.getTime() - RECONCILE_AFTER_MS) },
  })
    .limit(DUE_BATCH)
    .lean();
  let fixed = 0;
  for (const enrollment of stuck) {
    const dispatch = await CrmEmailDispatch.findById(enrollment.awaitingDispatchId).lean();
    if (!dispatch) {
      await CrmJourneyEnrollment.updateOne({ _id: enrollment._id }, { $set: { awaitingDispatchId: null, nextRunAt: now } });
      fixed++;
    } else if (dispatch.status === "sent") {
      await onDispatchOutcome(dispatch, "sent", { now: dispatch.sentAt || now });
      fixed++;
    } else if (dispatch.status === "failed" || dispatch.status === "skipped") {
      await onDispatchOutcome(dispatch, dispatch.status === "failed" ? "failed" : "skipped", { reason: dispatch.lastError || "", now });
      fixed++;
    }
  }
  return fixed;
}

async function advanceDue(now) {
  const due = await CrmJourneyEnrollment.find({ status: "active", nextRunAt: { $lte: now }, awaitingDispatchId: null })
    .sort({ nextRunAt: 1 })
    .limit(DUE_BATCH)
    .select("_id")
    .lean();
  const summary = { due: due.length, scheduled: 0, deferred: 0, ended: 0 };
  for (const { _id } of due) {
    const res = await advanceEnrollment(_id, { now });
    if (res.status === "scheduled") summary.scheduled++;
    else if (res.status === "deferred" || res.status === "paused") summary.deferred++;
    else if (["exited", "completed"].includes(res.status)) summary.ended++;
  }
  return summary;
}

async function enabledBusinessIds() {
  return (await CrmEngagementSettings.find({ enabled: true }).select("businessId").lean()).map((s) => s.businessId);
}

/** Contacts who started a booking but haven't booked since, per enabled journey. */
async function detectAbandonedBookings(businessIds, now) {
  const journeys = await CrmJourney.find({ businessId: { $in: businessIds }, isEnabled: true, "trigger.signal": "booking_abandoned" }).lean();
  let signals = 0;
  for (const journey of journeys) {
    const { afterHours } = catalog.normalizeTriggerParams("booking_abandoned", journey.trigger.params);
    const found = await CrmContact.find({
      businessId: journey.businessId,
      emailStatus: "subscribed",
      "bookings.lastStartedAt": { $lte: new Date(now.getTime() - afterHours * catalog.HOUR), $gte: new Date(now.getTime() - 3 * catalog.DAY) },
      $or: [{ "bookings.lastBookedAt": null }, { $expr: { $lt: ["$bookings.lastBookedAt", "$bookings.lastStartedAt"] } }],
    })
      .limit(DERIVED_BATCH)
      .lean();
    for (const contact of found) {
      const res = await handleSignal({ contact, signal: "booking_abandoned", now, onlyJourneyId: journey._id });
      if (res.enrolled) signals++;
    }
  }
  return signals;
}

/** Contacts with no activity for the journey's inactivity period. Checked at most weekly each. */
async function detectInactive(businessIds, now) {
  const journeys = await CrmJourney.find({ businessId: { $in: businessIds }, isEnabled: true, "trigger.signal": "inactive" }).lean();
  let signals = 0;
  for (const journey of journeys) {
    const { inactiveDays } = catalog.normalizeTriggerParams("inactive", journey.trigger.params);
    const found = await CrmContact.find({
      businessId: journey.businessId,
      emailStatus: "subscribed",
      "consent.basis": { $in: CrmContact.MARKETING_CONSENT_BASES },
      "engagement.lastActivityAt": { $ne: null, $lt: new Date(now.getTime() - inactiveDays * catalog.DAY) },
      $or: [{ "engagement.inactiveCheckedAt": null }, { "engagement.inactiveCheckedAt": { $lt: new Date(now.getTime() - 7 * catalog.DAY) } }],
    })
      .sort({ "engagement.lastActivityAt": 1 })
      .limit(DERIVED_BATCH)
      .lean();
    for (const contact of found) {
      await CrmContact.updateOne(
        { _id: contact._id },
        { $set: { "engagement.inactiveCheckedAt": now, ...(contact.lifecycle !== "customer" && contact.lifecycle !== "lead" ? { lifecycle: "inactive" } : {}) } }
      );
      const res = await handleSignal({ contact, signal: "inactive", now, onlyJourneyId: journey._id });
      if (res.enrolled) signals++;
    }
  }
  return signals;
}

/** One sweep: reconcile, derived signals, import triage, due steps. */
async function runSweep({ now = new Date() } = {}) {
  if (!dbReady()) return { skipped: true };
  const reconciled = await reconcileEnrollments(now);
  let derived = null;
  if (now.getTime() - lastDerivedRunAt >= DERIVED_INTERVAL_MS) {
    lastDerivedRunAt = now.getTime();
    const businessIds = await enabledBusinessIds();
    if (businessIds.length) {
      derived = {
        abandoned: await detectAbandonedBookings(businessIds, now),
        inactive: await detectInactive(businessIds, now),
      };
    }
  }
  let triage = null;
  try {
    triage = await require("./crmContactImportService").runPendingTriage({ now });
  } catch (error) {
    logger.error("crm_engagement.triage_failed", "Import triage failed", { error: error.message });
  }
  const advanced = await advanceDue(now);
  return { reconciled, derived, triage, ...advanced };
}

// ── Reads for the CRM UI ────────────────────────────────────────────────────

/** Contacts in journeys, for the "Active journeys" view. */
async function listEnrollments(businessId, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 20));
  const filter = { businessId };
  if (query.status && CrmJourneyEnrollment.ENROLLMENT_STATUSES.includes(query.status)) filter.status = query.status;
  if (query.journeyId && mongoose.isValidObjectId(query.journeyId)) filter.journeyId = query.journeyId;
  if (query.contactId && mongoose.isValidObjectId(query.contactId)) filter.contactId = query.contactId;
  const [total, rows] = await Promise.all([
    CrmJourneyEnrollment.countDocuments(filter),
    CrmJourneyEnrollment.find(filter)
      .sort({ status: 1, updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("contactId", "name email lifecycle emailStatus")
      .populate("journeyId", "name trigger steps isEnabled")
      .lean(),
  ]);
  const templateIds = [...new Set(rows.flatMap((r) => (r.journeyId?.steps || []).map((s) => String(s.templateId))))];
  const templates = await CrmEngagementTemplate.find({ _id: { $in: templateIds } }).select("_id name").lean();
  const names = Object.fromEntries(templates.map((t) => [String(t._id), t.name]));
  const enrollments = rows.map((r) => {
    const steps = (r.journeyId?.steps || []).map((s, i) => ({
      index: i,
      templateName: names[String(s.templateId)] || "Email",
      delayLabel: catalog.describeDelay(s.delay),
      condition: s.condition,
      state: i < r.currentStep ? "done" : i === r.currentStep && r.status === "active" ? "next" : "pending",
    }));
    return {
      ...r,
      triggerLabel: catalog.SIGNALS[r.trigger?.signal]?.label || r.trigger?.signal,
      steps,
      nextStepLabel: r.status === "active" ? steps[r.currentStep]?.templateName || null : null,
    };
  });
  return { enrollments, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

/** Owner stops a contact's journey. */
async function stopEnrollment({ businessId, enrollmentId, userName }) {
  if (!mongoose.isValidObjectId(enrollmentId)) throw httpError(404, "Journey enrolment not found");
  const enrollment = await CrmJourneyEnrollment.findOne({ _id: enrollmentId, businessId }).lean();
  if (!enrollment) throw httpError(404, "Journey enrolment not found");
  if (enrollment.status !== "active") throw httpError(400, "This journey has already ended for this contact");
  await endEnrollment(enrollment, "exited", `Stopped by ${userName || "the business"}`);
  const contact = await CrmContact.findById(enrollment.contactId).lean();
  if (contact) {
    await contacts.recordActivity(contact, { type: "journey_exited", summary: `Journey stopped by ${userName || "the business"}`, countsAsActivity: false });
  }
  return { stopped: true };
}

/** Owner puts a contact into a journey by hand (still subject to all checks). */
async function enrollManually({ businessId, journeyId, contactId }) {
  if (!mongoose.isValidObjectId(journeyId) || !mongoose.isValidObjectId(contactId)) throw httpError(404, "Journey or contact not found");
  const [journey, contact, settings] = await Promise.all([
    CrmJourney.findOne({ _id: journeyId, businessId }).lean(),
    CrmContact.findOne({ _id: contactId, businessId }).lean(),
    contacts.getSettings(businessId),
  ]);
  if (!journey || !contact) throw httpError(404, "Journey or contact not found");
  if (!settings.enabled) throw httpError(400, "Switch on engagement emails for this business first");
  const res = await enroll(contact, journey, { signal: journey.trigger.signal, context: { decidedBy: "owner", reason: "Added by the business" } });
  if (!res.enrollment) throw httpError(400, res.skipped || "Contact could not be added to this journey");
  return { enrollment: res.enrollment };
}

/** Headline numbers for the engagement overview. */
async function overview(businessId) {
  const bid = new mongoose.Types.ObjectId(String(businessId));
  const since = new Date(Date.now() - 30 * catalog.DAY);
  const [contactRows, enrollmentRows, emailRows] = await Promise.all([
    CrmContact.aggregate([
      { $match: { businessId: bid } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          marketable: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$emailStatus", "subscribed"] }, { $in: ["$consent.basis", CrmContact.MARKETING_CONSENT_BASES] }, { $gt: ["$email", ""] }] },
                1,
                0,
              ],
            },
          },
          unsubscribed: { $sum: { $cond: [{ $eq: ["$emailStatus", "unsubscribed"] }, 1, 0] } },
          bounced: { $sum: { $cond: [{ $eq: ["$emailStatus", "bounced"] }, 1, 0] } },
          newLast30: { $sum: { $cond: [{ $gte: ["$createdAt", since] }, 1, 0] } },
        },
      },
    ]),
    CrmJourneyEnrollment.aggregate([{ $match: { businessId: bid } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    CrmEmailDispatch.aggregate([
      { $match: { businessId: bid, trigger: "journey", createdAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          skipped: { $sum: { $cond: [{ $eq: ["$status", "skipped"] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $gt: ["$clickCount", 0] }, 1, 0] } },
        },
      },
    ]),
  ]);
  const enrollments = Object.fromEntries(enrollmentRows.map((r) => [r._id, r.count]));
  return {
    contacts: contactRows[0] || { total: 0, marketable: 0, unsubscribed: 0, bounced: 0, newLast30: 0 },
    journeys: { active: enrollments.active || 0, converted: enrollments.converted || 0, completed: enrollments.completed || 0, exited: enrollments.exited || 0 },
    emailsLast30: emailRows[0] || { sent: 0, failed: 0, skipped: 0, clicked: 0 },
  };
}

module.exports = {
  GLOBAL_DAILY_CAP,
  ensureIndexes,
  seedBusiness,
  listJourneys,
  getJourneyView,
  saveJourney,
  setJourneyEnabled,
  deleteJourney,
  disableJourneysUsingTemplate,
  enroll,
  endEnrollment,
  handleSignal,
  journeyParamsMatch,
  advanceEnrollment,
  onDispatchOutcome,
  isHardBounce,
  processJourneyDispatch,
  reconcileEnrollments,
  runSweep,
  listEnrollments,
  stopEnrollment,
  enrollManually,
  overview,
  _resetDerivedTimer: () => {
    lastDerivedRunAt = 0;
  },
};
