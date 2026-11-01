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

test("readScope widens super-admins and admins with the crm permission to every owner; others keep their own id", () => {
  assert.equal(scope.readScope({ isAdmin: true, user: { _id: "admin_1", role: "super-admin" } }), scope.ALL_OWNERS);
  assert.equal(scope.readScope({ isAdmin: true, user: { _id: "admin_2", role: "admin", permissions: ["crm"] } }), scope.ALL_OWNERS);
  assert.equal(scope.readScope({ isAdmin: true, user: { _id: "admin_3", role: "admin", permissions: ["business", "enquiries"] } }), "admin_3");
  assert.equal(scope.readScope({ isAdmin: false, user: { _id: "user_1" } }), "user_1");
});

test("an admin without the crm permission cannot write into a business's CRM", async () => {
  const mongoose = require("mongoose");
  const Business = mongoose.model("Business");
  const original = Business.findById;
  const id = new mongoose.Types.ObjectId();
  Business.findById = () => ({ select: () => ({ lean: async () => ({ _id: id, userId: "owner_1", businessName: "B" }) }) });
  try {
    await assert.rejects(
      () => scope.resolveWriteScope({ isAdmin: true, user: { _id: "admin_3", role: "admin", permissions: ["business"] } }, String(id)),
      (err) => err.status === 403
    );
    const ok = await scope.resolveWriteScope({ isAdmin: true, user: { _id: "admin_2", role: "admin", permissions: ["crm"] } }, String(id));
    assert.equal(ok.ownerId, "owner_1");
  } finally {
    Business.findById = original;
  }
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
