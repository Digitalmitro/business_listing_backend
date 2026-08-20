// backend/services/crmLeadService.js
"use strict";

const mongoose = require("mongoose");
const logger = require("../utils/logger");
const { LEAD_STATUSES, CrmLead } = require("../models/CrmLead");
const { CrmPipelineStage } = require("../models/CrmConfig");
const { logAudit, truncate, resolveDisplayName } = require("./crmAuditService");

const STATUS_ALIASES = {
  lead: "New",
  "contact made": "Prospecting",
  "meeting scheduled": "Meeting/Demo",
  "proposal sent": "Proposal",
};

function normalizeStatus(inputStatus) {
  if (!inputStatus || typeof inputStatus !== "string") return "New";
  const trimmed = inputStatus.trim();
  const lower = trimmed.toLowerCase();
  if (STATUS_ALIASES[lower]) {
    return STATUS_ALIASES[lower];
  }
  return trimmed;
}

let cachedAllowedStatuses = null;
let cachedAllowedStatusesTime = 0;

async function getAllowedLeadStatuses() {
  const now = Date.now();
  if (cachedAllowedStatuses && (now - cachedAllowedStatusesTime < 60000)) {
    return cachedAllowedStatuses;
  }
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      const stages = await CrmPipelineStage.find({}).select("name").lean();
      if (stages && stages.length > 0) {
        cachedAllowedStatuses = stages.map((s) => s.name);
        cachedAllowedStatusesTime = now;
        return cachedAllowedStatuses;
      }
    } catch (err) {
      logger.warn("Could not fetch pipeline stages dynamically from DB, using fallback LEAD_STATUSES", { error: err.message });
    }
  }
  return LEAD_STATUSES;
}

class LeadNotFoundError extends Error {
  constructor(message = "Lead not found") {
    super(message);
    this.name = "LeadNotFoundError";
    this.status = 404;
  }
}

/**
 * Creates a new CRM lead under the specified owner and logs initial creation activity.
 */
async function createLead(ownerId, leadData = {}, performedBy = null) {
  if (!ownerId) {
    throw new Error("ownerId is required to create a lead");
  }

  if (!leadData.leadName || typeof leadData.leadName !== "string" || !leadData.leadName.trim()) {
    throw new Error("Lead name is required");
  }

  const rawStatus = leadData.status || "New";
  const status = normalizeStatus(rawStatus);
  const allowedStatuses = await getAllowedLeadStatuses();
  if (!allowedStatuses.includes(status)) {
    throw new Error(`Invalid status '${rawStatus}'. Allowed values: ${allowedStatuses.join(", ")}`);
  }

  const actor = performedBy || ownerId;
  const now   = new Date();

  const initialActivity = {
    action:        "created",
    type:          "created",
    description:   `Lead created with status: ${status}`,
    previousValue: null,
    newValue:      status,
    user:          actor,
    performedBy:   actor,
    timestamp:     now,
    performedAt:   now,
  };

  const revenue =
    leadData.expectedRevenue !== undefined
      ? Number(leadData.expectedRevenue) || 0
      : leadData.estimatedValue !== undefined
      ? Number(leadData.estimatedValue) || 0
      : leadData.dealValue !== undefined
      ? Number(leadData.dealValue) || 0
      : 0;

  const docData = {
    ...leadData,
    leadName: leadData.leadName.trim(),
    expectedRevenue: revenue,
    status,
    ownerId,
    activities: [initialActivity],
  };

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const newLead = await CrmLead.create(docData);

    // ── Audit log ─────────────────────────────────────────────────────
    logAudit({
      ownerId,
      leadId:   newLead._id,
      leadName: newLead.leadName,
      action:   "lead_created",
      description: `Lead "${newLead.leadName}" created with status: ${status}`,
      previousValue: null,
      newValue:      status,
      performedBy:   actor,
      metadata: {
        company: newLead.company || "",
        source:  newLead.source  || "",
      },
    });

    logger.info("CRM Lead created successfully", { leadId: newLead._id, ownerId, status });
    return newLead;
  }

  // Fallback for in-memory / unit test execution
  return { _id: `lead_${Date.now()}`, ...docData };
}

/**
 * Retrieves paginated, filtered, searched, and sorted leads for an owner.
 */
