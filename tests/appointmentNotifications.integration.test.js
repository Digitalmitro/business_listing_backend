"use strict";

/**
 * End-to-end tests for appointment emails (confirmation, reminder series,
 * reschedule and cancellation notices) against a LOCAL MongoDB.
 *
 *   CRM_TEST_MONGO_URI=mongodb://127.0.0.1:27999/uc_appointment_test npm run test:integration
 *
 * The suite refuses to run against anything but localhost: the app's normal
 * MONGO_URI is a shared production cluster. Email delivery is stubbed and
 * recorded; the queue is the NODE_ENV=test stub, so the worker sweep is what
 * sends here (in production the same rows are also sent by delayed queue jobs).
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const URI = process.env.CRM_TEST_MONGO_URI || "";
const LOCAL = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(URI);
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.FRONTEND_URL = "https://front.test";
delete process.env.APPOINTMENT_REMINDER_SCHEDULE;
delete process.env.APPOINTMENT_DEFAULT_TIMEZONE;
delete process.env.APPOINTMENT_CONFIRMATION_BACKFILL_HOURS;

const mongoose = require("mongoose");
const moment = require("moment-timezone");
const User = require("../models/User");
const Business = require("../models/Business");
const Appointment = require("../models/Appointment");
const AppointmentNotification = require("../models/AppointmentNotification");
const EmailTemplate = require("../models/EmailTemplate");
const service = require("../services/appointmentNotificationService");
const timeService = require("../services/appointmentTimeService");
const controller = require("../controllers/appointmentController");
const { closeQueueConnections } = require("../utils/queue");

const skip = !LOCAL && "set CRM_TEST_MONGO_URI to a localhost MongoDB to run";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = "Asia/Kolkata";

const sent = [];
let deliverImpl = null;
let owner;
let customer;
let stranger;
let business;

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; },
  };
}

function reqAs(user, { body = {}, params = {}, isAdmin = false } = {}) {
  return { user, body, params, isAdmin };
}

/** "YYYY-MM-DD" in IST, `daysAhead` days from now. */
function istDate(daysAhead) {
  return moment.tz(new Date(), TZ).add(daysAhead, "day").format("YYYY-MM-DD");
}

async function book(body, user = customer) {
  const res = mockRes();
  await controller.CreateAppointment(reqAs(user, { body: { businessId: String(business._id), serviceName: "Hair Spa", timezone: TZ, ...body } }), res);
  return res;
}

async function rowsFor(appointmentId) {
  return AppointmentNotification.find({ appointmentId }).sort({ scheduledFor: 1, recipient: 1 }).lean();
}

const byKey = (rows) => Object.fromEntries(rows.map((r) => [`${r.key}:${r.recipient}`, r]));
const sweep = (now) => service.runScheduler({ now, catchUpDelayMs: 0 });

/** An appointment document inserted directly, with the plan made at a controlled `now`. */
async function plannedAppointment(startsAt, now, extra = {}) {
  const appointment = await Appointment.create({
    userId: customer._id,
    businessId: business._id,
    serviceName: "Hair Spa",
    appointmentDate: timeService.storedAppointmentDate(moment.tz(startsAt, TZ).format("YYYY-MM-DD")),
    timeSlot: moment.tz(startsAt, TZ).format("hh:mm A"),
    timezone: TZ,
    startsAt,
    status: "Scheduled",
    ...extra,
  });
  await service.planNotifications(appointment, { now });
  return appointment;
}

before(async () => {
  if (skip) return;
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  await service.ensureIndexes();

  // Stub email delivery: record instead of sending.
  service.deliver = async (args) => {
    if (deliverImpl) return deliverImpl(args);
    sent.push(args);
    return { success: true, info: { messageId: `msg-${sent.length}` } };
  };

  owner = await User.create({ full_name: "Owner Person", email: "owner@biz.test", timeZone: TZ });
  customer = await User.create({ full_name: "Bina Customer", email: "bina@example.com", phone: "9990001111", timeZone: TZ });
  stranger = await User.create({ full_name: "Someone Else", email: "else@example.com" });
  const bizId = new mongoose.Types.ObjectId();
  await Business.collection.insertOne({
    _id: bizId,
    businessName: "ABC Salon",
    userId: owner._id,
    isBlocked: false,
    address: { city: "Pune", country: "India", state: "MH", pincode: "411001" },
    location: { type: "Point", coordinates: [73.8, 18.5] },
    category: [],
    contact: { contactDetails: [{ title: "Mr", name: "Owner Person", mobileNumbers: ["9000000000"] }] },
  });
  business = await Business.findById(bizId).lean();
});

