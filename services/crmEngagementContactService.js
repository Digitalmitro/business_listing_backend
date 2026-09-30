"use strict";

/**
 * Contacts as the engagement hub of the business-wise CRM.
 *
 * Every person a business can talk to (listing visitors who left their email,
 * customers who booked, enquirers with an account, leads, imported contacts) is one
 * CrmContact per business, found by email (`emailKey`) and otherwise by phone or
 * linked visitor id. This module owns finding/creating those contacts, their
 * activity timeline, marketing eligibility, and the per-business engagement settings.
 *
 * Nothing here sends email or decides journeys; see crmSignalService / crmJourneyService.
 */

const mongoose = require("mongoose");
const validator = require("validator");
const moment = require("moment-timezone");
const CrmContact = require("../models/CrmContact");
const CrmContactActivity = require("../models/CrmContactActivity");
const CrmEngagementSettings = require("../models/CrmEngagementSettings");
const CrmJourneyEnrollment = require("../models/CrmJourneyEnrollment");
const CrmEmailDispatch = require("../models/CrmEmailDispatch");
const Business = require("../models/Business");
const UnsubscribedEmail = require("../models/UnsubscribedEmail");
const User = require("../models/User");
const { CrmLead } = require("../models/CrmLead");
const catalog = require("./crmEngagementCatalog");
const logger = require("../utils/logger");

const { MARKETING_CONSENT_BASES } = CrmContact;
const MAX_INTERESTS = 20;
const MAX_VISITOR_IDS = 5;
/** Repeated views of the same item within this window are folded into one timeline entry. */
const VIEW_FOLD_MS = 30 * 60 * 1000;
/** Consent bases ranked, so a weaker basis never overwrites a stronger one. */
const CONSENT_RANK = { unknown: 0, import_confirmed: 1, manual_confirmed: 1, lead: 2, opt_in: 3, customer: 4 };

function dbReady() {
  return Boolean(mongoose.connection && mongoose.connection.readyState === 1);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeEmail(email) {
  const clean = String(email || "").trim().toLowerCase();
  return clean && validator.isEmail(clean) ? clean : "";
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "").slice(0, 20);
}

function emailKeyFor(businessId, email) {
  const clean = normalizeEmail(email);
  return businessId && clean ? `${businessId}:${clean}` : undefined;
}

function strongerConsent(current, next) {
  return (CONSENT_RANK[next] || 0) > (CONSENT_RANK[current] || 0) ? next : current;
}

/** Visitor ids are random client-generated tokens; accept only a safe shape. */
function validVisitorId(vid) {
  return typeof vid === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(vid) ? vid : null;
}

// ── Settings ────────────────────────────────────────────────────────────────

/** Saved settings merged over defaults. Never throws for a missing document. */
async function getSettings(businessId) {
  const doc = dbReady() ? await CrmEngagementSettings.findOne({ businessId }).lean() : null;
  const d = catalog.DEFAULT_SETTINGS;
  return {
    ...d,
    ...(doc || {}),
    frequency: { ...d.frequency, ...(doc?.frequency || {}) },
    sendWindow: { ...d.sendWindow, ...(doc?.sendWindow || {}) },
    saved: Boolean(doc),
  };
}

async function saveSettings({ ownerId, businessId, input, userId }) {
  const current = await getSettings(businessId);
  const next = catalog.normalizeSettings(input, current);
  const update = { ...next, ownerId, updatedBy: userId || null };
  if (next.enabled && !current.enabled) update.enabledAt = new Date();
  await CrmEngagementSettings.updateOne({ businessId }, { $set: update, $setOnInsert: { businessId } }, { upsert: true });
  logger.info("crm_engagement.settings_saved", "Engagement settings saved", { businessId: String(businessId), enabled: next.enabled });
  return getSettings(businessId);
}

