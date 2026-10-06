"use strict";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { closeQueueConnections } = require("../utils/queue");
const service = require("./appointmentNotificationService");

after(async () => {
  await closeQueueConnections().catch(() => {});
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const id = () => new mongoose.Types.ObjectId();
const byKey = (rows) => Object.fromEntries(rows.map((r) => [`${r.key}:${r.recipient}`, r]));

function appointmentAt(startsAt, extra = {}) {
  return { _id: id(), businessId: id(), userId: id(), startsAt, timezone: "Asia/Kolkata", status: "Scheduled", ...extra };
}

function withSchedule(value, fn) {
  const before = process.env.APPOINTMENT_REMINDER_SCHEDULE;
  if (value === undefined) delete process.env.APPOINTMENT_REMINDER_SCHEDULE;
  else process.env.APPOINTMENT_REMINDER_SCHEDULE = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.APPOINTMENT_REMINDER_SCHEDULE;
    else process.env.APPOINTMENT_REMINDER_SCHEDULE = before;
  }
}

test("reminderSchedule defaults to 3d,2d,1d,30m,10m and honours the env override", () => {
  withSchedule(undefined, () => {
    assert.deepEqual(service.reminderSchedule().map((s) => s.key), ["3d", "2d", "1d", "30m", "10m"]);
  });
  withSchedule("10m, 1d ,bogus,30m", () => {
    assert.deepEqual(service.reminderSchedule().map((s) => s.key), ["1d", "30m", "10m"]);
  });
  withSchedule("", () => {
    assert.deepEqual(service.reminderSchedule(), []);
  });
});

test("buildPlan: a booking days away gets both confirmations now and every reminder at its exact time", () => {
  const now = new Date("2026-10-06T17:00:00.000Z");
  const startsAt = new Date("2026-10-12T04:30:00.000Z"); // Oct 12, 10:00 AM IST
  const ownerId = id();
  const rows = withSchedule(undefined, () => byKey(service.buildPlan({ appointment: appointmentAt(startsAt), ownerId, now })));
  assert.equal(Object.keys(rows).length, 7);

  for (const recipient of ["customer", "owner"]) {
    const row = rows[`confirmation:${recipient}`];
    assert.equal(row.status, "scheduled");
    assert.equal(row.kind, "confirmation");
    assert.equal(row.scheduledFor.getTime(), now.getTime());
    assert.equal(row.triggerType, recipient === "owner" ? "booking_confirmed_owner" : "booking_confirmed_user");
    assert.equal(String(row.ownerId), String(ownerId));
    assert.equal(row.startsAt.getTime(), startsAt.getTime());
  }
  const expected = {
    "3d": "2026-10-09T04:30:00.000Z",
    "2d": "2026-10-10T04:30:00.000Z",
    "1d": "2026-10-11T04:30:00.000Z",
    "30m": "2026-10-12T04:00:00.000Z",
    "10m": "2026-10-12T04:20:00.000Z",
  };
  for (const [key, at] of Object.entries(expected)) {
    const row = rows[`${key}:customer`];
    assert.equal(row.kind, "reminder");
    assert.equal(row.status, "scheduled", key);
    assert.equal(row.scheduledFor.toISOString(), at, key);
    assert.equal(row.triggerType, `booking_reminder_${key}_user`);
    assert.equal(row.lastError, null);
  }
});

test("buildPlan: tomorrow -> 3-day and 2-day reminders skipped, the rest scheduled", () => {
  const now = new Date("2026-10-06T17:00:00.000Z");
  const startsAt = new Date("2026-10-07T17:30:00.000Z"); // tomorrow 11:00 PM IST
  const rows = withSchedule(undefined, () => byKey(service.buildPlan({ appointment: appointmentAt(startsAt), ownerId: id(), now })));
  assert.equal(rows["3d:customer"].status, "skipped");
  assert.match(rows["3d:customer"].lastError, /already passed/);
  assert.equal(rows["2d:customer"].status, "skipped");
  assert.equal(rows["1d:customer"].status, "scheduled");
  assert.equal(rows["1d:customer"].scheduledFor.toISOString(), "2026-10-06T17:30:00.000Z");
  assert.equal(rows["30m:customer"].scheduledFor.toISOString(), "2026-10-07T17:00:00.000Z");
  assert.equal(rows["10m:customer"].scheduledFor.toISOString(), "2026-10-07T17:20:00.000Z");
});

test("buildPlan: booked shortly before the start keeps only the reminders still ahead", () => {
  const startsAt = new Date("2026-10-06T17:30:00.000Z"); // 11:00 PM IST
  const at20 = withSchedule(undefined, () => byKey(service.buildPlan({ appointment: appointmentAt(startsAt), ownerId: id(), now: new Date(startsAt.getTime() - 20 * MIN) })));
  assert.deepEqual(
    Object.values(at20).filter((r) => r.kind === "reminder").map((r) => `${r.key}:${r.status}`),
    ["3d:skipped", "2d:skipped", "1d:skipped", "30m:skipped", "10m:scheduled"]
  );
  assert.equal(at20["10m:customer"].scheduledFor.toISOString(), "2026-10-06T17:20:00.000Z");

  // Exactly at the 30-minute mark counts as passed.
  const at30 = withSchedule(undefined, () => byKey(service.buildPlan({ appointment: appointmentAt(startsAt), ownerId: id(), now: new Date(startsAt.getTime() - 30 * MIN) })));
  assert.equal(at30["30m:customer"].status, "skipped");
  assert.equal(at30["10m:customer"].status, "scheduled");

  const at5 = withSchedule(undefined, () => byKey(service.buildPlan({ appointment: appointmentAt(startsAt), ownerId: id(), now: new Date(startsAt.getTime() - 5 * MIN) })));
  assert.ok(Object.values(at5).filter((r) => r.kind === "reminder").every((r) => r.status === "skipped"));
  assert.equal(at5["confirmation:customer"].status, "scheduled");
  assert.equal(at5["confirmation:owner"].status, "scheduled");
});

test("buildPlan: owner, confirmation and kind options; start time derived from date + slot when missing", () => {
  const now = new Date("2026-10-06T17:00:00.000Z");
  const startsAt = new Date("2026-10-12T04:30:00.000Z");
  const noOwner = withSchedule(undefined, () => service.buildPlan({ appointment: appointmentAt(startsAt), ownerId: null, now }));
  assert.ok(!noOwner.some((r) => r.recipient === "owner"));

  const late = withSchedule(undefined, () => byKey(service.buildPlan({ appointment: appointmentAt(startsAt), ownerId: id(), now, includeConfirmation: false })));
  assert.equal(late["confirmation:customer"].status, "skipped");
  assert.match(late["confirmation:customer"].lastError, /before appointment notifications were enabled/);
  assert.equal(late["3d:customer"].status, "scheduled");

  const moved = withSchedule(undefined, () => byKey(service.buildPlan({ appointment: appointmentAt(startsAt), ownerId: id(), now, kind: "rescheduled" })));
  assert.equal(moved["rescheduled:customer"].triggerType, "booking_rescheduled_user");
  assert.equal(moved["rescheduled:owner"].triggerType, "booking_rescheduled_owner");
  assert.equal(moved["rescheduled:customer"].kind, "rescheduled");

  // No startsAt stored: derived from the stored date, slot and timezone.
  const derived = withSchedule(undefined, () => byKey(service.buildPlan({
    appointment: appointmentAt(null, { appointmentDate: new Date("2026-10-12T00:00:00.000Z"), timeSlot: "10:00 AM" }),
    ownerId: id(),
    now,
  })));
  assert.equal(derived["3d:customer"].scheduledFor.toISOString(), "2026-10-09T04:30:00.000Z");

  // No date at all: confirmations only.
  const undated = withSchedule(undefined, () => service.buildPlan({ appointment: appointmentAt(null), ownerId: id(), now }));
  assert.deepEqual(undated.map((r) => r.key), ["confirmation", "confirmation"]);
});

test("skipReason: reminders never go out after the start or outside their window; notices follow the appointment state", () => {
  const startsAt = new Date("2026-10-12T04:30:00.000Z");
  const appt = appointmentAt(startsAt);
  const r3d = { kind: "reminder", key: "3d", scheduledFor: new Date(startsAt.getTime() - 3 * DAY), startsAt };
  assert.equal(service.skipReason(r3d, appt, new Date(r3d.scheduledFor.getTime() + 5 * MIN)), null);
  assert.match(service.skipReason(r3d, appt, new Date(r3d.scheduledFor.getTime() + 13 * HOUR)), /window passed/);

  const r10m = { kind: "reminder", key: "10m", scheduledFor: new Date(startsAt.getTime() - 10 * MIN), startsAt };
  assert.equal(service.skipReason(r10m, appt, new Date(startsAt.getTime() - 9 * MIN)), null);
  assert.match(service.skipReason(r10m, appt, startsAt), /already passed/);
  assert.match(service.skipReason(r10m, appt, new Date(startsAt.getTime() + HOUR)), /already passed/);
  assert.match(service.skipReason(r10m, { ...appt, status: "Canceled" }, new Date(startsAt.getTime() - 10 * MIN)), /Canceled/);
  assert.match(service.skipReason(r10m, null, new Date()), /no longer exists/);
  assert.match(service.skipReason({ ...r10m, startsAt: null }, { ...appt, startsAt: null }, new Date()), /no start time/);

  const conf = { kind: "confirmation", key: "confirmation", scheduledFor: new Date(startsAt.getTime() - 5 * DAY), startsAt };
  assert.equal(service.skipReason(conf, appt, conf.scheduledFor), null);
  assert.equal(service.skipReason(conf, appt, new Date(startsAt.getTime() + 2 * HOUR)), null);
  assert.match(service.skipReason(conf, appt, new Date(startsAt.getTime() + 2 * DAY)), /date has passed/);
  assert.match(service.skipReason(conf, { ...appt, status: "Rescheduled" }, conf.scheduledFor), /Rescheduled/);

  const canceled = { kind: "canceled", key: "canceled", scheduledFor: new Date(), startsAt };
  assert.equal(service.skipReason(canceled, { ...appt, status: "Canceled" }, new Date()), null);
  assert.match(service.skipReason(canceled, appt, new Date()), /not canceled/);
});

test("nextRetryAt backs off 5, 10, 20 minutes", () => {
  const now = new Date("2026-10-06T17:00:00.000Z");
  assert.equal(service.nextRetryAt(1, now).toISOString(), "2026-10-06T17:05:00.000Z");
  assert.equal(service.nextRetryAt(2, now).toISOString(), "2026-10-06T17:10:00.000Z");
  assert.equal(service.nextRetryAt(3, now).toISOString(), "2026-10-06T17:20:00.000Z");
});

test("hooks never throw without a database; bad ids are ignored", async () => {
  const appt = appointmentAt(new Date(Date.now() + DAY));
  assert.deepEqual(await service.onAppointmentBooked(appt), { created: [], queued: 0 });
  assert.deepEqual(await service.onAppointmentCanceled(appt), { created: [], queued: 0 });
  assert.deepEqual(await service.onAppointmentRescheduled(appt, appt), { created: [], queued: 0 });
  assert.deepEqual(await service.processNotification("nope"), { status: "ignored" });
  assert.deepEqual(await service.runScheduler(), { skipped: true });
  assert.deepEqual(await service.listForAppointment("nope"), []);
  assert.equal(await service.resolveTimezone({ requested: "Europe/Paris", businessId: id() }), "Europe/Paris");
  assert.equal(await service.resolveTimezone({ requested: "Mars/Olympus", owner: { timeZone: "Asia/Tokyo" } }), "Asia/Tokyo");
});