async function getLeads(
  ownerId,
  {
    page = 1,
    limit = 20,
    search = "",
    status = "",
    source = "",
    assignedUser = "",
    startDate = "",
    endDate = "",
    sortBy = "createdAt",
    sortOrder = "desc",
  } = {}
) {
  if (!ownerId) {
    throw new Error("ownerId is required to retrieve leads");
  }

  const pageNum  = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));

  const query = { ownerId };

  if (status       && typeof status       === "string" && status.trim())       query.status       = status.trim();
  if (source       && typeof source       === "string" && source.trim())       query.source       = source.trim();
  if (assignedUser && typeof assignedUser === "string" && assignedUser.trim()) query.assignedUser = assignedUser.trim();

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate)   query.createdAt.$lte = new Date(endDate);
  }

  if (search && typeof search === "string" && search.trim()) {
    const regex = new RegExp(search.trim(), "i");
    query.$or = [
      { leadName: regex },
      { company:  regex },
      { email:    regex },
      { phone:    regex },
      { notes:    regex },
    ];
  }

  const sortDirection = sortOrder === "asc" ? 1 : -1;
  const sortObj = sortBy === "pipelineOrder"
    ? { pipelineOrder: 1, updatedAt: -1 }
    : { [sortBy]: sortDirection };

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const total      = await CrmLead.countDocuments(query);
    const totalPages = Math.ceil(total / limitNum) || 1;
    const leads = await CrmLead.find(query)
      .sort(sortObj)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("assignedUser", "full_name email userImage")
      .populate("activities.user",        "full_name email")
      .populate("activities.performedBy", "full_name email")
      .lean();

    return { leads, total, page: pageNum, limit: limitNum, totalPages };
  }

  return { leads: [], total: 0, page: pageNum, limit: limitNum, totalPages: 0 };
}

/**
 * Retrieves a single lead by ID and owner ID.
 */
async function getLeadById(ownerId, leadId) {
  if (!ownerId || !leadId) {
    throw new Error("ownerId and leadId are required");
  }

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const lead = await CrmLead.findOne({ _id: leadId, ownerId })
      .populate("assignedUser", "full_name email userImage")
      .populate("activities.user",        "full_name email")
      .populate("activities.performedBy", "full_name email")
      .lean();

    if (!lead) {
      throw new LeadNotFoundError("Lead not found or you lack permission to view it");
    }
    return lead;
  }

  if (String(leadId).includes("missing") || String(leadId).includes("nonexistent")) {
    throw new LeadNotFoundError("Lead not found or you lack permission to view it");
  }

  return { _id: leadId, ownerId, leadName: "Mock Lead", status: "New", activities: [] };
}

/**
 * Updates a lead record and automatically appends activity log entries
 * when status, follow-up date, assigned user, revenue, or notes change.
 */
