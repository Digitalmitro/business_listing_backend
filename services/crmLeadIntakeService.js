"use strict";

/**
 * Turns customer-facing records (business-profile enquiries and appointment bookings)
 * into CRM leads for the business they belong to, so the business owner sees them in
 * their business-wise CRM without re-keying anything.
 *
 * Both entry points are idempotent: `sourceRef` + a partial unique index guarantee
 * that one enquiry/appointment produces at most one lead, and every failure is
 * logged and swallowed so lead intake can never break the customer's request.
 *
 * Enquiries arrive in the New stage. A booking moves the customer's existing lead for
 * that business to the Booked stage (or creates it there), so a booked customer never
 * stays in, or re-enters, New Leads.
 */

const mongoose = require("mongoose");
const moment = require("moment");
const Business = require("../models/Business");
const { CrmLead, LEAD_STAGE, WON_STATUSES } = require("../models/CrmLead");
const { createLead, recordLeadBooking } = require("./crmLeadService");
const { appointmentStartTime } = require("./crmScope");
const { onLeadCreated } = require("./crmEmailAutomationService");
const logger = require("../utils/logger");

const ENQUIRY_SOURCE = "Business Profile Enquiry";
const APPOINTMENT_SOURCE = "Appointment Booking";

async function findExisting(model, id) {
  return CrmLead.findOne({ "sourceRef.model": model, "sourceRef.id": id }).select("_id").lean();
}

/** Stage a lead moves to on a new booking. Customers who already converted stay converted. */
function statusAfterBooking(currentStatus) {
  return WON_STATUSES.includes(currentStatus) ? currentStatus : LEAD_STAGE.BOOKED;
}

/** The lead an appointment was recorded on, whether it created the lead or was linked later. */
async function findLeadForAppointment(businessId, appointmentId) {
  if (!appointmentId) return null;
  return CrmLead.findOne({
    businessId,
    $or: [
      { "sourceRef.model": "Appointment", "sourceRef.id": appointmentId },
      { appointmentIds: appointmentId },
    ],
  }).lean();
}

/**
 * The customer's existing lead in this business's CRM: the lead of the appointment being
 * rescheduled, otherwise the most recently active lead with the same email or phone.
 */
async function findCustomerLead(business, appointment, customer) {
  if (appointment.rescheduledFrom) {
    const previous = await findLeadForAppointment(business._id, appointment.rescheduledFrom);
    if (previous) return previous;
  }

  const email = (customer?.email || "").trim().toLowerCase();
  const phone = (customer?.phone || "").trim();
  const contactMatch = [];
  if (email) contactMatch.push({ email });
  if (phone) contactMatch.push({ phone });
  if (contactMatch.length === 0) return null;

  return CrmLead.findOne({ ownerId: business.userId, businessId: business._id, $or: contactMatch })
    .sort({ updatedAt: -1 })
    .lean();
}

function describeBooking(appointment) {
  const when = appointment.appointmentDate
    ? moment(appointment.appointmentDate).format("dddd, MMMM Do YYYY")
    : "";
  return {
    service: appointment.serviceName || "Service",
    when: when ? `${when}${appointment.timeSlot ? ` at ${appointment.timeSlot}` : ""}` : "",
  };
}

async function resolveOwner(businessId) {
  if (!businessId || !mongoose.isValidObjectId(businessId)) return null;
  const business = await Business.findById(businessId).select("_id userId businessName").lean();
  if (!business || !business.userId) return null;
  return business;
}

async function createIntakeLead({ business, sourceModel, sourceId, leadData, status = LEAD_STAGE.NEW }) {
  const lead = await createLead(
    business.userId,
    {
      ...leadData,
      businessId: business._id,
      sourceRef: { model: sourceModel, id: sourceId },
      status,
    },
    business.userId
  );
  logger.info("crm_intake.lead_created", {
    leadId: lead._id,
    businessId: business._id,
    source: sourceModel,
    sourceId,
  });
  return lead;
}

/**
 * Creates a CRM lead for a business-profile enquiry. Returns the lead, the existing
 * lead when the enquiry was already converted, or null when nothing applies (no
 * business, business has no owner, or the write failed).
 */
