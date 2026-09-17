"use strict";

/**
 * Turns customer-facing records (business-profile enquiries and appointment bookings)
 * into CRM leads for the business they belong to, so the business owner sees them in
 * their business-wise CRM without re-keying anything.
 *
 * Both entry points are idempotent: `sourceRef` + a partial unique index guarantee
 * that one enquiry/appointment produces at most one lead, and every failure is
 * logged and swallowed so lead intake can never break the customer's request.
 */

const mongoose = require("mongoose");
const moment = require("moment");
const Business = require("../models/Business");
const { CrmLead } = require("../models/CrmLead");
const { createLead } = require("./crmLeadService");
const logger = require("../utils/logger");

const ENQUIRY_SOURCE = "Business Profile Enquiry";
const APPOINTMENT_SOURCE = "Appointment Booking";

async function findExisting(model, id) {
  return CrmLead.findOne({ "sourceRef.model": model, "sourceRef.id": id }).select("_id").lean();
}

async function resolveOwner(businessId) {
  if (!businessId || !mongoose.isValidObjectId(businessId)) return null;
  const business = await Business.findById(businessId).select("_id userId businessName").lean();
  if (!business || !business.userId) return null;
  return business;
}

async function createIntakeLead({ business, sourceModel, sourceId, leadData }) {
  const lead = await createLead(
    business.userId,
    {
      ...leadData,
      businessId: business._id,
      sourceRef: { model: sourceModel, id: sourceId },
      status: "New",
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

    return await createIntakeLead({
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
  } catch (error) {
    logger.error("crm_intake.enquiry_failed", { enquiryId: enquiry?._id, error: error.message });
    return null;
  }
}

/**
 * Creates a CRM lead for an appointment booking. `customer` is the booking user
 * (full_name, email, phone) when already loaded by the caller.
 */
async function createLeadFromAppointment(appointment, customer = null) {
  try {
    if (!appointment || !appointment.businessId) return null;
    const existing = await findExisting("Appointment", appointment._id);
    if (existing) return existing;

    const business = await resolveOwner(appointment.businessId);
    if (!business) return null;

    const when = appointment.appointmentDate
      ? moment(appointment.appointmentDate).format("dddd, MMMM Do YYYY")
      : "";
    const notes = [
      `Booked: ${appointment.serviceName || "Service"}`,
      when ? `Date: ${when}${appointment.timeSlot ? ` at ${appointment.timeSlot}` : ""}` : "",
      `Created from an appointment booking at ${business.businessName}.`,
    ].filter(Boolean).join("\n");

    return await createIntakeLead({
      business,
      sourceModel: "Appointment",
      sourceId: appointment._id,
      leadData: {
        leadName: customer?.full_name || "Appointment customer",
        email: customer?.email || "",
        phone: customer?.phone || "",
        company: "",
        source: APPOINTMENT_SOURCE,
        notes,
        nextFollowUpDate: appointment.appointmentDate || null,
      },
    });
  } catch (error) {
    logger.error("crm_intake.appointment_failed", { appointmentId: appointment?._id, error: error.message });
    return null;
  }
}

module.exports = {
  ENQUIRY_SOURCE,
  APPOINTMENT_SOURCE,
  createLeadFromEnquiry,
  createLeadFromAppointment,
};
