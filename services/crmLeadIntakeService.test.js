"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const intake = require("./crmLeadIntakeService");
const { closeQueueConnections } = require("../utils/queue");

test("createLeadFromEnquiry returns null for enquiries without a business and never throws", async () => {
  assert.equal(await intake.createLeadFromEnquiry(null), null);
  assert.equal(await intake.createLeadFromEnquiry({ _id: new mongoose.Types.ObjectId(), businessId: null }), null);
  // Offline (no DB connection): lookups fail and the helper must swallow the error.
  const result = await intake.createLeadFromEnquiry({
    _id: new mongoose.Types.ObjectId(),
    businessId: new mongoose.Types.ObjectId(),
    name: "Jane",
    phone: "911234567890",
    interest: ["Appointment"],
  });
  assert.equal(result, null);
});

test("createLeadFromAppointment returns null without a business and never throws", async () => {
  assert.equal(await intake.createLeadFromAppointment(null), null);
  const result = await intake.createLeadFromAppointment({
    _id: new mongoose.Types.ObjectId(),
    businessId: new mongoose.Types.ObjectId(),
    serviceName: "Haircut",
    appointmentDate: new Date(),
  }, { full_name: "Jane", email: "jane@example.com" });
  assert.equal(result, null);
});

test("createLeadFromAppointment accepts a populated businessId and never throws", async () => {
  const result = await intake.createLeadFromAppointment({
    _id: new mongoose.Types.ObjectId(),
    businessId: { _id: new mongoose.Types.ObjectId(), businessName: "Salon" },
    rescheduledFrom: new mongoose.Types.ObjectId(),
    serviceName: "Haircut",
    appointmentDate: new Date(),
  }, { full_name: "Jane", email: "jane@example.com" });
  assert.equal(result, null);
});

test("recordAppointmentCanceled returns null without a linked lead and never throws", async () => {
  assert.equal(await intake.recordAppointmentCanceled(null), null);
  const result = await intake.recordAppointmentCanceled({
    _id: new mongoose.Types.ObjectId(),
    businessId: { _id: new mongoose.Types.ObjectId() },
    serviceName: "Haircut",
  });
  assert.equal(result, null);
});

test("a booking moves open and lost leads to Booked but keeps converted customers converted", () => {
  for (const status of ["New", "Prospecting", "Negotiation", "Cold Lead", "Closed Lost", "Booked"]) {
    assert.equal(intake.statusAfterBooking(status), "Booked", status);
  }
  assert.equal(intake.statusAfterBooking("Closed Won"), "Closed Won");
  assert.equal(intake.statusAfterBooking("Completed"), "Completed");
});

test("source constants match what the frontends display", () => {
  assert.equal(intake.ENQUIRY_SOURCE, "Business Profile Enquiry");
  assert.equal(intake.APPOINTMENT_SOURCE, "Appointment Booking");
});

after(async () => {
  try { await closeQueueConnections(); } catch { /* ignore */ }
});