/** Default timezone for a new business's settings: the owner's own. */
async function ensureSettingsDoc(business) {
  const existing = await CrmEngagementSettings.findOne({ businessId: business._id }).lean();
  if (existing) return existing;
  const owner = business.userId ? await User.findById(business.userId).select("timeZone").lean() : null;
  const timezone = owner?.timeZone && moment.tz.zone(owner.timeZone) ? owner.timeZone : catalog.DEFAULT_SETTINGS.timezone;
  try {
    await CrmEngagementSettings.create({ ownerId: business.userId, businessId: business._id, timezone });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  return CrmEngagementSettings.findOne({ businessId: business._id }).lean();
}

// ── Finding and creating contacts ───────────────────────────────────────────

async function loadBusiness(businessId) {
  if (!businessId || !mongoose.isValidObjectId(businessId)) return null;
  return Business.findById(businessId).select("_id userId businessName isBlocked").lean();
}

/**
 * Finds the contact for a person in a business: by email, then linked visitor id,
 * then phone. Returns null when none matches.
 */
async function findContact(businessId, { email, phone, visitorId, userId } = {}) {
  const key = emailKeyFor(businessId, email);
  if (key) {
    const byKey = await CrmContact.findOne({ emailKey: key });
    if (byKey) return byKey;
    // Contacts created before engagement (no emailKey) are matched by email too.
    const legacy = await CrmContact.findOne({ businessId, email: normalizeEmail(email) }).sort({ updatedAt: -1 });
    if (legacy) return legacy;
  }
  if (userId && mongoose.isValidObjectId(userId)) {
    const byUser = await CrmContact.findOne({ businessId, userId });
    if (byUser) return byUser;
  }
  const vid = validVisitorId(visitorId);
  if (vid) {
    const byVisitor = await CrmContact.findOne({ businessId, visitorIds: vid });
    if (byVisitor) return byVisitor;
  }
  const cleanPhone = normalizePhone(phone);
  if (cleanPhone && cleanPhone.length >= 7) {
    const byPhone = await CrmContact.findOne({ businessId, phone: cleanPhone }).sort({ updatedAt: -1 });
    if (byPhone) return byPhone;
  }
  return null;
}

/** Lead of this business with the same email or phone, most recently active first. */
async function findLinkedLead(businessId, { email, phone }) {
  const or = [];
  const cleanEmail = normalizeEmail(email);
  if (cleanEmail) or.push({ email: cleanEmail });
  const cleanPhone = normalizePhone(phone);
  if (cleanPhone && cleanPhone.length >= 7) or.push({ phone: cleanPhone });
  if (!or.length) return null;
  return CrmLead.findOne({ businessId, $or: or }).sort({ updatedAt: -1 }).select("_id status leadName email phone").lean();
}

/**
 * Finds or creates the contact for a person in a business and merges what we just
 * learned. Existing data is only filled in, never blanked; consent only ever gets
 * stronger; an unsubscribed contact stays unsubscribed unless `resubscribe` (an
 * explicit new opt-in) is passed.
 *
 * @returns {Promise<{ contact, created: boolean } | null>} null when the business is
 *   unknown or there is nothing to identify the person by.
 */
async function ensureContact({
  business,
  businessId,
  email,
  phone,
  name,
  userId,
  visitorId,
  source = "Other",
  consent = "unknown",
  tags = [],
  resubscribe = false,
  createIfMissing = true,
} = {}) {
  if (!dbReady()) return null;
  const biz = business || (await loadBusiness(businessId));
  if (!biz || !biz.userId) return null;
  const cleanEmail = normalizeEmail(email);
  const cleanPhone = normalizePhone(phone);
  const vid = validVisitorId(visitorId);
  if (!cleanEmail && !cleanPhone && !userId && !vid) return null;

  const now = new Date();
  let contact = await findContact(biz._id, { email: cleanEmail, phone: cleanPhone, visitorId: vid, userId });
  let created = false;

  if (!contact) {
    if (!createIfMissing || (!cleanEmail && !cleanPhone)) return null;
    const lead = await findLinkedLead(biz._id, { email: cleanEmail, phone: cleanPhone });
    try {
      contact = await CrmContact.create({
        ownerId: biz.userId,
        businessId: biz._id,
        name: String(name || lead?.leadName || "").trim().slice(0, 120),
        email: cleanEmail,
        emailKey: emailKeyFor(biz._id, cleanEmail),
        phone: cleanPhone,
        userId: userId && mongoose.isValidObjectId(userId) ? userId : null,
        leadId: lead?._id || null,
        source,
        tags: [...new Set(tags.filter(Boolean).map((t) => String(t).trim().slice(0, 40)))],
        consent: { basis: consent, capturedAt: consent === "unknown" ? null : now },
        visitorIds: vid ? [vid] : undefined,
        lifecycle: lead ? "lead" : "subscriber",
      });
      created = true;
    } catch (error) {
      if (error.code !== 11000) throw error;
      // Created concurrently by another request: use that one.
      contact = await findContact(biz._id, { email: cleanEmail, phone: cleanPhone, visitorId: vid, userId });
      if (!contact) throw error;
    }
  }

  if (!created) {
    const set = {};
    const addToSet = {};
    if (!contact.name && name) set.name = String(name).trim().slice(0, 120);
    if (!contact.email && cleanEmail) {
      set.email = cleanEmail;
      set.emailKey = emailKeyFor(biz._id, cleanEmail);
    } else if (contact.email && !contact.emailKey && contact.businessId) {
      set.emailKey = emailKeyFor(contact.businessId, contact.email);
    }
    if (!contact.phone && cleanPhone) set.phone = cleanPhone;
    if (!contact.userId && userId && mongoose.isValidObjectId(userId)) set.userId = userId;
    if (!contact.businessId) set.businessId = biz._id;
    const nextConsent = strongerConsent(contact.consent?.basis || "unknown", consent);
    if (nextConsent !== (contact.consent?.basis || "unknown")) set.consent = { basis: nextConsent, capturedAt: now };
    if (resubscribe && contact.emailStatus === "unsubscribed") {
      set.emailStatus = "subscribed";
      set.emailStatusChangedAt = now;
    }
    if (!contact.leadId) {
      const lead = await findLinkedLead(biz._id, { email: cleanEmail || contact.email, phone: cleanPhone || contact.phone });
      if (lead) set.leadId = lead._id;
    }
    if (tags.length) addToSet.tags = { $each: tags.filter(Boolean).map((t) => String(t).trim().slice(0, 40)) };
    if (vid) addToSet.visitorIds = vid;
    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(addToSet).length) update.$addToSet = addToSet;
    if (Object.keys(update).length) {
      try {
        contact = await CrmContact.findOneAndUpdate({ _id: contact._id }, update, { new: true });
      } catch (error) {
        if (error.code !== 11000) throw error;
        // Another contact already owns this email; keep this one as it was.
        delete update.$set?.email;
        delete update.$set?.emailKey;
        contact = await CrmContact.findOneAndUpdate({ _id: contact._id }, update, { new: true });
      }
      if (vid) await trimVisitorIds(contact._id);
    }
  }
  return { contact, created };
}

