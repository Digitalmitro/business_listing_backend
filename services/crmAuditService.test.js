// backend/services/crmAuditService.test.js
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const service = require("./crmAuditService");
const { closeQueueConnections } = require("../utils/queue");

test("truncate helper shortens strings correctly", () => {
  const { truncate } = service;
  assert.equal(truncate("Hello World", 20), "Hello World");
  assert.equal(truncate("Hello World", 5), "Hello…");
});

test("resolveDisplayName returns correct display name or System", () => {
  const { resolveDisplayName } = service;
  assert.equal(resolveDisplayName(null), "System");
  assert.equal(resolveDisplayName({ full_name: "Alice Smith" }), "Alice Smith");
  assert.equal(resolveDisplayName({ email: "alice@example.com" }), "alice@example.com");
});

test("logAudit and getAuditLogs return safe structure when offline", async () => {
  await service.logAudit({
    ownerId: "mock_owner",
    leadId: "mock_lead",
    action: "status_change",
    description: "Changed status from New to Warm Lead",
  });

  const res = await service.getAuditLogs("mock_owner", { limit: 10 });
  assert.ok(Array.isArray(res.logs));
  assert.equal(typeof res.total, "number");
});

test("exportAuditLogs formats CSV correctly", async () => {
  const csv = await service.exportAuditLogs("mock_owner");
  assert.ok(typeof csv === "string");
  assert.ok(csv.toLowerCase().includes("timestamp,action,lead"));
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
