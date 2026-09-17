#!/usr/bin/env node
"use strict";

/**
 * One-off backfill: creates a CRM lead for every business-profile enquiry and
 * appointment that predates automatic lead intake. Safe to re-run: intake is
 * idempotent via sourceRef.
 *
 *   node scripts/backfillCrmLeadsFromEnquiries.js
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const Appointment = require("../models/Appointment");
const User = require("../models/User");
const { createLeadFromEnquiry, createLeadFromAppointment } = require("../services/crmLeadIntakeService");

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name}`);

  let created = 0, skipped = 0;
  const enquiries = await Enquiry.find({ businessId: { $ne: null } }).lean();
  for (const e of enquiries) {
    const lead = await createLeadFromEnquiry(e);
    if (lead && lead.leadName) created++; else skipped++;
  }
  console.log(`Enquiries: ${enquiries.length} scanned`);

  const appointments = await Appointment.find({ status: { $ne: "Canceled" } }).lean();
  for (const a of appointments) {
    const customer = a.userId ? await User.findById(a.userId).select("full_name email phone").lean() : null;
    const lead = await createLeadFromAppointment(a, customer);
    if (lead && lead.leadName) created++; else skipped++;
  }
  console.log(`Appointments: ${appointments.length} scanned`);
  console.log(`Leads created: ${created}; already existed or not applicable: ${skipped}`);
  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