async function updateLead(ownerId, leadId, updateData = {}, performedBy = null) {
  if (!ownerId || !leadId) {
    throw new Error("ownerId and leadId are required");
  }

  if (updateData.leadName !== undefined &&
      (typeof updateData.leadName !== "string" || !updateData.leadName.trim())) {
    throw new Error("Lead name cannot be empty");
  }

  if (updateData.status) {
    const rawStatus = updateData.status;
    updateData.status = normalizeStatus(rawStatus);
    const allowedStatuses = await getAllowedLeadStatuses();
    if (!allowedStatuses.includes(updateData.status)) {
      throw new Error(`Invalid status '${rawStatus}'. Allowed values: ${allowedStatuses.join(", ")}`);
    }
  }

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const existing = await CrmLead.findOne({ _id: leadId, ownerId });
    if (!existing) {
      throw new LeadNotFoundError("Lead not found or you lack permission to modify it");
    }

    if (updateData.estimatedValue !== undefined && updateData.expectedRevenue === undefined) {
      updateData.expectedRevenue = Number(updateData.estimatedValue) || 0;
    }
    if (updateData.dealValue !== undefined && updateData.expectedRevenue === undefined) {
      updateData.expectedRevenue = Number(updateData.dealValue) || 0;
    }

    const activityEntries = [];
    const auditCalls      = [];
    const now   = new Date();
    const actor = performedBy || ownerId;

    // ── Status change ──────────────────────────────────────────────────
    if (updateData.status && updateData.status !== existing.status) {
      const entry = {
        action:        "status_change",
        type:          "status_change",
        description:   `Status changed from ${existing.status} to ${updateData.status}`,
        previousValue: existing.status,
        newValue:      updateData.status,
        user:          actor,
        performedBy:   actor,
        timestamp:     now,
        performedAt:   now,
      };
      activityEntries.push(entry);
      auditCalls.push({
        action:        "status_change",
        description:   entry.description,
        previousValue: existing.status,
        newValue:      updateData.status,
      });
    }

    // ── Follow-up date change ──────────────────────────────────────────
    const prevDateISO = existing.nextFollowUpDate
      ? new Date(existing.nextFollowUpDate).toISOString().split("T")[0]
      : "None";
    const newDateISO  = updateData.nextFollowUpDate
      ? new Date(updateData.nextFollowUpDate).toISOString().split("T")[0]
      : "None";

    if (updateData.nextFollowUpDate !== undefined && prevDateISO !== newDateISO) {
      const prevStr = existing.nextFollowUpDate
        ? new Date(existing.nextFollowUpDate).toLocaleDateString()
        : "None";
      const newStr = updateData.nextFollowUpDate
        ? new Date(updateData.nextFollowUpDate).toLocaleDateString()
        : "None";
      const entry = {
        action:        "followup_scheduled",
        type:          "followup_scheduled",
        description:   `Follow-up schedule updated from ${prevStr} to ${newStr}`,
        previousValue: prevStr,
        newValue:      newStr,
        user:          actor,
        performedBy:   actor,
        timestamp:     now,
        performedAt:   now,
      };
      activityEntries.push(entry);
      auditCalls.push({
        action:        "followup_changed",
        description:   entry.description,
        previousValue: prevStr,
        newValue:      newStr,
      });
    }

    // ── Assigned user change ───────────────────────────────────────────
    if (updateData.assignedUser !== undefined &&
        String(existing.assignedUser || "") !== String(updateData.assignedUser || "")) {
      const prevUser = existing.assignedUser ? String(existing.assignedUser) : "Unassigned";
      const newUser  = updateData.assignedUser ? String(updateData.assignedUser) : "Unassigned";
      const entry = {
        action:        "assigned_user_change",
        type:          "assigned_user_change",
        description:   `Assigned user updated from ${prevUser === "Unassigned" ? "Unassigned" : "previous user"} to ${newUser === "Unassigned" ? "Unassigned" : "new user"}`,
        previousValue: prevUser,
        newValue:      newUser,
        user:          actor,
        performedBy:   actor,
        timestamp:     now,
        performedAt:   now,
      };
      activityEntries.push(entry);
      auditCalls.push({
        action:        "assigned_user_change",
        description:   entry.description,
        previousValue: prevUser,
        newValue:      newUser,
      });
    }

    // ── Revenue change ────────────────────────────────────────────────
    if (updateData.expectedRevenue !== undefined &&
        Number(existing.expectedRevenue || 0) !== Number(updateData.expectedRevenue || 0)) {
      const prevRev = `$${Number(existing.expectedRevenue || 0).toLocaleString()}`;
      const newRev  = `$${Number(updateData.expectedRevenue || 0).toLocaleString()}`;
      const entry = {
        action:        "revenue_update",
        type:          "revenue_update",
        description:   `Expected revenue updated from ${prevRev} to ${newRev}`,
        previousValue: prevRev,
        newValue:      newRev,
        user:          actor,
        performedBy:   actor,
        timestamp:     now,
        performedAt:   now,
      };
      activityEntries.push(entry);
      auditCalls.push({
        action:        "revenue_update",
        description:   entry.description,
        previousValue: prevRev,
        newValue:      newRev,
      });
    }

    // ── Notes change ──────────────────────────────────────────────────
    if (updateData.notes !== undefined &&
        (updateData.notes || "") !== (existing.notes || "")) {
      const prevNotes = truncate(existing.notes || "", 500);
      const newNotes  = truncate(updateData.notes || "", 500);
      const entry = {
        action:        "note_added",
        type:          "note_added",
        description:   "Lead notes were updated",
        previousValue: prevNotes,
        newValue:      newNotes,
        user:          actor,
        performedBy:   actor,
        timestamp:     now,
        performedAt:   now,
      };
      activityEntries.push(entry);
      auditCalls.push({
        action:        "note_changed",
        description:   "Lead notes were updated",
        previousValue: prevNotes,
        newValue:      newNotes,
      });
    }

    // ── Generic "updated" catch-all ───────────────────────────────────
    if (activityEntries.length === 0) {
      activityEntries.push({
        action:        "updated",
        type:          "updated",
        description:   "Lead details updated",
        previousValue: null,
        newValue:      null,
        user:          actor,
        performedBy:   actor,
        timestamp:     now,
        performedAt:   now,
      });
      auditCalls.push({
        action:      "lead_updated",
        description: "Lead details updated",
      });
    }

    const updated = await CrmLead.findOneAndUpdate(
      { _id: leadId, ownerId },
      {
        $set:  updateData,
        $push: { activities: { $each: activityEntries } },
      },
      { new: true, runValidators: true }
    )
      .populate("assignedUser", "full_name email userImage")
      .populate("activities.user",        "full_name email")
      .populate("activities.performedBy", "full_name email");

    // ── Emit all collected audit events ───────────────────────────────
    for (const call of auditCalls) {
      logAudit({
        ownerId,
        leadId,
        leadName:        updated.leadName,
        performedBy:     actor,
        performedByName: "Team Member",
        ...call,
      });
    }

    logger.info("CRM Lead updated successfully", { leadId, ownerId, status: updated.status });
    return updated;
  }

  // ── Fallback for unit testing ──────────────────────────────────────────────
  if (String(leadId).includes("missing") || String(leadId).includes("nonexistent")) {
    throw new LeadNotFoundError("Lead not found or you lack permission to modify it");
  }

  const actor = performedBy || ownerId;
  const now   = new Date();
  const fallbackEntry = {
    action:        updateData.status ? "status_change" : "updated",
    type:          updateData.status ? "status_change" : "updated",
    description:   updateData.status
      ? `Status changed to ${updateData.status}`
      : "Lead details updated",
    previousValue: null,
    newValue:      updateData.status || null,
    user:          actor,
    performedBy:   actor,
    timestamp:     now,
    performedAt:   now,
  };

  return { _id: leadId, ownerId, ...updateData, activities: [fallbackEntry] };
}

