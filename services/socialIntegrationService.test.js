"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  SUPPORTED_PLATFORMS,
  RevokedPermissionError,
  getPlatformConfig,
  getAuthUrl,
  exchangeCodeAndFetchProfile,
  getValidAccessToken,
  disconnectAccount,
  verifyOrPostToPlatform,
} = require("./socialIntegrationService");
const { encrypt } = require("../utils/cryptoUtils");
const { closeQueueConnections } = require("../utils/queue");

test("getPlatformConfig validates all 5 supported platforms and rejects unsupported ones", () => {
  const platforms = ["facebook", "instagram", "linkedin", "twitter", "pinterest"];
  for (const p of platforms) {
    const cfg = getPlatformConfig(p);
    assert.ok(cfg.name);
    assert.ok(cfg.authUrl);
    assert.ok(cfg.postUrl);
  }

  assert.throws(() => {
    getPlatformConfig("tiktok");
  }, /Unsupported social media platform/i);
});

test("getAuthUrl generates correct authorization URLs with required scopes for all platforms", () => {
  const fbUrl = getAuthUrl("facebook", "state_fb");
  assert.match(fbUrl, /https:\/\/www\.facebook\.com\/v19\.0\/dialog\/oauth/);
  assert.match(fbUrl, /pages_manage_posts/);
  assert.match(fbUrl, /state=state_fb/);

  const liUrl = getAuthUrl("linkedin", "state_li");
  assert.match(liUrl, /https:\/\/www\.linkedin\.com\/oauth\/v2\/authorization/);
  assert.match(liUrl, /w_member_social/);

  const twUrl = getAuthUrl("twitter", "state_tw");
  assert.match(twUrl, /https:\/\/twitter\.com\/i\/oauth2\/authorize/);
  assert.match(twUrl, /tweet\.write/);
});

test("exchangeCodeAndFetchProfile returns encrypted tokens and account metadata", async () => {
  const account = await exchangeCodeAndFetchProfile("facebook", "mock_auth_code_999");
  assert.equal(account.isConnected, true);
  assert.equal(account.status, "connected");
  assert.equal(typeof account.accessToken, "string");
  assert.equal(account.accessToken.split(":").length, 3); // Encrypted AES-256-GCM format
  assert.ok(account.tokenExpiry instanceof Date);
  assert.ok(Array.isArray(account.scopes));
});

test("getValidAccessToken decrypts unexpired token and returns plaintext", async () => {
  const mockUser = {
    socialMediaAccounts: {
      linkedin: {
        isConnected: true,
        status: "connected",
        accessToken: encrypt("secret_linkedin_access_token_123"),
        tokenExpiry: new Date(Date.now() + 3600 * 1000), // 1 hour in future
      },
    },
  };

  const token = await getValidAccessToken(mockUser, "linkedin");
  assert.equal(token, "secret_linkedin_access_token_123");
});

test("getValidAccessToken throws RevokedPermissionError if account status is already revoked", async () => {
  const mockUser = {
    socialMediaAccounts: {
      instagram: {
        isConnected: true,
        status: "revoked",
        accessToken: encrypt("old_token"),
      },
    },
  };

  await assert.rejects(
    async () => {
      await getValidAccessToken(mockUser, "instagram");
    },
    (err) => {
      return err instanceof RevokedPermissionError && err.status === "revoked";
    }
  );
});

test("getValidAccessToken automatically refreshes expired token and updates user", async () => {
  let saved = false;
  const mockUser = {
    _id: "user_refresh_123",
    socialMediaAccounts: {
      twitter: {
        isConnected: true,
        status: "connected",
        accessToken: encrypt("old_expired_twitter_token"),
        refreshToken: encrypt("valid_refresh_twitter_token"),
        tokenExpiry: new Date(Date.now() - 10000), // Expired
      },
    },
    async save() {
      saved = true;
    },
  };

  const newToken = await getValidAccessToken(mockUser, "twitter");
  assert.match(newToken, /mock_refreshed_access_twitter_/);
  assert.equal(mockUser.socialMediaAccounts.twitter.status, "connected");
  assert.equal(saved, true);
});

test("disconnectAccount resets account fields cleanly and sets status to not_connected", async () => {
  let saved = false;
  const mockUser = {
    _id: "user_disc_456",
    socialMediaAccounts: {
      pinterest: {
        isConnected: true,
        status: "connected",
        accessToken: "enc_token",
        profileName: "My Pin Board",
      },
    },
    async save() {
      saved = true;
    },
  };

  await disconnectAccount(mockUser, "pinterest");
  assert.equal(mockUser.socialMediaAccounts.pinterest.isConnected, false);
  assert.equal(mockUser.socialMediaAccounts.pinterest.status, "not_connected");
  assert.equal(mockUser.socialMediaAccounts.pinterest.accessToken, null);
  assert.equal(saved, true);
});

test("verifyOrPostToPlatform verifies official supported endpoints and publishes post", async () => {
  const mockUser = {
    _id: "user_post_789",
    socialMediaAccounts: {
      facebook: {
        isConnected: true,
        status: "connected",
        accessToken: encrypt("fb_access_valid"),
        tokenExpiry: new Date(Date.now() + 3600 * 1000),
      },
    },
  };

  const res = await verifyOrPostToPlatform(mockUser, "facebook", { text: "Hello from UrbanCitations!" });
  assert.equal(res.success, true);
  assert.equal(res.platform, "facebook");
  assert.equal(res.endpointUsed, "https://graph.facebook.com/v19.0/me/feed");
  assert.equal(res.status, "published");
});

test("verifyOrPostToPlatform throws error if account is not connected or revoked", async () => {
  const mockUser = {
    socialMediaAccounts: {
      twitter: {
        isConnected: true,
        status: "revoked",
        accessToken: encrypt("twitter_token"),
      },
    },
  };

  await assert.rejects(
    async () => {
      await verifyOrPostToPlatform(mockUser, "twitter", { text: "My Tweet" });
    },
    /Account Twitter\/X is not in 'connected' status|Permissions for twitter have been revoked/i
  );
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
