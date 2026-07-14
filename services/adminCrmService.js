// backend/services/adminCrmService.js
"use strict";

const mongoose = require("mongoose");
const { CrmLead } = require("../models/CrmLead");
const CrmContact = require("../models/CrmContact");
const { CrmAuditLog } = require("../models/CrmAuditLog");
const User = require("../models/User");

/**
 * Retrieves system-wide CRM analytics for super/sub admins.
 */
async function getGlobalCrmAnalytics({ startDate, endDate } = {}) {
  if (!(mongoose.connection && mongoose.connection.readyState === 1)) {
    return {
      totalLeads: 0,
      totalContacts: 0,
      totalExpectedRevenue: 0,
      conversionRate: 0,
      pipelineBreakdown: [],
      topUsersByLeads: [],
      topUsersByRevenue: [],
    };
  }

  const dateFilter = {};
  if (startDate || endDate) {
    dateFilter.createdAt = {};
    if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
    if (endDate) dateFilter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
  }

  const [totalLeads, totalContacts, pipelineAgg, userStatsAgg] = await Promise.all([
    CrmLead.countDocuments(dateFilter),
    CrmContact.countDocuments(dateFilter),
    CrmLead.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalRevenue: { $sum: "$expectedRevenue" },
        },
      },
      { $sort: { count: -1 } },
    ]),
    CrmLead.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: "$ownerId",
          leadCount: { $sum: 1 },
          wonCount: {
            $sum: { $cond: [{ $eq: ["$status", "Closed Won"] }, 1, 0] },
          },
          totalRevenue: { $sum: "$expectedRevenue" },
          wonRevenue: {
            $sum: { $cond: [{ $eq: ["$status", "Closed Won"] }, "$expectedRevenue", 0] },
          },
        },
      },
      { $sort: { wonRevenue: -1, leadCount: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "userInfo",
        },
      },
      {
        $project: {
          _id: 1,
          leadCount: 1,
          wonCount: 1,
          totalRevenue: 1,
          wonRevenue: 1,
          userName: { $arrayElemAt: ["$userInfo.full_name", 0] },
          userEmail: { $arrayElemAt: ["$userInfo.email", 0] },
        },
      },
    ]),
  ]);

  const totalExpectedRevenue = pipelineAgg.reduce((acc, stage) => acc + (stage.totalRevenue || 0), 0);
  const closedWonStage = pipelineAgg.find((s) => s._id === "Closed Won");
  const wonCount = closedWonStage ? closedWonStage.count : 0;
  const conversionRate = totalLeads > 0 ? Number(((wonCount / totalLeads) * 100).toFixed(2)) : 0;

  return {
    totalLeads,
    totalContacts,
    totalExpectedRevenue,
    conversionRate,
    pipelineBreakdown: pipelineAgg.map((s) => ({
      stage: s._id || "Unknown",
      count: s.count,
      totalRevenue: s.totalRevenue || 0,
    })),
    topPerformers: userStatsAgg.map((u) => ({
      userId: u._id,
      name: u.userName || u.userEmail || "Unknown User",
      email: u.userEmail || "",
      leadCount: u.leadCount,
      wonCount: u.wonCount,
      totalRevenue: u.totalRevenue,
      wonRevenue: u.wonRevenue,
    })),
  };
}

/**
 * Retrieves paginated global CRM audit timeline for admin monitoring.
 */
async function getGlobalAuditLogs({ page = 1, limit = 50, action, search } = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(200, Math.max(1, Number(limit) || 50));

  if (!(mongoose.connection && mongoose.connection.readyState === 1)) {
    return { logs: [], total: 0, page: pageNum, limit: limitNum, totalPages: 0 };
  }

  const filter = {};
  if (action) filter.action = action;
  if (search && search.trim()) {
    const rx = new RegExp(search.trim(), "i");
    filter.$or = [{ description: rx }, { leadName: rx }, { performedByName: rx }];
  }

  const [total, logs] = await Promise.all([
    CrmAuditLog.countDocuments(filter),
    CrmAuditLog.find(filter)
      .sort({ timestamp: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("ownerId", "full_name email")
      .lean(),
  ]);

  return {
    logs: logs.map((l) => ({
      ...l,
      ownerName: l.ownerId?.full_name || l.ownerId?.email || "Unknown Owner",
    })),
    total,
    page: pageNum,
    limit: limitNum,
    totalPages: Math.ceil(total / limitNum) || 1,
  };
}

module.exports = {
  getGlobalCrmAnalytics,
  getGlobalAuditLogs,
};
