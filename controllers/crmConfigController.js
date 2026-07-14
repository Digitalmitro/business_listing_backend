// backend/controllers/crmConfigController.js
"use strict";

const logger = require("../utils/logger");
const {
  CrmPipelineStage,
  CrmEventType,
  CrmReplyKeyword,
  CrmSchedulerConfig,
} = require("../models/CrmConfig");
const { STAGE_PROBABILITIES } = require("../services/crmForecastService");

/**
 * Helper to get default pipeline stages if none exist in DB.
 */
function getDefaultStages() {
  const defaultList = [
    { name: "New", internalKey: "New", color: "#3b82f6", sortOrder: 1, probability: 0.10, isClosed: false, isWon: false, isLost: false },
    { name: "Prospecting", internalKey: "Prospecting", color: "#6366f1", sortOrder: 2, probability: 0.20, isClosed: false, isWon: false, isLost: false },
    { name: "Qualification", internalKey: "Qualification", color: "#8b5cf6", sortOrder: 3, probability: 0.40, isClosed: false, isWon: false, isLost: false },
    { name: "Meeting/Demo", internalKey: "Meeting/Demo", color: "#ec4899", sortOrder: 4, probability: 0.60, isClosed: false, isWon: false, isLost: false },
    { name: "Proposal", internalKey: "Proposal", color: "#f43f5e", sortOrder: 5, probability: 0.75, isClosed: false, isWon: false, isLost: false },
    { name: "Negotiation", internalKey: "Negotiation", color: "#f97316", sortOrder: 6, probability: 0.90, isClosed: false, isWon: false, isLost: false },
    { name: "Pending Follow-Up", internalKey: "Pending Follow-Up", color: "#eab308", sortOrder: 7, probability: 0.30, isClosed: false, isWon: false, isLost: false },
    { name: "Follow-Up Sent", internalKey: "Follow-Up Sent", color: "#14b8a6", sortOrder: 8, probability: 0.35, isClosed: false, isWon: false, isLost: false },
    { name: "Warm Lead", internalKey: "Warm Lead", color: "#22c55e", sortOrder: 9, probability: 0.70, isClosed: false, isWon: false, isLost: false },
    { name: "Cold Lead", internalKey: "Cold Lead", color: "#64748b", sortOrder: 10, probability: 0.05, isClosed: false, isWon: false, isLost: false },
    { name: "Closed Won", internalKey: "Closed Won", color: "#10b981", sortOrder: 11, probability: 1.00, isClosed: true, isWon: true, isLost: false },
    { name: "Completed", internalKey: "Completed", color: "#059669", sortOrder: 12, probability: 1.00, isClosed: true, isWon: true, isLost: false },
    { name: "Closed Lost", internalKey: "Closed Lost", color: "#ef4444", sortOrder: 13, probability: 0.00, isClosed: true, isWon: false, isLost: true },
  ];
  return defaultList;
}

/**
 * GET /api/crm/config/stages
 * Retrieve all active pipeline stages (owner specific + global or defaults).
 */
