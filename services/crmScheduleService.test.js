// backend/services/crmScheduleService.test.js
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const service = require("./crmScheduleService");
const { closeQueueConnections } = require("../utils/queue");

test("createEvent validates required ownerId, title, and startTime before scheduling", async () => {
  await assert.rejects(async () => {
    await service.createEvent(null, { title: "Demo", startTime: new Date().toISOString() });
  }, /ownerId is required/i);

  await assert.rejects(async () => {
    await service.createEvent("owner_sched_1", { title: "", startTime: new Date().toISOString() });
  }, /title and startTime are required/i);

  await assert.rejects(async () => {
    await service.createEvent("owner_sched_1", { title: "Demo", startTime: "invalid-date" });
  }, /Invalid startTime date format/i);
});

test("createEvent defaults eventType to Follow-up and sets 1-hour duration when endTime missing", async () => {
  const now = new Date("2026-07-15T10:00:00.000Z");
  const ev = await service.createEvent("owner_sched_1", {
    title: "Quarterly Check-in",
    startTime: now.toISOString(),
  });

  assert.equal(ev.title, "Quarterly Check-in");
  assert.equal(ev.eventType, "Follow-up");
  assert.equal(new Date(ev.startTime).getTime(), now.getTime());
  assert.equal(new Date(ev.endTime).getTime(), now.getTime() + 60 * 60 * 1000);
  assert.equal(ev.status, "Scheduled");
});

test("getEvents throws error without ownerId and supports date range, eventType, and virtual lead synchronization", async () => {
  await assert.rejects(async () => {
    await service.getEvents(null);
  }, /ownerId is required/i);

  const res = await service.getEvents("owner_sched_sync", {
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-07-31T23:59:59.000Z",
    eventType: "Follow-up,Demo,Meeting",
    includeVirtual: "true",
  });

  assert.equal(res.success, true);
  assert.equal(typeof res.count, "number");
  assert.ok(Array.isArray(res.events));
});

test("updateEvent blocks direct edits to automated virtual lead schedules (`virtual_` prefix)", async () => {
  await assert.rejects(async () => {
    await service.updateEvent("owner_sched_1", "virtual_lead_123", { title: "Hacked Title" });
  }, /Cannot directly edit an automated virtual event/i);
});

test("deleteEvent blocks direct deletion of virtual lead schedules (`virtual_` prefix)", async () => {
  await assert.rejects(async () => {
    await service.deleteEvent("owner_sched_1", "virtual_lead_123");
  }, /Cannot directly delete a virtual lead schedule/i);
});

test("createEvent stores recurrence configuration accurately", async () => {
  const ev = await service.createEvent("owner_sched_1", {
    title: "Weekly Sync",
    startTime: new Date().toISOString(),
    recurrence: { type: "weekly", interval: 1 },
  });
  assert.equal(ev.recurrence.type, "weekly");
  assert.equal(ev.recurrence.interval, 1);
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
