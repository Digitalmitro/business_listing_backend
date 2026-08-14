"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const controller = require("./socialPostingController");
const service = require("../services/socialPostingService");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("publishPost requires an authenticated user and at least one platform", async () => {
  const unauthenticated = response();
  await controller.publishPost({ body: { platforms: ["facebook"] } }, unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);

  const empty = response();
  await controller.publishPost({ user: { _id: "u1" }, body: { platforms: [] } }, empty);
  assert.equal(empty.statusCode, 400);
});

test("publishPost forwards platform options and returns provider outcomes", async (context) => {
  let payload;
  context.mock.method(service, "publishUnifiedPost", async (_user, received) => {
    payload = received;
    return {
      success: true,
      overallStatus: "SUCCESS",
      postHistory: { _id: "history-1" },
      results: [{ platform: "facebook", status: "SUCCESS", externalPostId: "post-1" }],
    };
  });
  const res = response();
  await controller.publishPost({
    user: { _id: "u1", tenantId: "t1" },
    body: {
      caption: "hello",
      platforms: ["facebook"],
      platformOptions: { facebook: { pageId: "page-1" } },
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.platformOptions.facebook.pageId, "page-1");
  assert.equal(res.body.results[0].externalPostId, "post-1");
});

test("getHistory scopes the request through the authenticated user object", async (context) => {
  let receivedUser;
  context.mock.method(service, "getUserPostingHistory", async (user) => {
    receivedUser = user;
    return { history: [], total: 0, page: 1, limit: 10 };
  });
  const user = { _id: "u1", tenantId: "t1" };
  const res = response();
  await controller.getHistory({ user, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(receivedUser, user);
});
