"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const controller = require("./socialIntegrationController");
const { encrypt } = require("../utils/cryptoUtils");
const { closeQueueConnections } = require("../utils/queue");

function createMockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
}

test("getAuthUrl returns 200 on valid platform and 400 on unsupported platform", async () => {
  const reqValid = { query: { platform: "instagram" }, user: { _id: "user_ig_1" } };
  const resValid = createMockRes();
  await controller.getAuthUrl(reqValid, resValid);

  assert.equal(resValid.statusCode, 200);
  assert.equal(resValid.body.success, true);
  assert.equal(resValid.body.platform, "instagram");

  const reqInvalid = { query: { platform: "fake_social" }, user: { _id: "user_fake" } };
  const resInvalid = createMockRes();
  await controller.getAuthUrl(reqInvalid, resInvalid);

  assert.equal(resInvalid.statusCode, 400);
  assert.equal(resInvalid.body.success, false);
});

test("connectAccount saves account and returns sanitized info without raw tokens", async () => {
  let saved = false;
  const req = {
    body: { platform: "linkedin", code: "mock_auth_code_li_123" },
    user: {
      _id: "user_li_2",
      socialMediaAccounts: {},
      async save() {
        saved = true;
      },
    },
  };
  const res = createMockRes();

  await controller.connectAccount(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(saved, true);
  assert.equal(res.body.account.isConnected, true);
  assert.equal(res.body.account.status, "connected");
  // Ensure sensitive tokens are redacted from client response
  assert.equal(res.body.account.accessToken, undefined);
  assert.equal(res.body.account.refreshToken, undefined);
});

test("disconnectAccount disconnects target platform and returns 200", async () => {
  let saved = false;
  const req = {
    body: { platform: "twitter" },
    user: {
      _id: "user_tw_3",
      socialMediaAccounts: {
        twitter: { isConnected: true, status: "connected", accessToken: "enc_token" },
      },
      async save() {
        saved = true;
      },
    },
  };
  const res = createMockRes();

  await controller.disconnectAccount(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(req.user.socialMediaAccounts.twitter.isConnected, false);
  assert.equal(saved, true);
});

test("getAccounts returns status for all 5 platforms with zero tokens exposed", async () => {
  const req = {
    user: {
      _id: "user_all_4",
      socialMediaAccounts: {
        facebook: { isConnected: true, status: "connected", platformUsername: "fb_user", accessToken: "secret_enc" },
      },
    },
  };
  const res = createMockRes();

  await controller.getAccounts(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(Object.keys(res.body.accounts).length, 5);
  assert.equal(res.body.accounts.facebook.isConnected, true);
  assert.equal(res.body.accounts.facebook.platformUsername, "fb_user");
  assert.equal(res.body.accounts.facebook.accessToken, undefined);
  assert.equal(res.body.accounts.pinterest.isConnected, false);
});

test("refreshAccountToken returns 403 when account permissions are revoked", async () => {
  const req = {
    body: { platform: "facebook" },
    user: {
      _id: "user_rev_5",
      socialMediaAccounts: {
        facebook: { isConnected: true, status: "revoked", accessToken: encrypt("fb_token") },
      },
    },
  };
  const res = createMockRes();

  await controller.refreshAccountToken(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
  assert.equal(res.body.status, "revoked");
});

test("verifyOrPost returns 200 and published status when valid", async () => {
  const req = {
    body: { platform: "pinterest", postData: { text: "New Pin Title", imageUrl: "https://example.com/pin.jpg" } },
    user: {
      _id: "user_post_6",
      socialMediaAccounts: {
        pinterest: {
          isConnected: true,
          status: "connected",
          accessToken: encrypt("pin_access_token_123"),
          tokenExpiry: new Date(Date.now() + 3600000),
        },
      },
    },
  };
  const res = createMockRes();

  await controller.verifyOrPost(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.result.platform, "pinterest");
  assert.equal(res.body.result.status, "published");
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
