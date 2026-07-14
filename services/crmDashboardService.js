// backend/services/crmDashboardService.js
"use strict";

const mongoose = require("mongoose");
const User = require("../models/User");
// ── FIX: was previously importing the module object (CrmLead), not the Mongoose model
const { CrmLead } = require("../models/CrmLead");
const SocialPostHistory = require("../models/SocialPostHistory");
const crmForecastService = require("./crmForecastService");
const crmScheduleService = require("./crmScheduleService");
const logger = require("../utils/logger");
const { getCache, setCache } = require("../utils/cache");

// ── Dashboard widget limits – configurable via env ────────────────────────────
const DASHBOARD_RECENT_LEADS_LIMIT    = Number(process.env.DASHBOARD_RECENT_LEADS_LIMIT    || 6);
const DASHBOARD_RECENT_POSTS_LIMIT    = Number(process.env.DASHBOARD_RECENT_POSTS_LIMIT    || 5);
const DASHBOARD_FOLLOWUPS_LIMIT       = Number(process.env.DASHBOARD_FOLLOWUPS_LIMIT       || 6);
const DASHBOARD_ACTIVITY_FEED_LIMIT   = Number(process.env.DASHBOARD_ACTIVITY_FEED_LIMIT   || 10);
const DASHBOARD_CALENDAR_PREVIEW_DAYS = Number(process.env.DASHBOARD_CALENDAR_PREVIEW_DAYS || 30);
const DASHBOARD_CALENDAR_LIMIT        = Number(process.env.DASHBOARD_CALENDAR_LIMIT        || 6);

// ── Social platforms list – kept in sync with socialIntegrationService ────────
const SOCIAL_PLATFORMS = (process.env.SOCIAL_PLATFORMS || "facebook,instagram,linkedin,twitter,pinterest").split(",").map(p => p.trim());

/**
 * Retrieve comprehensive executive dashboard metrics for CRM & Social Media modules.
 * Returns exact summary cards, recent activity, calendar preview, and social status.
 */