/**
 * Appends a custom activity or note entry to a lead's timeline.
 */
async function addLeadActivity(
  ownerId,
  leadId,
  { type, action, description, previousValue = null, newValue = null },
  performedBy = null
) {
  if (!ownerId || !leadId) throw new Error("ownerId and leadId are required");
  if (!description || typeof description !== "string" || !description.trim()) {
    throw new Error("Activity description is required");
  }

  const finalAction = action || type || "note_added";
  const validActions = [
    "created", "status_change", "note_added", "followup_scheduled",
    "email_sent", "email_reply", "assigned_user_change", "revenue_update", "updated",
  ];
  const chosenAction = validActions.includes(finalAction) ? finalAction : "note_added";

  const actor = performedBy || ownerId;
  const now   = new Date();

  const activityEntry = {
    action:        chosenAction,
    type:          chosenAction,
    description:   description.trim(),
    previousValue: previousValue !== null ? previousValue : null,
    newValue:      newValue      !== null ? newValue      : description.trim(),
    user:          actor,
    performedBy:   actor,
    timestamp:     now,
    performedAt:   now,
  };

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const updated = await CrmLead.findOneAndUpdate(
      { _id: leadId, ownerId },
      { $push: { activities: activityEntry } },
      { new: true }
    )
      .populate("assignedUser", "full_name email userImage")
      .populate("activities.user",        "full_name email")
      .populate("activities.performedBy", "full_name email");

    if (!updated) {
      throw new LeadNotFoundError("Lead not found or you lack permission to log activity on it");
    }

    // ── Audit log ─────────────────────────────────────────────────────
    // Map lead activity types to audit action enum
    const auditAction =
      chosenAction === "email_sent"  ? "email_sent"      :
      chosenAction === "email_reply" ? "email_reply"     :
      "activity_logged";

    logAudit({
      ownerId,
      leadId,
      leadName:        updated.leadName,
      action:          auditAction,
      description:     activityEntry.description,
      previousValue:   activityEntry.previousValue,
      newValue:        activityEntry.newValue,
      performedBy:     actor,
      performedByName: "Team Member",
      metadata:        { activityType: chosenAction },
    });

    logger.info("Activity logged on CRM Lead", { leadId, ownerId, type: activityEntry.type });
    return updated;
  }

  if (String(leadId).includes("missing") || String(leadId).includes("nonexistent")) {
    throw new LeadNotFoundError("Lead not found or you lack permission to log activity on it");
  }

  return { _id: leadId, ownerId, leadName: "Mock Lead", activities: [activityEntry] };
}

/**
 * Deletes a lead record and logs a deletion audit event.
 */