async function trimVisitorIds(contactId) {
  const doc = await CrmContact.findById(contactId).select("+visitorIds").lean();
  if (doc?.visitorIds?.length > MAX_VISITOR_IDS) {
    await CrmContact.updateOne({ _id: contactId }, { $set: { visitorIds: doc.visitorIds.slice(-MAX_VISITOR_IDS) } });
  }
}

// ── Activity ────────────────────────────────────────────────────────────────

/**
 * Adds an entry to a contact's timeline and updates the contact's activity
 * aggregates. Views of the same item within 30 minutes are folded together.
 * Returns the updated contact document.
 */
async function recordActivity(contact, { type, subject, summary = "", meta, at = new Date(), countsAsActivity = true } = {}) {
  if (!contact || !catalog.ACTIVITY_TYPES.includes(type)) return contact;
  const subjectDoc = subject?.name
    ? { kind: subject.kind, name: String(subject.name).slice(0, 120), refId: subject.refId ? String(subject.refId).slice(0, 64) : undefined }
    : undefined;

  let folded = false;
  if (catalog.VIEW_SIGNALS.includes(type)) {
    const res = await CrmContactActivity.updateOne(
      {
        contactId: contact._id,
        type,
        "subject.name": subjectDoc?.name,
        lastOccurredAt: { $gte: new Date(at.getTime() - VIEW_FOLD_MS) },
      },
      { $inc: { count: 1 }, $set: { lastOccurredAt: at } }
    );
    folded = res.modifiedCount > 0;
  }
  if (!folded) {
    await CrmContactActivity.create({
      ownerId: contact.ownerId,
      businessId: contact.businessId,
      contactId: contact._id,
      type,
      subject: subjectDoc,
      summary: String(summary).slice(0, 300),
      meta,
      occurredAt: at,
      lastOccurredAt: at,
    });
  }

  const set = {};
  const inc = {};
  if (countsAsActivity) {
    set["engagement.lastActivityAt"] = at;
    set["engagement.lastActivityType"] = type;
    if (!folded) inc["engagement.activityCount"] = 1;
  }
  let updated = contact;
  if (Object.keys(set).length || Object.keys(inc).length) {
    updated = await CrmContact.findOneAndUpdate(
      { _id: contact._id },
      { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(inc).length ? { $inc: inc } : {}) },
      { new: true }
    );
  }
  if (subjectDoc && catalog.VIEW_SIGNALS.includes(type)) {
    updated = await recordInterest(updated, subjectDoc, at);
  }
  return refreshLifecycle(updated);
}

