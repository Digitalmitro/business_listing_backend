"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const controller = require("./googleBusinessController");
const service = require("../services/googleBusinessService");
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
