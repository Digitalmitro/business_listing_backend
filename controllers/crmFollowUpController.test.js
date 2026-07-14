// backend/controllers/crmFollowUpController.test.js
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const controller = require("./crmFollowUpController");
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

test("crmFollowUpController endpoints return 401 when unauthenticated", async () => {
  const endpoints = [
    (res) => controller.getConfig({}, res),
    (res) => controller.updateConfig({}, res),
    (res) => controller.getLogs({}, res),
    (res) => controller.processFollowUps({}, res),
    (res) => controller.retryFailed({}, res),
    (res) => controller.triggerForLead({ params: { id: "lead_1" } }, res),
  ];

  for (const fn of endpoints) {
    const res = createMockRes();
    await fn(res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
  }
});

test("getConfig and updateConfig return 200 with config structure", async () => {
  const getRes = createMockRes();
  await controller.getConfig({ user: { _id: "user_ctrl_1" } }, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.success, true);
  assert.equal(getRes.body.config.defaultIntervalDays, 3);

  const putRes = createMockRes();
  await controller.updateConfig(
    { user: { _id: "user_ctrl_1" }, body: { defaultIntervalDays: 4, maxAttempts: 5 } },
    putRes
  );
  assert.equal(putRes.statusCode, 200);
  assert.equal(putRes.body.success, true);
  assert.equal(putRes.body.config.defaultIntervalDays, 4);
});

test("getLogs returns 200 with logs array and pagination", async () => {
  const res = createMockRes();
  await controller.getLogs({ user: { _id: "user_ctrl_2" }, query: { page: 1, limit: 10 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.logs));
});

test("processFollowUps and retryFailed return 200 with scan summary", async () => {
  const processRes = createMockRes();
  await controller.processFollowUps({ user: { _id: "user_ctrl_3" }, body: { dryRun: true } }, processRes);
  assert.equal(processRes.statusCode, 200);
  assert.equal(processRes.body.success, true);
  assert.ok(processRes.body.summary);

  const retryRes = createMockRes();
  await controller.retryFailed({ user: { _id: "user_ctrl_3" } }, retryRes);
  assert.equal(retryRes.statusCode, 200);
  assert.equal(retryRes.body.success, true);
  assert.ok(retryRes.body.summary);
});

test("triggerForLead returns 200 when triggered or skipped, 404 for missing lead", async () => {
  const okRes = createMockRes();
  await controller.triggerForLead({ user: { _id: "user_ctrl_4" }, params: { id: "lead_ok" } }, okRes);
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.body.success, true);

  const missingRes = createMockRes();
  await controller.triggerForLead({ user: { _id: "user_ctrl_4" }, params: { id: "lead_missing" } }, missingRes);
  assert.equal(missingRes.statusCode, 404);
  assert.equal(missingRes.body.success, false);
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