/** Keeps the contact's "viewed" list: most recent first, capped. */
async function recordInterest(contact, subject, at) {
  const kind = subject.kind === "service" ? "service" : "business";
  const interests = [...(contact.interests || [])];
  const existing = interests.find((i) => i.kind === kind && i.name.toLowerCase() === subject.name.toLowerCase());
  if (existing) {
    existing.views = (existing.views || 0) + 1;
    existing.lastViewedAt = at;
  } else {
    interests.push({ kind, name: subject.name, refId: subject.refId || "", views: 1, firstViewedAt: at, lastViewedAt: at });
  }
  interests.sort((a, b) => new Date(b.lastViewedAt) - new Date(a.lastViewedAt));
  return CrmContact.findOneAndUpdate({ _id: contact._id }, { $set: { interests: interests.slice(0, MAX_INTERESTS) } }, { new: true });
}

async function refreshLifecycle(contact, now = new Date()) {
  if (!contact) return contact;
  const lifecycle = catalog.computeLifecycle(contact, now);
  if (lifecycle === contact.lifecycle) return contact;
  return CrmContact.findOneAndUpdate({ _id: contact._id }, { $set: { lifecycle } }, { new: true });
}

/** Views of the business's listing/services in the last `withinDays` days. */
async function countRecentVisits(contactId, withinDays, now = new Date()) {
  const since = new Date(now.getTime() - withinDays * catalog.DAY);
  const rows = await CrmContactActivity.aggregate([
    { $match: { contactId: new mongoose.Types.ObjectId(String(contactId)), type: { $in: catalog.VIEW_SIGNALS }, lastOccurredAt: { $gte: since } } },
    { $group: { _id: null, visits: { $sum: 1 } } },
  ]);
  // Folded entries are one visit each; a visit is a distinct browsing session.
  return rows[0]?.visits || 0;
}

// ── Eligibility ─────────────────────────────────────────────────────────────

/**
 * Why a contact must not receive marketing email from this business, or null when
 * they may. Global opt-outs are checked separately at send time as well.
 */
function marketingBlockReason(contact) {
  if (!contact) return "Contact no longer exists";
  if (!normalizeEmail(contact.email)) return "No valid email address";
  if (contact.emailStatus === "unsubscribed") return "Contact unsubscribed";
  if (contact.emailStatus === "bounced") return "Email address bounced";
  if (!MARKETING_CONSENT_BASES.includes(contact.consent?.basis)) return "No permission to email this contact";
  return null;
}

async function globallySuppressed(email, userId) {
  const clean = normalizeEmail(email);
  if (!clean) return true;
  if (await UnsubscribedEmail.exists({ email: clean })) return true;
  const user = userId
    ? await User.findById(userId).select("subscribedToEmails").lean()
    : await User.findOne({ email: clean }).select("subscribedToEmails").lean();
  return user?.subscribedToEmails === false;
}

/** Marks a contact unsubscribed (or bounced) for this business. Returns the updated doc. */
async function setEmailStatus(contactId, status, { reason = "" } = {}) {
  const contact = await CrmContact.findOneAndUpdate(
    { _id: contactId },
    { $set: { emailStatus: status, emailStatusChangedAt: new Date() } },
    { new: true }
  );
  if (contact) {
    const type = status === "bounced" ? "bounced" : status === "unsubscribed" ? "unsubscribed" : "resubscribed";
    await recordActivity(contact, { type, summary: reason || `Email status: ${status}`, countsAsActivity: false });
  }
  return contact;
}

// ── Reads for the CRM UI ────────────────────────────────────────────────────

