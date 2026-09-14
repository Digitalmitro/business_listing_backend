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
    const isClientError = /Unsupported platform|must contain either|Media URL|Invalid media URL|Instagram requires/.test(error.message);
    return res.status(isClientError ? 400 : 500).json({
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

    const { caption, media, platforms, platformOptions, scheduledFor, timezone } = req.body;
    if (!Array.isArray(platforms) || platforms.length === 0) {
      return res.status(400).json({ success: false, message: "platforms array is required and must not be empty" });
    }
    if (!scheduledFor) {
      return res.status(400).json({ success: false, message: "scheduledFor timestamp (UTC) is required" });
    }

    const result = await socialPostingService.scheduleUnifiedPost(req.user, {
      caption,
      media,
      platforms,
      platformOptions,
      scheduledFor,
      timezone: timezone || "UTC",
    });
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

/**
 * POST /api/social-posting/upload-media
 * Uploads an image or video to Cloudinary and returns a public HTTPS URL that
 * Facebook / Instagram / Threads / Pinterest can fetch when publishing.
 */
exports.uploadMedia = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: "A media file is required (field name: media)" });
    }

    const mime = String(req.file.mimetype || "");
    const isImage = mime.startsWith("image/");
    const isVideo = mime.startsWith("video/");
    if (!isImage && !isVideo) {
      return res.status(400).json({ success: false, message: "Only image or video files can be attached to social posts" });
    }

    const { cloudinary } = require("../config/Cloudinary");
    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `social-posts/${req.user.tenantId || req.user._id}`,
          resource_type: isVideo ? "video" : "image",
          // Instagram/Facebook only accept JPEG images fetched by URL; normalise PNG/WEBP/HEIC to JPEG.
          ...(isImage ? { format: "jpg" } : {}),
          chunk_size: 6 * 1024 * 1024,
          timeout: 120000,
        },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      stream.end(req.file.buffer);
    });

    return res.status(200).json({
      success: true,
      url: uploaded.secure_url,
      mediaUrl: uploaded.secure_url,
      type: isVideo ? "video" : "image",
      publicId: uploaded.public_id,
      width: uploaded.width,
      height: uploaded.height,
      bytes: uploaded.bytes,
    });
  } catch (error) {
    logger.error("Error uploading social media file", { error: error.message });
    return res.status(500).json({ success: false, message: `Media upload failed: ${error.message}` });
  }
};
