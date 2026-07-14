// backend/services/crmDashboardService.test.js
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const crmDashboardService = require("./crmDashboardService");
const { closeQueueConnections } = require("../utils/queue");

test("crmDashboardService returns comprehensive dashboard summary with all 8 sections", async () => {
  const res = await crmDashboardService.getDashboardSummary("user_test_123");
  assert.ok(res);
  assert.equal(res.success, true);
  assert.ok(Array.isArray(res.connectedSocialAccounts));
  assert.ok(Array.isArray(res.recentPosts));
  assert.ok(Array.isArray(res.recentLeads));
  assert.ok(res.revenueSummary);
  assert.equal(typeof res.revenueSummary.expectedRevenue, "number");
  assert.ok(res.pipelineSummary);
  assert.equal(typeof res.pipelineSummary.totalLeads, "number");
  assert.ok(Array.isArray(res.upcomingFollowUps));
  assert.ok(Array.isArray(res.calendarPreview));
  assert.ok(Array.isArray(res.recentActivityFeed));
});

test("crmDashboardService throws an error if ownerId is missing", async () => {
  await assert.rejects(async () => {
    await crmDashboardService.getDashboardSummary();
  }, /ownerId is required/i);
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
