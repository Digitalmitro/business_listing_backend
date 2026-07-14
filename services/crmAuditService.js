// backend/services/crmAuditService.js
"use strict";

const mongoose = require("mongoose");
const { CrmAuditLog, AUDIT_ACTIONS } = require("../models/CrmAuditLog");
const logger = require("../utils/logger");

// Max characters stored for notes diffs (avoids massive BSON documents)
const MAX_NOTES_DIFF_LEN = 500;

/**
 * Truncates a string to `max` characters, appending "…" if cut.
 */
function truncate(str, max = MAX_NOTES_DIFF_LEN) {
  if (!str || typeof str !== "string") return str;
  return str.length > max ? str.slice(0, max) + "…" : str;
}

/**
 * Resolves a user's display name from a User document or a plain object.
 * Returns "System" when no user info is available.
 */
function resolveDisplayName(userDoc) {
  if (!userDoc) return "System";
  if (typeof userDoc === "string" || userDoc instanceof mongoose.Types.ObjectId) return "Team Member";
  return userDoc.full_name || userDoc.email || "Team Member";
}

// ── Core write helper ────────────────────────────────────────────────────────

/**
 * Appends one audit log entry to the CrmAuditLog collection.
 * This function is **fire-and-forget safe** — it logs errors but never throws,
 * so callers are never broken by audit failures.
 *
 * @param {Object} opts
 * @param {string|ObjectId} opts.ownerId
 * @param {string|ObjectId} opts.leadId
 * @param {string}          opts.leadName        - Denormalized lead name
 * @param {string}          opts.action          - One of AUDIT_ACTIONS
 * @param {string}          opts.description     - Human-readable summary
 * @param {*}               [opts.previousValue]
 * @param {*}               [opts.newValue]
 * @param {string|ObjectId} [opts.performedBy]   - User ObjectId
 * @param {string}          [opts.performedByName] - Denormalized display name
 * @param {Object}          [opts.metadata]      - Extra key/value context
 * @returns {Promise<void>}
 */
async function logAudit({
  ownerId,
  leadId,
  leadName = "Unknown Lead",
  action,
  description,
  previousValue = null,
  newValue = null,
  performedBy = null,
  performedByName = "System",
  metadata = {},
}) {
  // Validate before touching the DB (silent validation — never throw)
  if (!ownerId || !leadId || !action || !description) {
    logger.warn("crmAuditService.logAudit called with missing required fields", {
      ownerId: !!ownerId,
      leadId: !!leadId,
      action,
    });
    return;
  }

  if (!AUDIT_ACTIONS.includes(action)) {
    logger.warn(`crmAuditService.logAudit: unknown action "${action}" — skipping`);
    return;
  }

  try {
    // Only write when a real DB connection is present
    if (!(mongoose.connection && mongoose.connection.readyState === 1)) return;

    const entry = new CrmAuditLog({
      ownerId,
      leadId,
      leadName: String(leadName || "Unknown Lead").slice(0, 200),
      action,
      description: String(description).slice(0, 500),
      previousValue,
      newValue,
      performedBy: performedBy || null,
      performedByName: String(performedByName || "System").slice(0, 100),
      metadata: new Map(Object.entries(metadata || {}).map(([k, v]) => [k, String(v).slice(0, 200)])),
      timestamp: new Date(),
    });

    await entry.save();
  } catch (err) {
    // Audit failures must never propagate — log and swallow
    logger.error("crmAuditService.logAudit failed silently", { error: err.message, action, leadId });
  }
}

// ── Query helpers ────────────────────────────────────────────────────────────

/**
 * Returns paginated audit logs for an owner with optional filters.
 *
 * @param {string|ObjectId} ownerId
 * @param {Object} opts
 * @param {string}   [opts.leadId]      - Filter to a specific lead
 * @param {string}   [opts.action]      - Filter by action type
 * @param {string}   [opts.performedBy] - Filter by performer ObjectId
 * @param {string}   [opts.search]      - Fuzzy search on description and leadName
 * @param {string}   [opts.startDate]   - ISO date string lower bound
 * @param {string}   [opts.endDate]     - ISO date string upper bound
 * @param {number}   [opts.page=1]
 * @param {number}   [opts.limit=25]
 * @returns {Promise<{ logs, total, page, limit, totalPages, actions: AUDIT_ACTIONS }>}
 */
