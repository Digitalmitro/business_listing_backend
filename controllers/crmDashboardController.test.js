// backend/controllers/crmDashboardController.test.js
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const crmDashboardController = require("./crmDashboardController");
const { closeQueueConnections } = require("../utils/queue");

test("crmDashboardController returns 200 and dashboard summary when authenticated", async () => {
  const req = { user: { _id: "user_test_456" } };
  let statusCalledWith = null;
  let jsonCalledWith = null;

  const res = {
    status(code) {
      statusCalledWith = code;
      return this;
    },
    json(data) {
      jsonCalledWith = data;
    },
  };

  await crmDashboardController.getDashboardSummary(req, res);
  assert.equal(statusCalledWith, 200);
  assert.ok(jsonCalledWith);
  assert.equal(jsonCalledWith.success, true);
  assert.ok(jsonCalledWith.connectedSocialAccounts);
  assert.ok(jsonCalledWith.revenueSummary);
});

test("crmDashboardController returns 401 if req.user is missing", async () => {
  const req = {};
  let statusCalledWith = null;

  const res = {
    status(code) {
      statusCalledWith = code;
      return this;
    },
    json() {},
  };

  await crmDashboardController.getDashboardSummary(req, res);
  assert.equal(statusCalledWith, 401);
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
