// backend/services/crmFollowUpService.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("./crmFollowUpService");

test("getOrUpdateConfig returns default configuration with 3-day interval", async () => {
  await assert.rejects(async () => {
    await service.getOrUpdateConfig(null);
  }, /ownerId is required/i);

  const config = await service.getOrUpdateConfig("owner_followup_1");
  assert.equal(config.ownerId, "owner_followup_1");
  assert.equal(config.isEnabled, true);
  assert.equal(config.defaultIntervalDays, 3);
  assert.equal(config.maxAttempts, 3);

  const updated = await service.getOrUpdateConfig("owner_followup_1", { defaultIntervalDays: 5, maxAttempts: 5 });
  assert.equal(updated.defaultIntervalDays, 5);
  assert.equal(updated.maxAttempts, 5);
});

test("applyLeadPlaceholders correctly replaces template variables", () => {
  const rawText = "Hello {{lead_name}}, following up on {{company}} with status {{status}}. Visit {{frontend_url}}";
  const processed = service.applyLeadPlaceholders(rawText, {
    "{{lead_name}}": "Alice Smith",
    "{{company}}": "TechCorp",
    "{{status}}": "Proposal",
    "{{frontend_url}}": "https://example.com",
  });
  assert.equal(
    processed,
    "Hello Alice Smith, following up on TechCorp with status Proposal. Visit https://example.com"
  );
});

test("triggerLeadFollowUp enforces status exclusions (Completed, Closed Won, Closed Lost)", async () => {
  await assert.rejects(async () => {
    await service.triggerLeadFollowUp(null, "lead_1");
  }, /ownerId and leadId are required/i);

  for (const excluded of service.EXCLUDED_STATUSES) {
    const res = await service.triggerLeadFollowUp("owner_followup_2", "lead_test", { mockStatus: excluded });
    assert.equal(res.success, false);
    assert.equal(res.status, "skipped");
    assert.match(res.reason, new RegExp(`Skipped: lead status is ${excluded}`, "i"));
  }
});

test("triggerLeadFollowUp simulates email sending and records status", async () => {
  const successRes = await service.triggerLeadFollowUp("owner_followup_3", "lead_test_ok");
  assert.equal(successRes.success, true);
  assert.equal(successRes.status, "sent");
  assert.equal(successRes.log.attemptNumber, 1);
  assert.ok(successRes.log.sentAt);

  const failRes = await service.triggerLeadFollowUp("owner_followup_3", "lead_test_fail", { mockFail: true });
  assert.equal(failRes.success, false);
  assert.equal(failRes.status, "failed");
  assert.match(failRes.error, /Simulated SMTP delivery failure/i);
});

test("processAutomatedFollowUps and retryFailedFollowUps run safely without error when offline or mocked", async () => {
  const summary = await service.processAutomatedFollowUps({ ownerId: "owner_followup_4" });
  assert.equal(typeof summary.totalProcessed, "number");
  assert.ok(Array.isArray(summary.candidates));

  const retrySummary = await service.retryFailedFollowUps("owner_followup_4");
  assert.equal(typeof retrySummary.retried, "number");
});
