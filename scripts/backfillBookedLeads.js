#!/usr/bin/env node
"use strict";

/**
 * Re-files leads that are still in the New stage although the customer has already
 * booked. Leads created before automatic lead segregation were always filed as New.
 *
 *   node scripts/backfillBookedLeads.js            # dry run: report only
 *   node scripts/backfillBookedLeads.js --apply    # write the changes
 *
 * Two groups of New leads are covered:
 *   A. leads created from an appointment booking (sourceRef.model = "Appointment")
 *   B. other leads (enquiries, manual, imports) of a customer who booked the same
 *      business, matched by the booking user's email or phone
 *
 * The target stage follows the customer's latest booking for that business:
 *   Scheduled / Rescheduled -> Booked
 *   Completed               -> Closed Won (the customer was served)
 *   Canceled only           -> left in New and listed for manual review
 *
 * Leads are updated in place: same id, notes and history, plus a status_change entry
 * on the timeline and the booking linked in appointmentIds. Nothing is merged or deleted.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const Appointment = require("../models/Appointment");
require("../models/User");
const { CrmLead, LEAD_STAGE } = require("../models/CrmLead");

const APPLY = process.argv.includes("--apply");

const norm = (v) => String(v || "").trim().toLowerCase();

/** Stage for a booking, or null when it gives no reason to move the lead. */
function stageForAppointment(status) {
  if (status === "Completed") return LEAD_STAGE.WON;
  if (status === "Scheduled" || status === "Rescheduled") return LEAD_STAGE.BOOKED;
  return null;
}

/** Latest booking first; a live or completed booking beats a canceled one. */
function pickBooking(appointments) {
  const sorted = [...appointments].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return sorted.find((a) => stageForAppointment(a.status)) || sorted[0] || null;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name} (${APPLY ? "APPLY" : "DRY RUN"})`);

  const newLeads = await CrmLead.find({ status: LEAD_STAGE.NEW, businessId: { $ne: null } })
    .select("_id leadName email phone ownerId businessId sourceRef source")
    .lean();

  const businessIds = [...new Set(newLeads.map((l) => String(l.businessId)))];
  const appointments = await Appointment.find({ businessId: { $in: businessIds } })
    .select("_id businessId userId status createdAt")
    .populate("userId", "email phone")
    .lean();

  const byId = new Map(appointments.map((a) => [String(a._id), a]));
  const byBusiness = new Map();
  for (const a of appointments) {
    const key = String(a.businessId);
    if (!byBusiness.has(key)) byBusiness.set(key, []);
    byBusiness.get(key).push(a);
  }

  const moves = [];    // { lead, group, appointment, to }
  const review = [];   // { lead, group, reason }

  for (const lead of newLeads) {
    let group;
    let matched = [];
    if (lead.sourceRef?.model === "Appointment") {
      group = "A";
      const own = byId.get(String(lead.sourceRef.id));
      if (own) matched = [own];
    } else {
      const email = norm(lead.email);
      const phone = norm(lead.phone);
      if (!email && !phone) continue;
      matched = (byBusiness.get(String(lead.businessId)) || []).filter((a) => {
        const u = a.userId || {};
        return (email && norm(u.email) === email) || (phone && norm(u.phone) === phone);
      });
      if (matched.length === 0) continue;
      group = "B";
    }

    const booking = pickBooking(matched);
    const to = booking ? stageForAppointment(booking.status) : null;
    if (!to) {
      review.push({ lead, group, reason: booking ? `booking ${booking.status}` : "booking not found" });
      continue;
    }
    moves.push({ lead, group, appointment: booking, to });
  }

  const print = (title, rows, fmt) => {
    console.log(`\n${title}: ${rows.length}`);
    for (const r of rows.slice(0, 60)) console.log(`  ${fmt(r)}`);
    if (rows.length > 60) console.log(`  ... ${rows.length - 60} more`);
  };
  const label = (lead) => `${lead._id}  ${JSON.stringify(lead.leadName)}  [${lead.source || "Other"}]`;

  console.log(`\nNew leads with a business: ${newLeads.length}`);
  for (const group of ["A", "B"]) {
    const name = group === "A" ? "A. created from a booking" : "B. other leads of customers who booked";
    for (const stage of [LEAD_STAGE.BOOKED, LEAD_STAGE.WON]) {
      print(`${name} -> ${stage}`, moves.filter((m) => m.group === group && m.to === stage),
        (m) => `${label(m.lead)}  (booking ${m.appointment.status})`);
    }
  }
  print("Left in New for manual review", review, (r) => `${label(r.lead)}  group ${r.group}: ${r.reason}`);

  if (!APPLY) { console.log("\nDry run only. Re-run with --apply to write these changes."); await mongoose.disconnect(); return; }

  const now = new Date();
  const ops = moves.map(({ lead, appointment, to }) => ({
    updateOne: {
      filter: { _id: lead._id, status: LEAD_STAGE.NEW },
      update: {
        $set: { status: to },
        $addToSet: { appointmentIds: appointment._id },
        $push: {
          activities: {
            action: "status_change",
            type: "status_change",
            description: `Status changed from ${LEAD_STAGE.NEW} to ${to} (customer booking ${appointment.status.toLowerCase()})`,
            previousValue: LEAD_STAGE.NEW,
            newValue: to,
            user: lead.ownerId,
            performedBy: lead.ownerId,
            timestamp: now,
            performedAt: now,
          },
        },
      },
    },
  }));
  const res = ops.length ? await CrmLead.bulkWrite(ops) : { modifiedCount: 0 };
  console.log(`\nUpdated ${res.modifiedCount} leads.`);
  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
