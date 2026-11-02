"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const User = require("../models/User");
const googleBusinessService = require("../services/googleBusinessService");
const googleBusinessImportService = require("../services/googleBusinessImportService");
const controller = require("./googleBusinessController");

function fakeRes() {
  return { redirectedTo: null, redirect(url) { this.redirectedTo = url; return this; } };
}

const userId = new mongoose.Types.ObjectId();

test("OAuth callback merges the Google Business Profile right after connecting and reports the outcome", async (context) => {
  context.mock.method(googleBusinessService, "connectFromCallback", async () => ({ userId, tenantId: userId, returnTo: "/settings/integrations" }));
  context.mock.method(User, "findById", () => ({ select: async () => ({ _id: userId }) }));
  let importedFor = null;
  context.mock.method(googleBusinessImportService, "autoImportAll", async (user) => {
    importedFor = user._id;
    return { summary: { total: 2, merged: 1, created: 0, pending: 1 }, results: [] };
  });
  const res = fakeRes();
  await controller.handleCallback({ query: { code: "c", state: "s" } }, res);
  assert.equal(String(importedFor), String(userId));
  const url = new URL(res.redirectedTo, "https://example.test");
  assert.equal(url.pathname, "/settings/integrations");
  assert.equal(url.searchParams.get("gmb"), "connected");
  assert.equal(url.searchParams.get("gmbImport"), "done");
  assert.equal(url.searchParams.get("merged"), "1");
  assert.equal(url.searchParams.get("pending"), "1");
});

test("OAuth callback keeps the connection and reports why the merge could not run", async (context) => {
  context.mock.method(googleBusinessService, "connectFromCallback", async () => ({ userId, tenantId: userId, returnTo: "/businessform?mode=google" }));
  context.mock.method(User, "findById", () => ({ select: async () => ({ _id: userId }) }));
  context.mock.method(googleBusinessImportService, "autoImportAll", async () => {
    throw Object.assign(new Error("API disabled"), { status: 403, code: "api_disabled" });
  });
  const res = fakeRes();
  await controller.handleCallback({ query: { code: "c", state: "s" } }, res);
  const url = new URL(res.redirectedTo, "https://example.test");
  assert.equal(url.searchParams.get("gmb"), "connected");
  assert.equal(url.searchParams.get("mode"), "google");
  assert.equal(url.searchParams.get("gmbImport"), "failed");
  assert.equal(url.searchParams.get("importReason"), "api_disabled");
});

test("OAuth callback sends the user back with scope_missing when the Business Profile permission was unticked", async (context) => {
  context.mock.method(googleBusinessService, "connectFromCallback", async () => {
    throw Object.assign(new Error("Google Business Profile permission was not granted"), { code: "scope_missing", returnTo: "/businessform?mode=google" });
  });
  const res = fakeRes();
  await controller.handleCallback({ query: { code: "c", state: "s" } }, res);
  const url = new URL(res.redirectedTo, "https://example.test");
  assert.equal(url.searchParams.get("gmb"), "error");
  assert.equal(url.searchParams.get("reason"), "scope_missing");
  assert.equal(url.searchParams.get("mode"), "google");
});