exports.getPipelineStages = async (req, res) => {
  try {
    const ownerId = req.user ? req.user._id : null;
    const filter = { isActive: true };
    if (ownerId) {
      filter.$or = [{ ownerId: null }, { ownerId }];
    } else {
      filter.ownerId = null;
    }

    let stages = await CrmPipelineStage.find(filter).sort({ sortOrder: 1, createdAt: 1 }).lean();

    if (!stages || stages.length === 0) {
      stages = getDefaultStages();
    }

    return res.status(200).json({ success: true, stages });
  } catch (error) {
    logger.error("Error retrieving pipeline stages config", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/crm/config/stages
 * Update or initialize pipeline stages for the user or system globally (if admin).
 */
exports.updatePipelineStages = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const { stages } = req.body;
    if (!Array.isArray(stages) || stages.length === 0) {
      return res.status(400).json({ success: false, message: "Stages array is required" });
    }

    const ownerId = req.user.role === "admin" ? null : req.user._id;

    // Delete existing custom stages for this ownerId/global and insert new ones
    await CrmPipelineStage.deleteMany({ ownerId });

    const newDocs = stages.map((s, idx) => ({
      name: (s.name || "").trim(),
      internalKey: (s.internalKey || s.name || "").trim(),
      color: s.color || "#6366f1",
      sortOrder: typeof s.sortOrder === "number" ? s.sortOrder : idx + 1,
      probability: typeof s.probability === "number" ? s.probability : (STAGE_PROBABILITIES[s.name] || 0.1),
      isClosed: Boolean(s.isClosed),
      isWon: Boolean(s.isWon),
      isLost: Boolean(s.isLost),
      isActive: s.isActive !== undefined ? Boolean(s.isActive) : true,
      ownerId,
    }));

    const inserted = await CrmPipelineStage.insertMany(newDocs);
    logger.info("Pipeline stages updated via config API", { ownerId, count: inserted.length });

    return res.status(200).json({ success: true, stages: inserted });
  } catch (error) {
    logger.error("Error updating pipeline stages config", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/crm/config/event-types
 * Retrieve valid calendar event types.
 */
exports.getEventTypes = async (req, res) => {
  try {
    let types = await CrmEventType.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
    if (!types || types.length === 0) {
      types = [
        { name: "Follow-up", color: "#3b82f6", icon: "CalendarOutlined", sortOrder: 1 },
        { name: "Meeting", color: "#10b981", icon: "TeamOutlined", sortOrder: 2 },
        { name: "Call", color: "#f59e0b", icon: "PhoneOutlined", sortOrder: 3 },
        { name: "Demo", color: "#8b5cf6", icon: "DesktopOutlined", sortOrder: 4 },
        { name: "Proposal reminder", color: "#ef4444", icon: "FileTextOutlined", sortOrder: 5 },
        { name: "Other", color: "#64748b", icon: "PushpinOutlined", sortOrder: 6 },
      ];
    }
    return res.status(200).json({ success: true, eventTypes: types });
  } catch (error) {
    logger.error("Error retrieving event types config", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/crm/config/reply-keywords
 * Retrieve reply classification keywords.
 */
exports.getReplyKeywords = async (req, res) => {
  try {
    let keywords = await CrmReplyKeyword.find({ isActive: true }).sort({ priority: -1 }).lean();
    if (!keywords || keywords.length === 0) {
      const negative = ["not interested", "unsubscribe", "stop", "remove me", "don't contact", "do not contact", "spam", "take me off", "no thanks", "no thank you", "too expensive", "not a good fit"];
      const positive = ["interested", "more info", "tell me more", "schedule a call", "let's talk", "lets talk", "send details", "send more info", "what are the next steps", "how much", "pricing", "available", "when can we connect"];
      keywords = [
        ...negative.map(k => ({ keyword: k, classification: "Negative", priority: 10 })),
        ...positive.map(k => ({ keyword: k, classification: "Positive", priority: 5 })),
      ];
    }
    return res.status(200).json({ success: true, keywords });
  } catch (error) {
    logger.error("Error retrieving reply keywords config", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/crm/config/scheduler
 * Retrieve global scheduler settings.
 */
exports.getSchedulerConfig = async (req, res) => {
  try {
    let config = await CrmSchedulerConfig.findOne({ key: "global" }).lean();
    if (!config) {
      config = {
        key: "global",
        isEnabled: true,
        schedulerIntervalMs: 3_600_000,
        maxAttempts: 3,
        retryDelayMs: 1_000,
        overdueThresholdDays: 7,
        excludedStatuses: ["Completed", "Closed Won", "Closed Lost"],
        defaultIntervalDays: 3,
        auditExportMaxRows: 10_000,
        auditNotesDiffMaxLen: 500,
        dashboardRecentLeadsLimit: 6,
        dashboardActivityFeedLimit: 10,
        dashboardCalendarPreviewDays: 30,
        currencySymbol: process.env.CRM_CURRENCY_SYMBOL || "$",
      };
    }
    return res.status(200).json({ success: true, schedulerConfig: config });
  } catch (error) {
    logger.error("Error retrieving scheduler config", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};
