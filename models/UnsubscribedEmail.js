// backend/models/UnsubscribedEmail.js
"use strict";

const mongoose = require("mongoose");

const unsubscribedEmailSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    reason: {
      type: String,
      default: "User clicked unsubscribe link",
      trim: true,
    },
    source: {
      type: String,
      enum: ["email_campaign", "crm_followup", "manual_admin", "user_setting", "other"],
      default: "email_campaign",
    },
    unsubscribedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

const UnsubscribedEmail = mongoose.model("UnsubscribedEmail", unsubscribedEmailSchema);

module.exports = UnsubscribedEmail;
