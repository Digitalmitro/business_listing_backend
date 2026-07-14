// backend/controllers/crmForecastController.test.js
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const controller = require("./crmForecastController");
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

test("getForecast returns 401 when user is not authenticated", async () => {
  const unauthRes = createMockRes();
  await controller.getForecast({}, unauthRes);
  assert.equal(unauthRes.statusCode, 401);
});

test("getForecast returns 200 with forecast summary and charts structure when authenticated", async () => {
  const okRes = createMockRes();
  await controller.getForecast({ user: { _id: "user_fct_ctrl_1" }, query: {} }, okRes);
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.body.success, true);
  assert.ok(okRes.body.summary);
  assert.ok(okRes.body.charts);
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