beforeEach(async () => {
  sent.length = 0;
  deliverImpl = null;
  // The sweep is global: silence rows left by earlier tests so a sweep at a
  // simulated time only ever sends this test's own emails.
  if (!skip) await AppointmentNotification.updateMany({ status: "scheduled" }, { $set: { status: "skipped", lastError: "test isolation" } });
});

after(async () => {
  if (skip) return;
  await mongoose.disconnect();
  await closeQueueConnections().catch(() => {});
});

test("booking days ahead: both confirmations now, each reminder at its exact time, never twice", { skip }, async () => {
  const date = istDate(5);
  const bookedAt = new Date();
  const res = await book({ appointmentDate: date, timeSlot: "10:00 AM" });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const appointment = res.body.appointment;
  const startsAt = timeService.startInstant(date, "10:00 AM", TZ);
  assert.equal(new Date(appointment.startsAt).getTime(), startsAt.getTime());
  assert.equal(appointment.timezone, TZ);
  assert.equal(new Date(appointment.appointmentDate).toISOString(), `${date}T00:00:00.000Z`);

  const rows = byKey(await rowsFor(appointment._id));
  assert.equal(Object.keys(rows).length, 7);
  assert.equal(rows["confirmation:customer"].status, "scheduled");
  assert.equal(rows["confirmation:owner"].status, "scheduled");
  assert.ok(rows["confirmation:customer"].scheduledFor >= bookedAt);
  for (const [key, offset] of [["3d", 3 * DAY], ["2d", 2 * DAY], ["1d", DAY], ["30m", 30 * MIN], ["10m", 10 * MIN]]) {
    assert.equal(rows[`${key}:customer`].status, "scheduled", key);
    assert.equal(rows[`${key}:customer`].scheduledFor.getTime(), startsAt.getTime() - offset, key);
  }
  const stored = await Appointment.findById(appointment._id).lean();
  assert.ok(stored.notificationsScheduledAt);

  // Confirmations go out now.
  const first = await sweep(new Date());
  assert.equal(first.sent, 2);
  assert.deepEqual(sent.map((m) => m.to).sort(), ["bina@example.com", "owner@biz.test"]);
  const toCustomer = sent.find((m) => m.to === "bina@example.com");
  const toOwner = sent.find((m) => m.to === "owner@biz.test");
  assert.equal(toCustomer.subject, "Booking Confirmed - ABC Salon");
  assert.match(toCustomer.html, /Hair Spa/);
  assert.match(toCustomer.html, new RegExp(timeService.formatInTimezone(startsAt, TZ)));
  assert.match(toCustomer.html, /10:00 AM \(Asia\/Kolkata\)/);
  assert.match(toCustomer.html, /Please be on time/);
  assert.match(toCustomer.html, new RegExp(String(appointment._id)));
  assert.equal(toCustomer.replyTo, "owner@biz.test");
  assert.match(toCustomer.unsubscribeLink, new RegExp(`userId=${customer._id}`));
  assert.equal(toOwner.subject, "New Appointment Booked - Hair Spa");
  assert.match(toOwner.html, /Bina Customer/);
  assert.equal(toOwner.replyTo, undefined);

  // Nothing is sent twice.
  assert.equal((await sweep(new Date())).sent, 0);
  assert.equal(sent.length, 2);

  // Each reminder goes out at its time, with its own wording, and only once.
  const wording = { "3d": "in 3 days", "2d": "in 2 days", "1d": "tomorrow", "30m": "in 30 minutes", "10m": "in 10 minutes" };
  for (const [key, when] of Object.entries(wording)) {
    sent.length = 0;
    const at = new Date(rows[`${key}:customer`].scheduledFor.getTime() + 20 * 1000);
    assert.equal((await sweep(new Date(at.getTime() - MIN))).sent, 0, `${key} is not sent early`);
    const summary = await sweep(at);
    assert.equal(summary.sent, 1, `${key} sent once`);
    assert.equal(sent[0].to, "bina@example.com");
    assert.equal(sent[0].subject, `Reminder: your appointment at ABC Salon is ${when}`);
    assert.match(sent[0].html, new RegExp(`is <strong>${when}</strong>`));
    assert.match(sent[0].html, /Please be on time/);
    assert.equal((await sweep(at)).sent, 0, `${key} not repeated`);
  }
  assert.equal((await sweep(new Date(startsAt.getTime() + MIN))).sent, 0);
  const finalRows = await rowsFor(appointment._id);
  assert.ok(finalRows.every((r) => r.status === "sent"), JSON.stringify(finalRows.map((r) => [r.key, r.status])));
  assert.ok(finalRows.every((r) => r.messageId && r.sentAt && r.to));
});