async function getAuditLogs(ownerId, opts = {}) {
  if (!ownerId) throw new Error("ownerId is required to retrieve audit logs");

  const {
    leadId,
    action,
    performedBy,
    search = "",
    startDate,
    endDate,
    page = 1,
    limit = 25,
  } = opts;

  const pageNum  = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));

  const filter = { ownerId };

  if (leadId)      filter.leadId      = leadId;
  if (action && AUDIT_ACTIONS.includes(action)) filter.action = action;
  if (performedBy) filter.performedBy = performedBy;

  if (startDate || endDate) {
    filter.timestamp = {};
    if (startDate) filter.timestamp.$gte = new Date(startDate);
    if (endDate)   filter.timestamp.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
  }

  if (search && search.trim()) {
    const rx = new RegExp(search.trim(), "i");
    filter.$or = [
      { description: rx },
      { leadName:    rx },
      { performedByName: rx },
    ];
  }

  if (!(mongoose.connection && mongoose.connection.readyState === 1)) {
    return { logs: [], total: 0, page: pageNum, limit: limitNum, totalPages: 0, actions: AUDIT_ACTIONS };
  }

  const [total, logs] = await Promise.all([
    CrmAuditLog.countDocuments(filter),
    CrmAuditLog.find(filter)
      .sort({ timestamp: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
  ]);

  return {
    logs,
    total,
    page: pageNum,
    limit: limitNum,
    totalPages: Math.ceil(total / limitNum) || 1,
    actions: AUDIT_ACTIONS,
  };
}

/**
 * Convenience wrapper: audit logs for a single lead.
 */
async function getAuditLogsForLead(ownerId, leadId, opts = {}) {
  if (!ownerId || !leadId) throw new Error("ownerId and leadId are required");
  return getAuditLogs(ownerId, { ...opts, leadId });
}

/**
 * Exports audit logs as a CSV string.
 * Streams all matching records (up to 10,000) without pagination for download.
 *
 * @returns {Promise<string>} CSV string
 */
async function exportAuditLogs(ownerId, opts = {}) {
  if (!ownerId) throw new Error("ownerId is required");

  const { leadId, action, performedBy, startDate, endDate, search } = opts;
  const filter = { ownerId };
  if (leadId)      filter.leadId      = leadId;
  if (action && AUDIT_ACTIONS.includes(action)) filter.action = action;
  if (performedBy) filter.performedBy = performedBy;
  if (startDate || endDate) {
    filter.timestamp = {};
    if (startDate) filter.timestamp.$gte = new Date(startDate);
    if (endDate)   filter.timestamp.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
  }
  if (search && search.trim()) {
    const rx = new RegExp(search.trim(), "i");
    filter.$or = [{ description: rx }, { leadName: rx }, { performedByName: rx }];
  }

  if (!(mongoose.connection && mongoose.connection.readyState === 1)) {
    return "Timestamp,Action,Lead,Description,Performed By,Previous Value,New Value\n";
  }

  const logs = await CrmAuditLog.find(filter)
    .sort({ timestamp: -1 })
    .limit(10000)
    .lean();

  const escape = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    // CSV-escape: wrap in quotes and double any internal quotes
    return `"${s.replace(/"/g, '""')}"`;
  };

  const header = "Timestamp,Action,Lead Name,Description,Performed By,Previous Value,New Value";
  const rows = logs.map(l =>
    [
      l.timestamp ? new Date(l.timestamp).toISOString() : "",
      l.action,
      l.leadName,
      l.description,
      l.performedByName,
      l.previousValue !== null && l.previousValue !== undefined ? String(l.previousValue) : "",
      l.newValue      !== null && l.newValue      !== undefined ? String(l.newValue)      : "",
    ]
      .map(escape)
      .join(",")
  );

  return [header, ...rows].join("\n");
}

module.exports = {
  AUDIT_ACTIONS,
  truncate,
  resolveDisplayName,
  logAudit,
  getAuditLogs,
  getAuditLogsForLead,
  exportAuditLogs,
};
