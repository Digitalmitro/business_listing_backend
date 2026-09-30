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
      platforms: ["facebook", "threads"],
      platformOptions: {
        facebook: { pageId: "page-1" },
      },
    }
  );

  assert.equal(result.overallStatus, "SUCCESS");
  assert.equal(result.results.length, 2);
  assert.equal(calls.find((call) => call.platform === "facebook").postData.pageId, "page-1");
  assert.equal(calls.find((call) => call.platform === "threads").postData.imageUrl, "https://cdn.example.com/post.jpg");
  assert.equal(String(result.postHistory.tenantId), "507f1f77bcf86cd799439012");
});

test("publishUnifiedPost preserves partial provider outcomes", async (context) => {
  context.mock.method(socialIntegrationService, "verifyOrPostToPlatform", async (_user, platform) => {
    if (platform === "linkedin") throw new Error("permission revoked");
    return { postId: "threads-post-id" };
  });
  const result = await publishUnifiedPost(
    { _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" },
    { caption: "Partial result", platforms: ["threads", "linkedin"] }
  );
  assert.equal(result.overallStatus, "PARTIAL_SUCCESS");
  assert.equal(result.results.find((item) => item.platform === "threads").status, "SUCCESS");
  assert.match(result.results.find((item) => item.platform === "linkedin").failureReason, /revoked/);
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

test("publishUnifiedPost rejects browser-only blob:/data: media URLs before contacting providers", async (context) => {
  const verify = context.mock.method(socialIntegrationService, "verifyOrPostToPlatform", async () => ({ postId: "x" }));
  const user = { _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" };
  await assert.rejects(
    publishUnifiedPost(user, { caption: "hi", platforms: ["facebook", "instagram"], media: [{ type: "image", url: "blob:https://urbancitations.com/1234-abcd" }] }),
    /Media URL must be a public http\(s\) address/
  );
  await assert.rejects(
    publishUnifiedPost(user, { caption: "hi", platforms: ["facebook"], media: ["data:image/png;base64,AAAA"] }),
    /Media URL must be a public http\(s\) address/
  );
  await assert.rejects(
    publishUnifiedPost(user, { caption: "hi", platforms: ["facebook"], media: ["not a url"] }),
    /Invalid media URL/
  );
  assert.equal(verify.mock.callCount(), 0);
});

test("scheduleUnifiedPost rejects browser-only media URLs", async () => {
  const user = { _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" };
  await assert.rejects(
    scheduleUnifiedPost(user, {
      caption: "hi",
      platforms: ["instagram"],
      media: [{ type: "image", url: "blob:https://urbancitations.com/1234-abcd" }],
      scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
    }),
    /Media URL must be a public http\(s\) address/
  );
});

test("publishUnifiedPost routes google_business to the local-post publisher and records the post link", async (context) => {
  const googleBusinessPostService = require("./googleBusinessPostService");
  const social = context.mock.method(socialIntegrationService, "verifyOrPostToPlatform", async () => ({ postId: "fb-1" }));
  let received;
  context.mock.method(googleBusinessPostService, "publishLocalPost", async (_user, postData) => {
    received = postData;
    return { postId: "accounts/1/locations/2/localPosts/3", postUrl: "https://local.google.com/post/3", state: "LIVE" };
  });

  const result = await publishUnifiedPost(
    { _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" },
    {
      caption: "Open late tonight",
      media: [{ type: "image", url: "https://cdn.example.com/post.jpg" }],
      platforms: ["google_business"],
      platformOptions: { google_business: { accountName: "accounts/1", locationName: "locations/2", locationTitle: "Acme Downtown" } },
    }
  );

  assert.equal(social.mock.callCount(), 0);
  assert.equal(received.locationName, "locations/2");
  assert.equal(received.imageUrl, "https://cdn.example.com/post.jpg");
  assert.equal(result.overallStatus, "SUCCESS");
  assert.deepEqual(
    { ...result.results[0] },
    {
      platform: "google_business",
      status: "SUCCESS",
      externalPostId: "accounts/1/locations/2/localPosts/3",
      externalPostUrl: "https://local.google.com/post/3",
      providerState: "LIVE",
      targetName: "Acme Downtown",
    }
  );
  assert.equal(result.postHistory.results[0].externalPostUrl, "https://local.google.com/post/3");
});

test("publishUnifiedPost flags reconnect-required Google failures without failing other platforms", async (context) => {
  const googleBusinessPostService = require("./googleBusinessPostService");
  context.mock.method(socialIntegrationService, "verifyOrPostToPlatform", async () => ({ postId: "threads-1" }));
  context.mock.method(googleBusinessPostService, "publishLocalPost", async () => {
    throw new googleBusinessPostService.GoogleBusinessPostError("Reconnect it to keep posting.", { code: "RECONNECT_REQUIRED", reconnectRequired: true });
  });
  const result = await publishUnifiedPost(
    { _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" },
    {
      caption: "Hello",
      platforms: ["threads", "google_business"],
      platformOptions: { google_business: { accountName: "accounts/1", locationName: "locations/2" } },
    }
  );
  const google = result.results.find((r) => r.platform === "google_business");
  assert.equal(result.overallStatus, "PARTIAL_SUCCESS");
  assert.equal(google.status, "FAILURE");
  assert.equal(google.reconnectRequired, true);
  assert.equal(google.errorCode, "RECONNECT_REQUIRED");
});

test("publish and schedule reject invalid Google posts before contacting any provider", async (context) => {
  const verify = context.mock.method(socialIntegrationService, "verifyOrPostToPlatform", async () => ({ postId: "x" }));
  const user = { _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" };
  await assert.rejects(
    publishUnifiedPost(user, { caption: "hi", platforms: ["facebook", "google_business"], platformOptions: { facebook: { pageId: "p" } } }),
    (error) => error.status === 400 && /Select the Google Business Profile location/.test(error.message)
  );
  await assert.rejects(
    scheduleUnifiedPost(user, {
      caption: "hi",
      platforms: ["google_business"],
      media: [{ type: "video", url: "https://cdn.example.com/v.mp4" }],
      platformOptions: { google_business: { accountName: "accounts/1", locationName: "locations/2" } },
      scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
    }),
    /photos only/
  );
  assert.equal(verify.mock.callCount(), 0);
});

test("scheduleUnifiedPost accepts google_business and keeps the location selection for the worker", async () => {
  const result = await scheduleUnifiedPost(
    { _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" },
    {
      caption: "Scheduled Google post",
      platforms: ["google_business"],
      platformOptions: { google_business: { accountName: "accounts/1", locationName: "locations/2" } },
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
    }
  );
  assert.deepEqual(result.scheduledPost.platforms, ["google_business"]);
  assert.equal(result.scheduledPost.platformOptions.google_business.locationName, "locations/2");
});