test("booking for tomorrow from a browser instant lands on the right IST day; past reminder steps are skipped", { skip }, async () => {
  const date = istDate(1);
  // What the old booking page sends: toISOString() of local midnight (18:30Z the day before).
  const browserInstant = moment.tz(date, "YYYY-MM-DD", TZ).toDate().toISOString();
  const bookedAt = new Date();
  const res = await book({ appointmentDate: browserInstant, timeSlot: "10:00 AM" });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const appointment = res.body.appointment;
  assert.equal(new Date(appointment.appointmentDate).toISOString(), `${date}T00:00:00.000Z`);
  const startsAt = timeService.startInstant(date, "10:00 AM", TZ);
  assert.equal(new Date(appointment.startsAt).getTime(), startsAt.getTime());

  const rows = byKey(await rowsFor(appointment._id));
  assert.equal(rows["3d:customer"].status, "skipped");
  assert.equal(rows["2d:customer"].status, "skipped");
  assert.equal(rows["30m:customer"].status, "scheduled");
  assert.equal(rows["10m:customer"].status, "scheduled");
  for (const [key, offset] of [["1d", DAY], ["30m", 30 * MIN], ["10m", 10 * MIN]]) {
    const row = rows[`${key}:customer`];
    assert.equal(row.scheduledFor.getTime(), startsAt.getTime() - offset);
    assert.equal(row.status, row.scheduledFor.getTime() > bookedAt.getTime() ? "scheduled" : "skipped", key);
  }
});

test("a New York booking keeps the browser timezone, including across DST", { skip }, async () => {
  const dst = await book({ appointmentDate: "2027-03-15", timeSlot: "03:00 PM", timezone: "America/New_York" });
  assert.equal(dst.statusCode, 201, JSON.stringify(dst.body));
  assert.equal(dst.body.appointment.timezone, "America/New_York");
  assert.equal(new Date(dst.body.appointment.startsAt).toISOString(), "2027-03-15T19:00:00.000Z"); // EDT
  const winter = await book({ appointmentDate: "2027-01-20", timeSlot: "03:00 PM", timezone: "America/New_York" });
  assert.equal(new Date(winter.body.appointment.startsAt).toISOString(), "2027-01-20T20:00:00.000Z"); // EST
  const rows = byKey(await rowsFor(dst.body.appointment._id));
  assert.equal(rows["3d:customer"].scheduledFor.toISOString(), "2027-03-12T19:00:00.000Z");
  assert.equal(rows["10m:customer"].scheduledFor.toISOString(), "2027-03-15T18:50:00.000Z");
});

