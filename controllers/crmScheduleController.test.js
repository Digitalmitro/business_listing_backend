// backend/controllers/crmScheduleController.test.js
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const controller = require("./crmScheduleController");
const { closeQueueConnections } = require("../utils/queue");

function createMockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
}

test("getEvents returns 401 when user is not authenticated", async () => {
  const unauthRes = createMockRes();
  await controller.getEvents({}, unauthRes);
  assert.equal(unauthRes.statusCode, 401);
});

test("createEvent returns 401 when user is not authenticated", async () => {
  const unauthRes = createMockRes();
  await controller.createEvent({ body: { title: "Test" } }, unauthRes);
  assert.equal(unauthRes.statusCode, 401);
});

test("getEvents returns 200 with events list when authenticated", async () => {
  const okRes = createMockRes();
  await controller.getEvents({ user: { _id: "user_sched_ctrl_1" }, query: {} }, okRes);
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.body.success, true);
  assert.ok(Array.isArray(okRes.body.events));
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
