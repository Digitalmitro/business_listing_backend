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

test("source constants match what the frontends display", () => {
  assert.equal(intake.ENQUIRY_SOURCE, "Business Profile Enquiry");
  assert.equal(intake.APPOINTMENT_SOURCE, "Appointment Booking");
});

after(async () => {
  try { await closeQueueConnections(); } catch { /* ignore */ }
});
