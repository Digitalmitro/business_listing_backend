// backend/workers/leadFollowUpWorker.js
"use strict";

const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const crmFollowUpService = require("../services/crmFollowUpService");
const logger = require("../utils/logger");

let schedulerTimer = null;

const leadFollowUpWorker = new Worker(
  "lead-followup-scheduler",
  async (job) => {
    try {
      const { action, ownerId, leadId, force } = job.data || {};

      if (action === "trigger_lead" && ownerId && leadId) {
        logger.info("Processing background follow-up email for lead", { leadId, ownerId });
        return await crmFollowUpService.triggerLeadFollowUp(ownerId, leadId, { force: Boolean(force) });
      }

      if (action === "retry_failed") {
        logger.info("Retrying failed follow-up emails via queue worker", { ownerId });
        return await crmFollowUpService.retryFailedFollowUps(ownerId || null);
      }

      // Default job action is automated scan across eligible leads
      logger.info("Executing background automated follow-up scheduler scan");
      const result = await crmFollowUpService.processAutomatedFollowUps({ ownerId: ownerId || null });
      logger.info("Completed background automated follow-up scheduler scan", result);
      return result;
    } catch (error) {
      logger.error(`Error in leadFollowUpWorker for job ${job.id}:`, { error: error.message });
      throw error;
    }
  },
  { connection: redisConnection }
);

/**
 * Starts the periodic background scheduler scanning loop.
 * @param {number} [intervalMs=3600000] - Interval in milliseconds (default 1 hour).
 */
function startFollowUpScheduler(intervalMs = 3600_000) {
  if (schedulerTimer) return;
  const envIntervalMinutes = Number(process.env.CRM_CRON_INTERVAL_MINUTES || 60);
  const effectiveIntervalMs = intervalMs !== 3600_000 ? intervalMs : envIntervalMinutes * 60_000;

  logger.info("crm.followup_scheduler.starting", "Starting automated lead follow-up background scheduler loop", {
    intervalSeconds: Math.round(effectiveIntervalMs / 1000),
  });

  schedulerTimer = setInterval(async () => {
    let lockAcquired = false;
    const lockKey = "lock:lead-followup-scheduler";
    const lockTtlSeconds = Math.max(30, Math.floor(effectiveIntervalMs / 1000) - 5);

    try {
      if (redisConnection && redisConnection.status === "ready") {
        const res = await redisConnection.set(lockKey, "LOCKED", "NX", "EX", lockTtlSeconds);
        if (!res) {
          logger.info("crm.followup_scheduler.skipped", "Another worker instance holds the scheduler lock, skipping scan.");
          return;
        }
        lockAcquired = true;
      }
    } catch (lockErr) {
      logger.warn("Could not acquire Redis lock for followup scheduler, proceeding locally", { error: lockErr.message });
    }

    try {
      await crmFollowUpService.processAutomatedFollowUps();
      await crmFollowUpService.retryFailedFollowUps();
    } catch (error) {
      logger.error("crm.followup_scheduler.error", "Error during automated lead follow-up periodic scan", {
        error: error.message,
      });
    } finally {
      if (lockAcquired && redisConnection && redisConnection.status === "ready") {
        try {
          await redisConnection.del(lockKey);
        } catch (e) {}
      }
    }
  }, effectiveIntervalMs);

  // Ensure timer does not prevent process exit if idle
  if (schedulerTimer.unref) schedulerTimer.unref();
}

/**
 * Stops the periodic background scheduler scanning loop.
 */
function stopFollowUpScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    logger.info("crm.followup_scheduler.stopped", "Stopped automated lead follow-up background scheduler loop");
  }
}

// Intercept close to stop timer alongside BullMQ worker
const originalClose = leadFollowUpWorker.close.bind(leadFollowUpWorker);
leadFollowUpWorker.close = async () => {
  stopFollowUpScheduler();
  return originalClose();
};

module.exports = leadFollowUpWorker;
module.exports.startFollowUpScheduler = startFollowUpScheduler;
module.exports.stopFollowUpScheduler = stopFollowUpScheduler;
