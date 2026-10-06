"use strict";

/**
 * Appointment emails: the booking confirmation (customer + business owner), the
 * reminder series before the appointment (customer), and the reschedule and
 * cancellation notices, all measured from the appointment's exact start time.
 *
 * Flow
 *   booking / reschedule / cancel -> plan AppointmentNotification rows: one per email,
 *                                    unique per appointment + key + recipient
 *   due rows                      -> BullMQ "booking-email" job delayed to the exact
 *                                    time, plus the worker sweep as the catch-up path
 *   processNotification()         -> claim (scheduled -> sending), re-check the
 *                                    appointment, render the EmailTemplate, send,
 *                                    mark sent | failed (retried) | skipped
 *
 * The rows are the source of truth: a lost Redis job, a worker restart, or an API
 * process that could not reach Redis never loses an email, and the claim means an
 * email is never sent twice. Every hook here swallows its own errors, so email
 * problems can never break a booking.
 *
 * Reminder steps (APPOINTMENT_REMINDER_SCHEDULE, default "3d,2d,1d,30m,10m") are
 * offsets before `startsAt`. Steps whose time has already passed when the
 * appointment is booked are recorded as skipped, never sent late.
 */

const mongoose = require("mongoose");
const validator = require("validator");
const Appointment = require("../models/Appointment");
const AppointmentNotification = require("../models/AppointmentNotification");
const Business = require("../models/Business");
const User = require("../models/User");
const SenderEmail = require("../models/SenderEmail");
const CrmEngagementSettings = require("../models/CrmEngagementSettings");
const { getTemplate } = require("../helpers/emailHelper");
const timeService = require("./appointmentTimeService");
const { addJob } = require("../utils/queue");
const logger = require("../utils/logger");

const QUEUE_NAME = "booking-email";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The reminder series. `offsetMs` is how long before the appointment the email
 * goes out; `lateToleranceMs` is how late it may still go out (a worker outage)
 * before it is skipped instead, so wording like "in 3 days" is never sent a day late.
 */
const REMINDER_STEPS = {
  "3d": { key: "3d", offsetMs: 3 * DAY, lateToleranceMs: 12 * HOUR, when: "in 3 days", triggerType: "booking_reminder_3d_user" },
  "2d": { key: "2d", offsetMs: 2 * DAY, lateToleranceMs: 12 * HOUR, when: "in 2 days", triggerType: "booking_reminder_2d_user" },
  "1d": { key: "1d", offsetMs: 1 * DAY, lateToleranceMs: 12 * HOUR, when: "tomorrow", triggerType: "booking_reminder_1d_user" },
  "30m": { key: "30m", offsetMs: 30 * MINUTE, lateToleranceMs: 15 * MINUTE, when: "in 30 minutes", triggerType: "booking_reminder_30m_user" },
  "10m": { key: "10m", offsetMs: 10 * MINUTE, lateToleranceMs: 8 * MINUTE, when: "in 10 minutes", triggerType: "booking_reminder_10m_user" },
};
const DEFAULT_SCHEDULE = ["3d", "2d", "1d", "30m", "10m"];

const MAX_ATTEMPTS = Math.max(1, Number(process.env.APPOINTMENT_EMAIL_MAX_ATTEMPTS) || 3);
const RETRY_BASE_MS = 5 * MINUTE;
const STALE_SENDING_MS = 15 * MINUTE;
/** A confirmation is still worth sending this long after the appointment started. */
const CONFIRMATION_GRACE_MS = DAY;
const BATCH_SIZE = 200;

let warnedUnknownSteps = false;

/** Reminder steps in effect, nearest-to-appointment last. */
function reminderSchedule() {
  const raw = process.env.APPOINTMENT_REMINDER_SCHEDULE;
  if (raw === undefined || raw === null) return DEFAULT_SCHEDULE.map((k) => REMINDER_STEPS[k]);
  const keys = String(raw).split(",").map((k) => k.trim()).filter(Boolean);
  const unknown = keys.filter((k) => !REMINDER_STEPS[k]);
  if (unknown.length && !warnedUnknownSteps) {
    warnedUnknownSteps = true;
    logger.warn("appointment_notifications.unknown_steps", "APPOINTMENT_REMINDER_SCHEDULE contains unknown steps; ignoring them", {
      unknown,
      known: Object.keys(REMINDER_STEPS),
    });
  }
  return keys.filter((k) => REMINDER_STEPS[k]).map((k) => REMINDER_STEPS[k]).sort((a, b) => b.offsetMs - a.offsetMs);
}

function dbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function frontendUrl() {
  return process.env.FRONTEND_URL || "https://urbancitations.com";
}

function nextRetryAt(attempts, now = new Date()) {
  return new Date(now.getTime() + RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

// ── Email wording (used when no EmailTemplate exists for the trigger) ────────

function emailLayout(title, color, body) {
  return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
        <h2 style="color: ${color};">${title}</h2>
        ${body}
      </div>`;
}

const DETAILS_BLOCK = `
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p style="margin: 5px 0;"><strong>Business:</strong> {{business_name}}</p>
          <p style="margin: 5px 0;"><strong>Service:</strong> {{service_name}}</p>
          <p style="margin: 5px 0;"><strong>Date:</strong> {{appointment_date}}</p>
          <p style="margin: 5px 0;"><strong>Time:</strong> {{appointment_time}} ({{timezone}})</p>
          <p style="margin: 5px 0;"><strong>Booking ID:</strong> {{appointment_id}}</p>
        </div>`;

const ON_TIME_LINE = `<p><strong>Please be on time.</strong> Arrive a few minutes early so your appointment can start as scheduled. If your plans change, cancel or reschedule from <a href="{{booking_link}}">My Bookings</a>.</p>`;

function reminderFallback(step) {
  return {
    subject: `Reminder: your appointment at {{business_name}} is ${step.when}`,
    html: emailLayout(`Your appointment is ${step.when}`, "#FF9800", `
        <p>Hi {{recipient_name}},</p>
        <p>This is a reminder that your appointment for <strong>{{service_name}}</strong> at <strong>{{business_name}}</strong> is <strong>{{reminder_when}}</strong>.</p>
        ${DETAILS_BLOCK}
        ${ON_TIME_LINE}
        <p>See you soon,<br>The {{business_name}} Team</p>`),
  };
}

const FALLBACKS = {
  booking_confirmed_user: {
    subject: "Booking Confirmed - {{business_name}}",
    html: emailLayout("Booking Confirmed!", "#4CAF50", `
        <p>Hi {{recipient_name}},</p>
        <p>Your booking for <strong>{{service_name}}</strong> at <strong>{{business_name}}</strong> is confirmed.</p>
        ${DETAILS_BLOCK}
        ${ON_TIME_LINE}
        <p>We look forward to seeing you!</p>
        <p>Best Regards,<br>The {{business_name}} Team</p>`),
  },
  booking_confirmed_owner: {
    subject: "New Appointment Booked - {{service_name}}",
    html: emailLayout("New Booking Received", "#2196F3", `
        <p>Hi {{recipient_name}},</p>
        <p>A new appointment has been booked at <strong>{{business_name}}</strong>.</p>
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p style="margin: 5px 0;"><strong>Customer:</strong> {{customer_name}}</p>
          <p style="margin: 5px 0;"><strong>Service:</strong> {{service_name}}</p>
          <p style="margin: 5px 0;"><strong>Date:</strong> {{appointment_date}}</p>
          <p style="margin: 5px 0;"><strong>Time:</strong> {{appointment_time}} ({{timezone}})</p>
          <p style="margin: 5px 0;"><strong>Booking ID:</strong> {{appointment_id}}</p>
        </div>
        <div style="text-align: center; margin: 30px 0;">
          <a href="{{frontend_url}}/dashboard" style="background-color: #2196F3; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">View in Dashboard</a>
        </div>
        <p>Best Regards,<br>The UrbanCitations Team</p>`),
  },
  booking_rescheduled_user: {
    subject: "Booking Rescheduled - {{business_name}}",
    html: emailLayout("Booking Rescheduled", "#FF9800", `
        <p>Hi {{recipient_name}},</p>
        <p>Your booking for <strong>{{service_name}}</strong> at <strong>{{business_name}}</strong> has moved from {{old_date}} at {{old_time}} to:</p>
        ${DETAILS_BLOCK}
        ${ON_TIME_LINE}
        <p>Best Regards,<br>The {{business_name}} Team</p>`),
  },
  booking_rescheduled_owner: {
    subject: "Appointment Rescheduled - {{customer_name}}",
    html: emailLayout("Appointment Rescheduled", "#FF9800", `
        <p>Hi {{recipient_name}},</p>
        <p><strong>{{customer_name}}</strong> moved their appointment for <strong>{{service_name}}</strong> from {{old_date}} at {{old_time}} to:</p>
        ${DETAILS_BLOCK}
        <p>Best Regards,<br>The UrbanCitations Team</p>`),
  },
  booking_canceled_user: {
    subject: "Booking Canceled - {{business_name}}",
    html: emailLayout("Booking Canceled", "#f44336", `
        <p>Hi {{recipient_name}},</p>
        <p>Your booking for <strong>{{service_name}}</strong> at <strong>{{business_name}}</strong> on {{appointment_date}} at {{appointment_time}} has been canceled.</p>
        <p>You can book again any time from <a href="{{frontend_url}}">UrbanCitations</a>.</p>
        <p>Best Regards,<br>The {{business_name}} Team</p>`),
  },
  booking_canceled_owner: {
    subject: "Appointment Canceled - {{customer_name}}",
    html: emailLayout("Appointment Canceled", "#f44336", `
        <p>Hi {{recipient_name}},</p>
        <p><strong>{{customer_name}}</strong> canceled their appointment for <strong>{{service_name}}</strong> on {{appointment_date}} at {{appointment_time}}.</p>
        <p>Best Regards,<br>The UrbanCitations Team</p>`),
  },
};
for (const step of Object.values(REMINDER_STEPS)) FALLBACKS[step.triggerType] = reminderFallback(step);

// ── Context ──────────────────────────────────────────────────────────────────

/** First phone number on a business's contact record, if any. */
function businessPhone(contact) {
  if (!contact) return "";
  const details = Array.isArray(contact.contactDetails) ? contact.contactDetails : [];
  for (const person of details) {
    const numbers = Array.isArray(person?.mobileNumbers) ? person.mobileNumbers : [];
    if (numbers.length) return String(numbers[0]);
  }
  if (Array.isArray(contact.mobile) && contact.mobile.length) return String(contact.mobile[0]);
  return "";
}

function displayName(user, fallback) {
  return user?.full_name || user?.name || fallback;
}

function validEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email && validator.isEmail(email) ? email : null;
}

/**
 * The timezone a booking's date and time slot are in. A timezone the business
 * configured in its CRM settings wins; then the one the booking client sent
 * (the customer's browser), then the owner's and customer's profile zones, then
 * APPOINTMENT_DEFAULT_TIMEZONE / Asia/Kolkata.
 */
async function resolveTimezone({ requested, businessId, owner, customer } = {}) {
  let businessTimezone = null;
  if (businessId && dbReady()) {
    try {
      const settings = await CrmEngagementSettings.findOne({ businessId }).select("timezone").lean();
      businessTimezone = settings?.timezone || null;
    } catch (error) {
      logger.warn("appointment_notifications.timezone_lookup_failed", "Could not read the business timezone", { error: error.message });
    }
  }
  return timeService.pickTimezone(businessTimezone, requested, owner?.timeZone, customer?.timeZone);
}

function placeholdersFor({ appointment, business, customer, owner, previous, step, recipient }) {
  const timezone = timeService.pickTimezone(appointment?.timezone);
  const startsAt = appointment?.startsAt ? new Date(appointment.startsAt) : timeService.appointmentStartsAt(appointment, timezone);
  const recipientUser = recipient === "owner" ? owner : customer;
  const previousStart = previous ? (previous.startsAt ? new Date(previous.startsAt) : timeService.appointmentStartsAt(previous, timezone)) : null;
  return {
    "{{recipient_name}}": displayName(recipientUser, recipient === "owner" ? "Owner" : "Customer"),
    "{{customer_name}}": displayName(customer, "Customer"),
    "{{business_name}}": business?.businessName || "the business",
    "{{service_name}}": appointment?.serviceName || "Service",
    "{{appointment_date}}": timeService.formatInTimezone(startsAt, timezone),
    "{{appointment_time}}": appointment?.timeSlot || timeService.formatInTimezone(startsAt, timezone, "hh:mm A"),
    "{{appointment_id}}": String(appointment?._id || ""),
    "{{timezone}}": timezone,
    "{{business_phone}}": businessPhone(business?.contact),
    "{{reminder_when}}": step?.when || "",
    "{{old_date}}": previousStart ? timeService.formatInTimezone(previousStart, timezone) : "",
    "{{old_time}}": previous?.timeSlot || "",
    "{{booking_link}}": `${frontendUrl()}/bookinghistory`,
  };
}

// ── Planning ─────────────────────────────────────────────────────────────────

/**
 * The notification rows an appointment needs, as plain objects. Pure: no I/O.
 * `kind` is "confirmation" for a new booking or "rescheduled" for the appointment
 * a reschedule created. Reminder steps already in the past are returned as skipped.
 */
function buildPlan({ appointment, ownerId = null, now = new Date(), kind = "confirmation", includeConfirmation = true, schedule = reminderSchedule() }) {
  const startsAt = appointment?.startsAt ? new Date(appointment.startsAt) : timeService.appointmentStartsAt(appointment);
  const base = {
    appointmentId: appointment._id,
    businessId: appointment.businessId?._id || appointment.businessId,
    customerId: appointment.userId?._id || appointment.userId || null,
    ownerId: ownerId || null,
    startsAt: startsAt || null,
  };
  const rows = [];

  const noticeKey = kind === "rescheduled" ? "rescheduled" : "confirmation";
  const noticeTrigger = kind === "rescheduled" ? "booking_rescheduled" : "booking_confirmed";
  for (const recipient of ["customer", "owner"]) {
    if (recipient === "owner" && !base.ownerId) continue;
    rows.push({
      ...base,
      kind: noticeKey,
      key: noticeKey,
      recipient,
      triggerType: `${noticeTrigger}_${recipient === "owner" ? "owner" : "user"}`,
      scheduledFor: now,
      status: includeConfirmation ? "scheduled" : "skipped",
      lastError: includeConfirmation ? null : "Booked before appointment notifications were enabled",
    });
  }

  if (startsAt) {
    for (const step of schedule) {
      const scheduledFor = new Date(startsAt.getTime() - step.offsetMs);
      const past = scheduledFor.getTime() <= now.getTime();
      rows.push({
        ...base,
        kind: "reminder",
        key: step.key,
        recipient: "customer",
        triggerType: step.triggerType,
        scheduledFor,
        status: past ? "skipped" : "scheduled",
        lastError: past ? `The "${step.when}" reminder time had already passed when the appointment was booked` : null,
      });
    }
  }
  return rows;
}

/** Inserts rows, ignoring ones that already exist (unique appointment + key + recipient). */
async function insertRows(rows) {
  const created = [];
  for (const row of rows) {
    try {
      created.push(await AppointmentNotification.create(row));
    } catch (error) {
      if (error && error.code === 11000) continue;
      throw error;
    }
  }
  return created;
}

/** Queues the send job for a row at its exact time; the sweep covers a failed enqueue. */
async function enqueueSend(row, now = new Date()) {
  const delay = Math.max(0, new Date(row.scheduledFor).getTime() - now.getTime());
  try {
    await addJob(
      QUEUE_NAME,
      { action: "send", notificationId: String(row._id) },
      { jobId: `appointment-notification-${row._id}-${row.attempts || 0}`, delay }
    );
    return true;
  } catch (error) {
    logger.warn("appointment_notifications.enqueue_failed", "Could not queue appointment email; the worker sweep will send it", {
      notificationId: String(row._id),
      error: error.message,
    });
    return false;
  }
}

/**
 * Plans every email for an appointment and queues the ones due now. Idempotent per
 * appointment: rows that already exist are left alone. Never throws.
 */
async function planNotifications(appointment, { now = new Date(), kind = "confirmation", includeConfirmation = true, lookaheadMs = 2 * MINUTE } = {}) {
  try {
    if (!dbReady() || !appointment || !appointment._id) return { created: [], queued: 0 };
    const businessId = appointment.businessId?._id || appointment.businessId;
    const business = await Business.findById(businessId).select("_id userId").lean();
    const rows = buildPlan({ appointment, ownerId: business?.userId || null, now, kind, includeConfirmation });
    if (!rows.some((r) => r.kind === "reminder")) {
      logger.warn("appointment_notifications.no_start_time", "Appointment has no start time; reminders were not scheduled", {
        appointmentId: String(appointment._id),
      });
    }
    const created = await insertRows(rows);
    await Appointment.updateOne({ _id: appointment._id }, { $set: { notificationsScheduledAt: now } });

    let queued = 0;
    for (const row of created) {
      if (row.status === "scheduled" && row.scheduledFor.getTime() <= now.getTime() + lookaheadMs) {
        if (await enqueueSend(row, now)) queued++;
      }
    }
    logger.info("appointment_notifications.planned", "Appointment emails planned", {
      appointmentId: String(appointment._id),
      kind,
      created: created.length,
      scheduled: created.filter((r) => r.status === "scheduled").map((r) => `${r.key}:${r.recipient}@${r.scheduledFor.toISOString()}`),
      skipped: created.filter((r) => r.status === "skipped").map((r) => r.key),
      queued,
    });
    return { created, queued };
  } catch (error) {
    logger.error("appointment_notifications.plan_failed", "Could not plan appointment emails", {
      appointmentId: String(appointment?._id),
      error: error.message,
    });
    return { created: [], queued: 0 };
  }
}

/** Marks every pending email of an appointment as skipped (cancel / reschedule). */
async function cancelPending(appointmentId, reason) {
  const res = await AppointmentNotification.updateMany(
    { appointmentId, status: "scheduled" },
    { $set: { status: "skipped", lastError: reason } }
  );
  return res.modifiedCount || 0;
}

/** A booking was made: confirmation now, reminders before it starts. */
async function onAppointmentBooked(appointment, options = {}) {
  return planNotifications(appointment, { ...options, kind: "confirmation" });
}

/** A booking moved: the old appointment's reminders stop, the new one gets its own. */
async function onAppointmentRescheduled(previousAppointment, newAppointment, options = {}) {
  try {
    if (dbReady() && previousAppointment?._id) await cancelPending(previousAppointment._id, "Appointment was rescheduled");
  } catch (error) {
    logger.error("appointment_notifications.reschedule_cleanup_failed", "Could not stop reminders of the rescheduled appointment", {
      appointmentId: String(previousAppointment?._id),
      error: error.message,
    });
  }
  return planNotifications(newAppointment, { ...options, kind: "rescheduled" });
}

/** A booking was canceled: reminders stop, both parties get the cancellation notice. */
async function onAppointmentCanceled(appointment, { now = new Date() } = {}) {
  try {
    if (!dbReady() || !appointment || !appointment._id) return { created: [], queued: 0 };
    await cancelPending(appointment._id, "Appointment was canceled");
    const businessId = appointment.businessId?._id || appointment.businessId;
    const business = await Business.findById(businessId).select("_id userId").lean();
    const base = {
      appointmentId: appointment._id,
      businessId,
      customerId: appointment.userId?._id || appointment.userId || null,
      ownerId: business?.userId || null,
      startsAt: appointment.startsAt || timeService.appointmentStartsAt(appointment) || null,
      kind: "canceled",
      key: "canceled",
      scheduledFor: now,
      status: "scheduled",
    };
    const rows = [{ ...base, recipient: "customer", triggerType: "booking_canceled_user" }];
    if (base.ownerId) rows.push({ ...base, recipient: "owner", triggerType: "booking_canceled_owner" });
    const created = await insertRows(rows);
    let queued = 0;
    for (const row of created) if (await enqueueSend(row, now)) queued++;
    return { created, queued };
  } catch (error) {
    logger.error("appointment_notifications.cancel_failed", "Could not plan cancellation emails", {
      appointmentId: String(appointment?._id),
      error: error.message,
    });
    return { created: [], queued: 0 };
  }
}

// ── Sending ──────────────────────────────────────────────────────────────────

/**
 * Why a claimed row must not be sent now, or null. Reminders are never sent once
 * the appointment has started or once their window has passed; notices are not
 * sent for appointments that are no longer in the matching state.
 */
function skipReason(row, appointment, now = new Date()) {
  if (!appointment) return "Appointment no longer exists";
  const startsAt = appointment.startsAt ? new Date(appointment.startsAt) : row.startsAt ? new Date(row.startsAt) : null;
  if (row.kind === "reminder") {
    if (appointment.status !== "Scheduled") return `Appointment is ${appointment.status}`;
    if (!startsAt) return "Appointment has no start time";
    if (now.getTime() >= startsAt.getTime()) return "Appointment start time has already passed";
    const step = REMINDER_STEPS[row.key];
    const tolerance = step ? step.lateToleranceMs : 0;
    if (now.getTime() > new Date(row.scheduledFor).getTime() + tolerance) {
      return `The "${step?.when || row.key}" reminder window passed before it could be sent`;
    }
    return null;
  }
  if (row.kind === "confirmation" || row.kind === "rescheduled") {
    if (appointment.status !== "Scheduled") return `Appointment is ${appointment.status}`;
    if (startsAt && now.getTime() > startsAt.getTime() + CONFIRMATION_GRACE_MS) return "Appointment date has passed";
    return null;
  }
  if (row.kind === "canceled" && appointment.status !== "Canceled") return `Appointment is ${appointment.status}, not canceled`;
  return null;
}

async function loadContext(row) {
  const [appointment, business, customer] = await Promise.all([
    Appointment.findById(row.appointmentId).lean(),
    Business.findById(row.businessId).select("_id businessName userId contact").lean(),
    row.customerId ? User.findById(row.customerId).select("full_name name email").lean() : null,
  ]);
  const ownerId = business?.userId || row.ownerId;
  const [owner, previous] = await Promise.all([
    ownerId ? User.findById(ownerId).select("full_name name email").lean() : null,
    row.kind === "rescheduled" && appointment?.rescheduledFrom
      ? Appointment.findById(appointment.rescheduledFrom).select("appointmentDate timeSlot timezone startsAt").lean()
      : null,
  ]);
  return { appointment, business, customer, owner, previous };
}

/**
 * Sends through the active SenderEmail (SMTP) or, if none is configured, the
 * EMAIL_USER / EMAIL_PASS Gmail fallback. Returns { success, info | error }.
 * Exported so tests can stub delivery.
 */
async function deliver({ to, subject, html, unsubscribeLink, replyTo }) {
  const sender = await SenderEmail.findOne({ isActive: true }).select("email").lean();
  if (sender) {
    const nodemailerUtil = require("../utils/nodemailer");
    return nodemailerUtil.sendMail(sender.email, to, subject, html, unsubscribeLink, { replyTo });
  }
  const sendMailService = require("./sendMail");
  const footer = unsubscribeLink ? `<br><br><a href="${unsubscribeLink}" style="color:#888;font-size:12px;">Unsubscribe</a>` : "";
  return sendMailService(to, subject, `${html}${footer}`, { replyTo });
}

async function finish(row, status, fields = {}) {
  await AppointmentNotification.updateOne({ _id: row._id }, { $set: { status, lockedAt: null, ...fields } });
  return { notificationId: String(row._id), key: row.key, recipient: row.recipient, status, ...fields };
}

/**
 * Claims and sends one due notification. Safe to call from the queue job and the
 * sweep at the same time: only the caller that flips it to "sending" proceeds.
 */
async function processNotification(notificationId, { now = new Date() } = {}) {
  if (!dbReady() || !mongoose.isValidObjectId(notificationId)) return { status: "ignored" };
  const row = await AppointmentNotification.findOneAndUpdate(
    { _id: notificationId, status: "scheduled", scheduledFor: { $lte: now } },
    { $set: { status: "sending", lockedAt: now }, $inc: { attempts: 1 } },
    { new: true }
  ).lean();
  if (!row) return { status: "not_due" };

  let ctx;
  try {
    ctx = await loadContext(row);
    const reason = skipReason(row, ctx.appointment, now);
    if (reason) {
      logger.info("appointment_notifications.skipped", "Appointment email skipped", { notificationId: String(row._id), key: row.key, recipient: row.recipient, reason });
      return finish(row, "skipped", { lastError: reason });
    }

    const recipientUser = row.recipient === "owner" ? ctx.owner : ctx.customer;
    const to = validEmail(recipientUser?.email);
    if (!to) {
      return finish(row, "skipped", { lastError: `No valid email address for the ${row.recipient}` });
    }

    const step = REMINDER_STEPS[row.key] || null;
    const placeholders = placeholdersFor({ ...ctx, step, recipient: row.recipient });
    const fallback = FALLBACKS[row.triggerType] || FALLBACKS.booking_confirmed_user;
    const { subject, html } = await getTemplate(row.triggerType, placeholders, fallback);
    const unsubscribeLink = recipientUser?._id ? `${frontendUrl()}/unsubscribe?userId=${recipientUser._id}` : undefined;
    const replyTo = row.recipient === "customer" ? validEmail(ctx.owner?.email) || undefined : undefined;

    const result = await module.exports.deliver({ to, subject, html, unsubscribeLink, replyTo });
    if (result && result.success) {
      logger.info("appointment_notifications.sent", "Appointment email sent", {
        notificationId: String(row._id),
        appointmentId: String(row.appointmentId),
        key: row.key,
        recipient: row.recipient,
        to,
        messageId: result.info?.messageId,
      });
      return finish(row, "sent", { to, subject, sentAt: new Date(), messageId: result.info?.messageId || null, lastError: null });
    }
    throw result?.error || new Error("Unknown email delivery failure");
  } catch (error) {
    const message = error?.message || String(error);
    const startsAt = ctx?.appointment?.startsAt ? new Date(ctx.appointment.startsAt) : row.startsAt ? new Date(row.startsAt) : null;
    const retryAt = nextRetryAt(row.attempts, now);
    const retryStillUseful = row.kind !== "reminder" || !startsAt || retryAt.getTime() < startsAt.getTime();
    if (row.attempts < MAX_ATTEMPTS && retryStillUseful) {
      logger.warn("appointment_notifications.retry_scheduled", "Appointment email failed; retry scheduled", {
        notificationId: String(row._id),
        key: row.key,
        attempt: row.attempts,
        retryAt: retryAt.toISOString(),
        error: message,
      });
      const result = await finish(row, "scheduled", { scheduledFor: retryAt, lastError: message });
      await enqueueSend({ ...row, scheduledFor: retryAt }, now);
      return result;
    }
    logger.error("appointment_notifications.failed", "Appointment email failed permanently", {
      notificationId: String(row._id),
      key: row.key,
      attempts: row.attempts,
      error: message,
    });
    return finish(row, "failed", { lastError: retryStillUseful ? message : `${message} (no retry: the appointment starts before the next attempt)` });
  }
}

// ── Worker sweep ─────────────────────────────────────────────────────────────

/**
 * A row left in "sending" (worker crashed mid-send) may or may not have gone out.
 * It is marked failed rather than retried, so nobody ever gets an email twice.
 */
async function recoverStaleSending(now = new Date()) {
  const res = await AppointmentNotification.updateMany(
    { status: "sending", lockedAt: { $lt: new Date(now.getTime() - STALE_SENDING_MS) } },
    { $set: { status: "failed", lockedAt: null, lastError: "Delivery was interrupted; not retried to avoid a duplicate email" } }
  );
  return res.modifiedCount || 0;
}

/**
 * Plans emails for scheduled appointments that have none yet: bookings made before
 * this feature shipped, or whose API process could not write the plan. A booking
 * older than APPOINTMENT_CONFIRMATION_BACKFILL_HOURS (24) gets its reminders but
 * no late confirmation.
 */
async function backfillAppointments({ now = new Date(), limit = BATCH_SIZE } = {}) {
  const confirmationWindowMs = Math.max(0, Number(process.env.APPOINTMENT_CONFIRMATION_BACKFILL_HOURS ?? 24)) * HOUR;
  const candidates = await Appointment.find({
    status: "Scheduled",
    notificationsScheduledAt: null,
    $or: [{ startsAt: { $gt: now } }, { startsAt: null, appointmentDate: { $gte: new Date(now.getTime() - DAY) } }],
  })
    .sort({ appointmentDate: 1 })
    .limit(limit)
    .lean();

  const summary = { examined: candidates.length, planned: 0, past: 0 };
  for (const appointment of candidates) {
    let { startsAt, timezone } = appointment;
    if (!startsAt || !timezone) {
      const business = await Business.findById(appointment.businessId).select("_id userId").lean();
      const [owner, customer] = await Promise.all([
        business?.userId ? User.findById(business.userId).select("timeZone").lean() : null,
        User.findById(appointment.userId).select("timeZone").lean(),
      ]);
      timezone = await resolveTimezone({ requested: timezone, businessId: appointment.businessId, owner, customer });
      startsAt = timeService.appointmentStartsAt(appointment, timezone);
      await Appointment.updateOne({ _id: appointment._id }, { $set: { timezone, startsAt } });
    }
    if (!startsAt || startsAt.getTime() <= now.getTime()) {
      await Appointment.updateOne({ _id: appointment._id }, { $set: { notificationsScheduledAt: now } });
      summary.past++;
      continue;
    }
    const createdAt = appointment.createdAt ? new Date(appointment.createdAt) : now;
    const includeConfirmation = now.getTime() - createdAt.getTime() <= confirmationWindowMs;
    await planNotifications({ ...appointment, startsAt, timezone }, { now, kind: appointment.rescheduledFrom ? "rescheduled" : "confirmation", includeConfirmation });
    summary.planned++;
  }
  return summary;
}

/** Queues every row due within the lookahead window as a delayed job (exact timing). */
async function enqueueUpcoming(now = new Date(), lookaheadMs = 2 * MINUTE) {
  const rows = await AppointmentNotification.find({ status: "scheduled", scheduledFor: { $lte: new Date(now.getTime() + lookaheadMs) } })
    .sort({ scheduledFor: 1 })
    .limit(BATCH_SIZE)
    .lean();
  let queued = 0;
  for (const row of rows) if (await enqueueSend(row, now)) queued++;
  return queued;
}

/** Catch-up: sends rows that were due more than `catchUpDelayMs` ago and are still pending. */
async function sendDue(now = new Date(), catchUpDelayMs = MINUTE) {
  const due = await AppointmentNotification.find({ status: "scheduled", scheduledFor: { $lte: new Date(now.getTime() - catchUpDelayMs) } })
    .sort({ scheduledFor: 1 })
    .limit(BATCH_SIZE)
    .select("_id")
    .lean();
  const summary = { processed: 0, sent: 0, failed: 0, skipped: 0, retrying: 0 };
  for (const { _id } of due) {
    const res = await processNotification(_id, { now });
    if (res.status === "not_due") continue;
    summary.processed++;
    if (res.status === "sent") summary.sent++;
    else if (res.status === "failed") summary.failed++;
    else if (res.status === "skipped") summary.skipped++;
    else if (res.status === "scheduled") summary.retrying++;
  }
  return summary;
}

/** Builds this feature's indexes (the app connects with autoIndex off). */
async function ensureIndexes() {
  await Promise.all([Appointment.createIndexes(), AppointmentNotification.createIndexes()]);
}

/** One worker sweep: recover, backfill, queue what is due soon, send what a job missed. */
async function runScheduler({ now = new Date(), lookaheadMs = 2 * MINUTE, catchUpDelayMs = MINUTE } = {}) {
  if (!dbReady()) return { skipped: true };
  const recovered = await recoverStaleSending(now);
  const backfill = await backfillAppointments({ now });
  const queued = await enqueueUpcoming(now, lookaheadMs);
  const sent = await sendDue(now, catchUpDelayMs);
  return { recovered, backfill, queued, ...sent };
}

/** Delivery log of one appointment, oldest first. */
async function listForAppointment(appointmentId) {
  if (!dbReady() || !mongoose.isValidObjectId(appointmentId)) return [];
  return AppointmentNotification.find({ appointmentId })
    .sort({ scheduledFor: 1, recipient: 1 })
    .select("-__v")
    .lean();
}

module.exports = {
  QUEUE_NAME,
  REMINDER_STEPS,
  DEFAULT_SCHEDULE,
  MAX_ATTEMPTS,
  reminderSchedule,
  resolveTimezone,
  buildPlan,
  planNotifications,
  onAppointmentBooked,
  onAppointmentRescheduled,
  onAppointmentCanceled,
  skipReason,
  deliver,
  processNotification,
  recoverStaleSending,
  backfillAppointments,
  enqueueUpcoming,
  sendDue,
  ensureIndexes,
  runScheduler,
  listForAppointment,
  nextRetryAt,
};
