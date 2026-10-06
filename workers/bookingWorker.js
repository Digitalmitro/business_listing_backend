// backend/workers/bookingWorker.js
"use strict";

const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const { sendMail } = require("../utils/nodemailer");
const Business = require("../models/Business");
const User = require("../models/User");
const SenderEmail = require("../models/SenderEmail");
const { getTemplate } = require("../helpers/emailHelper");
const appointmentNotifications = require("../services/appointmentNotificationService");
const logger = require("../utils/logger");

let schedulerTimer = null;
let initialSweepTimer = null;

/**
 * Booking emails queued by an API process that predates appointment notification
 * rows ({ triggerType, userId, businessId, replacements }). Kept so a deploy never
 * drops an email that is already in the queue. Delivery failures are reported, so
 * BullMQ retries them instead of logging a success that never happened.
 */
async function processLegacyJob(job) {
  const { triggerType, userId, businessId, replacements = {} } = job.data;
  const business = await Business.findById(businessId).populate("userId");
  const user = await User.findById(userId);
  if (!business) throw new Error("Business not found");
  if (!user) throw new Error("User not found");

  const sender = await SenderEmail.findOne({ isActive: true });
  if (!sender) throw new Error("No active sender email found");

  const owner = business.userId;
  const frontendUrl = process.env.FRONTEND_URL || "https://urbancitations.com";
  const subjects = {
    booking_confirmed: ["New Appointment Booked", "Booking Confirmation"],
    booking_rescheduled: ["Appointment Rescheduled", "Booking Rescheduled"],
    booking_canceled: ["Appointment Canceled", "Booking Canceled"],
  };
  const [ownerSubject, userSubject] = subjects[triggerType] || subjects.booking_confirmed;
  const failures = [];

  if (owner && owner.email) {
    const { subject, html } = await getTemplate(
      `${triggerType}_owner`,
      { ...replacements, "{{recipient_name}}": owner.full_name || owner.name || "Owner" },
      {
        subject: ownerSubject,
        html: `<h3>Notification</h3><p>Booking details for ${business.businessName}: ${replacements["{{service_name}}"]} on ${replacements["{{appointment_date}}"]} at ${replacements["{{appointment_time}}"]}.</p>`,
      }
    );
    const result = await sendMail(sender.email, owner.email, subject, html, `${frontendUrl}/unsubscribe?userId=${owner._id}`);
    if (!result?.success) failures.push(`owner: ${result?.error?.message || "unknown error"}`);
  }

  if (user.email) {
    const { subject, html } = await getTemplate(
      `${triggerType}_user`,
      { ...replacements, "{{recipient_name}}": user.full_name || user.name || "Customer" },
      {
        subject: userSubject,
        html: `<h3>Confirmation</h3><p>Your booking at ${business.businessName} for ${replacements["{{service_name}}"]} is confirmed for ${replacements["{{appointment_date}}"]} at ${replacements["{{appointment_time}}"]}.</p>`,
      }
    );
    const result = await sendMail(sender.email, user.email, subject, html, `${frontendUrl}/unsubscribe?userId=${user._id}`);
    if (!result?.success) failures.push(`customer: ${result?.error?.message || "unknown error"}`);
  }

  if (failures.length) throw new Error(`Booking email delivery failed (${failures.join("; ")})`);
  logger.info("booking_email.legacy_sent", "Legacy booking emails sent", { jobId: job.id, triggerType });
  return { triggerType, sent: true };
}

/**
 * Sends one appointment email per "send" job, at the exact time the job was
 * delayed to. The scheduler sweep below is the source of truth and sends anything
 * a job missed, so a lost job or a restart never loses an email.
 */
const bookingWorker = new Worker(
  appointmentNotifications.QUEUE_NAME,
  async (job) => {
    const data = job.data || {};
    try {
      if (data.action === "send" && data.notificationId) {
        return await appointmentNotifications.processNotification(data.notificationId);
      }
      if (data.action === "sweep") {
        return await appointmentNotifications.runScheduler();
      }
      if (data.triggerType) {
        return await processLegacyJob(job);
      }
      logger.warn("booking_email.unknown_job", "Ignoring unknown booking email job", { jobId: job.id, data });
      return null;
    } catch (error) {
      logger.error("booking_email.job_failed", "Booking email job failed", { jobId: job.id, error: error.message });
      throw error;
    }
  },
  { connection: redisConnection }
);

/**
 * Periodic sweep: backfills plans for appointments that have none, queues emails
 * due within the next window as delayed jobs (exact timing), and sends anything a
 * job missed. One sweep runs shortly after startup so a restart catches up at once.
 * A Redis lock keeps several worker processes from sweeping together (the
 * per-row claim prevents double sends anyway).
 * @param {number} [intervalMs] - defaults to APPOINTMENT_NOTIFICATION_SWEEP_SECONDS (60).
 */
function startAppointmentNotificationScheduler(intervalMs) {
  if (schedulerTimer) return;
  const seconds = Math.max(15, Number(process.env.APPOINTMENT_NOTIFICATION_SWEEP_SECONDS) || 60);
  const effectiveIntervalMs = intervalMs || seconds * 1000;
  const lookaheadMs = effectiveIntervalMs + 30_000;
  const lockKey = "lock:appointment-notification-scheduler";
  const lockTtlSeconds = Math.max(10, Math.floor(effectiveIntervalMs / 1000) - 2);

  logger.info("appointment_notifications.scheduler_starting", "Starting appointment notification scheduler", {
    intervalSeconds: Math.round(effectiveIntervalMs / 1000),
    reminderSteps: appointmentNotifications.reminderSchedule().map((s) => s.key),
  });
  appointmentNotifications.ensureIndexes().catch((error) => {
    logger.error("appointment_notifications.index_failed", "Could not build appointment notification indexes", { error: error.message });
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
      logger.warn("appointment_notifications.lock_failed", "Could not acquire scheduler lock; sweeping locally", { error: lockErr.message });
    }

    try {
      const summary = await appointmentNotifications.runScheduler({ lookaheadMs });
      if (summary.processed || summary.queued || summary.recovered || summary.backfill?.planned) {
        logger.info("appointment_notifications.sweep_complete", "Appointment notification sweep complete", summary);
      }
    } catch (error) {
      logger.error("appointment_notifications.sweep_failed", "Appointment notification sweep failed", { error: error.message });
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

  initialSweepTimer = setTimeout(sweep, 5_000);
  if (initialSweepTimer.unref) initialSweepTimer.unref();
  schedulerTimer = setInterval(sweep, effectiveIntervalMs);
  if (schedulerTimer.unref) schedulerTimer.unref();
}

function stopAppointmentNotificationScheduler() {
  if (initialSweepTimer) {
    clearTimeout(initialSweepTimer);
    initialSweepTimer = null;
  }
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

const originalClose = bookingWorker.close.bind(bookingWorker);
bookingWorker.close = async () => {
  stopAppointmentNotificationScheduler();
  return originalClose();
};

module.exports = bookingWorker;
module.exports.startAppointmentNotificationScheduler = startAppointmentNotificationScheduler;
module.exports.stopAppointmentNotificationScheduler = stopAppointmentNotificationScheduler;
module.exports.processLegacyJob = processLegacyJob;
