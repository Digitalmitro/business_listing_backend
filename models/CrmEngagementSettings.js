// backend/models/CrmEngagementSettings.js
const mongoose = require("mongoose");

/**
 * Per-business switches for contact engagement: the master on/off switch, how often
 * a contact may be emailed, when emails may go out, and import behaviour.
 * Defaults live in crmEngagementCatalog.DEFAULT_SETTINGS.
 */
const crmEngagementSettingsSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, unique: true },
    enabled: { type: Boolean, default: false },
    enabledAt: { type: Date, default: null },
    frequency: {
      maxPerWeek: { type: Number, default: 2 },
      minHoursBetween: { type: Number, default: 48 },
    },
    sendWindow: {
      startHour: { type: Number, default: 9 },
      endHour: { type: Number, default: 20 },
    },
    timezone: { type: String, default: "Asia/Kolkata" },
    /** New imported contacts that may start a journey per day, to protect sender reputation. */
    importDailyLimit: { type: Number, default: 200 },
    aiTriage: { type: Boolean, default: true },
    /** Show the "get updates" email box on the public listing page. */
    captureWidget: { type: Boolean, default: true },
    /** Set when starter templates and journeys were copied in. */
    seededAt: { type: Date, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CrmEngagementSettings", crmEngagementSettingsSchema);
