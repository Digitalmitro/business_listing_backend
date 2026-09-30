// backend/models/CrmJourneyEnrollment.js
const mongoose = require("mongoose");

const ENROLLMENT_STATUSES = ["active", "completed", "converted", "exited"];

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    type: { type: String, enum: ["enrolled", "scheduled", "sent", "deferred", "skipped", "failed", "completed", "converted", "exited"], required: true },
    stepIndex: { type: Number, default: undefined },
    note: { type: String, default: "" },
    dispatchId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
  },
  { _id: false }
);

/**
 * One contact's path through one journey: which step is next and when, and what
 * happened so far. A contact has at most one active marketing journey per business.
 */
const crmJourneyEnrollmentSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    journeyId: { type: mongoose.Schema.Types.ObjectId, ref: "CrmJourney", required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "CrmContact", required: true },
    status: { type: String, enum: ENROLLMENT_STATUSES, default: "active" },
    /** The signal that started it and what it was about (e.g. the service viewed). */
    trigger: {
      signal: { type: String, required: true },
      at: { type: Date, default: Date.now },
    },
    context: {
      itemName: { type: String, default: undefined },
      serviceName: { type: String, default: undefined },
      importId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
      decidedBy: { type: String, default: undefined },
      reason: { type: String, default: undefined },
    },
    enrolledAt: { type: Date, default: Date.now },
    /** Index of the next step to send. */
    currentStep: { type: Number, default: 0 },
    /** When the next step is due; null while an email is being delivered. */
    nextRunAt: { type: Date, default: null },
    awaitingDispatchId: { type: mongoose.Schema.Types.ObjectId, default: null },
    lastSentAt: { type: Date, default: null },
    emailsSent: { type: Number, default: 0 },
    endedAt: { type: Date, default: null },
    exitReason: { type: String, default: "" },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

// At most one active enrolment per journey and contact.
crmJourneyEnrollmentSchema.index(
  { journeyId: 1, contactId: 1 },
  { unique: true, partialFilterExpression: { status: "active" } }
);
crmJourneyEnrollmentSchema.index({ status: 1, nextRunAt: 1 });
crmJourneyEnrollmentSchema.index({ contactId: 1, status: 1 });
crmJourneyEnrollmentSchema.index({ businessId: 1, status: 1, updatedAt: -1 });
crmJourneyEnrollmentSchema.index({ journeyId: 1, contactId: 1, enrolledAt: -1 });

module.exports = mongoose.model("CrmJourneyEnrollment", crmJourneyEnrollmentSchema);
module.exports.ENROLLMENT_STATUSES = ENROLLMENT_STATUSES;
