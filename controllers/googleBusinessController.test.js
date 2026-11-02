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

function jsonRes() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test("profiles endpoint shows Google's real reason even though axios sets error.status on its own errors", async (context) => {
  context.mock.method(googleBusinessService, "connection", async () => ({ status: "connected", googleEmail: "owner@example.com" }));
  context.mock.method(googleBusinessService, "fetchAllProfilesForUser", async () => {
    throw Object.assign(new Error("Request failed with status code 403"), {
      status: 403, // what axios >= 1.7 puts on the error
      response: { status: 403, data: { error: { status: "PERMISSION_DENIED", message: "My Business Account Management API has not been used in project 157093348458 before or it is disabled.", details: [{ reason: "SERVICE_DISABLED", metadata: { service: "mybusinessaccountmanagement.googleapis.com", consumer: "projects/157093348458" } }] } } },
    });
  });
  const res = jsonRes();
  await controller.getProfiles({ user: { _id: userId } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "api_disabled");
  assert.doesNotMatch(res.body.message, /Request failed with status code/);
  assert.equal(res.body.google.reason, "SERVICE_DISABLED");
  assert.match(res.body.google.message, /has not been used in project 157093348458/);
});
