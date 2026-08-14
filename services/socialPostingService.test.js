"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const socialIntegrationService = require("./socialIntegrationService");
const { publishUnifiedPost, getUserPostingHistory, scheduleUnifiedPost } = require("./socialPostingService");

test("publishUnifiedPost validates authentication, platforms, and content", async () => {
  await assert.rejects(publishUnifiedPost(null, { platforms: ["facebook"] }), /User authentication required/);
  await assert.rejects(publishUnifiedPost({ _id: "u1" }, { platforms: [] }), /At least one social media platform/);
  await assert.rejects(publishUnifiedPost({ _id: "u1" }, { platforms: ["tiktok"], caption: "hello" }), /Unsupported platform/);
  await assert.rejects(publishUnifiedPost({ _id: "u1" }, { platforms: ["facebook"] }), /must contain either caption text or attached media/);
});

test("publishUnifiedPost passes provider selectors and records success", async (context) => {
  const calls = [];
  context.mock.method(socialIntegrationService, "verifyOrPostToPlatform", async (_user, platform, postData) => {
    calls.push({ platform, postData });
    return { postId: `${platform}-post-id` };
  });

  const result = await publishUnifiedPost(
    { _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" },
    {
      caption: "Tenant update",
      media: [{ type: "image", url: "https://cdn.example.com/post.jpg" }],
      platforms: ["facebook", "pinterest", "threads"],
      platformOptions: {
        facebook: { pageId: "page-1" },
        pinterest: { boardId: "board-1" },
      },
    }
  );

  assert.equal(result.overallStatus, "SUCCESS");
  assert.equal(result.results.length, 3);
  assert.equal(calls.find((call) => call.platform === "facebook").postData.pageId, "page-1");
  assert.equal(calls.find((call) => call.platform === "pinterest").postData.boardId, "board-1");
  assert.equal(calls.find((call) => call.platform === "threads").postData.imageUrl, "https://cdn.example.com/post.jpg");
  assert.equal(String(result.postHistory.tenantId), "507f1f77bcf86cd799439012");
});

test("publishUnifiedPost preserves partial provider outcomes", async (context) => {
  context.mock.method(socialIntegrationService, "verifyOrPostToPlatform", async (_user, platform) => {
    if (platform === "pinterest") throw new Error("board permission revoked");
    return { postId: "threads-post-id" };
  });
  const result = await publishUnifiedPost(
    { _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" },
    { caption: "Partial result", platforms: ["threads", "pinterest"] }
  );
  assert.equal(result.overallStatus, "PARTIAL_SUCCESS");
  assert.equal(result.results.find((item) => item.platform === "threads").status, "SUCCESS");
  assert.match(result.results.find((item) => item.platform === "pinterest").failureReason, /revoked/);
});

test("getUserPostingHistory validates identity and returns an offline empty page", async () => {
  await assert.rejects(getUserPostingHistory(null), /User ID is required/);
  const result = await getUserPostingHistory("507f1f77bcf86cd799439011", { page: 2, limit: 5 });
  assert.deepEqual(result.history, []);
  assert.equal(result.page, 2);
  assert.equal(result.limit, 5);
});

test("scheduleUnifiedPost preserves media type and provider-specific selectors", async () => {
  const result = await scheduleUnifiedPost(
    { _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" },
    {
      caption: "Scheduled video",
      media: [{ type: "video", url: "https://cdn.example.com/video.mp4" }],
      platforms: ["threads"],
      platformOptions: { threads: { replyControl: "everyone" } },
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
    }
  );
  assert.equal(result.scheduledPost.media[0].type, "video");
  assert.equal(result.scheduledPost.media[0].url, "https://cdn.example.com/video.mp4");
  assert.equal(result.scheduledPost.platformOptions.threads.replyControl, "everyone");
});
