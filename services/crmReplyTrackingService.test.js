// backend/services/crmReplyTrackingService.test.js
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const service = require("./crmReplyTrackingService");
const { closeQueueConnections } = require("../utils/queue");

test("classifyReplyText correctly evaluates Negative keywords (`Not Interested`, `Stop`, `Remove Me`) to Cold Lead", () => {
  const negativeInputs = [
    { text: "I am not interested at all, thank you", expectedKeyword: "Not Interested" },
    { text: "Please STOP contacting me immediately", expectedKeyword: "Stop" },
    { text: "Can you remove me from your list?", expectedKeyword: "Remove Me" },
  ];

  for (const { text, expectedKeyword } of negativeInputs) {
    const res = service.classifyReplyText("Re: Proposal", text);
    assert.equal(res.classification, "Negative");
    assert.equal(res.matchedKeyword, expectedKeyword);
    assert.equal(res.newStatus, "Cold Lead");
  }
});

test("classifyReplyText enforces strict precedence where `Not Interested` overrides `Interested`", () => {
  const res = service.classifyReplyText("", "I am really NOT INTERESTED in your software");
  assert.equal(res.classification, "Negative");
  assert.equal(res.matchedKeyword, "Not Interested");
  assert.equal(res.newStatus, "Cold Lead");
});

test("classifyReplyText evaluates Positive keywords (`Interested`, `Let's Talk`, `Meeting`, `Demo`) to Warm Lead", () => {
  const positiveInputs = [
    { text: "Yes, I am interested in hearing more", expectedKeyword: "Interested" },
    { text: "Let's talk on Friday afternoon", expectedKeyword: "Let's Talk" },
    { text: "lets talk next week when I am back", expectedKeyword: "Let's Talk" },
    { text: "Can we schedule a meeting for tomorrow?", expectedKeyword: "Meeting" },
    { text: "I would like to see a demo of the platform", expectedKeyword: "Demo" },
  ];

  for (const { text, expectedKeyword } of positiveInputs) {
    const res = service.classifyReplyText("Inquiry", text);
    assert.equal(res.classification, "Positive");
    assert.equal(res.matchedKeyword, expectedKeyword);
    assert.equal(res.newStatus, "Warm Lead");
  }
});

test("classifyReplyText classifies unknown replies without keywords to Pending Follow-Up", () => {
  const res = service.classifyReplyText("Re: Check in", "Got your email, let me check with my team first.");
  assert.equal(res.classification, "Unknown");
  assert.equal(res.matchedKeyword, null);
  assert.equal(res.newStatus, "Pending Follow-Up");
});

test("processIncomingReply throws error when body text or lead identifiers are missing", async () => {
  await assert.rejects(async () => {
    await service.processIncomingReply({ leadId: "lead_1", body: "" });
  }, /Reply body text is required/i);

  await assert.rejects(async () => {
    await service.processIncomingReply({ body: "Hello" });
  }, /Either leadId or fromEmail must be provided/i);
});

test("processIncomingReply processes reply safely and returns classification structure", async () => {
  const res = await service.processIncomingReply({
    leadId: "lead_test_ok",
    subject: "Re: Demo",
    body: "Let's talk on Monday",
  });

  assert.equal(res.success, true);
  assert.equal(res.classification, "Positive");
  assert.equal(res.newStatus, "Warm Lead");
  assert.ok(res.logId);
});

test("getReplyLogs throws error without ownerId and returns paginated log structure when valid", async () => {
  await assert.rejects(async () => {
    await service.getReplyLogs(null);
  }, /ownerId is required/i);

  const res = await service.getReplyLogs("owner_reply_1", { page: 1, limit: 10 });
  assert.equal(res.success, true);
  assert.ok(Array.isArray(res.logs));
  assert.equal(typeof res.total, "number");
});

test("classifyReplyTextAsync falls back to standard classification when offline or DB not ready", async () => {
  const res = await service.classifyReplyTextAsync("Inquiry", "I am interested in setting up a meeting");
  assert.equal(res.classification, "Positive");
  assert.ok(res.matchedKeyword);
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
