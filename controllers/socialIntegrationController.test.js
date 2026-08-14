"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const controller = require("./socialIntegrationController");
const service = require("../services/socialIntegrationService");

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    redirectUrl: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    redirect(url) { this.statusCode = 302; this.redirectUrl = url; return this; },
  };
}

test("getAuthUrl returns the provider authorization URL", async (context) => {
  context.mock.method(service, "createAuthorizationRequest", async () => "https://provider.example/oauth?state=safe");
  const req = {
    query: { platform: "threads", returnTo: "/settings/integrations" },
    user: { _id: "user-1", tenantId: "tenant-1" },
  };
  const res = createMockRes();
  await controller.getAuthUrl(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.platform, "threads");
  assert.match(res.body.url, /^https:\/\/provider\.example/);
});

test("getAccounts returns redacted tenant connections from the service", async (context) => {
  context.mock.method(service, "listAccounts", async () => ({
    facebook: { platform: "facebook", status: "connected", isConnected: true },
    threads: { platform: "threads", status: "not_connected", isConnected: false },
  }));
  const res = createMockRes();
  await controller.getAccounts({ user: { _id: "user-1", tenantId: "tenant-1" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.accounts.facebook.isConnected, true);
  assert.equal(res.body.accounts.facebook.accessToken, undefined);
});

test("OAuth callback returns to the configured frontend and blocks external return URLs", async (context) => {
  const previous = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = "https://urbancitations.com";
  context.mock.method(service, "connectFromCallback", async () => ({
    returnTo: "https://attacker.example/steal",
  }));
  const res = createMockRes();
  await controller.handleCallback({
    params: { platform: "linkedin" },
    query: { code: "code", state: "state" },
  }, res);
  const redirect = new URL(res.redirectUrl);
  assert.equal(redirect.origin, "https://urbancitations.com");
  assert.equal(redirect.pathname, "/settings/integrations");
  assert.equal(redirect.searchParams.get("social"), "connected");
  process.env.FRONTEND_URL = previous;
});

test("OAuth callback failures expose only a stable error code", async (context) => {
  const previous = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = "https://urbancitations.com";
  context.mock.method(service, "connectFromCallback", async () => {
    throw new Error("provider response containing sensitive details");
  });
  const res = createMockRes();
  await controller.handleCallback({
    params: { platform: "facebook" },
    query: { code: "code", state: "state" },
  }, res);
  const redirect = new URL(res.redirectUrl);
  assert.equal(redirect.searchParams.get("reason"), "oauth_failed");
  assert.equal(res.redirectUrl.includes("sensitive"), false);
  process.env.FRONTEND_URL = previous;
});
