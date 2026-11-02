#!/usr/bin/env node
"use strict";

/**
 * Re-queues customer/lead emails that were skipped only because the business had
 * no verified sender of its own ("The business hasn't connected and verified its
 * own email address"). Run it AFTER deploying the platform-sender fallback in
 * services/clientMailer.js, or the old code will skip them again.
 *
 *   node scripts/resendSenderSkippedEmails.js                       # dry run: lists what would be re-sent
 *   node scripts/resendSenderSkippedEmails.js --apply               # re-queues them
 *   node scripts/resendSenderSkippedEmails.js --since=2026-11-01 --business=<id>
 *
 * Rows go back to "scheduled"; the running worker sweep picks them up within a
 * minute and re-checks them at send time (a reminder for an appointment that has
 * already started, or a canceled booking, is skipped again with that reason).
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const mongoose = require("mongoose");
const AppointmentNotification = require("../models/AppointmentNotification");
const CrmEmailDispatch = require("../models/CrmEmailDispatch");

const APPLY = process.argv.includes("--apply");
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").split("=")[1];
const SINCE = new Date(arg("since") || "2026-11-01T00:00:00Z");
const BUSINESS = arg("business");
const SENDER_SKIP = "The business hasn't connected and verified its own email address";

async function main() {
  if (Number.isNaN(SINCE.getTime())) throw new Error("--since must be a date, e.g. --since=2026-11-01");
  if (BUSINESS && !mongoose.isValidObjectId(BUSINESS)) throw new Error("--business must be a business id");
  await mongoose.connect(process.env.MONGO_URI);

  const filter = { status: "skipped", lastError: SENDER_SKIP, updatedAt: { $gte: SINCE } };
  if (BUSINESS) filter.businessId = new mongoose.Types.ObjectId(BUSINESS);

  const [bookings, dispatches] = await Promise.all([
    AppointmentNotification.find(filter).select("_id businessId key recipient to scheduledFor").lean(),
    CrmEmailDispatch.find(filter).select("_id businessId trigger to scheduledFor").lean(),
  ]);

  console.log(`${APPLY ? "Re-queuing" : "Would re-queue"} ${bookings.length} booking email(s) and ${dispatches.length} CRM email(s) skipped since ${SINCE.toISOString()}:`);
  for (const b of bookings) console.log(`  booking  ${b.key}/${b.recipient}  ${b.to || "-"}  business ${b.businessId}`);
  for (const d of dispatches) console.log(`  crm      ${d.trigger}  ${d.to || "-"}  business ${d.businessId}`);

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply (after deploying the clientMailer fallback) to re-send.");
  } else {
    const reset = { $set: { status: "scheduled", lastError: null, lockedAt: null, attempts: 0 } };
    const [b, d] = await Promise.all([
      bookings.length ? AppointmentNotification.updateMany({ _id: { $in: bookings.map((x) => x._id) } }, reset) : { modifiedCount: 0 },
      dispatches.length ? CrmEmailDispatch.updateMany({ _id: { $in: dispatches.map((x) => x._id) } }, reset) : { modifiedCount: 0 },
    ]);
    console.log(`\nRe-queued ${b.modifiedCount} booking and ${d.modifiedCount} CRM email(s). Watch them in CRM → Email Automation → Delivery log.`);
  }
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
