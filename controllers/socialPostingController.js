"use strict";

const logger = require("../utils/logger");
const socialPostingService = require("../services/socialPostingService");

/**
 * POST /api/social-posting/publish
 * Publishes a unified post across one or more selected social media platforms and records history.
 */
exports.publishPost = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const { caption, media, platforms, platformOptions } = req.body;
    if (!Array.isArray(platforms) || platforms.length === 0) {
      return res.status(400).json({ success: false, message: "platforms array is required and must not be empty" });
    }

    const result = await socialPostingService.publishUnifiedPost(req.user, { caption, media, platforms, platformOptions });

    const failureMessages = (result.results || [])
      .filter((r) => r.status === "FAILURE")
      .map((r) => `${r.platform}: ${r.failureReason}`)
      .join("; ");

    return res.status(result.success ? 200 : 400).json({
      success: result.success,
      overallStatus: result.overallStatus,
      message: failureMessages || (result.success ? "Post published successfully" : "Broadcast failed"),
      postHistory: result.postHistory,
      results: result.results,
    });
  } catch (error) {
    logger.error("Error publishing unified social media post", { error: error.message });
    return res.status(error.message.includes("Unsupported platform") || error.message.includes("must contain either") ? 400 : 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * GET /api/social-posting/history
 * Retrieves paginated posting history for the authenticated user.
 */
exports.getHistory = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const { page, limit } = req.query;
    const historyData = await socialPostingService.getUserPostingHistory(req.user, { page, limit });

    return res.status(200).json({
      success: true,
      ...historyData,
    });
  } catch (error) {
    logger.error("Error fetching social media posting history", { error: error.message });
    return res.status(500).json({
      success: false,
      message: "Failed to fetch posting history: " + error.message,
    });
  }
};

/**
 * POST /api/social-posting/schedule
 * Schedules a unified post across selected social media platforms at a future date/time.
 */
exports.schedulePost = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const { caption, media, platforms, platformOptions, scheduledFor } = req.body;
    if (!Array.isArray(platforms) || platforms.length === 0) {
      return res.status(400).json({ success: false, message: "platforms array is required and must not be empty" });
    }
    if (!scheduledFor) {
      return res.status(400).json({ success: false, message: "scheduledFor timestamp is required" });
    }

    const result = await socialPostingService.scheduleUnifiedPost(req.user, { caption, media, platforms, platformOptions, scheduledFor });
    return res.status(201).json(result);
  } catch (error) {
    logger.error("Error scheduling unified social media post", { error: error.message });
    return res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/social-posting/scheduled
 * Retrieves paginated scheduled posts for the authenticated user.
 */
exports.getScheduledPosts = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const { page, limit, status } = req.query;
    const data = await socialPostingService.getScheduledPosts(req.user, { page, limit, status });
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    logger.error("Error fetching scheduled social media posts", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /api/social-posting/scheduled/:id
 * Cancels a scheduled post if it has not been processed yet.
 */
exports.cancelScheduledPost = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const result = await socialPostingService.cancelScheduledPost(req.user, req.params.id);
    return res.status(200).json(result);
  } catch (error) {
    logger.error("Error cancelling scheduled post", { error: error.message });
    return res.status(error.message.includes("not found") ? 404 : 400).json({ success: false, message: error.message });
  }
};
