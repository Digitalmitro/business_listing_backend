"use strict";

/**
 * The CRM's contact-activity event bus.
 *
 * Every place where a contact does something (views a listing, leaves their email,
 * starts or makes a booking, sends an enquiry, clicks or replies to an email,
 * unsubscribes) calls one function here. It:
 *   1. finds (or, where appropriate, creates) the contact in that business's CRM,
 *   2. records the activity on the contact's timeline and updates its aggregates,
 *   3. hands the signal to the journey engine, which stops or starts journeys.
 *
 * Privacy rules for attribution:
 *   - Contacts are only created when a person gives their details to the business
 *     (email capture, enquiry, booking, import, manual entry). Merely browsing a
 *     listing never creates a contact.
 *   - Browsing is attributed only to people who are already that business's contact
 *     or lead: signed-in customers by account email/phone, anonymous visitors by the
 *     random visitor id they linked when they gave their email.
 *   - Business owners browsing their own listing are ignored.
 *
 * All functions here swallow and log errors: engagement must never break a booking,
 * an enquiry or a page view.
 */

const mongoose = require("mongoose");
const CrmContact = require("../models/CrmContact");
const CrmEmailDispatch = require("../models/CrmEmailDispatch");
const catalog = require("./crmEngagementCatalog");
const contacts = require("./crmEngagementContactService");
const journeys = require("./crmJourneyService");
const { appointmentStartTime } = require("./crmScope");
const logger = require("../utils/logger");

function dbReady() {
  return Boolean(mongoose.connection && mongoose.connection.readyState === 1);
}

function cleanItem(item) {
  if (!item || typeof item !== "object") return null;
  const name = String(item.name || "").trim().slice(0, 120);
  if (!name) return null;
  return { kind: item.kind === "service" ? "service" : "business", name, refId: item.id ? String(item.id).slice(0, 64) : undefined };
}

function summaryFor(signal, subject, extra) {
  const label = catalog.SIGNALS[signal]?.label || signal;
  if (extra) return `${label}: ${extra}`;
  return subject?.name ? `${label}: ${subject.name}` : label;
}

/**
 * Records a signal for a contact that has already been resolved, applies its effect
 * on the contact's aggregates and runs the journey engine.
 */
async function applySignal(contact, signal, { subject, summary, meta, context = {}, now = new Date(), bookingUpdate } = {}) {
  const def = catalog.SIGNALS[signal];
  let current = contact;
  if (bookingUpdate) {
    current = (await CrmContact.findOneAndUpdate({ _id: current._id }, bookingUpdate, { new: true })) || current;
  }
  if (signal === "email_replied") {
    current = (await CrmContact.findOneAndUpdate({ _id: current._id }, { $set: { "engagement.lastRepliedAt": now } }, { new: true })) || current;
  }
  if (def?.activity) {
    current = await contacts.recordActivity(current, { type: signal, subject, summary: summary || summaryFor(signal, subject), meta, at: now });
  }
  const result = await journeys.handleSignal({ contact: current.toObject ? current.toObject() : current, signal, context: { itemName: subject?.name, ...context }, now });

  // Browsing may also mean "keeps coming back".
  if (catalog.VIEW_SIGNALS.includes(signal) && !result.enrolled) {
    await journeys.handleSignal({ contact: current.toObject ? current.toObject() : current, signal: "repeat_visit", context: { itemName: subject?.name }, now });
  }
  return { contact: current, ...result };
}

/**
 * A known visitor browsed a business: listing opened, service viewed, or booking
 * page opened. Never creates a contact from browsing alone.
 */
async function onListingActivity({ businessId, event, item, viewer = null, visitorId = null, now = new Date() } = {}) {
  try {
    if (!dbReady() || !["business_viewed", "service_viewed", "booking_started"].includes(event)) return null;
    const business = await contacts.loadBusiness(businessId);
    if (!business || !business.userId || business.isBlocked) return null;
    if (viewer && String(viewer._id) === String(business.userId)) return null;

    let contact = null;
    if (viewer) {
      contact = await contacts.findContact(business._id, { email: viewer.email, userId: viewer._id, phone: viewer.phone });
      if (!contact) {
        // An existing lead of this business who is signed in becomes a contact.
        const lead = await contacts.findLinkedLead(business._id, { email: viewer.email, phone: viewer.phone });
        if (lead && viewer.email) {
          const res = await contacts.ensureContact({ business, email: viewer.email, phone: viewer.phone, name: viewer.full_name, userId: viewer._id, source: "Lead", consent: "lead" });
          contact = res?.contact || null;
        }
      } else if (!contact.userId) {
        await CrmContact.updateOne({ _id: contact._id }, { $set: { userId: viewer._id } });
      }
    }
    if (!contact && visitorId) {
      contact = await contacts.findContact(business._id, { visitorId });
    }
    if (!contact) return null;

    const subject = cleanItem(item) || { kind: "business", name: business.businessName };
    const bookingUpdate = event === "booking_started" ? { $set: { "bookings.lastStartedAt": now } } : undefined;
    return await applySignal(contact, event, { subject, now, bookingUpdate });
  } catch (error) {
    logger.error("crm_signal.listing_activity_failed", "Listing activity tracking failed", { businessId: String(businessId), event, error: error.message });
    return null;
  }
}