test("validation: bad slot, bad date, double booking and unknown business write nothing", { skip }, async () => {
  const countBefore = await Appointment.countDocuments();
  const date = istDate(3);
  assert.equal((await book({ appointmentDate: date, timeSlot: "noon" })).statusCode, 400);
  assert.equal((await book({ appointmentDate: "2026-02-30", timeSlot: "10:00 AM" })).statusCode, 400);
  assert.equal((await book({ appointmentDate: date, timeSlot: "10:00 AM", businessId: String(new mongoose.Types.ObjectId()) })).statusCode, 404);
  assert.equal((await book({ appointmentDate: date, timeSlot: "10:00 AM", businessId: "not-an-id" })).statusCode, 404);
  assert.equal(await Appointment.countDocuments(), countBefore);
  assert.equal((await book({ appointmentDate: date, timeSlot: "11:00 AM" })).statusCode, 201);
  assert.equal((await book({ appointmentDate: date, timeSlot: "11:00 AM" }, stranger)).statusCode, 400);
});

test("booked 20 minutes before the start: only the 10-minute reminder remains and goes out on time", { skip }, async () => {
  const startsAt = new Date(Date.now() + 30 * DAY);
  const bookedAt = new Date(startsAt.getTime() - 20 * MIN);
  const appointment = await plannedAppointment(startsAt, bookedAt);
  const rows = byKey(await rowsFor(appointment._id));
  for (const key of ["3d", "2d", "1d", "30m"]) {
    assert.equal(rows[`${key}:customer`].status, "skipped", key);
    assert.match(rows[`${key}:customer`].lastError, /already passed when the appointment was booked/);
  }
  assert.equal(rows["10m:customer"].status, "scheduled");
  assert.equal(rows["10m:customer"].scheduledFor.getTime(), startsAt.getTime() - 10 * MIN);

  assert.equal((await sweep(bookedAt)).sent, 2); // confirmations
  assert.equal((await sweep(new Date(startsAt.getTime() - 11 * MIN))).sent, 0);
  const summary = await sweep(new Date(startsAt.getTime() - 10 * MIN));
  assert.equal(summary.sent, 1);
  assert.equal(sent[2].subject, "Reminder: your appointment at ABC Salon is in 10 minutes");
  assert.equal((await sweep(startsAt)).sent, 0);
});

test("booked 5 minutes before the start: confirmation only, every reminder skipped", { skip }, async () => {
  const startsAt = new Date(Date.now() + 31 * DAY);
  const bookedAt = new Date(startsAt.getTime() - 5 * MIN);
  const appointment = await plannedAppointment(startsAt, bookedAt);
  const rows = await rowsFor(appointment._id);
  assert.ok(rows.filter((r) => r.kind === "reminder").every((r) => r.status === "skipped"));
  assert.equal((await sweep(bookedAt)).sent, 2);
  assert.equal((await sweep(new Date(startsAt.getTime() + HOUR))).sent, 0);
});

test("a reminder found long after its time is skipped, never sent late", { skip }, async () => {
  const startsAt = new Date(Date.now() + 40 * DAY);
  const bookedAt = new Date(startsAt.getTime() - 10 * DAY);
  const appointment = await plannedAppointment(startsAt, bookedAt);
  await sweep(bookedAt); // confirmations
  sent.length = 0;

  // The worker was down for the whole 3-day window: skipped, with the reason recorded.
  const late = await sweep(new Date(startsAt.getTime() - 3 * DAY + 13 * HOUR));
  assert.equal(late.sent, 0);
  assert.equal(late.skipped, 1);
  const rows = byKey(await rowsFor(appointment._id));
  assert.equal(rows["3d:customer"].status, "skipped");
  assert.match(rows["3d:customer"].lastError, /window passed/);

  // Back within an hour of the 2-day mark: still sent.
  assert.equal((await sweep(new Date(startsAt.getTime() - 2 * DAY + HOUR))).sent, 1);
  assert.match(sent[0].subject, /in 2 days/);

  // Found only after the appointment started: nothing goes out.
  const after = await sweep(new Date(startsAt.getTime() + 5 * MIN));
  assert.equal(after.sent, 0);
  const final = byKey(await rowsFor(appointment._id));
  for (const key of ["1d", "30m", "10m"]) {
    assert.equal(final[`${key}:customer`].status, "skipped", key);
    assert.match(final[`${key}:customer`].lastError, /already passed/);
  }
});

