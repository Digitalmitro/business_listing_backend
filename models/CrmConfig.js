// backend/models/CrmConfig.js
"use strict";

/**
 * Configuration-driven CRM models.
 * These models replace every hardcoded business rule in the CRM module:
 *  - CrmPipelineStage  → replaces LEAD_STATUSES + STAGE_PROBABILITIES
 *  - CrmEventType      → replaces VALID_EVENT_TYPES
 *  - CrmReplyKeyword   → replaces hardcoded keyword arrays
 *  - CrmSchedulerConfig → replaces hardcoded scheduler defaults
 */

const mongoose = require("mongoose");

// ── 1. Pipeline Stages (replaces LEAD_STATUSES + STAGE_PROBABILITIES) ──────────

const crmPipelineStageSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    internalKey: {
      type: String,
      required: true,
      trim: true,
      // Derived from name; used for internal lookups and backward compatibility
    },
    color: {
      type: String,
      default: "#6366f1",
      trim: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    probability: {
      type: Number,
      min: 0,
      max: 1,
      default: 0.1,
    },
    isClosed: {
      type: Boolean,
      default: false,
    },
    isWon: {
      type: Boolean,
      default: false,
    },
    isLost: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Owner: null means system-wide default visible to all users
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

crmPipelineStageSchema.index({ ownerId: 1, sortOrder: 1 });
crmPipelineStageSchema.index({ ownerId: 1, internalKey: 1 }, { unique: true, sparse: true });

// ── 2. Event Types (replaces VALID_EVENT_TYPES) ─────────────────────────────────

const crmEventTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    color: {
      type: String,
      default: "#6366f1",
    },
    icon: {
      type: String,
      default: "CalendarOutlined",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

crmEventTypeSchema.index({ isActive: 1, sortOrder: 1 });

// ── 3. Reply Classification Keywords (replaces hardcoded keyword arrays) ──────────

const crmReplyKeywordSchema = new mongoose.Schema(
  {
    keyword: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },
    classification: {
      type: String,
      enum: ["Positive", "Negative", "Unknown"],
      required: true,
    },
    priority: {
      type: Number,
      default: 0,
      // Higher priority keywords are matched first
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

crmReplyKeywordSchema.index({ classification: 1, priority: -1 });
crmReplyKeywordSchema.index({ isActive: 1, classification: 1 });

// ── 4. Scheduler Configuration (replaces hardcoded worker settings) ────────────

const crmSchedulerConfigSchema = new mongoose.Schema(
  {
    // Singleton config document (one per installation)
    key: {
      type: String,
      default: "global",
      unique: true,
    },
    isEnabled: {
      type: Boolean,
      default: true,
    },
    schedulerIntervalMs: {
      type: Number,
      default: 3_600_000, // 1 hour
    },
    maxAttempts: {
      type: Number,
      default: 3,
    },
    retryDelayMs: {
      type: Number,
      default: 1_000,
    },
    // Days before a lead is considered overdue for follow-up
    overdueThresholdDays: {
      type: Number,
      default: 7,
    },
    // Statuses excluded from automated follow-up
    excludedStatuses: {
      type: [String],
      default: ["Completed", "Closed Won", "Closed Lost"],
    },
    // Default follow-up interval in days (overridable per lead)
    defaultIntervalDays: {
      type: Number,
      default: 3,
    },
    // Audit log export limit
    auditExportMaxRows: {
      type: Number,
      default: 10_000,
    },
    // Audit notes diff max length
    auditNotesDiffMaxLen: {
      type: Number,
      default: 500,
    },
    // Dashboard widget sizes
    dashboardRecentLeadsLimit: {
      type: Number,
      default: 6,
    },
    dashboardActivityFeedLimit: {
      type: Number,
      default: 10,
    },
    dashboardCalendarPreviewDays: {
      type: Number,
      default: 30,
    },
    // Currency symbol for revenue display
    currencySymbol: {
      type: String,
      default: process.env.CRM_CURRENCY_SYMBOL || "$",
    },
  },
  { timestamps: true }
);

// ── Export ──────────────────────────────────────────────────────────────────────

const CrmPipelineStage   = mongoose.model("CrmPipelineStage",   crmPipelineStageSchema);
const CrmEventType       = mongoose.model("CrmEventType",       crmEventTypeSchema);
const CrmReplyKeyword    = mongoose.model("CrmReplyKeyword",    crmReplyKeywordSchema);
const CrmSchedulerConfig = mongoose.model("CrmSchedulerConfig", crmSchedulerConfigSchema);

module.exports = {
  CrmPipelineStage,
  CrmEventType,
  CrmReplyKeyword,
  CrmSchedulerConfig,
};
