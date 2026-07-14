"use strict";

require("dotenv").config();

const logger = require("./utils/logger");
logger.installConsoleBridge();

const connectDB = require("./config/db");
const { disconnectDB } = require("./config/db");
const { closeQueueConnections } = require("./utils/queue");
const { installProcessHandlers } = require("./utils/processHandlers");
const { ResourceMonitor } = require("./utils/resourceMonitor");
const emailWorker = require("./workers/emailWorker");
const welcomeWorker = require("./workers/welcomeWorker");
const purchaseWorker = require("./workers/purchaseWorker");
const claimWorker = require("./workers/claimWorker");
const kycWorker = require("./workers/kycWorker");
const geocodingWorker = require("./workers/geocodingWorker");
const enquiryWorker = require("./workers/enquiryWorker");
const bookingWorker = require("./workers/bookingWorker");
const leadFollowUpWorker = require("./workers/leadFollowUpWorker");
const scheduledSocialPostWorker = require("./workers/scheduledSocialPostWorker");
const { startFollowUpScheduler } = require("./workers/leadFollowUpWorker");

const workers = [
  emailWorker,
  welcomeWorker,
  purchaseWorker,
  claimWorker,
  kycWorker,
  geocodingWorker,
  enquiryWorker,
  bookingWorker,
  leadFollowUpWorker,
  scheduledSocialPostWorker,
];
const workerNames = [
  "email-campaigns",
  "welcome-email",
  "purchase-email",
  "claim-email",
  "kyc-email",
  "geocoding-batch",
  "enquiry-email",
  "booking-email",
  "lead-followup-scheduler",
  "scheduled-social-post",
];

let resourceMonitor;
let shutdownPromise;

async function startWorkers() {
  logger.info("workers.starting", "Queue worker startup initiated", { workerNames });
  await connectDB();
  resourceMonitor = new ResourceMonitor({ logger });
  resourceMonitor.start();
  startFollowUpScheduler();
  logger.info("workers.ready", "Queue workers are ready", { workerNames });
  if (typeof process.send === "function") process.send("ready");
}

async function shutdown(reason, { crash = false } = {}) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    logger.info("workers.shutdown_started", "Graceful queue worker shutdown started", {
      reason,
      crash,
    });
    resourceMonitor?.stop();

    const workerResults = await Promise.allSettled(workers.map((worker) => worker.close()));
    const workerFailures = workerResults.filter((result) => result.status === "rejected");
    if (workerFailures.length) {
      logger.error("workers.shutdown_partial", "Some queue workers did not close cleanly", {
        errors: workerFailures.map((failure) => failure.reason),
      });
    }

    const dependencyResults = await Promise.allSettled([
      closeQueueConnections(),
      disconnectDB(),
    ]);
    const dependencyFailures = dependencyResults.filter((result) => result.status === "rejected");
    if (dependencyFailures.length) {
      logger.error("workers.dependency_shutdown_failed", "Worker dependencies did not close cleanly", {
        errors: dependencyFailures.map((failure) => failure.reason),
      });
    }
    logger.info("workers.shutdown_complete", "Queue workers shut down cleanly", { reason });
  })();
  return shutdownPromise;
}

if (require.main === module) {
  installProcessHandlers({ logger, shutdown });
  startWorkers().catch(async (error) => {
    logger.fatal("workers.startup_failed", "Queue workers failed during startup", { error });
    try {
      await shutdown("startupFailure", { crash: true });
    } finally {
      process.exit(1);
    }
  });
}

module.exports = { shutdown, startWorkers };