test("delivery failures retry with backoff; a reminder that cannot retry before the start fails permanently", { skip }, async () => {
  const startsAt = new Date(Date.now() + 50 * DAY);
  const bookedAt = new Date(startsAt.getTime() - 20 * MIN);
  const appointment = await plannedAppointment(startsAt, bookedAt);

  let calls = 0;
  deliverImpl = async () => {
    calls++;
    return { success: false, error: new Error("SMTP connection refused") };
  };
  const failed = await sweep(bookedAt);
  assert.equal(failed.retrying, 2);
  const rows = byKey(await rowsFor(appointment._id));
  assert.equal(rows["confirmation:customer"].status, "scheduled");
  assert.equal(rows["confirmation:customer"].attempts, 1);
  assert.equal(rows["confirmation:customer"].lastError, "SMTP connection refused");
  assert.equal(rows["confirmation:customer"].scheduledFor.getTime(), bookedAt.getTime() + 5 * MIN);

  // Not retried before its backoff; then delivered.
  deliverImpl = null;
  assert.equal((await sweep(new Date(bookedAt.getTime() + 4 * MIN))).sent, 0);
  assert.equal((await sweep(new Date(bookedAt.getTime() + 5 * MIN))).sent, 2);
  assert.equal(calls, 2);
  assert.equal((await rowsFor(appointment._id)).find((r) => r.key === "confirmation" && r.recipient === "customer").attempts, 2);

  // The 10-minute reminder keeps failing: one retry fits before the start, the next would not.
  deliverImpl = async () => ({ success: false, error: new Error("mailbox unavailable") });
  await sweep(new Date(startsAt.getTime() - 10 * MIN));
  let reminder = (await rowsFor(appointment._id)).find((r) => r.key === "10m");
  assert.equal(reminder.status, "scheduled");
  assert.equal(reminder.scheduledFor.getTime(), startsAt.getTime() - 5 * MIN);
  await sweep(new Date(startsAt.getTime() - 5 * MIN));
  reminder = (await rowsFor(appointment._id)).find((r) => r.key === "10m");
  assert.equal(reminder.status, "failed");
  assert.equal(reminder.attempts, 2);
  assert.match(reminder.lastError, /no retry: the appointment starts before the next attempt/);
});

