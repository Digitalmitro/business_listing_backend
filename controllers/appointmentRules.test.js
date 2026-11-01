"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { isWithinBusinessHours } = require("./appointmentController");
const { closeQueueConnections } = require("../utils/queue");

const weekdays = {
  isOpen24Hours: false,
  daysOfWeek: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  schedule: Object.fromEntries(["Mon", "Tue", "Wed", "Thu", "Fri"].map((d) => [d, [{ openAt: "09:00", closeAt: "21:00" }]])),
};

test("slots inside opening hours are accepted, outside are refused", () => {
  // 2026-11-02 is a Monday
  assert.equal(isWithinBusinessHours(weekdays, "2026-11-02", "09:00 AM"), true);
  assert.equal(isWithinBusinessHours(weekdays, "2026-11-02", "08:30 PM"), true);
  assert.equal(isWithinBusinessHours(weekdays, "2026-11-02", "09:00 PM"), false, "closing time itself is closed");
  assert.equal(isWithinBusinessHours(weekdays, "2026-11-02", "07:00 AM"), false);
  assert.equal(isWithinBusinessHours(weekdays, "2026-11-01", "10:00 AM"), false, "Sunday is not an open day");
});

test("overnight hours, 24-hour businesses, and businesses without hours", () => {
  const night = { daysOfWeek: ["Sat"], schedule: { Sat: [{ openAt: "18:00", closeAt: "02:00" }] } };
  assert.equal(isWithinBusinessHours(night, "2026-11-07", "11:00 PM"), true);
  assert.equal(isWithinBusinessHours(night, "2026-11-07", "01:00 AM"), true);
  assert.equal(isWithinBusinessHours(night, "2026-11-07", "03:00 PM"), false);
  assert.equal(isWithinBusinessHours({ isOpen24Hours: true }, "2026-11-07", "03:00 AM"), true);
  assert.equal(isWithinBusinessHours({ daysOfWeek: [], schedule: {} }, "2026-11-07", "03:00 AM"), true);
  assert.equal(isWithinBusinessHours({ daysOfWeek: ["Mon"], schedule: {} }, "2026-11-02", "10:00 AM"), false, "day without times is closed");
  const map = { daysOfWeek: ["Mon"], schedule: new Map([["Mon", [{ openAt: "10:00", closeAt: "12:00" }]]]) };
  assert.equal(isWithinBusinessHours(map, "2026-11-02", "11:00 AM"), true);
});

after(async () => {
  try { await closeQueueConnections(); } catch (e) {}
});
