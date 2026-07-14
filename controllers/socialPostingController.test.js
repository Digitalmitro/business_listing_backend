"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const controller = require("./socialPostingController");
const { encrypt } = require("../utils/cryptoUtils");
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

test("publishPost returns 401 when user is not authenticated", async () => {
  const req = { body: { caption: "hi", platforms: ["facebook"] } };
  const res = createMockRes();
  await controller.publishPost(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
});

test("publishPost returns 400 when platforms array is missing or empty", async () => {
  const req = { user: { _id: "u1" }, body: { caption: "hi", platforms: [] } };
  const res = createMockRes();
  await controller.publishPost(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test("publishPost executes unified publication across platforms and returns 200", async () => {
  const req = {
    user: {
      _id: "u_ctrl_pub",
      socialMediaAccounts: {
        facebook: {
          isConnected: true,
          status: "connected",
          accessToken: encrypt("ctrl_fb"),
          tokenExpiry: new Date(Date.now() + 3600000),
        },
      },
    },
    body: {
      caption: "Controller unified post test",
      platforms: ["facebook"],
      media: [{ type: "image", url: "https://example.com/ctrl.png" }],
    },
  };
  const res = createMockRes();
  await controller.publishPost(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.overallStatus, "SUCCESS");
  assert.equal(res.body.results[0].platform, "facebook");
  assert.equal(res.body.results[0].status, "SUCCESS");
  assert.ok(res.body.postHistory._id);
});

test("getHistory returns 200 with paginated structure for authenticated user", async () => {
  const req = { user: { _id: "u_ctrl_hist" }, query: { page: 1, limit: 15 } };
  const res = createMockRes();
  await controller.getHistory(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.history));
  assert.equal(res.body.page, 1);
  assert.equal(res.body.limit, 15);
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
