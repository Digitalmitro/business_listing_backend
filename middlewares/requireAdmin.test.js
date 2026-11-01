"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { requireAdmin, requireSuperAdmin, hasPermission } = require("./requireAdmin");
const { closeQueueConnections } = require("../utils/queue");

function run(middleware, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, next: false }); },
    };
    middleware(req, res, () => resolve({ status: 200, next: true }));
  });
}

const superAdmin = { role: "super-admin", permissions: [] };
const subAdmin = { role: "admin", permissions: ["business", "enquiries"] };
const customer = { full_name: "Customer" };

test("requireAdmin: unauthenticated requests are rejected with 401 (via authMiddleware)", async () => {
  const out = await run(requireAdmin(), { header: () => null });
  assert.equal(out.status, 401);
});

test("requireAdmin: a regular user gets 403", async () => {
  const out = await run(requireAdmin(), { user: customer, isAdmin: false });
  assert.equal(out.status, 403);
});

test("requireAdmin(permission): super-admins bypass, sub-admins need the key", async () => {
  assert.equal((await run(requireAdmin("users"), { user: superAdmin, isAdmin: true })).next, true);
  assert.equal((await run(requireAdmin("business"), { user: subAdmin, isAdmin: true })).next, true);
  assert.equal((await run(requireAdmin("users"), { user: subAdmin, isAdmin: true })).status, 403);
  assert.equal((await run(requireAdmin(["users", "enquiries"]), { user: subAdmin, isAdmin: true })).next, true);
});

test("requireAdmin.ifAdmin lets owners through but checks admins", async () => {
  assert.equal((await run(requireAdmin.ifAdmin("email_marketing"), { user: customer, isAdmin: false })).next, true);
  assert.equal((await run(requireAdmin.ifAdmin("email_marketing"), { user: subAdmin, isAdmin: true })).status, 403);
});

test("requireSuperAdmin refuses sub-admins", async () => {
  assert.equal((await run(requireSuperAdmin, { user: subAdmin, isAdmin: true })).status, 403);
  assert.equal((await run(requireSuperAdmin, { user: superAdmin, isAdmin: true })).next, true);
  assert.equal(hasPermission(subAdmin, []), true);
});

after(async () => {
  try { await closeQueueConnections(); } catch (e) {}
});
