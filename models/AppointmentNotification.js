// backend/models/AppointmentNotification.js
"use strict";

const mongoose = require("mongoose");

const NOTIFICATION_KINDS = ["confirmation", "reminder", "rescheduled", "canceled"];
const NOTIFICATION_RECIPIENTS = ["customer", "owner"];
const NOTIFICATION_STATUSES = ["scheduled", "sending", "sent", "failed", "skipped"];

/**
 * One appointment email: who gets it, when it is due, and what happened to it.
 *
 * Rows are the source of truth for booking emails. They are created when an
 * appointment is booked, rescheduled or canceled (and backfilled by the worker
 * for appointments that predate this), sent by the `booking-email` queue at
 * their exact time, and picked up by the worker sweep if a job is ever lost.
 * `appointmentId + key + recipient` is unique, so the same email can never be
 * created twice, and the scheduled -> sending claim means it can never be sent
 * twice, however often a job is retried or a worker restarts.
 *
 * key: "confirmation" | "rescheduled" | "canceled" | a reminder step ("3d", "2d",
 * "1d", "30m", "10m" - the time before `startsAt` the reminder goes out).
 */
const appointmentNotificationSchema = new mongoose.Schema(
  {
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment", required: true, index: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    kind: { type: String, enum: NOTIFICATION_KINDS, required: true },
    key: { type: String, required: true },
    recipient: { type: String, enum: NOTIFICATION_RECIPIENTS, required: true },
    /** EmailTemplate trigger used to render this email (fallback wording is built in). */
    triggerType: { type: String, required: true },
    /** Appointment start instant when this row was planned; reminders are stale once it passes. */
    startsAt: { type: Date, default: null },
    scheduledFor: { type: Date, required: true },
    status: { type: String, enum: NOTIFICATION_STATUSES, default: "scheduled" },
    attempts: { type: Number, default: 0 },
    lockedAt: { type: Date, default: null },
    to: { type: String, default: "" },
    subject: { type: String, default: "" },
    messageId: { type: String, default: null },
    /** Why the email failed or was skipped. */
    lastError: { type: String, default: null },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One email per appointment, step and recipient.
appointmentNotificationSchema.index({ appointmentId: 1, key: 1, recipient: 1 }, { unique: true });
// Due-work scan used by the worker sweep.
appointmentNotificationSchema.index({ status: 1, scheduledFor: 1 });
// Delivery log per appointment.
appointmentNotificationSchema.index({ appointmentId: 1, scheduledFor: 1 });

module.exports = mongoose.model("AppointmentNotification", appointmentNotificationSchema);
module.exports.NOTIFICATION_KINDS = NOTIFICATION_KINDS;
module.exports.NOTIFICATION_RECIPIENTS = NOTIFICATION_RECIPIENTS;
module.exports.NOTIFICATION_STATUSES = NOTIFICATION_STATUSES;
