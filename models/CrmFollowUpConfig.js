// backend/models/CrmFollowUpConfig.js
const mongoose = require("mongoose");

const crmFollowUpConfigSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    isEnabled: {
      type: Boolean,
      default: true,
    },
    defaultIntervalDays: {
      type: Number,
      default: 3, // Default follow-up after 3 days
      min: 1,
    },
    maxAttempts: {
      type: Number,
      default: 3, // Maximum automated follow-ups per lead
      min: 1,
    },
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailTemplate",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("CrmFollowUpConfig", crmFollowUpConfigSchema);