async function createLeadFromEnquiry(enquiry) {
  try {
    if (!enquiry || !enquiry.businessId) return null;
    const existing = await findExisting("Enquiry", enquiry._id);
    if (existing) return existing;

    const business = await resolveOwner(enquiry.businessId);
    if (!business) return null;

    const interests = Array.isArray(enquiry.interest) ? enquiry.interest.filter(Boolean) : [];
    const notes = [
      interests.length ? `Interested in: ${interests.join(", ")}` : "",
      enquiry.location && enquiry.location !== "Unknown" ? `Location: ${enquiry.location}` : "",
      `Submitted via the ${business.businessName} profile enquiry form.`,
    ].filter(Boolean).join("\n");

    const lead = await createIntakeLead({
      business,
      sourceModel: "Enquiry",
      sourceId: enquiry._id,
      leadData: {
        leadName: enquiry.name,
        phone: enquiry.phone || "",
        email: "",
        company: "",
        source: ENQUIRY_SOURCE,
        notes,
      },
    });
    // Business's "New lead" email automation, if enabled (never throws)
    await onLeadCreated(lead);
    return lead;
  } catch (error) {
    logger.error("crm_intake.enquiry_failed", { enquiryId: enquiry?._id, error: error.message });
    return null;
  }
}

/**
 * Puts an appointment booking into the business's CRM in the Booked stage.
 *
 * - The customer already has a lead there (an earlier enquiry or booking, matched by the
 *   rescheduled appointment, email or phone): that lead is moved to Booked and the
 *   booking is added to its timeline. No second lead is created.
 * - Otherwise a new lead is created directly in Booked.
 *
 * `customer` is the booking user (full_name, email, phone) when already loaded by the
 * caller. Idempotent per appointment; never throws.
 */
async function createLeadFromAppointment(appointment, customer = null) {
  try {
    if (!appointment || !appointment.businessId) return null;
    const existing = await findExisting("Appointment", appointment._id);
    if (existing) return existing;

    // Callers may pass the appointment with `businessId` populated (e.g. reschedule).
    const business = await resolveOwner(appointment.businessId._id || appointment.businessId);
    if (!business) return null;

    const linked = await findLeadForAppointment(business._id, appointment._id);
    if (linked) return linked;

    const { service, when } = describeBooking(appointment);
    const startTime = appointmentStartTime(appointment) || appointment.appointmentDate || null;

    const customerLead = await findCustomerLead(business, appointment, customer);
    if (customerLead) {
      const verb = appointment.rescheduledFrom ? "Booking rescheduled" : "Booked";
      const lead = await recordLeadBooking(
        customerLead,
        {
          appointmentId: appointment._id,
          nextStatus: statusAfterBooking(customerLead.status),
          nextFollowUpDate: startTime,
          description: `${verb}: ${service}${when ? ` on ${when}` : ""}`,
        },
        business.userId
      );
      logger.info("crm_intake.booking_linked", {
        leadId: lead._id,
        businessId: business._id,
        appointmentId: appointment._id,
        status: lead.status,
      });
      return lead;
    }

    const notes = [
      `Booked: ${service}`,
      when ? `Date: ${when}` : "",
      `Created from an appointment booking at ${business.businessName}.`,
    ].filter(Boolean).join("\n");

    return await createIntakeLead({
      business,
      sourceModel: "Appointment",
      sourceId: appointment._id,
      status: LEAD_STAGE.BOOKED,
      leadData: {
        leadName: customer?.full_name || "Appointment customer",
        email: customer?.email || "",
        phone: customer?.phone || "",
        company: "",
        source: APPOINTMENT_SOURCE,
        notes,
        appointmentIds: [appointment._id],
        nextFollowUpDate: startTime,
      },
    });
  } catch (error) {
    logger.error("crm_intake.appointment_failed", { appointmentId: appointment?._id, error: error.message });
    return null;
  }
}

/**
 * Logs a customer's cancellation on the lead the appointment belongs to. The lead's
 * stage is left for the business to decide (reschedule, follow up, or mark lost).
 * Never throws.
 */
async function recordAppointmentCanceled(appointment) {
  try {
    if (!appointment || !appointment.businessId) return null;
    const businessId = appointment.businessId._id || appointment.businessId;
    const lead = await findLeadForAppointment(businessId, appointment._id);
    if (!lead) return null;

    const { service, when } = describeBooking(appointment);
    return await recordLeadBooking(
      lead,
      { description: `Booking canceled by the customer: ${service}${when ? ` on ${when}` : ""}` },
      lead.ownerId
    );
  } catch (error) {
    logger.error("crm_intake.cancel_failed", { appointmentId: appointment?._id, error: error.message });
    return null;
  }
}

module.exports = {
  ENQUIRY_SOURCE,
  APPOINTMENT_SOURCE,
  statusAfterBooking,
  createLeadFromEnquiry,
  createLeadFromAppointment,
  recordAppointmentCanceled,
};
