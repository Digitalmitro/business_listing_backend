// backend/workers/crmEmailAutomationWorker.js
"use strict";

const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const automationService = require("../services/crmEmailAutomationService");
const logger = require("../utils/logger");

let schedulerTimer = null;

/**
 * Sends one automated CRM email per "send" job. Jobs are an optimisation for
 * immediate/delayed event emails; the scheduler sweep below is the source of
 * truth and picks up anything a job missed.
 */
const crmEmailAutomationWorker = new Worker(
  automationService.QUEUE_NAME,
  async (job) => {
    const { action, dispatchId } = job.data || {};
    if (action === "send" && dispatchId) {
      return automationService.processDispatch(dispatchId);
    }
    if (action === "sweep") {
      return automationService.runScheduler();
    }
    logger.warn("crm_email_automation.unknown_job", "Ignoring unknown email automation job", { jobId: job.id, action });
    return null;
  },
  { connection: redisConnection }
);

/**
 * Periodic sweep: detects due reminder / booking-day / after-booking emails and
 * sends every due dispatch. A Redis lock keeps multiple worker processes from
 * sweeping at the same time (the per-dispatch claim prevents double sends anyway).
 * @param {number} [intervalMs] - defaults to CRM_EMAIL_AUTOMATION_SWEEP_MINUTES (5).
 */
function startEmailAutomationScheduler(intervalMs) {
  if (schedulerTimer) return;
  const effectiveIntervalMs =
    intervalMs || Math.max(1, Number(process.env.CRM_EMAIL_AUTOMATION_SWEEP_MINUTES) || 5) * 60_000;
  const lockKey = "lock:crm-email-automation-scheduler";
  const lockTtlSeconds = Math.max(30, Math.floor(effectiveIntervalMs / 1000) - 5);

  logger.info("crm_email_automation.scheduler_starting", "Starting CRM email automation scheduler", {
    intervalSeconds: Math.round(effectiveIntervalMs / 1000),
  });
  automationService.ensureIndexes().catch((error) => {
    logger.error("crm_email_automation.index_failed", "Could not build email automation indexes", { error: error.message });
  });

  const sweep = async () => {
    let lockAcquired = false;
    try {
      if (redisConnection && redisConnection.status === "ready") {
        const res = await redisConnection.set(lockKey, "LOCKED", "NX", "EX", lockTtlSeconds);
        if (!res) return;
        lockAcquired = true;
      }
    } catch (lockErr) {
      logger.warn("crm_email_automation.lock_failed", "Could not acquire scheduler lock; sweeping locally", {
        error: lockErr.message,
      });
    }

    try {
      const summary = await automationService.runScheduler();
      if (summary.processed || summary.evaluated?.created || summary.recovered) {
        logger.info("crm_email_automation.sweep_complete", "CRM email automation sweep complete", summary);
      }
    } catch (error) {
      logger.error("crm_email_automation.sweep_failed", "CRM email automation sweep failed", { error: error.message });
    } finally {
      if (lockAcquired && redisConnection && redisConnection.status === "ready") {
        try {
          await redisConnection.del(lockKey);
        } catch {
          /* lock expires on its own */
        }
      }
    }
  };

  schedulerTimer = setInterval(sweep, effectiveIntervalMs);
  if (schedulerTimer.unref) schedulerTimer.unref();
}

function stopEmailAutomationScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

const originalClose = crmEmailAutomationWorker.close.bind(crmEmailAutomationWorker);
crmEmailAutomationWorker.close = async () => {
  stopEmailAutomationScheduler();
  return originalClose();
};

module.exports = crmEmailAutomationWorker;
module.exports.startEmailAutomationScheduler = startEmailAutomationScheduler;
module.exports.stopEmailAutomationScheduler = stopEmailAutomationScheduler;
