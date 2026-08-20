// backend/models/CrmLead.js
const mongoose = require("mongoose");

const LEAD_STATUSES = [
  "New",
  "Prospecting",
  "Qualification",
  "Meeting/Demo",
  "Proposal",
  "Negotiation",
  "Pending Follow-Up",
  "Follow-Up Sent",
  "Warm Lead",
  "Cold Lead",
  "Closed Won",
  "Closed Lost",
  "Completed",
];

const leadActivitySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: [
        "created",
        "status_change",
        "note_added",
        "followup_scheduled",
        "email_sent",
        "email_reply",
        "assigned_user_change",
        "revenue_update",
        "updated",
      ],
      required: true,
    },
    type: {
      type: String, // maintained for backward compatibility with existing queries/UI
    },
    description: {
      type: String,
      required: true,
    },
    previousValue: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    newValue: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    performedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const crmLeadSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    leadName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    company: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      default: "",
      index: true,
    },
    phone: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    source: {
      type: String,
      trim: true,
      default: "Other",
      index: true,
    },
    notes: {
      type: String,
      default: "",
    },
    expectedRevenue: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },
    assignedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    nextFollowUpDate: {
      type: Date,
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: LEAD_STATUSES,
      default: "New",
      required: true,
      index: true,
    },
    pipelineOrder: {
      type: Number,
      default: 0,
      index: true,
    },
    lastFollowUpSentAt: {
      type: Date,
      default: null,
      index: true,
    },
    followUpCount: {
      type: Number,
      default: 0,
    },
    lastFollowUpStatus: {
      type: String,
      enum: ["pending", "sent", "failed", "skipped"],
      default: "pending",
      index: true,
    },
    lastFollowUpError: {
      type: String,
      default: null,
    },
    followUpIntervalDays: {
      type: Number,
      default: null,
    },
    activities: [leadActivitySchema],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual getters and setters for estimatedValue and dealValue aliases
crmLeadSchema.virtual("estimatedValue")
  .get(function () { return this.expectedRevenue !== undefined ? this.expectedRevenue : 0; })
  .set(function (val) { this.expectedRevenue = Number(val) || 0; });

crmLeadSchema.virtual("dealValue")
  .get(function () { return this.expectedRevenue !== undefined ? this.expectedRevenue : 0; })
  .set(function (val) { this.expectedRevenue = Number(val) || 0; });

// Compound index for fast multi-tenant pipeline filtering and Kanban ordering
crmLeadSchema.index({ ownerId: 1, status: 1, pipelineOrder: 1, expectedRevenue: -1 });

// Full-text search index across name, company, email, and notes
crmLeadSchema.index({ leadName: "text", company: "text", email: "text", notes: "text" }, { name: "lead_text_index" });

module.exports = {
  LEAD_STATUSES,
  CrmLead: mongoose.model("CrmLead", crmLeadSchema),
};
