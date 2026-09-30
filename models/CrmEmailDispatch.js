// backend/models/CrmEmailDispatch.js
const mongoose = require("mongoose");
const { TRIGGER_KEYS } = require("../services/crmEmailAutomationCatalog");

const DISPATCH_STATUSES = ["scheduled", "sending", "sent", "failed", "skipped"];

/**
 * One automated email for one lead/booking and trigger: when it is due, and what
 * happened when it was sent. `dedupeKey` is unique, so the same trigger can never
 * email the same lead/booking twice, however many times the event fires.
 */
const crmEmailDispatchSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    automationId: { type: mongoose.Schema.Types.ObjectId, ref: "CrmEmailAutomation", default: null },
    trigger: { type: String, enum: TRIGGER_KEYS, required: true },
    dedupeKey: { type: String, required: true, unique: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "CrmLead", default: null, index: true },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment", default: null },
    /** Customer (User) behind the booking or listing view, used when the lead has no email. */
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /** Extra event context, e.g. the service a lead viewed. */
    context: { type: mongoose.Schema.Types.Mixed, default: undefined },
    scheduledFor: { type: Date, required: true },
    status: { type: String, enum: DISPATCH_STATUSES, default: "scheduled" },
    attempts: { type: Number, default: 0 },
    lockedAt: { type: Date, default: null },
    to: { type: String, default: "" },
    subject: { type: String, default: "" },
    body: { type: String, default: "" },
    messageId: { type: String, default: null },
    /** Why an email failed or was skipped. */
    lastError: { type: String, default: null },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Due-work scan used by the scheduler.
crmEmailDispatchSchema.index({ status: 1, scheduledFor: 1 });
// Delivery log and per-trigger counters in the CRM.
crmEmailDispatchSchema.index({ businessId: 1, trigger: 1, status: 1 });
crmEmailDispatchSchema.index({ businessId: 1, createdAt: -1 });

module.exports = mongoose.model("CrmEmailDispatch", crmEmailDispatchSchema);
module.exports.DISPATCH_STATUSES = DISPATCH_STATUSES;
