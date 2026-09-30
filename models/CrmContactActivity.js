// backend/models/CrmContactActivity.js
const mongoose = require("mongoose");
const { ACTIVITY_TYPES } = require("../services/crmEngagementCatalog");

/**
 * One thing a CRM contact did (viewed a service, booked, clicked an email...) or
 * that happened to them (email sent, journey started). Kept in its own collection
 * because page views are high-volume; repeated views of the same item within a
 * short window are folded into one entry (`count`).
 */
const crmContactActivitySchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "CrmContact", required: true },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    /** What the activity was about, e.g. { kind: "service", name: "Hair Spa" }. */
    subject: {
      kind: { type: String, default: undefined },
      name: { type: String, default: undefined },
      refId: { type: String, default: undefined },
    },
    /** Short human-readable summary shown on the timeline. */
    summary: { type: String, default: "", maxlength: 300 },
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
    count: { type: Number, default: 1 },
    occurredAt: { type: Date, default: Date.now },
    lastOccurredAt: { type: Date, default: Date.now },
  },
  { timestamps: false, versionKey: false }
);

crmContactActivitySchema.index({ contactId: 1, occurredAt: -1 });
crmContactActivitySchema.index({ contactId: 1, type: 1, lastOccurredAt: -1 });
crmContactActivitySchema.index({ businessId: 1, occurredAt: -1 });

module.exports = mongoose.model("CrmContactActivity", crmContactActivitySchema);
