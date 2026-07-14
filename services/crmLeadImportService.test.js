// backend/services/crmLeadImportService.test.js
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const service = require("./crmLeadImportService");
const { closeQueueConnections } = require("../utils/queue");

test("importLeads throws when ownerId is missing", async () => {
  await assert.rejects(async () => {
    await service.importLeads(null, "some csv");
  }, /ownerId is required/i);
});

test("importLeads parses valid CSV buffer offline", async () => {
  const csvData = Buffer.from(
    "leadName,company,email,phone,expectedRevenue,status,source,notes\n" +
      "John Doe,Acme Corp,john@acme.com,1234567890,5000,Warm Lead,Website,Interested in demo\n" +
      "Jane Smith,Beta Inc,jane@beta.com,9876543210,12000,Proposal,Referral,Follow up next week\n"
  );

  const res = await service.importLeads("mock_owner", csvData, "csv");
  assert.equal(res.success, true);
  assert.equal(res.importedCount, 2);
  assert.equal(res.failedCount, 0);
});

test("importLeads records errors on missing leadName column", async () => {
  const csvData = Buffer.from(
    "company,email\n" +
      "Acme Corp,john@acme.com\n"
  );

  const res = await service.importLeads("mock_owner", csvData, "csv");
  assert.equal(res.success, true);
  assert.equal(res.importedCount, 0);
  assert.equal(res.failedCount, 1);
  assert.ok(res.errors[0].error.includes("leadName"));
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
