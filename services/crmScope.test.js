"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const scope = require("./crmScope");
const { closeQueueConnections } = require("../utils/queue");

const BIZ = new mongoose.Types.ObjectId().toString();

test("scopeFilter combines owner and business clauses and ignores invalid business ids", () => {
  assert.deepEqual(scope.scopeFilter("owner_1"), { ownerId: "owner_1" });
  assert.deepEqual(scope.scopeFilter("owner_1", BIZ), { ownerId: "owner_1", businessId: BIZ });
  assert.deepEqual(scope.scopeFilter("owner_1", "not-an-id"), { ownerId: "owner_1" });
  assert.deepEqual(scope.scopeFilter(scope.ALL_OWNERS, BIZ), { businessId: BIZ });
  assert.deepEqual(scope.scopeFilter(scope.ALL_OWNERS), {});
});

test("scopeMatch produces ObjectId values for aggregation", () => {
  const owner = new mongoose.Types.ObjectId().toString();
  const match = scope.scopeMatch(owner, BIZ);
  assert.ok(match.ownerId instanceof mongoose.Types.ObjectId);
  assert.ok(match.businessId instanceof mongoose.Types.ObjectId);
  assert.deepEqual(Object.keys(scope.scopeMatch(scope.ALL_OWNERS)), []);
});

test("readScope widens admins to every owner and keeps users on their own id", () => {
  assert.equal(scope.readScope({ isAdmin: true, user: { _id: "admin_1" } }), scope.ALL_OWNERS);
  assert.equal(scope.readScope({ isAdmin: false, user: { _id: "user_1" } }), "user_1");
});

test("resolveWriteScope without a businessId keeps the caller as owner", async () => {
  const result = await scope.resolveWriteScope({ isAdmin: false, user: { _id: "user_1" } }, undefined);
  assert.deepEqual(result, { ownerId: "user_1", businessId: null });
  const admin = await scope.resolveWriteScope({ isAdmin: true, user: { _id: "admin_1" } }, "garbage");
  assert.deepEqual(admin, { ownerId: "admin_1", businessId: null });
});

after(async () => {
  try { await closeQueueConnections(); } catch { /* ignore */ }
});
