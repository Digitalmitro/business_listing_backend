"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { publishUnifiedPost, getUserPostingHistory } = require("./socialPostingService");
const { encrypt } = require("../utils/cryptoUtils");
const { closeQueueConnections } = require("../utils/queue");

test("publishUnifiedPost validates required inputs before attempting broadcast", async () => {
  await assert.rejects(async () => {
    await publishUnifiedPost(null, { platforms: ["facebook"] });
  }, /User authentication required/i);

  await assert.rejects(async () => {
    await publishUnifiedPost({ _id: "u1" }, { platforms: [] });
  }, /At least one social media platform must be selected/i);

  await assert.rejects(async () => {
    await publishUnifiedPost({ _id: "u1" }, { platforms: ["tiktok"] });
  }, /Unsupported platform/i);

  await assert.rejects(async () => {
    await publishUnifiedPost({ _id: "u1" }, { platforms: ["facebook"], caption: "", media: [] });
  }, /Post must contain either caption text or attached media/i);
});

test("publishUnifiedPost records SUCCESS on all selected platforms when verified", async () => {
  const mockUser = {
    _id: "user_multi_success",
    socialMediaAccounts: {
      facebook: { isConnected: true, status: "connected", accessToken: encrypt("token_fb"), tokenExpiry: new Date(Date.now() + 3600000) },
      linkedin: { isConnected: true, status: "connected", accessToken: encrypt("token_li"), tokenExpiry: new Date(Date.now() + 3600000) },
    },
  };

  const result = await publishUnifiedPost(mockUser, {
    caption: "Exciting company update across FB and LinkedIn!",
    media: [{ type: "image", url: "https://example.com/photo.jpg" }],
    platforms: ["facebook", "linkedin"],
  });

  assert.equal(result.success, true);
  assert.equal(result.overallStatus, "SUCCESS");
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].status, "SUCCESS");
  assert.equal(result.results[1].status, "SUCCESS");
  assert.ok(result.postHistory._id);
  assert.equal(result.postHistory.content, "Exciting company update across FB and LinkedIn!");
});

test("publishUnifiedPost records PARTIAL_SUCCESS when one platform passes and another fails without aborting", async () => {
  const mockUser = {
    _id: "user_partial_resilient",
    socialMediaAccounts: {
      twitter: { isConnected: true, status: "connected", accessToken: encrypt("token_tw"), tokenExpiry: new Date(Date.now() + 3600000) },
      // pinterest is NOT connected / revoked
      pinterest: { isConnected: true, status: "revoked", accessToken: encrypt("token_pin") },
    },
  };

  const result = await publishUnifiedPost(mockUser, {
    caption: "Partial failure resilience test message",
    platforms: ["twitter", "pinterest"],
  });

  assert.equal(result.success, true);
  assert.equal(result.overallStatus, "PARTIAL_SUCCESS");
  assert.equal(result.results.length, 2);
  
  const twRes = result.results.find((r) => r.platform === "twitter");
  assert.equal(twRes.status, "SUCCESS");
  assert.ok(twRes.externalPostId);

  const pinRes = result.results.find((r) => r.platform === "pinterest");
  assert.equal(pinRes.status, "FAILURE");
  assert.match(pinRes.failureReason, /revoked/i);
});

test("publishUnifiedPost records FAILURE when all target platforms fail", async () => {
  const mockUser = {
    _id: "user_all_fail",
    socialMediaAccounts: {},
  };

  const result = await publishUnifiedPost(mockUser, {
    caption: "Will fail on all",
    platforms: ["facebook", "instagram"],
  });

  assert.equal(result.success, false);
  assert.equal(result.overallStatus, "FAILURE");
  assert.equal(result.results[0].status, "FAILURE");
  assert.equal(result.results[1].status, "FAILURE");
});

test("getUserPostingHistory returns paginated history structure", async () => {
  await assert.rejects(async () => {
    await getUserPostingHistory(null);
  }, /User ID is required/i);

  const res = await getUserPostingHistory("user_hist_123", { page: 1, limit: 10 });
  assert.ok(Array.isArray(res.history));
  assert.equal(res.page, 1);
  assert.equal(res.limit, 10);
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
