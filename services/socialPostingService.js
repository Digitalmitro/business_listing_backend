"use strict";

const mongoose = require("mongoose");
const logger = require("../utils/logger");
const socialIntegrationService = require("./socialIntegrationService");
const googleBusinessPostService = require("./googleBusinessPostService");
const SocialPostHistory = require("../models/SocialPostHistory");
const ScheduledSocialPost = require("../models/ScheduledSocialPost");
const { addJob } = require("../utils/queue");

/**
 * Social platforms fetch attached media by URL from their own servers, so every media
 * URL must be a publicly reachable http(s) address. Browser-only `blob:` / `data:`
 * object URLs (produced by URL.createObjectURL) can never be fetched by Facebook,
 * Instagram or Threads and would fail with opaque provider errors such as
 * "Unsupported state or unable to authenticate data" or
 * "Only photo or video can be accepted as media type".
 */
function normalizeMediaList(media) {
  if (!Array.isArray(media)) return [];
  const normalized = media
    .map((m) => {
      if (typeof m === "string") return { type: "image", url: m.trim() };
      return {
        type: m?.type === "video" ? "video" : "image",
        url: String(m?.url || m?.src || "").trim(),
      };
    })
    .filter((m) => Boolean(m.url));

  for (const m of normalized) {
    let parsed;
    try {
      parsed = new URL(m.url);
    } catch {
      throw new Error(`Invalid media URL '${m.url}'. Provide a public https:// image or video URL, or upload the file first.`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(
        `Media URL must be a public http(s) address that social platforms can download. '${parsed.protocol}' URLs only exist inside your browser; upload the file so it is hosted on a public URL first.`
      );
    }
    if (["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) {
      throw new Error("Media URL points to localhost, which social platforms cannot reach. Use a publicly hosted URL.");
    }
  }
  return normalized;
}

/**
 * Google Business Profile has its own OAuth connection (GoogleBusinessConnection) rather than a
 * SocialConnection, so it is publishable here without being an OAuth entry in SUPPORTED_PLATFORMS.
 */
const GOOGLE_BUSINESS = "google_business";

function publishablePlatforms() {
  return [...Object.keys(socialIntegrationService.SUPPORTED_PLATFORMS), GOOGLE_BUSINESS];
}

function platformDisplayName(platform) {
  if (platform === GOOGLE_BUSINESS) return "Google Business Profile";
  return socialIntegrationService.SUPPORTED_PLATFORMS[platform]?.name || platform;
}

function normalizePlatforms(platforms) {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error("At least one social media platform must be selected");
  }
  const supported = publishablePlatforms();
  const normalized = [];
  for (const p of platforms) {
    const value = String(p).toLowerCase().trim();
    if (!supported.includes(value)) {
      throw new Error(`Unsupported platform: '${p}'. Supported platforms: ${supported.join(", ")}`);
    }
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized;
}

/**
 * Validates content once for publish and schedule so a scheduled post fails at submit time,
 * not hours later in the worker.
 */
function validatePostContent(platforms, captionStr, media, platformOptions) {
  if (!captionStr && media.length === 0) {
    throw new Error("Post must contain either caption text or attached media");
  }
  if (platforms.includes("instagram") && media.length === 0) {
    throw new Error("Instagram requires at least one attached image or video URL");
  }
  if (platforms.includes(GOOGLE_BUSINESS)) {
    googleBusinessPostService.validatePostInput({
      text: captionStr,
      imageUrl: media.find((m) => m.type === "image")?.url || "",
      videoUrl: media.find((m) => m.type === "video")?.url || "",
      ...((platformOptions && platformOptions[GOOGLE_BUSINESS]) || {}),
    });
  }
}

function publishToPlatform(user, platform, postData) {
  if (platform === GOOGLE_BUSINESS) return googleBusinessPostService.publishLocalPost(user, postData);
  return socialIntegrationService.verifyOrPostToPlatform(user, platform, postData);
}

/** Display-only label for the post target (e.g. the Google location title), never trusted for routing. */
function targetNameFor(platform, options = {}) {
  const raw = platform === GOOGLE_BUSINESS ? options.locationTitle : null;
  return raw ? String(raw).trim().slice(0, 200) : undefined;
}

/**
 * Publishes content immediately across selected social media platforms.
 * Handles partial posting failures by recording exact per-platform outcomes without aborting other broadcasts.
 * @param {Object} user - Authenticated user; connections are loaded by user ID from SocialConnection.
 * @param {Object} payload - Payload with `{ caption, media, platforms }`.
 * @returns {Promise<Object>} Created SocialPostHistory record and summary.
 */
async function publishUnifiedPost(user, { caption = "", media = [], platforms = [], platformOptions = {} } = {}) {
  if (!user || !user._id) {
    throw new Error("User authentication required for publishing social media posts");
  }

  const normalizedPlatforms = normalizePlatforms(platforms);
  const captionStr = typeof caption === "string" ? caption.trim() : "";
  const normalizedMedia = normalizeMediaList(media);
  const options = platformOptions && typeof platformOptions === "object" ? platformOptions : {};
  validatePostContent(normalizedPlatforms, captionStr, normalizedMedia, options);

  const imageUrl = normalizedMedia.find((m) => m.type === "image")?.url || "";
  const videoUrl = normalizedMedia.find((m) => m.type === "video")?.url || "";

  const results = [];
  for (const platform of normalizedPlatforms) {
    const targetName = targetNameFor(platform, options[platform]);
    try {
      const postRes = await publishToPlatform(user, platform, {
        text: captionStr,
        imageUrl,
        videoUrl,
        ...(options[platform] || {}),
      });

      results.push({
        platform,
        status: "SUCCESS",
        externalPostId: String(postRes.postId || postRes.id || `${platform}_post_${Date.now()}`),
        ...(postRes.postUrl ? { externalPostUrl: postRes.postUrl } : {}),
        ...(postRes.state ? { providerState: postRes.state } : {}),
        ...(targetName ? { targetName } : {}),
      });
      logger.info(`Unified post published successfully to ${platform}`, { userId: user._id, postId: postRes.postId });
    } catch (err) {
      const errorDetail = err.response?.data?.detail || err.response?.data?.error?.message || err.response?.data?.message || err.message || "Unknown error occurred while publishing to platform";
      const reconnectRequired = Boolean(err.reconnectRequired) || err.name === "RevokedPermissionError";
      logger.error(`Unified post failed for ${platform}`, { error: errorDetail, userId: user._id });
      results.push({
        platform,
        status: "FAILURE",
        failureReason: errorDetail,
        ...(err.code && typeof err.code === "string" ? { errorCode: err.code } : {}),
        ...(reconnectRequired ? { reconnectRequired: true } : {}),
        ...(targetName ? { targetName } : {}),
      });
    }
  }

  const successCount = results.filter((r) => r.status === "SUCCESS").length;
  const failureCount = results.filter((r) => r.status === "FAILURE").length;

  let overallStatus = "SUCCESS";
  if (successCount === 0 && failureCount > 0) {
    overallStatus = "FAILURE";
  } else if (successCount > 0 && failureCount > 0) {
    overallStatus = "PARTIAL_SUCCESS";
  }

  const docData = {
    userId: user._id,
    tenantId: user.tenantId || user._id,
    platforms: normalizedPlatforms,
    content: captionStr,
    media: normalizedMedia,
    results,
    overallStatus,
    postedAt: new Date(),
  };

  let historyDoc;
  try {
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      historyDoc = await SocialPostHistory.create(docData);
    } else {
      historyDoc = new SocialPostHistory(docData);
    }
  } catch (err) {
    logger.warn("Could not save SocialPostHistory to live MongoDB, returning document object", { error: err.message });
    historyDoc = new SocialPostHistory(docData);
  }

  return {
    success: overallStatus !== "FAILURE",
    overallStatus,
    postHistory: historyDoc,
    results,
  };
}

/**
 * Retrieves the paginated posting history for a specific user.
 * @param {string} userId - Target User ObjectId.
 * @param {Object} options - Pagination options `{ page, limit }`.
 * @returns {Promise<Object>} Paginated history list.
 */
async function getUserPostingHistory(userOrId, { page = 1, limit = 20 } = {}) {
  const userId = userOrId?._id || userOrId;
  const tenantId = userOrId?.tenantId || userId;
  if (!userId) {
    throw new Error("User ID is required to fetch posting history");
  }

  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const total = await SocialPostHistory.countDocuments({ userId, tenantId });
    const history = await SocialPostHistory.find({ userId, tenantId })
      .sort({ postedAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    return { history, total, page: pageNum, limit: limitNum };
  }

  // Fallback / unit test mode when MongoDB connection is not active
  return {
    history: [],
    total: 0,
    page: pageNum,
    limit: limitNum,
  };
}

/**
 * Schedules a unified post to be published across selected platforms at a future time.
 */
async function scheduleUnifiedPost(user, { caption = "", media = [], platforms = [], platformOptions = {}, scheduledFor, timezone = "UTC" } = {}) {
  if (!user || !user._id) {
    throw new Error("User authentication required for scheduling posts");
  }
  if (!scheduledFor || isNaN(new Date(scheduledFor).getTime())) {
    throw new Error("Valid scheduledFor timestamp (UTC format) is required");
  }

  const scheduleDate = new Date(scheduledFor);
  const now = new Date();
  const delayMs = scheduleDate.getTime() - now.getTime();
  if (delayMs <= 0) {
    throw new Error("Scheduled time must be in the future");
  }

  const normalizedPlatforms = normalizePlatforms(platforms);
  const captionStr = typeof caption === "string" ? caption.trim() : "";
  const normalizedMedia = normalizeMediaList(media);
  validatePostContent(normalizedPlatforms, captionStr, normalizedMedia, platformOptions || {});

  const docData = {
    userId: user._id,
    tenantId: user.tenantId || user._id,
    caption: captionStr,
    media: normalizedMedia,
    platforms: normalizedPlatforms,
    platformOptions,
    scheduledFor: scheduleDate,
    timezone: String(timezone || "UTC"),
    status: "scheduled",
  };

  let scheduledDoc;
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    scheduledDoc = await ScheduledSocialPost.create(docData);
    try {
      const job = await addJob("scheduled-social-post", { scheduledPostId: scheduledDoc._id }, { delay: delayMs });
      scheduledDoc.bullmqJobId = job.id;
      await scheduledDoc.save();
    } catch (queueErr) {
      logger.warn("Could not enqueue delayed BullMQ job for scheduled post", { error: queueErr.message });
    }
  } else {
    scheduledDoc = new ScheduledSocialPost(docData);
  }

  logger.info("Social media post scheduled successfully", { userId: user._id, scheduledPostId: scheduledDoc._id, delayMs });
  return { success: true, scheduledPost: scheduledDoc };
}

/**
 * Retrieves paginated scheduled posts for a user.
 */
async function getScheduledPosts(userOrId, { page = 1, limit = 20, status = "scheduled" } = {}) {
  const userId = userOrId?._id || userOrId;
  const tenantId = userOrId?.tenantId || userId;
  if (!userId) throw new Error("User ID required");
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const filter = { userId, tenantId };
    if (status && status !== "all") filter.status = status;

    const [total, scheduledPosts] = await Promise.all([
      ScheduledSocialPost.countDocuments(filter),
      ScheduledSocialPost.find(filter)
        .sort({ scheduledFor: 1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
    ]);
    return { scheduledPosts, total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) || 1 };
  }
  return { scheduledPosts: [], total: 0, page: pageNum, limit: limitNum, totalPages: 0 };
}

/**
 * Cancels a scheduled post if it has not been processed yet.
 */
async function cancelScheduledPost(userOrId, scheduledPostId) {
  const userId = userOrId?._id || userOrId;
  const tenantId = userOrId?.tenantId || userId;
  if (!userId || !scheduledPostId) throw new Error("User ID and Scheduled Post ID required");

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const post = await ScheduledSocialPost.findOne({ _id: scheduledPostId, userId, tenantId });
    if (!post) throw new Error("Scheduled post not found or unauthorized");
    if (post.status !== "scheduled") {
      throw new Error(`Cannot cancel post with status '${post.status}'`);
    }
    post.status = "cancelled";
    await post.save();
    return { success: true, message: "Scheduled post cancelled successfully" };
  }
  return { success: true, message: "Mock post cancelled" };
}

module.exports = {
  GOOGLE_BUSINESS,
  platformDisplayName,
  publishUnifiedPost,
  getUserPostingHistory,
  scheduleUnifiedPost,
  getScheduledPosts,
  cancelScheduledPost,
};
