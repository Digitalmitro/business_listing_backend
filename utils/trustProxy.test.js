"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveTrustProxy } = require("./trustProxy");

test("production trusts exactly the one nginx hop; dev only loopback", () => {
  assert.equal(resolveTrustProxy(undefined, "production"), 1);
  assert.equal(resolveTrustProxy(undefined, "development"), "loopback");
  assert.equal(resolveTrustProxy("", "production"), 1);
});

test("explicit settings; legacy `true` no longer trusts every hop", () => {
  assert.equal(resolveTrustProxy("true", "production"), 1);
  assert.equal(resolveTrustProxy("false", "production"), false);
  assert.equal(resolveTrustProxy("2", "production"), 2);
  assert.equal(resolveTrustProxy("10.0.0.0/8", "production"), "10.0.0.0/8");
});
