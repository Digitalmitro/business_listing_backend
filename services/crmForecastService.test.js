// backend/services/crmForecastService.test.js
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const service = require("./crmForecastService");
const { closeQueueConnections } = require("../utils/queue");

test("STAGE_PROBABILITIES contains exact weights for all standard CRM pipeline stages", () => {
  const { STAGE_PROBABILITIES } = service;
  assert.equal(STAGE_PROBABILITIES["Prospecting"], 0.20);
  assert.equal(STAGE_PROBABILITIES["Qualification"], 0.40);
  assert.equal(STAGE_PROBABILITIES["Meeting/Demo"], 0.60);
  assert.equal(STAGE_PROBABILITIES["Proposal"], 0.75);
  assert.equal(STAGE_PROBABILITIES["Negotiation"], 0.90);
  assert.equal(STAGE_PROBABILITIES["Warm Lead"], 0.70);
  assert.equal(STAGE_PROBABILITIES["Closed Won"], 1.00);
  assert.equal(STAGE_PROBABILITIES["Closed Lost"], 0.00);
});

test("getRevenueForecast throws error when ownerId is missing", async () => {
  await assert.rejects(async () => {
    await service.getRevenueForecast(null);
  }, /ownerId is required/i);
});

test("getRevenueForecast returns exact 10 summary metrics and breakdown chart structures", async () => {
  const res = await service.getRevenueForecast("owner_forecast_1", {});
  assert.equal(res.success, true);
  assert.ok(res.summary);

  const { summary, charts } = res;
  assert.equal(typeof summary.totalLeads, "number");
  assert.equal(typeof summary.warmLeads, "number");
  assert.equal(typeof summary.coldLeads, "number");
  assert.equal(typeof summary.closedWon, "number");
  assert.equal(typeof summary.closedLost, "number");
  assert.equal(typeof summary.expectedRevenue, "number");
  assert.equal(typeof summary.closedRevenue, "number");
  assert.equal(typeof summary.forecastRevenue, "number");
  assert.equal(typeof summary.conversionRate, "number");
  assert.equal(typeof summary.averageDealSize, "number");

  assert.ok(Array.isArray(charts.revenueByStage));
  assert.ok(Array.isArray(charts.leadsBySource));
  assert.ok(Array.isArray(charts.monthlyTrend));
});

test("getRevenueForecast calculates exact weighted probability formulas for mock pipeline", async () => {
  const res = await service.getRevenueForecast("mock_owner");
  const { summary } = res;
  assert.equal(summary.totalLeads, 5);
  assert.equal(summary.warmLeads, 1);
  assert.equal(summary.coldLeads, 1);
  assert.equal(summary.closedWon, 1);
  assert.equal(summary.closedLost, 1);
  assert.equal(summary.expectedRevenue, 30000); // Warm (10000) + Proposal (20000)
  assert.equal(summary.closedRevenue, 25000);
  assert.equal(summary.forecastRevenue, 22250); // 10000 * 0.7 + 20000 * 0.75 + 5000 * 0.05
  assert.equal(summary.conversionRate, 50.0); // 1 / (1 + 1) * 100
  assert.equal(summary.averageDealSize, 25000.0); // 25000 / 1
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
