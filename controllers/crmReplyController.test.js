// backend/controllers/crmReplyController.test.js
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const controller = require("./crmReplyController");
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

test("handleInboundWebhook returns 400 when body text or target identifiers are missing", async () => {
  const noBodyRes = createMockRes();
  await controller.handleInboundWebhook({ body: { leadId: "lead_1" } }, noBodyRes);
  assert.equal(noBodyRes.statusCode, 400);

  const noTargetRes = createMockRes();
  await controller.handleInboundWebhook({ body: { text: "Let's talk soon" } }, noTargetRes);
  assert.equal(noTargetRes.statusCode, 400);
});

test("handleInboundWebhook returns 200 on successful webhook classification and status update", async () => {
  const res = createMockRes();
  await controller.handleInboundWebhook(
    { body: { leadId: "lead_ok", subject: "Demo request", body: "I would love to see a demo" } },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.classification, "Positive");
  assert.equal(res.body.newStatus, "Warm Lead");
});

test("handleManualReply returns 401 when unauthenticated, 400 when body is missing, 200 on success", async () => {
  const unauthRes = createMockRes();
  await controller.handleManualReply({ params: { id: "lead_1" }, body: { body: "Stop sending emails" } }, unauthRes);
  assert.equal(unauthRes.statusCode, 401);

  const noBodyRes = createMockRes();
  await controller.handleManualReply(
    { user: { _id: "user_ctrl_1" }, params: { id: "lead_1" }, body: { body: "" } },
    noBodyRes
  );
  assert.equal(noBodyRes.statusCode, 400);

  const successRes = createMockRes();
  await controller.handleManualReply(
    { user: { _id: "user_ctrl_1" }, params: { id: "lead_1" }, body: { body: "Please stop and remove me" } },
    successRes
  );
  assert.equal(successRes.statusCode, 200);
  assert.equal(successRes.body.success, true);
  assert.equal(successRes.body.classification, "Negative");
  assert.equal(successRes.body.newStatus, "Cold Lead");
});

test("getLogs returns 401 when unauthenticated and 200 with logs array when authenticated", async () => {
  const unauthRes = createMockRes();
  await controller.getLogs({}, unauthRes);
  assert.equal(unauthRes.statusCode, 401);

  const okRes = createMockRes();
  await controller.getLogs({ user: { _id: "user_ctrl_2" }, query: { page: 1, limit: 10 } }, okRes);
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.body.success, true);
  assert.ok(Array.isArray(okRes.body.logs));
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
