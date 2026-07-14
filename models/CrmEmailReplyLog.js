// backend/models/CrmEmailReplyLog.js
const mongoose = require("mongoose");

const crmEmailReplyLogSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CrmLead",
      required: true,
      index: true,
    },
    fromEmail: {
      type: String,
      required: true,
      index: true,
    },
    subject: {
      type: String,
      default: "",
    },
    body: {
      type: String,
      required: true,
    },
    classification: {
      type: String,
      enum: ["Positive", "Negative", "Unknown"],
      required: true,
      index: true,
    },
    matchedKeyword: {
      type: String,
      default: null,
    },
    previousStatus: {
      type: String,
      required: true,
    },
    newStatus: {
      type: String,
      required: true,
      index: true,
    },
    receivedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("CrmEmailReplyLog", crmEmailReplyLogSchema);
