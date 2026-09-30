"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const googleBusinessService = require("./googleBusinessService");
const service = require("./googleBusinessPostService");

const user = { _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" };
const location = { accountName: "accounts/111", locationName: "locations/222" };

function providerError(status, body = {}) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data: { error: body } };
  return error;
}

test("validatePostInput requires a well-formed location selection", () => {
  assert.throws(() => service.validatePostInput({ text: "hi" }), /Select the Google Business Profile location/);
  assert.throws(
    () => service.validatePostInput({ text: "hi", accountName: "accounts/1", locationName: "locations/../x" }),
    /location is invalid/
  );
  assert.throws(
    () => service.validatePostInput({ text: "hi", accountName: "https://evil.test", locationName: "locations/1" }),
    /location is invalid/
  );
});

test("validatePostInput enforces Google's content rules with status 400", () => {
  const tooLong = "a".repeat(service.SUMMARY_MAX_LENGTH + 1);
  const error = (() => { try { service.validatePostInput({ ...location, text: tooLong }); } catch (e) { return e; } })();
  assert.equal(error.status, 400);
  assert.match(error.message, /limited to 1500 characters/);

  assert.throws(() => service.validatePostInput({ ...location, videoUrl: "https://cdn.test/v.mp4" }), /photos only/);
  assert.throws(() => service.validatePostInput({ ...location }), /need text or a photo/);
  assert.throws(
    () => service.validatePostInput({ ...location, text: "hi", callToAction: { actionType: "DONATE" } }),
    /Unsupported Google button type/
  );
  assert.throws(
    () => service.validatePostInput({ ...location, text: "hi", callToAction: { actionType: "BOOK", url: "javascript:alert(1)" } }),
    /must start with http/
  );
});

test("validatePostInput normalizes the call to action and language", () => {
  const call = service.validatePostInput({ ...location, text: "hi", callToAction: { actionType: "call", url: "https://ignored.test" } });
  assert.deepEqual(call.callToAction, { actionType: "CALL" });
  assert.equal(call.languageCode, "en");

  const book = service.validatePostInput({ ...location, text: "hi", languageCode: "fr-CA", callToAction: { actionType: "BOOK", url: "https://acme.test/book" } });
  assert.deepEqual(book.callToAction, { actionType: "BOOK", url: "https://acme.test/book" });
  assert.equal(book.languageCode, "fr-CA");
});

test("publishLocalPost creates a STANDARD local post on the selected location", async (context) => {
  context.mock.method(googleBusinessService, "getValidAccessToken", async () => "access-token");
  let request;
  context.mock.method(axios, "post", async (url, body, options) => {
    request = { url, body, options };
    return { data: { name: "accounts/111/locations/222/localPosts/333", state: "LIVE", searchUrl: "https://local.google.com/place?id=1" } };
  });

  const result = await service.publishLocalPost(user, {
    ...location,
    text: "Weekend special",
    imageUrl: "https://res.cloudinary.com/demo/image.jpg",
    callToAction: { actionType: "LEARN_MORE", url: "https://acme.test" },
  });

  assert.equal(request.url, "https://mybusiness.googleapis.com/v4/accounts/111/locations/222/localPosts");
  assert.equal(request.options.headers.Authorization, "Bearer access-token");
  assert.deepEqual(request.body, {
    languageCode: "en",
    topicType: "STANDARD",
    summary: "Weekend special",
    media: [{ mediaFormat: "PHOTO", sourceUrl: "https://res.cloudinary.com/demo/image.jpg" }],
    callToAction: { actionType: "LEARN_MORE", url: "https://acme.test/" },
  });
  assert.deepEqual(result, {
    postId: "accounts/111/locations/222/localPosts/333",
    postUrl: "https://local.google.com/place?id=1",
    state: "LIVE",
  });
});

test("publishLocalPost asks for a reconnect when the stored authorization is unusable", async (context) => {
  context.mock.method(googleBusinessService, "getValidAccessToken", async () => {
    throw new Error("Google authorization was revoked; reconnect is required");
  });
  const post = context.mock.method(axios, "post", async () => ({ data: {} }));
  await assert.rejects(service.publishLocalPost(user, { ...location, text: "hi" }), (error) => {
    assert.equal(error.code, "RECONNECT_REQUIRED");
    assert.equal(error.reconnectRequired, true);
    return true;
  });
  assert.equal(post.mock.callCount(), 0);
});

test("publishLocalPost maps a provider 401 to a reconnect prompt", async (context) => {
  context.mock.method(googleBusinessService, "getValidAccessToken", async () => "token");
  context.mock.method(axios, "post", async () => { throw providerError(401, { status: "UNAUTHENTICATED", message: "Request had invalid authentication credentials." }); });
  await assert.rejects(service.publishLocalPost(user, { ...location, text: "hi" }), (error) => {
    assert.equal(error.reconnectRequired, true);
    assert.doesNotMatch(error.message, /invalid authentication credentials/);
    return true;
  });
});

test("toFriendlyError replaces raw Google errors with actionable messages", () => {
  assert.equal(service.toFriendlyError(providerError(403, { status: "PERMISSION_DENIED" })).code, "PERMISSION_DENIED");
  assert.equal(
    service.toFriendlyError(providerError(403, { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] })).code,
    "API_NOT_ENABLED"
  );
  assert.equal(
    service.toFriendlyError(providerError(403, { details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] })).reconnectRequired,
    true
  );
  assert.equal(service.toFriendlyError(providerError(404)).code, "LOCATION_NOT_FOUND");
  assert.equal(service.toFriendlyError(providerError(400, { status: "INVALID_ARGUMENT", message: "Invalid media sourceUrl" })).code, "INVALID_MEDIA");
  assert.equal(service.toFriendlyError(providerError(503)).code, "PROVIDER_UNAVAILABLE");
});

test("publishLocalPost retries a 429 but never retries a 5xx create", async (context) => {
  context.mock.method(googleBusinessService, "getValidAccessToken", async () => "token");
  let calls = 0;
  context.mock.method(axios, "post", async () => {
    calls += 1;
    if (calls === 1) throw providerError(429, { status: "RESOURCE_EXHAUSTED" });
    return { data: { name: "accounts/111/locations/222/localPosts/9", state: "PROCESSING" } };
  });
  const result = await service.publishLocalPost(user, { ...location, text: "hi" });
  assert.equal(calls, 2);
  assert.equal(result.state, "PROCESSING");

  calls = 0;
  context.mock.method(axios, "post", async () => { calls += 1; throw providerError(500); });
  await assert.rejects(service.publishLocalPost(user, { ...location, text: "hi" }), /temporarily unavailable/);
  assert.equal(calls, 1);
});
