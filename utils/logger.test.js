"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const logger = require("./logger");

test("sanitize redacts secrets recursively and handles circular values", () => {
  const value = {
    user: { name: "Ada", password: "do-not-log", accessToken: "token" },
  };
  value.self = value;

  const sanitized = logger.sanitize(value);

  assert.equal(sanitized.user.name, "Ada");
  assert.equal(sanitized.user.password, "[REDACTED]");
  assert.equal(sanitized.user.accessToken, "[REDACTED]");
  assert.equal(sanitized.self, "[Circular]");
});

test("serializeError preserves RCA fields without exposing sensitive metadata", () => {
  const error = new Error("database failed");
  error.code = "ECONNRESET";
  error.authorization = "Bearer secret";

  const serialized = logger.serializeError(error);

  assert.equal(serialized.name, "Error");
  assert.equal(serialized.message, "database failed");
  assert.equal(serialized.code, "ECONNRESET");
  assert.equal(serialized.authorization, "[REDACTED]");
  assert.match(serialized.stack, /database failed/);
});

test("createEntry prevents metadata from overriding core log identity", () => {
  const entry = logger.createEntry("error", "real.event", "real message", {
    level: "info",
    event: "spoofed.event",
    timestamp: "not-a-timestamp",
  });

  assert.equal(entry.level, "error");
  assert.equal(entry.event, "real.event");
  assert.notEqual(entry.timestamp, "not-a-timestamp");
});
