"use strict";

/**
 * Appointment date/time handling.
 *
 * An appointment is a calendar date plus a wall-clock time slot ("11:00 AM") in
 * a timezone. `startsAt` is the exact instant that pair means, and it is what
 * reminders are measured from ("30 minutes before" is `startsAt - 30 min`,
 * whatever the server's own timezone is).
 *
 * `Appointment.appointmentDate` is stored as midnight UTC of the calendar date:
 * a stable, timezone-free day marker that the slot-conflict check compares
 * exactly and that every existing record already uses.
 */

const moment = require("moment-timezone");

const FALLBACK_TIMEZONE = "Asia/Kolkata";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SLOT = /^\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*$/i;

function isValidTimezone(tz) {
  return typeof tz === "string" && tz.trim() !== "" && Boolean(moment.tz.zone(tz.trim()));
}

/** APPOINTMENT_DEFAULT_TIMEZONE when it is a valid IANA zone, else Asia/Kolkata. */
function defaultTimezone() {
  const configured = process.env.APPOINTMENT_DEFAULT_TIMEZONE;
  return isValidTimezone(configured) ? configured.trim() : FALLBACK_TIMEZONE;
}

/** The first valid IANA zone among the candidates, else the default. */
function pickTimezone(...candidates) {
  for (const candidate of candidates) {
    if (isValidTimezone(candidate)) return candidate.trim();
  }
  return defaultTimezone();
}

/** "11:00 AM", "11:00AM", "11 am", "23:00" -> { hours, minutes } in 24h, or null. */
function parseTimeSlot(slot) {
  if (slot === null || slot === undefined) return null;
  const match = TIME_SLOT.exec(String(slot));
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const period = (match[3] || "").replace(/\./g, "").toUpperCase();
  if (minutes > 59) return null;
  if (period) {
    if (hours < 1 || hours > 12) return null;
    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;
  } else if (hours > 23) {
    return null;
  }
  return { hours, minutes };
}

/**
 * The calendar date ("YYYY-MM-DD") an appointment-date input means, in `timezone`.
 *
 * - "2026-10-07"                        -> that date (what the booking page sends)
 * - an instant at exactly midnight UTC  -> that UTC date (how dates are stored, and
 *                                          how a date-only string parses on a UTC server)
 * - any other instant (a browser's toISOString() of a picked day, or "now")
 *                                       -> the date that instant falls on in `timezone`
 */
function calendarDate(input, timezone) {
  if (input === null || input === undefined || input === "") return null;
  const tz = pickTimezone(timezone);
  if (typeof input === "string" && DATE_ONLY.test(input.trim())) {
    const day = moment.tz(input.trim(), "YYYY-MM-DD", true, tz);
    return day.isValid() ? day.format("YYYY-MM-DD") : null;
  }
  const instant = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(instant.getTime())) return null;
  const utc = moment.utc(instant);
  if (utc.hours() === 0 && utc.minutes() === 0 && utc.seconds() === 0 && utc.milliseconds() === 0) {
    return utc.format("YYYY-MM-DD");
  }
  return moment.tz(instant, tz).format("YYYY-MM-DD");
}

/** The value stored in Appointment.appointmentDate for a calendar date: midnight UTC. */
function storedAppointmentDate(dateString) {
  const day = moment.utc(dateString, "YYYY-MM-DD", true);
  return day.isValid() ? day.toDate() : null;
}

/**
 * Exact start instant of `dateString` + `timeSlot` in `timezone`. Null when the
 * date is invalid; the start of that day when the slot is missing or unparsable.
 */
function startInstant(dateString, timeSlot, timezone) {
  if (!dateString) return null;
  const tz = pickTimezone(timezone);
  const day = moment.tz(dateString, "YYYY-MM-DD", true, tz);
  if (!day.isValid()) return null;
  const time = parseTimeSlot(timeSlot);
  if (!time) return day.toDate();
  return day.hour(time.hours).minute(time.minutes).second(0).millisecond(0).toDate();
}

/** Start instant of a stored appointment from its date, slot and timezone. */
function appointmentStartsAt(appointment, timezone) {
  const tz = pickTimezone(appointment?.timezone, timezone);
  return startInstant(calendarDate(appointment?.appointmentDate, tz), appointment?.timeSlot, tz);
}

function formatInTimezone(instant, timezone, format = "dddd, MMMM Do YYYY") {
  if (!instant) return "";
  const m = moment.tz(instant, pickTimezone(timezone));
  return m.isValid() ? m.format(format) : "";
}

module.exports = {
  FALLBACK_TIMEZONE,
  isValidTimezone,
  defaultTimezone,
  pickTimezone,
  parseTimeSlot,
  calendarDate,
  storedAppointmentDate,
  startInstant,
  appointmentStartsAt,
  formatInTimezone,
};
