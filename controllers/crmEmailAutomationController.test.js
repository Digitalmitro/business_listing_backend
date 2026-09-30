// backend/controllers/crmEmailAutomationController.test.js
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const controller = require("./crmEmailAutomationController");
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

const user = { _id: new mongoose.Types.ObjectId(), email: "owner@example.com" };

test("catalog lists triggers and whether AI is available, without exposing keys", async () => {
  const res = createMockRes();
  await controller.getCatalog({ user }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.catalog.triggers.length, 7);
  assert.equal(typeof res.body.aiEnabled, "boolean");
  assert.doesNotMatch(JSON.stringify(res.body), /sk-ant|ANTHROPIC|smtpPass|EMAIL_PASS/);
});

test("management endpoints require a businessId", async () => {
  const calls = [
    (res) => controller.listAutomations({ user, query: {} }, res),
    (res) => controller.getLogs({ user, query: {} }, res),
    (res) => controller.saveAutomation({ user, params: { trigger: "new_lead" }, body: {} }, res),
    (res) => controller.setEnabled({ user, params: { trigger: "new_lead" }, body: { isEnabled: true } }, res),
    (res) => controller.preview({ user, body: { trigger: "new_lead" } }, res),
    (res) => controller.generateWithAi({ user, body: { trigger: "new_lead" } }, res),
  ];
  for (const call of calls) {
    const res = createMockRes();
    await call(res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /businessId/);
  }
});

test("unknown triggers and bad toggle values are rejected", async () => {
  let res = createMockRes();
  await controller.saveAutomation({ user, params: { trigger: "birthday" }, body: { businessId: "x" } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Unknown trigger/);

  res = createMockRes();
  await controller.setEnabled({ user, params: { trigger: "new_lead" }, body: { businessId: "x", isEnabled: "yes" } }, res);
  assert.equal(res.statusCode, 400);
});

test("listing views always answer 202 so callers cannot tell who is a lead", async () => {
  for (const body of [{}, { businessId: new mongoose.Types.ObjectId().toString() }]) {
    const res = createMockRes();
    await controller.recordListingView({ user, body }, res);
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.success, true);
  }
});

after(async () => {
  try { await closeQueueConnections(); } catch { /* ignore */ }
});
