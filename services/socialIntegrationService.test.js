"use strict";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-only-encryption-key-32-characters-minimum";

const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const TenantSocialCredential = require("../models/TenantSocialCredential");
const OAuthState = require("../models/OAuthState");
const SocialConnection = require("../models/SocialConnection");
const { decrypt } = require("../utils/cryptoUtils");
const service = require("./socialIntegrationService");

test("provider registry exposes all implemented OAuth integrations", () => {
  const platforms = ["facebook", "instagram", "threads", "linkedin", "twitter"];
  assert.deepEqual(Object.keys(service.SUPPORTED_PLATFORMS), platforms);
  for (const platform of platforms) {
    const config = service.getPlatformConfig(platform);
    assert.ok(config.name);
    assert.match(config.authUrl, /^https:\/\//);
    assert.match(config.tokenUrl, /^https:\/\//);
    assert.ok(config.scopes.length > 0);
  }
  assert.throws(() => service.getPlatformConfig("tiktok"), /Unsupported social media platform/);
});

test("authorization URLs include exact callback, state, scopes, and X PKCE", () => {
  const facebook = service.buildAuthorizationUrl(
    service.getPlatformConfig("facebook"),
    { id: "fb-client", redirectUri: "https://api.example.com/api/social-integrations/callback/facebook" },
    "state-facebook"
  );
  const facebookUrl = new URL(facebook);
  assert.equal(facebookUrl.searchParams.get("client_id"), "fb-client");
  assert.equal(facebookUrl.searchParams.get("state"), "state-facebook");
  assert.match(facebookUrl.searchParams.get("scope"), /pages_manage_posts/);

  const twitter = service.buildAuthorizationUrl(
    service.getPlatformConfig("twitter"),
    { id: "x-client", redirectUri: "https://api.example.com/api/social-integrations/callback/twitter" },
    "state-x",
    "pkce-challenge"
  );
  const twitterUrl = new URL(twitter);
  assert.equal(twitterUrl.searchParams.get("code_challenge"), "pkce-challenge");
  assert.equal(twitterUrl.searchParams.get("code_challenge_method"), "S256");
  assert.match(twitterUrl.searchParams.get("scope"), /offline\.access/);
});

test("tenant credentials are encrypted before upsert and never returned in plaintext", async (context) => {
  let capturedFilter;
  let capturedUpdate;
  context.mock.method(TenantSocialCredential, "findOneAndUpdate", (filter, update) => {
    capturedFilter = filter;
    capturedUpdate = update;
    return {
      select: async () => ({
        platform: update.platform,
        redirectUri: update.redirectUri,
        enabled: true,
      }),
    };
  });

  const user = { _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" };
  const result = await service.saveTenantCredential(user, "threads", {
    clientId: "threads-client",
    clientSecret: "threads-secret",
    redirectUri: "https://api.example.com/api/social-integrations/callback/threads",
  });

  assert.equal(capturedFilter.tenantId, user.tenantId);
  assert.equal(capturedFilter.platform, "threads");
  assert.notEqual(capturedUpdate.clientId, "threads-client");
  assert.notEqual(capturedUpdate.clientSecret, "threads-secret");
  assert.equal(decrypt(capturedUpdate.clientId), "threads-client");
  assert.equal(decrypt(capturedUpdate.clientSecret), "threads-secret");
  assert.equal(result.clientSecret, undefined);
});

test("credential validation rejects missing fields and insecure production callbacks", async () => {
  const user = { _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" };
  await assert.rejects(
    service.saveTenantCredential(user, "facebook", { clientId: "id" }),
    /clientId, clientSecret, and redirectUri are required/
  );

  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  await assert.rejects(
    service.saveTenantCredential(user, "facebook", {
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "http://api.example.com/callback",
    }),
    /must use HTTPS/
  );
  process.env.NODE_ENV = previous;
});

test("authorization request persists one-time hashed state without plaintext state", async (context) => {
  const user = { _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" };
  let stateRecord;
  context.mock.method(TenantSocialCredential, "findOne", () => ({
    select: async () => ({
      clientId: require("../utils/cryptoUtils").encrypt("x-client"),
      clientSecret: require("../utils/cryptoUtils").encrypt("x-secret"),
      redirectUri: "https://api.example.com/api/social-integrations/callback/twitter",
    }),
  }));
  context.mock.method(OAuthState, "create", async (record) => {
    stateRecord = record;
    return record;
  });

  const url = await service.createAuthorizationRequest(user, "twitter", "/settings/integrations");
  const state = new URL(url).searchParams.get("state");
  assert.ok(state);
  assert.notEqual(stateRecord.stateHash, state);
  assert.equal(stateRecord.stateHash.length, 64);
  assert.equal(stateRecord.returnTo, "/settings/integrations");
  assert.ok(stateRecord.codeVerifier);
});

test("redacted connection metadata contains selectors but no tokens", () => {
  const result = service.redact({
    platform: "facebook",
    status: "connected",
    providerUsername: "tenant-user",
    accessToken: "encrypted-secret",
    refreshToken: "encrypted-refresh",
    providerData: {
      pages: [{ id: "page-1", name: "Main Page", access_token: "encrypted-page-token" }],
    },
  });
  assert.equal(result.isConnected, true);
  assert.equal(result.platformUsername, "tenant-user");
  assert.deepEqual(result.providerData.pages, [{ id: "page-1", name: "Main Page", image: "" }]);
  assert.equal(result.accessToken, undefined);
  assert.equal(result.refreshToken, undefined);
  assert.equal(JSON.stringify(result).includes("encrypted-page-token"), false);
});

test("account listing is scoped by both tenant and user", async (context) => {
  const previousReadyState = SocialConnection.db.readyState;
  SocialConnection.db.readyState = 1;
  let filter;
  context.mock.method(SocialConnection, "find", (received) => {
    filter = received;
    return { select: async () => [] };
  });
  try {
    const accounts = await service.listAccounts({
      _id: "507f1f77bcf86cd799439011",
      tenantId: "507f1f77bcf86cd799439012",
    });
    assert.deepEqual(filter, {
      tenantId: "507f1f77bcf86cd799439012",
      userId: "507f1f77bcf86cd799439011",
    });
    assert.equal(accounts.threads.status, "not_connected");
    assert.equal(accounts.threads.isConnected, false);
  } finally {
    SocialConnection.db.readyState = previousReadyState;
  }
});

test("an invalidated Meta token (OAuthException 190) marks the connection for reconnect", async () => {
  const axios = require("axios");
  const { encrypt } = require("../utils/cryptoUtils");
  const previousReadyState = SocialConnection.db.readyState;
  SocialConnection.db.readyState = 1;
  const account = {
    _id: "conn1",
    platform: "instagram",
    status: "connected",
    providerAccountId: "1789",
    accessToken: encrypt("ig-token"),
    tokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    saved: 0,
    save: async function () { this.saved += 1; },
  };
  const findMock = mock.method(SocialConnection, "findOne", () => ({ select: async () => account }));
  const postMock = mock.method(axios, "post", async () => {
    const error = new Error("Request failed with status code 400");
    error.response = { status: 400, data: { error: { code: 190, type: "OAuthException", message: "Error validating access token: The session has been invalidated because the user changed their password." } } };
    throw error;
  });
  try {
    await assert.rejects(
      service.verifyOrPostToPlatform({ _id: "507f1f77bcf86cd799439011", tenantId: "507f1f77bcf86cd799439012" }, "instagram", { text: "hi", imageUrl: "https://cdn.test/a.jpg" }),
      (error) => {
        assert.equal(error.name, "RevokedPermissionError");
        assert.match(error.message, /session has been invalidated/);
        assert.match(error.message, /Reconnect Instagram/);
        return true;
      }
    );
    assert.equal(account.status, "expired");
    assert.match(account.lastError, /session has been invalidated/);
    assert.ok(account.saved >= 1);
  } finally {
    findMock.mock.restore();
    postMock.mock.restore();
    SocialConnection.db.readyState = previousReadyState;
  }
});
