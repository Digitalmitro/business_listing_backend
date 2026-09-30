// backend/models/CrmEngagementTemplate.js
const mongoose = require("mongoose");
const { TONES } = require("../services/crmEmailAutomationCatalog");
const { TEMPLATE_PURPOSES } = require("../services/crmEngagementCatalog");

/**
 * A business's own email template for engagement journeys. Every business starts
 * with editable copies of the starter templates (`starterKey`); owners can edit,
 * duplicate, create or have AI draft more. A template is only ever sent once the
 * owner has approved its current wording.
 */
const crmEngagementTemplateSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    /** Starter this template was seeded from; unique per business so seeding is idempotent. */
    starterKey: { type: String, default: undefined },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    purpose: { type: String, enum: Object.keys(TEMPLATE_PURPOSES), default: "other" },
    tone: { type: String, enum: [...TONES, null], default: null },
    source: { type: String, enum: ["starter", "custom", "ai", "duplicate"], default: "custom" },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true },
    /** Set only by an explicit owner approval; cleared whenever the wording changes. */
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    archived: { type: Boolean, default: false },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

crmEngagementTemplateSchema.index(
  { businessId: 1, starterKey: 1 },
  { unique: true, partialFilterExpression: { starterKey: { $type: "string" } } }
);

module.exports = mongoose.model("CrmEngagementTemplate", crmEngagementTemplateSchema);