/**
 * A visitor gave their email on a business's listing ("Get updates" / "Ask about
 * availability"). Creates or updates the contact with opt-in consent, links their
 * anonymous visitor id, and starts the "recently viewed" style journeys.
 */
async function onContactCaptured({ businessId, email, name, visitorId, item, viewer = null, now = new Date() } = {}) {
  try {
    if (!dbReady()) return null;
    const business = await contacts.loadBusiness(businessId);
    if (!business || !business.userId || business.isBlocked) return null;
    if (viewer && String(viewer._id) === String(business.userId)) return null;
    const res = await contacts.ensureContact({
      business,
      email,
      name,
      visitorId,
      userId: viewer && contacts.normalizeEmail(viewer.email) === contacts.normalizeEmail(email) ? viewer._id : null,
      source: "Listing Visitor",
      consent: "opt_in",
      resubscribe: true,
    });
    if (!res) return null;
    const subject = cleanItem(item) || { kind: "business", name: business.businessName };
    // The page they were on counts as a view, so "viewed" templates have something to say.
    const viewed = await contacts.recordActivity(res.contact, { type: subject.kind === "service" ? "service_viewed" : "business_viewed", subject, summary: summaryFor(subject.kind === "service" ? "service_viewed" : "business_viewed", subject), at: now });
    const out = await applySignal(viewed || res.contact, "contact_captured", { subject, summary: `Left their email while viewing ${subject.name}`, now });
    logger.info("crm_signal.contact_captured", "Contact captured from listing", { businessId: String(business._id), contactId: String(res.contact._id), created: res.created });
    return { ...out, created: res.created };
  } catch (error) {
    logger.error("crm_signal.capture_failed", "Contact capture failed", { businessId: String(businessId), error: error.message });
    return null;
  }
}

/** A booking was made: the customer becomes/remains a contact and marketing hands over. */
async function onBookingCreated(appointment, customer, { now = new Date() } = {}) {
  try {
    if (!dbReady() || !appointment?.businessId) return null;
    const business = await contacts.loadBusiness(appointment.businessId._id || appointment.businessId);
    if (!business || !business.userId) return null;
    if (customer && String(customer._id) === String(business.userId)) return null;
    const res = await contacts.ensureContact({
      business,
      email: customer?.email,
      phone: customer?.phone,
      name: customer?.full_name,
      userId: customer?._id || appointment.userId,
      source: "Booking",
      consent: "customer",
    });
    if (!res) return null;
    const start = appointmentStartTime(appointment);
    const isReschedule = Boolean(appointment.rescheduledFrom);
    const bookingUpdate = {
      $set: {
        "bookings.lastBookedAt": now,
        "bookings.lastServiceName": appointment.serviceName || "",
        ...(start && start > now ? { "bookings.nextBookingAt": start } : {}),
        lifecycle: "customer",
      },
      ...(isReschedule ? {} : { $inc: { "bookings.count": 1 } }),
    };
    const subject = { kind: "service", name: appointment.serviceName || "Booking", refId: String(appointment._id) };
    const when = start ? start.toISOString() : "";
    return await applySignal(res.contact, "booking_created", {
      subject,
      summary: `${isReschedule ? "Booking rescheduled" : "Booked"}: ${subject.name}`,
      meta: { appointmentId: appointment._id, start: when },
      context: { serviceName: appointment.serviceName },
      now,
      bookingUpdate,
    });
  } catch (error) {
    logger.error("crm_signal.booking_failed", "Booking signal failed", { appointmentId: String(appointment?._id), error: error.message });
    return null;
  }
}

async function onBookingCanceled(appointment, { now = new Date() } = {}) {
  try {
    if (!dbReady() || !appointment?.businessId) return null;
    const businessId = appointment.businessId._id || appointment.businessId;
    const contact = await CrmContact.findOne({ businessId, userId: appointment.userId?._id || appointment.userId });
    if (!contact) return null;
    return await applySignal(contact, "booking_canceled", {
      subject: { kind: "service", name: appointment.serviceName || "Booking", refId: String(appointment._id) },
      meta: { appointmentId: appointment._id },
      now,
      bookingUpdate: { $set: { "bookings.nextBookingAt": null } },
    });
  } catch (error) {
    logger.error("crm_signal.cancel_failed", "Booking cancel signal failed", { appointmentId: String(appointment?._id), error: error.message });
    return null;
  }
}

/**
 * A profile enquiry. Enquiries carry a phone but no email, so a contact is only
 * created when the enquirer is signed in (their account email), or already exists.
 */