test("duplicate prevention: re-planning adds nothing, concurrent sends deliver once, stale sends are not repeated", { skip }, async () => {
  const startsAt = new Date(Date.now() + 60 * DAY);
  const bookedAt = new Date(startsAt.getTime() - 5 * DAY);
  const appointment = await plannedAppointment(startsAt, bookedAt);
  const before = await rowsFor(appointment._id);
  await service.planNotifications(appointment, { now: bookedAt });
  await service.onAppointmentBooked(appointment, { now: bookedAt });
  assert.equal((await rowsFor(appointment._id)).length, before.length);

  const confirmation = before.find((r) => r.key === "confirmation" && r.recipient === "customer");
  const results = await Promise.all([
    service.processNotification(confirmation._id, { now: bookedAt }),
    service.processNotification(confirmation._id, { now: bookedAt }),
    service.processNotification(confirmation._id, { now: bookedAt }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["not_due", "not_due", "sent"]);
  assert.equal(sent.length, 1);

  // A send interrupted mid-flight is failed, not retried (it may already have gone out).
  const reminder = before.find((r) => r.key === "3d");
  await AppointmentNotification.updateOne({ _id: reminder._id }, { $set: { status: "sending", lockedAt: new Date(Date.now() - 20 * MIN) } });
  assert.equal(await service.recoverStaleSending(new Date()), 1);
  const recovered = await AppointmentNotification.findById(reminder._id).lean();
  assert.equal(recovered.status, "failed");
  assert.match(recovered.lastError, /not retried to avoid a duplicate/);
});

test("cancel stops the reminders and notifies both parties", { skip }, async () => {
  const date = istDate(6);
  const res = await book({ appointmentDate: date, timeSlot: "02:00 PM" });
  assert.equal(res.statusCode, 201);
  const appointmentId = res.body.appointment._id;
  await sweep(new Date());
  sent.length = 0;

  const cancel = mockRes();
  await controller.CancelAppointment(reqAs(customer, { params: { appointmentId } }), cancel);
  assert.equal(cancel.statusCode, 200, JSON.stringify(cancel.body));
  const rows = byKey(await rowsFor(appointmentId));
  for (const key of ["3d", "2d", "1d", "30m", "10m"]) {
    assert.equal(rows[`${key}:customer`].status, "skipped", key);
    assert.equal(rows[`${key}:customer`].lastError, "Appointment was canceled");
  }
  assert.equal(rows["canceled:customer"].status, "scheduled");
  assert.equal(rows["canceled:owner"].status, "scheduled");

  assert.equal((await sweep(new Date())).sent, 2);
  assert.deepEqual(sent.map((m) => m.subject).sort(), ["Appointment Canceled - Bina Customer", "Booking Canceled - ABC Salon"]);
  const startsAt = timeService.startInstant(date, "02:00 PM", TZ);
  assert.equal((await sweep(new Date(startsAt.getTime() - 3 * DAY + MIN))).sent, 2 - 2);
});

test("reschedule stops the old reminders, confirms the new slot and plans its reminders", { skip }, async () => {
  const date = istDate(7);
  const res = await book({ appointmentDate: date, timeSlot: "03:00 PM" });
  assert.equal(res.statusCode, 201);
  const oldId = res.body.appointment._id;
  await sweep(new Date());
  sent.length = 0;

  const newDate = istDate(9);
  const move = mockRes();
  await controller.RescheduleAppointment(reqAs(customer, { params: { appointmentId: oldId }, body: { appointmentDate: newDate, timeSlot: "04:00 PM", timezone: TZ } }), move);
  assert.equal(move.statusCode, 200, JSON.stringify(move.body));
  const newAppointment = move.body.newAppointment;
  const newStart = timeService.startInstant(newDate, "04:00 PM", TZ);
  assert.equal(new Date(newAppointment.startsAt).getTime(), newStart.getTime());
  assert.equal(String(newAppointment.rescheduledFrom), String(oldId));
  assert.equal((await Appointment.findById(oldId).lean()).status, "Rescheduled");

  const oldRows = await rowsFor(oldId);
  assert.ok(oldRows.filter((r) => r.kind === "reminder").every((r) => r.status === "skipped" && r.lastError === "Appointment was rescheduled"));
  const rows = byKey(await rowsFor(newAppointment._id));
  assert.equal(rows["rescheduled:customer"].triggerType, "booking_rescheduled_user");
  assert.equal(rows["rescheduled:owner"].triggerType, "booking_rescheduled_owner");
  assert.equal(rows["3d:customer"].scheduledFor.getTime(), newStart.getTime() - 3 * DAY);
  assert.equal(rows["10m:customer"].scheduledFor.getTime(), newStart.getTime() - 10 * MIN);

  assert.equal((await sweep(new Date())).sent, 2);
  const toCustomer = sent.find((m) => m.to === "bina@example.com");
  assert.equal(toCustomer.subject, "Booking Rescheduled - ABC Salon");
  assert.match(toCustomer.html, new RegExp(`${timeService.formatInTimezone(timeService.startInstant(date, "03:00 PM", TZ), TZ)} at 03:00 PM`));
  assert.match(toCustomer.html, /04:00 PM \(Asia\/Kolkata\)/);
  assert.equal((await sweep(new Date(newStart.getTime() - 3 * DAY + 10 * 1000))).sent, 1);
  assert.match(sent[2].subject, /in 3 days/);
});

test("backfill: appointments booked before this shipped get a start time, reminders and (if recent) a confirmation", { skip }, async () => {
  const recentDate = istDate(2);
  const oldDate = istDate(4);
  const legacy = (date, createdAt, slot = "11:00 PM") => ({
    userId: customer._id,
    businessId: business._id,
    serviceName: "General Appointment",
    appointmentDate: timeService.storedAppointmentDate(date),
    timeSlot: slot,
    status: "Scheduled",
    createdAt,
    updatedAt: createdAt,
  });
  const now = new Date();
  const { insertedIds } = await Appointment.collection.insertMany([
    legacy(recentDate, new Date(now.getTime() - HOUR)),
    legacy(oldDate, new Date(now.getTime() - 3 * DAY)),
    // Today at midnight IST: within the backfill window but already in the past.
    legacy(istDate(0), new Date(now.getTime() - 2 * DAY), "12:00 AM"),
  ]);
  const [recentId, oldId, pastId] = [insertedIds[0], insertedIds[1], insertedIds[2]];

  const summary = await sweep(now);
  assert.equal(summary.backfill.planned, 2);
  assert.equal(summary.backfill.past, 1);

  const recent = await Appointment.findById(recentId).lean();
  assert.equal(recent.timezone, TZ);
  assert.equal(recent.startsAt.getTime(), timeService.startInstant(recentDate, "11:00 PM", TZ).getTime());
  const recentRows = byKey(await rowsFor(recentId));
  assert.equal(recentRows["confirmation:customer"].status, "sent");
  assert.equal(recentRows["confirmation:owner"].status, "sent");
  assert.equal(recentRows["1d:customer"].scheduledFor.getTime(), recent.startsAt.getTime() - DAY);
  assert.equal(recentRows["10m:customer"].status, "scheduled");

  const oldRows = byKey(await rowsFor(oldId));
  assert.equal(oldRows["confirmation:customer"].status, "skipped");
  assert.match(oldRows["confirmation:customer"].lastError, /before appointment notifications were enabled/);
  assert.equal(oldRows["3d:customer"].status, "scheduled");

  const past = await Appointment.findById(pastId).lean();
  assert.ok(past.notificationsScheduledAt);
  assert.ok(past.startsAt < now);
  assert.equal((await rowsFor(pastId)).length, 0);

  assert.equal(sent.length, 2);
  assert.equal((await sweep(now)).sent, 0);
  assert.equal((await sweep(now)).backfill.planned, 0);
});

test("a template in the database overrides the built-in wording", { skip }, async () => {
  await EmailTemplate.create({
    name: "Custom 10 minute reminder",
    triggerType: "booking_reminder_10m_user",
    subject: "Custom {{business_name}} ping",
    body: "<p>{{recipient_name}}: {{reminder_when}} at {{appointment_time}}, call {{business_phone}}</p>",
    createdBy: owner._id,
  });
  try {
    const startsAt = new Date(Date.now() + 70 * DAY);
    const appointment = await plannedAppointment(startsAt, new Date(startsAt.getTime() - 20 * MIN));
    await sweep(new Date(startsAt.getTime() - 10 * MIN));
    const reminder = sent.find((m) => m.subject === "Custom ABC Salon ping");
    assert.ok(reminder, JSON.stringify(sent.map((m) => m.subject)));
    assert.equal(reminder.html, `<p>Bina Customer: in 10 minutes at ${moment.tz(startsAt, TZ).format("hh:mm A")}, call 9000000000</p>`);
    assert.equal((await rowsFor(appointment._id)).find((r) => r.key === "10m").subject, "Custom ABC Salon ping");
  } finally {
    await EmailTemplate.deleteMany({ triggerType: "booking_reminder_10m_user" });
  }
});

test("the delivery log is visible to the customer, the owner and admins only", { skip }, async () => {
  const res = await book({ appointmentDate: istDate(8), timeSlot: "05:00 PM" });
  const appointmentId = res.body.appointment._id;
  const call = async (user, isAdmin = false, id = appointmentId) => {
    const out = mockRes();
    await controller.getAppointmentNotifications(reqAs(user, { params: { appointmentId: id }, isAdmin }), out);
    return out;
  };
  const mine = await call(customer);
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.body.notifications.length, 7);
  assert.equal(mine.body.appointment.timezone, TZ);
  assert.equal((await call(owner)).statusCode, 200);
  assert.equal((await call(stranger)).statusCode, 403);
  assert.equal((await call(stranger, true)).statusCode, 200);
  assert.equal((await call(customer, false, "nope")).statusCode, 404);
  assert.equal((await call(customer, false, String(new mongoose.Types.ObjectId()))).statusCode, 404);
});
