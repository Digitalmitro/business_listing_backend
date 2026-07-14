// backend/models/CrmAuditLog.js
"use strict";

const mongoose = require("mongoose");

/**
 * All event types the CRM audit system can record.
 * Kept as a flat const so it can be imported by services/controllers.
 */
const AUDIT_ACTIONS = [
  "lead_created",
  "lead_updated",
  "lead_deleted",
  "status_change",
  "pipeline_move",
  "note_changed",
  "followup_changed",
  "email_sent",
  "email_reply",
  "assigned_user_change",
  "revenue_update",
  "activity_logged",
];

const crmAuditLogSchema = new mongoose.Schema(
  {
    // ── Tenant isolation ──────────────────────────────────────────────
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // ── Lead reference ────────────────────────────────────────────────
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CrmLead",
      required: true,
      index: true,
    },
    /** Denormalized so we can display the lead name without a join even after deletion. */
    leadName: {
      type: String,
      default: "Unknown Lead",
      trim: true,
    },

    // ── Event classification ──────────────────────────────────────────
    action: {
      type: String,
      enum: AUDIT_ACTIONS,
      required: true,
      index: true,
    },

    // ── Who did it ────────────────────────────────────────────────────
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    /** Denormalized name so the audit view never needs a populate for display. */
    performedByName: {
      type: String,
      default: "System",
      trim: true,
    },

    // ── What changed ─────────────────────────────────────────────────
    description: {
      type: String,
      required: true,
      trim: true,
    },
    previousValue: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    newValue: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // ── Extra contextual data (email subject, Kanban column, etc.) ────
    metadata: {
      type: Map,
      of: String,
      default: () => new Map(),
    },

    // ── When it happened ─────────────────────────────────────────────
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    // Disable automatic updatedAt — audit logs are immutable
    timestamps: { createdAt: "createdAt", updatedAt: false },
    // Lean schema: audit logs are read-heavy; avoid virtuals overhead
    toJSON: { virtuals: false },
    toObject: { virtuals: false },
  }
);

// ── Compound indexes for common query patterns ────────────────────────────────

/** Primary sort: all audit events for an owner, newest first */
crmAuditLogSchema.index({ ownerId: 1, timestamp: -1 });

/** Per-lead audit timeline */
crmAuditLogSchema.index({ leadId: 1, timestamp: -1 });

/** Filter by action type across an owner */
crmAuditLogSchema.index({ ownerId: 1, action: 1, timestamp: -1 });

/** Filter by performer across an owner */
crmAuditLogSchema.index({ ownerId: 1, performedBy: 1, timestamp: -1 });

module.exports = {
  AUDIT_ACTIONS,
  CrmAuditLog: mongoose.model("CrmAuditLog", crmAuditLogSchema),
};