async function onEnquiry(enquiry, { now = new Date() } = {}) {
  try {
    if (!dbReady() || !enquiry?.businessId) return null;
    const business = await contacts.loadBusiness(enquiry.businessId);
    if (!business || !business.userId) return null;
    let email = "";
    if (enquiry.userId) {
      const User = require("../models/User");
      const user = await User.findById(enquiry.userId).select("email").lean();
      if (user && String(user._id) === String(business.userId)) return null;
      email = user?.email || "";
    }
    const res = await contacts.ensureContact({
      business,
      email,
      phone: enquiry.phone,
      name: enquiry.name,
      userId: enquiry.userId || null,
      source: "Enquiry",
      consent: "lead",
      createIfMissing: Boolean(email),
    });
    if (!res) return null;
    const interests = Array.isArray(enquiry.interest) ? enquiry.interest.filter(Boolean) : [];
    return await applySignal(res.contact, "enquiry_submitted", {
      subject: interests[0] ? { kind: "service", name: String(interests[0]).slice(0, 120) } : { kind: "business", name: business.businessName },
      summary: `Enquiry${interests.length ? `: ${interests.join(", ")}`.slice(0, 200) : ""}`,
      meta: { enquiryId: enquiry._id },
      now,
    });
  } catch (error) {
    logger.error("crm_signal.enquiry_failed", "Enquiry signal failed", { enquiryId: String(enquiry?._id), error: error.message });
    return null;
  }
}

/** A lead replied to an email (reply tracking). */
async function onLeadReplied(lead, { now = new Date() } = {}) {
  try {
    if (!dbReady() || !lead?.businessId || !lead.email) return null;
    const contact = await contacts.findContact(lead.businessId, { email: lead.email });
    if (!contact) return null;
    return await applySignal(contact, "email_replied", { summary: "Replied to an email", now });
  } catch (error) {
    logger.error("crm_signal.reply_failed", "Reply signal failed", { leadId: String(lead?._id), error: error.message });
    return null;
  }
}

/** A lead was marked won: its contact has converted. */
async function onLeadWon(lead, { now = new Date() } = {}) {
  try {
    if (!dbReady() || !lead?.businessId) return null;
    const contact = await CrmContact.findOne({ businessId: lead.businessId, $or: [{ leadId: lead._id }, ...(lead.email ? [{ email: lead.email }] : [])] });
    if (!contact) return null;
    return await applySignal(contact, "lead_won", { summary: `Lead marked ${lead.status}`, now });
  } catch (error) {
    logger.error("crm_signal.lead_won_failed", "Lead-won signal failed", { leadId: String(lead?._id), error: error.message });
    return null;
  }
}

/** A tracked link in a journey email was clicked. Returns nothing; never throws. */
async function onEmailClicked(dispatchId, { now = new Date() } = {}) {
  try {
    if (!dbReady() || !mongoose.isValidObjectId(dispatchId)) return;
    const dispatch = await CrmEmailDispatch.findOneAndUpdate(
      { _id: dispatchId },
      { $inc: { clickCount: 1 } },
      { new: false }
    ).lean();
    if (!dispatch) return;
    if (!dispatch.firstClickedAt) await CrmEmailDispatch.updateOne({ _id: dispatchId, firstClickedAt: null }, { $set: { firstClickedAt: now } });
    if (!dispatch.contactId) return;
    const contact = await CrmContact.findOneAndUpdate({ _id: dispatch.contactId }, { $set: { "engagement.lastClickedAt": now } }, { new: true });
    if (!contact) return;
    // Only the first click on an email counts as a new signal.
    if (dispatch.clickCount > 0) return;
    await applySignal(contact, "email_clicked", { summary: `Clicked a link in "${dispatch.subject || "an email"}"`, meta: { dispatchId }, now });
  } catch (error) {
    logger.error("crm_signal.click_failed", "Email click tracking failed", { dispatchId: String(dispatchId), error: error.message });
  }
}

/** The contact opted out of this business's emails (signed unsubscribe link or owner action). */
async function onContactUnsubscribed(contactId, { reason = "Unsubscribed via email link", now = new Date() } = {}) {
  const contact = await contacts.setEmailStatus(contactId, "unsubscribed", { reason });
  if (contact) await journeys.handleSignal({ contact: contact.toObject(), signal: "unsubscribed", now });
  return contact;
}

/** An address opted out of all email (global unsubscribe): every business's contact stops. */
async function onGlobalUnsubscribe(email, { reason = "Unsubscribed from all emails", now = new Date() } = {}) {
  try {
    const clean = contacts.normalizeEmail(email);
    if (!dbReady() || !clean) return 0;
    const matches = await CrmContact.find({ email: clean, emailStatus: { $ne: "unsubscribed" } }).select("_id").lean();
    for (const { _id } of matches) {
      await onContactUnsubscribed(_id, { reason, now });
    }
    return matches.length;
  } catch (error) {
    logger.error("crm_signal.global_unsubscribe_failed", "Could not apply global unsubscribe to contacts", { error: error.message });
    return 0;
  }
}

module.exports = {
  applySignal,
  onListingActivity,
  onContactCaptured,
  onBookingCreated,
  onBookingCanceled,
  onEnquiry,
  onLeadReplied,
  onLeadWon,
  onEmailClicked,
  onContactUnsubscribed,
  onGlobalUnsubscribe,
};
