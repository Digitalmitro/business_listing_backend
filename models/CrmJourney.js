// backend/models/CrmJourney.js
const mongoose = require("mongoose");
const { TRIGGER_SIGNALS, EXIT_SIGNALS, STEP_CONDITIONS } = require("../services/crmEngagementCatalog");

const stepSchema = new mongoose.Schema(
  {
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "CrmEngagementTemplate", required: true },
    /** Wait before this step: after enrolment for the first step, after the previous email otherwise. */
    delay: {
      amount: { type: Number, default: 0 },
      unit: { type: String, enum: ["minutes", "hours", "days"], default: "hours" },
    },
    condition: { type: String, enum: Object.keys(STEP_CONDITIONS), default: "always" },
  },
  { _id: false }
);

/**
 * An automated email journey for one business: the signal that starts it, the
 * emails and waits, and the signals that stop it. Journeys are data, so new ones
 * (by the owner or proposed by AI) need no code changes.
 */
const crmJourneySchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    starterKey: { type: String, default: undefined },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    goal: { type: String, trim: true, maxlength: 300, default: "" },
    trigger: {
      signal: { type: String, enum: TRIGGER_SIGNALS, required: true },
      params: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    steps: { type: [stepSchema], default: [] },
    exitOn: { type: [{ type: String, enum: EXIT_SIGNALS }], default: [] },
    /** When a contact qualifies for two journeys, the higher priority wins. */
    priority: { type: Number, default: 50, min: 0, max: 100 },
    /** A contact is not re-enrolled in this journey within this many days. */
    reentryDays: { type: Number, default: 30 },
    isEnabled: { type: Boolean, default: false },
    enabledAt: { type: Date, default: null },
    source: { type: String, enum: ["starter", "custom", "ai"], default: "custom" },
    /** Why the AI proposed this journey, when it did. */
    rationale: { type: String, default: "", maxlength: 600 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

crmJourneySchema.index({ businessId: 1, "trigger.signal": 1, isEnabled: 1 });
crmJourneySchema.index(
  { businessId: 1, starterKey: 1 },
  { unique: true, partialFilterExpression: { starterKey: { $type: "string" } } }
);

module.exports = mongoose.model("CrmJourney", crmJourneySchema);
