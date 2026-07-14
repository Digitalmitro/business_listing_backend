// backend/middlewares/authMiddleware.test.js
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { authMiddleware } = require("./authMiddleware");
const { closeQueueConnections } = require("../utils/queue");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_key_12345";

test("authMiddleware returns 401 when Authorization header is missing", async () => {
  const req = { header: () => null };
  let status = null;
  let jsonRes = null;
  const res = {
    status: (code) => {
      status = code;
      return { json: (data) => { jsonRes = data; } };
    },
  };
  let nextCalled = false;

  await authMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(status, 401);
  assert.equal(nextCalled, false);
  assert.ok(jsonRes.message.includes("No token"));
});

test("authMiddleware returns 401 when token is malformed/invalid", async () => {
  const req = { header: () => "Bearer invalid.jwt.token" };
  let status = null;
  let jsonRes = null;
  const res = {
    status: (code) => {
      status = code;
      return { json: (data) => { jsonRes = data; } };
    },
  };
  let nextCalled = false;

  await authMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(status, 401);
  assert.equal(nextCalled, false);
  assert.ok(jsonRes.message.includes("not valid"));
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
