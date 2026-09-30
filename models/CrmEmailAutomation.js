// backend/models/CrmEmailAutomation.js
const mongoose = require("mongoose");
const { TRIGGER_KEYS, TONES } = require("../services/crmEmailAutomationCatalog");

/**
 * One email automation per business and trigger: which template it sends, when,
 * and whether it is switched on. The template is the owner's saved copy (started
 * from a preset, edited by hand or drafted by AI) and must be approved before the
 * automation can be enabled.
 */
const crmEmailAutomationSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    trigger: { type: String, enum: TRIGGER_KEYS, required: true },
    isEnabled: { type: Boolean, default: false, index: true },
    /** When the automation was last switched on; after-booking emails never go to bookings before this. */
    activatedAt: { type: Date, default: null },
    template: {
      /** Preset the owner started from, if any. */
      presetKey: { type: String, default: null },
      name: { type: String, trim: true, maxlength: 100, default: "" },
      tone: { type: String, enum: [...TONES, null], default: null },
      /** Where the current wording came from. */
      source: { type: String, enum: ["preset", "custom", "ai"], default: "preset" },
      subject: { type: String, required: true, trim: true, maxlength: 200 },
      body: { type: String, required: true },
      /** Set only by an explicit owner approval; cleared whenever the wording changes. */
      approvedAt: { type: Date, default: null },
      approvedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    timing: {
      amount: { type: Number, default: undefined },
      unit: { type: String, enum: ["minutes", "hours", "days"], default: undefined },
      sendHour: { type: Number, min: 0, max: 23, default: undefined },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

crmEmailAutomationSchema.index({ businessId: 1, trigger: 1 }, { unique: true });
crmEmailAutomationSchema.index({ trigger: 1, isEnabled: 1 });

module.exports = mongoose.model("CrmEmailAutomation", crmEmailAutomationSchema);
