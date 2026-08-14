// backend/workers/scheduledSocialPostWorker.js
"use strict";

const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const ScheduledSocialPost = require("../models/ScheduledSocialPost");
const User = require("../models/User");
const socialPostingService = require("../services/socialPostingService");
const logger = require("../utils/logger");

const scheduledSocialPostWorker = new Worker(
  "scheduled-social-post",
  async (job) => {
    const { scheduledPostId } = job.data;
    logger.info("scheduledSocialPostWorker.processing", `Processing scheduled post ${scheduledPostId}`, { jobId: job.id });

    const scheduledPost = await ScheduledSocialPost.findById(scheduledPostId);
    if (!scheduledPost) {
      logger.warn("scheduledSocialPostWorker.not_found", `Scheduled post ${scheduledPostId} no longer exists`);
      return { status: "skipped", reason: "not_found" };
    }

    if (scheduledPost.status !== "scheduled") {
      logger.info("scheduledSocialPostWorker.not_scheduled", `Scheduled post ${scheduledPostId} is ${scheduledPost.status}, skipping`);
      return { status: "skipped", reason: scheduledPost.status };
    }

    scheduledPost.status = "processing";
    await scheduledPost.save();

    const user = await User.findById(scheduledPost.userId);
    if (!user) {
      scheduledPost.status = "failed";
      scheduledPost.error = "User not found";
      await scheduledPost.save();
      return { status: "failed", reason: "user_not_found" };
    }
    if (String(user.tenantId || user._id) !== String(scheduledPost.tenantId)) {
      scheduledPost.status = "failed";
      scheduledPost.error = "Tenant mismatch";
      await scheduledPost.save();
      return { status: "failed", reason: "tenant_mismatch" };
    }

    try {
      const result = await socialPostingService.publishUnifiedPost(user, {
        caption: scheduledPost.caption,
        media: scheduledPost.media,
        platforms: scheduledPost.platforms,
        platformOptions: scheduledPost.platformOptions,
      });

      scheduledPost.status = result.success ? "published" : "failed";
      scheduledPost.results = result.results;
      if (!result.success && result.results && result.results[0]?.error) {
        scheduledPost.error = result.results[0].error;
      }
      await scheduledPost.save();

      logger.info("scheduledSocialPostWorker.completed", `Scheduled post ${scheduledPostId} finished`, { status: scheduledPost.status });
      return result;
    } catch (err) {
      scheduledPost.status = "failed";
      scheduledPost.error = err.message;
      await scheduledPost.save();
      logger.error("scheduledSocialPostWorker.error", `Failed to publish scheduled post ${scheduledPostId}`, { error: err.message });
      throw err;
    }
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

scheduledSocialPostWorker.on("completed", (job) => {
  logger.info("scheduledSocialPostWorker.job_completed", `Job ${job.id} completed`);
});

scheduledSocialPostWorker.on("failed", (job, err) => {
  logger.error("scheduledSocialPostWorker.job_failed", `Job ${job?.id} failed`, { error: err.message });
});

module.exports = scheduledSocialPostWorker;
