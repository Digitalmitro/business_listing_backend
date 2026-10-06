"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const t = require("./appointmentTimeService");

test("parseTimeSlot reads 12h and 24h slots", () => {
  assert.deepEqual(t.parseTimeSlot("11:00 AM"), { hours: 11, minutes: 0 });
  assert.deepEqual(t.parseTimeSlot("11:00 PM"), { hours: 23, minutes: 0 });
  assert.deepEqual(t.parseTimeSlot("12:00 AM"), { hours: 0, minutes: 0 });
  assert.deepEqual(t.parseTimeSlot("12:30 PM"), { hours: 12, minutes: 30 });
  assert.deepEqual(t.parseTimeSlot("09:15pm"), { hours: 21, minutes: 15 });
  assert.deepEqual(t.parseTimeSlot("23:45"), { hours: 23, minutes: 45 });
  assert.deepEqual(t.parseTimeSlot("7 am"), { hours: 7, minutes: 0 });
  assert.equal(t.parseTimeSlot("13:00 PM"), null);
  assert.equal(t.parseTimeSlot("25:00"), null);
  assert.equal(t.parseTimeSlot("11:60 AM"), null);
  assert.equal(t.parseTimeSlot("noon"), null);
  assert.equal(t.parseTimeSlot(""), null);
  assert.equal(t.parseTimeSlot(null), null);
});

test("calendarDate: date-only strings, stored midnight-UTC dates and browser instants", () => {
  assert.equal(t.calendarDate("2026-10-07", "Asia/Kolkata"), "2026-10-07");
  assert.equal(t.calendarDate("2026-02-30", "Asia/Kolkata"), null);
  // Stored value / date-only string parsed on a UTC server: keep the UTC date.
  assert.equal(t.calendarDate(new Date("2026-10-06T00:00:00.000Z"), "Asia/Kolkata"), "2026-10-06");
  assert.equal(t.calendarDate("2026-10-06T00:00:00.000Z", "America/New_York"), "2026-10-06");
  // A browser in IST picking Oct 7 sends local midnight = Oct 6 18:30Z: that is Oct 7 in IST.
  assert.equal(t.calendarDate("2026-10-06T18:30:00.000Z", "Asia/Kolkata"), "2026-10-07");
  // "Now" late in the evening IST is still the same IST day.
  assert.equal(t.calendarDate("2026-10-06T16:36:46.147Z", "Asia/Kolkata"), "2026-10-06");
  // A New York browser picking Oct 7 sends Oct 7 04:00Z (EDT): Oct 7 in New York.
  assert.equal(t.calendarDate("2026-10-07T04:00:00.000Z", "America/New_York"), "2026-10-07");
  assert.equal(t.calendarDate("not a date", "Asia/Kolkata"), null);
  assert.equal(t.calendarDate(null, "Asia/Kolkata"), null);
});

test("storedAppointmentDate is midnight UTC of the calendar date", () => {
  assert.equal(t.storedAppointmentDate("2026-10-07").toISOString(), "2026-10-07T00:00:00.000Z");
  assert.equal(t.storedAppointmentDate("2026-13-01"), null);
});

test("startInstant combines date and slot in the given timezone", () => {
  assert.equal(t.startInstant("2026-10-06", "11:00 PM", "Asia/Kolkata").toISOString(), "2026-10-06T17:30:00.000Z");
  assert.equal(t.startInstant("2026-10-06", "11:00 AM", "Asia/Kolkata").toISOString(), "2026-10-06T05:30:00.000Z");
  // Day boundary: 11:30 PM IST on Dec 31 is Dec 31 18:00Z; 12:30 AM IST on Jan 1 is Dec 31 19:00Z.
  assert.equal(t.startInstant("2026-12-31", "11:30 PM", "Asia/Kolkata").toISOString(), "2026-12-31T18:00:00.000Z");
  assert.equal(t.startInstant("2027-01-01", "12:30 AM", "Asia/Kolkata").toISOString(), "2026-12-31T19:00:00.000Z");
  // DST: New York is EDT (UTC-4) in October and EST (UTC-5) in January.
  assert.equal(t.startInstant("2026-10-06", "03:00 PM", "America/New_York").toISOString(), "2026-10-06T19:00:00.000Z");
  assert.equal(t.startInstant("2026-01-15", "03:00 PM", "America/New_York").toISOString(), "2026-01-15T20:00:00.000Z");
  // Missing slot: the start of that day in the timezone.
  assert.equal(t.startInstant("2026-10-06", "", "Asia/Kolkata").toISOString(), "2026-10-05T18:30:00.000Z");
  assert.equal(t.startInstant(null, "11:00 AM", "Asia/Kolkata"), null);
  assert.equal(t.startInstant("2026-02-30", "11:00 AM", "Asia/Kolkata"), null);
});

test("appointmentStartsAt handles stored records with and without a timezone", () => {
  // A record exactly as production stores it today: midnight-UTC date, 12h slot, no timezone.
  const legacy = { appointmentDate: new Date("2026-10-06T00:00:00.000Z"), timeSlot: "11:00 AM" };
  assert.equal(t.appointmentStartsAt(legacy, "Asia/Kolkata").toISOString(), "2026-10-06T05:30:00.000Z");
  // The record's own timezone wins over the fallback.
  assert.equal(t.appointmentStartsAt({ ...legacy, timezone: "America/New_York" }, "Asia/Kolkata").toISOString(), "2026-10-06T15:00:00.000Z");
  // A record written by a server running in IST (local midnight = 18:30Z the day before).
  const istServer = { appointmentDate: new Date("2026-01-14T18:30:00.000Z"), timeSlot: "02:30 PM" };
  assert.equal(t.appointmentStartsAt(istServer, "Asia/Kolkata").toISOString(), "2026-01-15T09:00:00.000Z");
  assert.equal(t.appointmentStartsAt({}, "Asia/Kolkata"), null);
});

test("pickTimezone skips invalid zones and honours APPOINTMENT_DEFAULT_TIMEZONE", () => {
  assert.equal(t.pickTimezone("Nowhere/Land", "", null, "Europe/Berlin"), "Europe/Berlin");
  assert.equal(t.pickTimezone(" Asia/Kolkata "), "Asia/Kolkata");
  const before = process.env.APPOINTMENT_DEFAULT_TIMEZONE;
  process.env.APPOINTMENT_DEFAULT_TIMEZONE = "Europe/London";
  try {
    assert.equal(t.pickTimezone(undefined, "bad"), "Europe/London");
    process.env.APPOINTMENT_DEFAULT_TIMEZONE = "Not/AZone";
    assert.equal(t.pickTimezone(), t.FALLBACK_TIMEZONE);
  } finally {
    if (before === undefined) delete process.env.APPOINTMENT_DEFAULT_TIMEZONE;
    else process.env.APPOINTMENT_DEFAULT_TIMEZONE = before;
  }
});

test("formatInTimezone renders the appointment in its own timezone", () => {
  assert.equal(t.formatInTimezone(new Date("2026-10-06T17:30:00.000Z"), "Asia/Kolkata"), "Tuesday, October 6th 2026");
  assert.equal(t.formatInTimezone(new Date("2026-10-06T17:30:00.000Z"), "Asia/Kolkata", "hh:mm A"), "11:00 PM");
  assert.equal(t.formatInTimezone(new Date("2026-10-06T17:30:00.000Z"), "America/New_York"), "Tuesday, October 6th 2026");
  assert.equal(t.formatInTimezone(null, "Asia/Kolkata"), "");
});
