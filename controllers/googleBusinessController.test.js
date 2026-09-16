"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const controller = require("./googleBusinessController");
const service = require("../services/googleBusinessService");
const importService = require("../services/googleBusinessImportService");
const Business = require("../models/Business");
const Category = require("../models/Category");
const GoogleConnection = require("../models/GoogleBusinessConnection");
const User = require("../models/User");

function response() {
  return {
    statusCode: 200,
    body: null,
    redirectUrl: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    redirect(url) { this.statusCode = 302; this.redirectUrl = url; return this; },
  };
}

test("getAuthUrl returns the tenant Google authorization URL", async (context) => {
  context.mock.method(service, "createAuthorizationRequest", async () => "https://accounts.google.com/o/oauth2/v2/auth?state=safe");
  const res = response();
  await controller.getAuthUrl({
    user: { _id: "u1", tenantId: "t1" },
    query: { returnTo: "/settings/integrations" },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.url, /^https:\/\/accounts\.google\.com/);
});

test("legacy direct code exchange endpoint is disabled", async () => {
  const res = response();
  await controller.connectAccount({}, res);
  assert.equal(res.statusCode, 410);
});

test("disconnect deletes only the current tenant and user connection", async (context) => {
  let filter;
  context.mock.method(GoogleConnection, "deleteOne", async (received) => { filter = received; });
  const res = response();
  await controller.disconnectAccount({ user: { _id: "u1", tenantId: "t1" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(filter, { tenantId: "t1", userId: "u1" });
});

test("callback success uses the stored safe return path", async (context) => {
  const previous = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = "https://urbancitations.com";
  context.mock.method(service, "connectFromCallback", async () => ({
    userId: "u1",
    returnTo: "/settings/integrations",
  }));
  context.mock.method(User, "findById", async () => null);
  const res = response();
  await controller.handleCallback({ query: { code: "code", state: "state" } }, res);
  const redirect = new URL(res.redirectUrl);
  assert.equal(redirect.origin, "https://urbancitations.com");
  assert.equal(redirect.pathname, "/settings/integrations");
  assert.equal(redirect.searchParams.get("gmb"), "connected");
  process.env.FRONTEND_URL = previous;
});

test("callback rejects missing code or state without exposing details", async () => {
  const codeMissing = response();
  await controller.handleCallback({ query: { state: "state" } }, codeMissing);
  assert.equal(new URL(codeMissing.redirectUrl).searchParams.get("reason"), "missing_code");

  const stateMissing = response();
  await controller.handleCallback({ query: { code: "code" } }, stateMissing);
  assert.equal(new URL(stateMissing.redirectUrl).searchParams.get("reason"), "missing_state");
});

test("getProfiles never writes to the Business collection — importing is a separate, explicit action", async (context) => {
  context.mock.method(service, "connection", async () => ({ _id: "conn1", status: "connected" }));
  context.mock.method(service, "fetchAllProfilesForUser", async () => [
    { businessId: "locations/1", businessName: "Art Brain", category: "Art Studio" },
    { businessId: "locations/2", businessName: "DigitalMitro", category: "" },
  ]);
  let businessWriteAttempted = false;
  for (const writeMethod of ["create", "updateOne", "findOneAndUpdate", "insertMany"]) {
    context.mock.method(Business, writeMethod, async () => { businessWriteAttempted = true; });
  }
  context.mock.method(Business, "find", () => ({ select: () => ({ lean: async () => [] }) }));
  context.mock.method(Category, "find", () => ({ select: () => ({ lean: async () => [] }) }));

  const res = response();
  await controller.getProfiles({ user: { _id: "u1", tenantId: "t1" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.profiles.length, 2);
  assert.equal(businessWriteAttempted, false);
  assert.ok("linkedBusinessId" in res.body.profiles[0]);
  assert.ok("linkedToCurrentUser" in res.body.profiles[0]);
});

test("callback consumes denied OAuth state and returns to the original business-import screen", async (context) => {
  const previous = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = "https://urbancitations.com";
  let consumedState;
  context.mock.method(service, "cancelAuthorizationRequest", async (state) => {
    consumedState = state;
    return { returnTo: "/businessform?mode=google" };
  });
  const res = response();
  await controller.handleCallback({ query: { error: "access_denied", state: "one-time-state" } }, res);
  const redirect = new URL(res.redirectUrl);
  assert.equal(consumedState, "one-time-state");
  assert.equal(redirect.pathname, "/businessform");
  assert.equal(redirect.searchParams.get("mode"), "google");
  assert.equal(redirect.searchParams.get("gmb"), "error");
  process.env.FRONTEND_URL = previous;
});

test("importLocation returns 403 when Google denies access to the requested location", async (context) => {
  context.mock.method(importService, "importLocation", async () => {
    const err = new Error("You are not authorized to access this Google Business Profile location");
    err.status = 403;
    throw err;
  });
  const res = response();
  await controller.importLocation(
    { user: { _id: "u1" }, body: { accountName: "accounts/1", locationName: "locations/999" } },
    res
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
});

test("importLocation returns 409 with the existing business id when the location is linked to another account", async (context) => {
  context.mock.method(importService, "importLocation", async () => {
    const err = new Error("This Google Business Profile is already linked to another Urban Citation business");
    err.status = 409;
    err.existingBusinessId = "biz123";
    err.claimable = true;
    throw err;
  });
  const res = response();
  await controller.importLocation(
    { user: { _id: "u1" }, body: { accountName: "accounts/1", locationName: "locations/111111" } },
    res
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.existingBusinessId, "biz123");
  assert.equal(res.body.claimable, true);
});

test("importLocation returns 201 with the created business on success", async (context) => {
  context.mock.method(importService, "importLocation", async () => ({
    created: true,
    business: { _id: "biz999", businessName: "Art Brain" },
  }));
  const res = response();
  await controller.importLocation(
    { user: { _id: "u1" }, body: { accountName: "accounts/1", locationName: "locations/111111", categoryId: "cat1" } },
    res
  );
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.created, true);
  assert.equal(res.body.businessId, "biz999");
});

test("importLocation requires locationName in the request body", async () => {
  const res = response();
  await controller.importLocation({ user: { _id: "u1" }, body: {} }, res);
  assert.equal(res.statusCode, 400);
});
