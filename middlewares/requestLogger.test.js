"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { getRequestId } = require("./requestLogger");

test("getRequestId accepts safe correlation IDs", () => {
  const req = { get: () => "mobile-client:request-42" };
  assert.equal(getRequestId(req), "mobile-client:request-42");
});

test("getRequestId replaces unsafe correlation IDs", () => {
  const req = { get: () => "bad id with spaces and\nnewlines" };
  assert.match(getRequestId(req), /^[0-9a-f-]{36}$/);
});