/** Full profile for the contact drawer: contact, lead, timeline, journeys and emails. */
async function getContactProfile(scope, contactId) {
  if (!mongoose.isValidObjectId(contactId)) throw httpError(404, "Contact not found");
  const contact = await CrmContact.findOne({ _id: contactId, ...scope }).populate("businessId", "businessName").lean();
  if (!contact) throw httpError(404, "Contact not found or you lack permission to view it");

  const [activities, enrollments, emails, lead, suppressed] = await Promise.all([
    CrmContactActivity.find({ contactId: contact._id }).sort({ occurredAt: -1 }).limit(100).lean(),
    CrmJourneyEnrollment.find({ contactId: contact._id }).sort({ enrolledAt: -1 }).limit(20).populate("journeyId", "name trigger steps").lean(),
    CrmEmailDispatch.find({ $or: [{ contactId: contact._id }, ...(contact.email ? [{ businessId: contact.businessId?._id || contact.businessId, to: contact.email }] : [])] })
      .sort({ createdAt: -1 })
      .limit(50)
      .select("-body -dedupeKey")
      .populate("journeyId", "name")
      .lean(),
    contact.leadId ? CrmLead.findById(contact.leadId).select("leadName status source expectedRevenue nextFollowUpDate").lean() : null,
    contact.email ? globallySuppressed(contact.email, contact.userId) : false,
  ]);
  return {
    contact,
    lead,
    activities,
    enrollments,
    emails,
    marketing: {
      blockedReason: marketingBlockReason(contact) || (suppressed ? "Opted out of all UrbanCitations email" : null),
      globallySuppressed: Boolean(suppressed),
    },
  };
}

/**
 * Brings the business's existing leads (with an email) and booking customers into
 * Contacts, so they can take part in engagement. Idempotent; never overwrites.
 */
async function syncExistingPeople(business) {
  const Appointment = require("../models/Appointment");
  const summary = { leads: 0, customers: 0, created: 0 };
  const leads = await CrmLead.find({ businessId: business._id, email: { $ne: "" } }).select("_id leadName email phone status").limit(5000).lean();
  for (const lead of leads) {
    const res = await ensureContact({ business, email: lead.email, phone: lead.phone, name: lead.leadName, source: "Lead", consent: "lead" });
    if (!res) continue;
    summary.leads++;
    if (res.created) summary.created++;
    if (!res.contact.leadId) await CrmContact.updateOne({ _id: res.contact._id }, { $set: { leadId: lead._id } });
  }
  const customerIds = await Appointment.distinct("userId", { businessId: business._id });
  const customers = await User.find({ _id: { $in: customerIds.slice(0, 5000) } }).select("_id full_name email phone").lean();
  for (const user of customers) {
    const res = await ensureContact({ business, email: user.email, phone: user.phone, name: user.full_name, userId: user._id, source: "Booking", consent: "customer" });
    if (!res) continue;
    summary.customers++;
    if (res.created) summary.created++;
    const [count, last] = await Promise.all([
      Appointment.countDocuments({ businessId: business._id, userId: user._id, status: { $ne: "Canceled" } }),
      Appointment.findOne({ businessId: business._id, userId: user._id, status: { $ne: "Canceled" } }).sort({ appointmentDate: -1 }).select("appointmentDate createdAt serviceName").lean(),
    ]);
    if (count) {
      const updated = await CrmContact.findOneAndUpdate(
        { _id: res.contact._id },
        {
          $set: {
            "bookings.count": count,
            "bookings.lastBookedAt": last?.createdAt || last?.appointmentDate || null,
            "bookings.lastServiceName": last?.serviceName || "",
            ...(res.contact.engagement?.lastActivityAt ? {} : { "engagement.lastActivityAt": last?.createdAt || last?.appointmentDate || null }),
          },
        },
        { new: true }
      );
      await refreshLifecycle(updated);
    }
  }
  logger.info("crm_engagement.sync_existing", "Existing leads and customers synced to contacts", { businessId: String(business._id), ...summary });
  return summary;
}

module.exports = {
  MAX_INTERESTS,
  normalizeEmail,
  normalizePhone,
  emailKeyFor,
  validVisitorId,
  strongerConsent,
  getSettings,
  saveSettings,
  ensureSettingsDoc,
  loadBusiness,
  findContact,
  findLinkedLead,
  ensureContact,
  recordActivity,
  refreshLifecycle,
  countRecentVisits,
  marketingBlockReason,
  globallySuppressed,
  setEmailStatus,
  getContactProfile,
  syncExistingPeople,
};