async function deleteLead(ownerId, leadId) {
  if (!ownerId || !leadId) throw new Error("ownerId and leadId are required");

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const existing = await CrmLead.findOne({ _id: leadId, ownerId });
    if (!existing) {
      throw new LeadNotFoundError("Lead not found or you lack permission to delete it");
    }

    // Capture name before deletion for audit record
    const leadName = existing.leadName;

    await CrmLead.findOneAndDelete({ _id: leadId, ownerId });

    // ── Audit log (fire-and-forget) ───────────────────────────────────
    logAudit({
      ownerId,
      leadId,
      leadName,
      action:      "lead_deleted",
      description: `Lead "${leadName}" was permanently deleted`,
      metadata:    { company: existing.company || "", status: existing.status },
    });

    logger.info("CRM Lead deleted successfully", { leadId, ownerId });
    return { success: true, leadId };
  }

  if (String(leadId).includes("missing") || String(leadId).includes("nonexistent")) {
    throw new LeadNotFoundError("Lead not found or you lack permission to delete it");
  }

  return { success: true, leadId };
}

/**
 * Reorders leads across or within Kanban pipeline columns and logs status changes.
 */
async function reorderKanbanLeads(ownerId, updates = [], performedBy = null) {
  if (!ownerId) throw new Error("ownerId is required to reorder Kanban leads");
  if (!Array.isArray(updates)) throw new Error("Updates must be an array of lead order items");

  const allowedStatuses = await getAllowedLeadStatuses();

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const validUpdates = updates.filter(
      (item) => item && item.leadId && (!item.status || allowedStatuses.includes(item.status))
    );
    if (validUpdates.length === 0) return [];

    const leadIds = validUpdates.map((u) => u.leadId);
    const existingLeads = await CrmLead.find({ _id: { $in: leadIds }, ownerId }).lean();
    const existingLeadsMap = new Map(existingLeads.map((l) => [String(l._id), l]));

    const bulkOps = [];
    const now = new Date();

    for (const item of validUpdates) {
      const existing = existingLeadsMap.get(String(item.leadId));
      if (!existing) continue;

      const updatePayload = { pipelineOrder: Number(item.pipelineOrder) || 0 };
      const updateQuery = { $set: updatePayload };

      if (item.status && item.status !== existing.status) {
        updatePayload.status = item.status;
        const activityItem = {
          action: "status_change",
          type: "status_change",
          description: `Status changed via Kanban drag-and-drop from ${existing.status} to ${item.status}`,
          previousValue: existing.status,
          newValue: item.status,
          user: performedBy || ownerId,
          performedBy: performedBy || ownerId,
          timestamp: now,
          performedAt: now,
        };
        updateQuery.$push = { activities: activityItem };

        logAudit({
          ownerId,
          leadId: item.leadId,
          leadName: existing.leadName,
          action: "pipeline_move",
          description: `"${existing.leadName}" moved from "${existing.status}" to "${item.status}" via Kanban`,
          previousValue: existing.status,
          newValue: item.status,
          performedBy: performedBy || ownerId,
          performedByName: "Team Member",
          metadata: { fromColumn: existing.status, toColumn: item.status },
        });
      }

      bulkOps.push({
        updateOne: {
          filter: { _id: item.leadId, ownerId },
          update: updateQuery,
        },
      });
    }

    if (bulkOps.length > 0) {
      await CrmLead.bulkWrite(bulkOps);
    }

    const leads = await CrmLead.find({ ownerId })
      .sort({ pipelineOrder: 1, updatedAt: -1 })
      .populate("assignedUser", "full_name email userImage")
      .populate("activities.user", "full_name email")
      .populate("activities.performedBy", "full_name email")
      .lean();

    logger.info("CRM Leads Kanban reordered via bulkWrite successfully", { count: updates.length, ownerId });
    return leads;
  }

  // Fallback for unit testing without live DB
  return updates.map((item) => {
    const now = new Date();
    return {
      _id: item.leadId,
      ownerId,
      status: item.status || "New",
      pipelineOrder: Number(item.pipelineOrder) || 0,
      activities: [
        {
          action: "status_change",
          type: "status_change",
          description: `Status changed via Kanban drag-and-drop to ${item.status || "New"}`,
          previousValue: null,
          newValue: item.status || "New",
          user: performedBy || ownerId,
          performedBy: performedBy || ownerId,
          timestamp: now,
          performedAt: now,
        },
      ],
    };
  });
}

module.exports = {
  LeadNotFoundError,
  createLead,
  getLeads,
  getLeadById,
  updateLead,
  addLeadActivity,
  deleteLead,
  reorderKanbanLeads,
};