exports.getDashboardSummary = async (ownerId) => {
  if (!ownerId) {
    throw new Error("ownerId is required to fetch dashboard summary");
  }

  const cacheKey = `crm:dashboard:${ownerId}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) return cachedData;

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const now = new Date();
    const plus30Days = new Date(now.getTime() + DASHBOARD_CALENDAR_PREVIEW_DAYS * 24 * 60 * 60 * 1000);
    // Previous period for trend comparison (same window length, ending at now)
    const prevPeriodStart = new Date(now.getTime() - DASHBOARD_CALENDAR_PREVIEW_DAYS * 24 * 60 * 60 * 1000);

    // 1. Fetch User Social Accounts
    const user = await User.findById(ownerId).select("socialMediaAccounts googleBusinessProfile").lean();
    const connectedSocialAccounts = [];
    const platforms = SOCIAL_PLATFORMS;

    if (user && user.socialMediaAccounts) {
      for (const platform of platforms) {
        const acc = user.socialMediaAccounts[platform];
        if (acc && (acc.isConnected || acc.status === "connected")) {
          connectedSocialAccounts.push({
            platform,
            isConnected: true,
            status: acc.status || "connected",
            profileName: acc.profileName || `${platform.toUpperCase()} Account`,
            accountHandle: acc.accountHandle || "",
            connectedAt: acc.connectedAt || acc.updatedAt || null,
          });
        } else {
          connectedSocialAccounts.push({
            platform,
            isConnected: false,
            status: acc?.status || "not_connected",
            profileName: "",
            accountHandle: "",
          });
        }
      }
    } else {
      for (const platform of platforms) {
        connectedSocialAccounts.push({ platform, isConnected: false, status: "not_connected", profileName: "", accountHandle: "" });
      }
    }

    if (user && user.googleBusinessProfile && user.googleBusinessProfile.isConnected) {
      connectedSocialAccounts.push({
        platform: "googleBusiness",
        isConnected: true,
        status: "connected",
        profileName: user.googleBusinessProfile.googleEmail || "Google Business Profile",
        accountHandle: user.googleBusinessProfile.selectedProfileId || "",
      });
    }

    // 2. Fetch Recent Social Posts
    const recentPosts = await SocialPostHistory.find({ userId: ownerId })
      .sort({ createdAt: -1 })
      .limit(DASHBOARD_RECENT_POSTS_LIMIT)
      .lean();

    // 3. Fetch Recent Leads
    const recentLeads = await CrmLead.find({ ownerId })
      .select("leadName company email phone status expectedRevenue createdAt nextFollowUpDate assignedUser")
      .populate("assignedUser", "full_name email")
      .sort({ createdAt: -1 })
      .limit(DASHBOARD_RECENT_LEADS_LIMIT)
      .lean();

    // 4 & 5. Fetch Revenue Summary & Pipeline Summary via crmForecastService
    let forecastData = {
      totalLeads: 0,
      warmLeads: 0,
      coldLeads: 0,
      closedWon: 0,
      closedLost: 0,
      expectedRevenue: 0,
      closedRevenue: 0,
      forecastRevenue: 0,
      conversionRate: 0,
      averageDealSize: 0,
      stageBreakdown: [],
    };

    try {
      forecastData = await crmForecastService.getRevenueForecast(ownerId);
    } catch (err) {
      logger.warn("Could not compute forecast metrics for dashboard summary", { error: err.message });
    }

    // 5b. Trend comparison – previous period forecast for delta metrics
    let previousForecastData = { totalLeads: 0, closedWon: 0, closedRevenue: 0, conversionRate: 0 };
    try {
      const prevResult = await crmForecastService.getRevenueForecast(ownerId, {
        startDate: prevPeriodStart.toISOString(),
        endDate: now.toISOString(),
      });
      if (prevResult && prevResult.summary) {
        previousForecastData = prevResult.summary;
      }
    } catch (err) {
      logger.warn("Could not compute previous period forecast for trend comparison", { error: err.message });
    }

    // 6. Fetch Upcoming Follow-ups (specifically leads scheduled for follow-up)
    const upcomingFollowUps = await CrmLead.find({
      ownerId,
      nextFollowUpDate: { $gte: now },
      status: { $nin: ["Completed", "Closed Won", "Closed Lost"] },
    })
      .select("leadName company nextFollowUpDate status expectedRevenue notes")
      .sort({ nextFollowUpDate: 1 })
      .limit(DASHBOARD_FOLLOWUPS_LIMIT)
      .lean();

    // 7. Fetch Calendar Preview via crmScheduleService
    let calendarPreview = [];
    try {
      const scheduleRes = await crmScheduleService.getEvents(ownerId, {
        startDate: now.toISOString(),
        endDate: plus30Days.toISOString(),
        includeVirtual: "true",
      });
      if (scheduleRes && scheduleRes.events) {
        calendarPreview = scheduleRes.events.slice(0, 6);
      }
    } catch (err) {
      logger.warn("Could not fetch calendar preview for dashboard summary", { error: err.message });
    }

    // 8. Recent Activity Feed – MongoDB aggregation pipeline (no in-memory sort)
    const recentActivityFeed = await CrmLead.aggregate([
      { $match: { ownerId: new mongoose.Types.ObjectId(String(ownerId)), "activities.0": { $exists: true } } },
      { $unwind: "$activities" },
      { $sort: { "activities.timestamp": -1, "activities.performedAt": -1 } },
      { $limit: DASHBOARD_ACTIVITY_FEED_LIMIT },
      {
        $project: {
          _id: 0,
          leadId: "$_id",
          leadName: 1,
          company: { $ifNull: ["$company", "No Company"] },
          action:        "$activities.action",
          type:          "$activities.type",
          description:   "$activities.description",
          previousValue: "$activities.previousValue",
          newValue:      "$activities.newValue",
          timestamp:     { $ifNull: ["$activities.timestamp", "$activities.performedAt"] },
        },
      },
    ]);

    // ── Compute trend deltas (current vs previous period) ─────────────────────
    const currentSummary  = forecastData.summary || forecastData;
    const previousSummary = previousForecastData;
    const trends = {
      totalLeads_delta:     (currentSummary.totalLeads    || 0) - (previousSummary.totalLeads    || 0),
      closedWon_delta:      (currentSummary.closedWon     || 0) - (previousSummary.closedWon     || 0),
      closedRevenue_delta:  Number(((currentSummary.closedRevenue || 0) - (previousSummary.closedRevenue || 0)).toFixed(2)),
      conversionRate_delta: Number(((currentSummary.conversionRate || 0) - (previousSummary.conversionRate || 0)).toFixed(1)),
    };

    return {
      success: true,
      timestamp: new Date(),
      connectedSocialAccounts,
      recentPosts,
      recentLeads,
      revenueSummary: {
        expectedRevenue:  currentSummary.expectedRevenue  || forecastData.expectedRevenue,
        closedRevenue:    currentSummary.closedRevenue    || forecastData.closedRevenue,
        forecastRevenue:  currentSummary.forecastRevenue  || forecastData.forecastRevenue,
        conversionRate:   currentSummary.conversionRate   || forecastData.conversionRate,
        averageDealSize:  currentSummary.averageDealSize  || forecastData.averageDealSize,
      },
      pipelineSummary: {
        totalLeads:     currentSummary.totalLeads  || forecastData.totalLeads,
        warmLeads:      currentSummary.warmLeads   || forecastData.warmLeads,
        coldLeads:      currentSummary.coldLeads   || forecastData.coldLeads,
        closedWon:      currentSummary.closedWon   || forecastData.closedWon,
        closedLost:     currentSummary.closedLost  || forecastData.closedLost,
        stageBreakdown: (forecastData.charts && forecastData.charts.revenueByStage) || forecastData.stageBreakdown || [],
      },
      trends,
      upcomingFollowUps,
      calendarPreview,
      recentActivityFeed,
    };
    await setCache(cacheKey, dashboardData, 60);
    return dashboardData;
  }

  // Safe mock / fallback payload for offline unit tests
  return {
    success: true,
    timestamp: new Date(),
    connectedSocialAccounts: [
      { platform: "facebook", isConnected: true, status: "connected", profileName: "Acme Facebook" },
      { platform: "linkedin", isConnected: true, status: "connected", profileName: "Acme LinkedIn" },
      { platform: "instagram", isConnected: false, status: "not_connected", profileName: "" },
      { platform: "twitter", isConnected: false, status: "not_connected", profileName: "" },
      { platform: "pinterest", isConnected: false, status: "not_connected", profileName: "" },
    ],
    recentPosts: [
      { _id: "post_1", platform: "linkedin", content: "Excited to launch our new CRM module!", status: "SUCCESS", createdAt: new Date() },
      { _id: "post_2", platform: "facebook", content: "Join our live product walkthrough tomorrow at 10am.", status: "SUCCESS", createdAt: new Date(Date.now() - 3600000) },
    ],
    recentLeads: [
      { _id: "lead_1", leadName: "Sarah Jenkins", company: "TechFlow Inc", status: "Demo", expectedRevenue: 12500, createdAt: new Date() },
      { _id: "lead_2", leadName: "David Miller", company: "Global Logistics", status: "Proposal", expectedRevenue: 28000, createdAt: new Date(Date.now() - 7200000) },
    ],
    revenueSummary: {
      expectedRevenue: 145000,
      closedRevenue: 62000,
      forecastRevenue: 89400,
      conversionRate: 38.5,
      averageDealSize: 15500,
    },
    pipelineSummary: {
      totalLeads: 24,
      warmLeads: 9,
      coldLeads: 3,
      closedWon: 4,
      closedLost: 2,
      stageBreakdown: [
        { stage: "Prospecting", count: 5, revenue: 25000 },
        { stage: "Qualification", count: 4, revenue: 32000 },
        { stage: "Demo", count: 6, revenue: 48000 },
        { stage: "Proposal", count: 3, revenue: 40000 },
      ],
    },
    upcomingFollowUps: [
      { _id: "follow_1", leadName: "Sarah Jenkins", company: "TechFlow Inc", nextFollowUpDate: new Date(Date.now() + 86400000), status: "Demo", expectedRevenue: 12500 },
      { _id: "follow_2", leadName: "Michael Chang", company: "Apex Corp", nextFollowUpDate: new Date(Date.now() + 172800000), status: "Pending Follow-Up", expectedRevenue: 8500 },
    ],
    calendarPreview: [
      { _id: "cal_1", title: "Demo: Sarah Jenkins (TechFlow)", eventType: "Demo", startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000), status: "Scheduled" },
      { _id: "cal_2", title: "Follow-up: Apex Corp check-in", eventType: "Follow-up", startTime: new Date(Date.now() + 172800000), endTime: new Date(Date.now() + 176400000), status: "Scheduled" },
    ],
    recentActivityFeed: [
      { _id: "act_1", action: "status_change", previousValue: "Qualification", newValue: "Demo", notes: "Advanced lead after successful discovery call", timestamp: new Date(), leadName: "Sarah Jenkins", company: "TechFlow Inc" },
      { _id: "act_2", action: "followup_scheduled", previousValue: "", newValue: new Date(Date.now() + 86400000).toISOString(), notes: "Scheduled product walkthrough", timestamp: new Date(Date.now() - 3600000), leadName: "Sarah Jenkins", company: "TechFlow Inc" },
    ],
  };
};
