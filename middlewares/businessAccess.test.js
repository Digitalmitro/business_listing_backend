"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Business = require("../models/Business");
const { requireBusinessAccess, fromParam, fromBusinessData } = require("./businessAccess");
const { closeQueueConnections } = require("../utils/queue");

const ownerId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();
const businessId = new mongoose.Types.ObjectId();

function run(middleware, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, next: false }); },
    };
    middleware(req, res, (err) => resolve({ status: err ? 500 : 200, next: !err, err }));
  });
}

function stubBusiness(context, doc) {
  context.mock.method(Business, "findById", () => ({ select: () => ({ lean: async () => doc }) }));
}

test("owner passes, another user gets 403, admins need the business permission", async (context) => {
  stubBusiness(context, { _id: businessId, userId: ownerId });
  const mw = requireBusinessAccess(fromParam("id"));
  const params = { id: String(businessId) };
  assert.equal((await run(mw, { params, user: { _id: ownerId } })).next, true);
  assert.equal((await run(mw, { params, user: { _id: otherId } })).status, 403);
  assert.equal((await run(mw, { params, user: { role: "admin", permissions: ["business"] }, isAdmin: true })).next, true);
  assert.equal((await run(mw, { params, user: { role: "admin", permissions: ["cms"] }, isAdmin: true })).status, 403);
  assert.equal((await run(mw, { params, user: { role: "super-admin", permissions: [] }, isAdmin: true })).next, true);
});

test("unowned business: only admins; bad or missing ids are rejected", async (context) => {
  stubBusiness(context, { _id: businessId, userId: null });
  const mw = requireBusinessAccess(fromBusinessData);
  const body = { businessData: JSON.stringify({ _id: String(businessId) }) };
  assert.equal((await run(mw, { body, user: { _id: ownerId } })).status, 403);
  assert.equal((await run(mw, { body: { businessData: "{" }, user: { _id: ownerId } })).status, 400);
  assert.equal((await run(mw, { body: {}, user: { _id: ownerId } })).status, 400);
  assert.equal((await run(mw, { body, user: undefined })).status, 401);
});

after(async () => {
  try { await closeQueueConnections(); } catch (e) {}
});
