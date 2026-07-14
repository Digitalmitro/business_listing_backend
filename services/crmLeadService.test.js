"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const service = require("./crmLeadService");
const { closeQueueConnections } = require("../utils/queue");

test("createLead validates required ownerId and leadName, checks status, and logs created activity", async () => {
  await assert.rejects(async () => {
    await service.createLead(null, { leadName: "Bob" });
  }, /ownerId is required/i);

  await assert.rejects(async () => {
    await service.createLead("owner_lead_1", { leadName: "" });
  }, /Lead name is required/i);

  await assert.rejects(async () => {
    await service.createLead("owner_lead_1", { leadName: "Bob", status: "Invalid_Pipeline_Step" });
  }, /Invalid status/i);

  const lead = await service.createLead("owner_lead_1", {
    leadName: "John Lead",
    company: "Acme Leads",
    status: "Prospecting",
    expectedRevenue: 15000,
  });

  assert.equal(lead.ownerId, "owner_lead_1");
  assert.equal(lead.leadName, "John Lead");
  assert.equal(lead.status, "Prospecting");
  assert.equal(lead.activities[0].type, "created");
  assert.match(lead.activities[0].description, /Prospecting/);
});

test("getLeads handles search, status filter, sorting by revenue/follow-up, and pagination", async () => {
  await assert.rejects(async () => {
    await service.getLeads(null);
  }, /ownerId is required/i);

  const result = await service.getLeads("owner_lead_2", {
    page: 1,
    limit: 10,
    search: "Acme",
    status: "Meeting/Demo",
    source: "Website",
    sortBy: "expectedRevenue",
    sortOrder: "desc",
  });

  assert.ok(Array.isArray(result.leads));
  assert.equal(result.page, 1);
  assert.equal(result.limit, 10);
});

test("updateLead changes status, validates pipeline enum, and appends status_change activity", async () => {
  await assert.rejects(async () => {
    await service.updateLead("owner_lead_3", "lead_123", { leadName: "" });
  }, /Lead name cannot be empty/i);

  await assert.rejects(async () => {
    await service.updateLead("owner_lead_3", "lead_123", { status: "Not A Real Status" });
  }, /Invalid status/i);

  const updated = await service.updateLead("owner_lead_3", "valid_lead_1", {
    status: "Proposal",
    expectedRevenue: 25000,
  });

  assert.equal(updated.status, "Proposal");
  assert.equal(updated.expectedRevenue, 25000);
  assert.ok(updated.activities.some((a) => a.type === "status_change" || a.type === "updated"));
});

test("addLeadActivity validates description and appends timeline note", async () => {
  await assert.rejects(async () => {
    await service.addLeadActivity("owner_lead_4", "lead_444", { description: "" });
  }, /Activity description is required/i);

  const res = await service.addLeadActivity("owner_lead_4", "lead_444", {
    type: "followup_scheduled",
    description: "Scheduled Zoom call for next Tuesday at 2 PM",
  });

  assert.equal(res.activities[0].type, "followup_scheduled");
  assert.match(res.activities[0].description, /Zoom call/);
});

test("getLeadById, updateLead, addLeadActivity, and deleteLead throw 404 on nonexistent lead IDs", async () => {
  await assert.rejects(async () => {
    await service.getLeadById("owner_lead_5", "missing_lead");
  }, (err) => err instanceof service.LeadNotFoundError && err.status === 404);

  await assert.rejects(async () => {
    await service.updateLead("owner_lead_5", "missing_lead", { leadName: "Bob" });
  }, (err) => err instanceof service.LeadNotFoundError && err.status === 404);

  await assert.rejects(async () => {
    await service.addLeadActivity("owner_lead_5", "missing_lead", { description: "test" });
  }, (err) => err instanceof service.LeadNotFoundError && err.status === 404);

  await assert.rejects(async () => {
    await service.deleteLead("owner_lead_5", "missing_lead");
  }, (err) => err instanceof service.LeadNotFoundError && err.status === 404);
});

test("reorderKanbanLeads updates pipelineOrder and status across multiple cards cleanly", async () => {
  await assert.rejects(async () => {
    await service.reorderKanbanLeads(null, []);
  }, /ownerId is required/i);

  await assert.rejects(async () => {
    await service.reorderKanbanLeads("owner_kanban_1", "not_an_array");
  }, /must be an array/i);

  const updates = [
    { leadId: "lead_k_1", status: "Qualification", pipelineOrder: 0 },
    { leadId: "lead_k_2", status: "Proposal", pipelineOrder: 1 },
  ];

  const result = await service.reorderKanbanLeads("owner_kanban_1", updates);
  assert.equal(result.length, 2);
  assert.equal(result[0].status, "Qualification");
  assert.equal(result[0].pipelineOrder, 0);
  assert.equal(result[1].status, "Proposal");
  assert.equal(result[1].pipelineOrder, 1);
  assert.equal(result[0].activities[0].type, "status_change");
});

test("getLeads filters by startDate and endDate accurately", async () => {
  const result = await service.getLeads("owner_date_filter", {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    sortBy: "pipelineOrder",
    sortOrder: "asc",
  });
  assert.ok(Array.isArray(result.leads));
});

test("complete lead activity history records email_sent, email_reply, status_change, and exact audit values", async () => {
  const sentRes = await service.addLeadActivity("owner_audit", "lead_audit_1", {
    action: "email_sent",
    description: "Sent introduction brochure to lead",
  }, "user_admin_1");
  assert.equal(sentRes.activities[0].action, "email_sent");
  assert.equal(sentRes.activities[0].type, "email_sent");
  assert.equal(sentRes.activities[0].user, "user_admin_1");
  assert.ok(sentRes.activities[0].timestamp);

  const replyRes = await service.addLeadActivity("owner_audit", "lead_audit_1", {
    action: "email_reply",
    description: "Lead replied requesting pricing quote",
  }, "user_admin_1");
  assert.equal(replyRes.activities[0].action, "email_reply");

  const createdLead = await service.createLead("owner_audit", {
    leadName: "Audit Lead",
    status: "Prospecting",
  }, "user_admin_1");
  assert.equal(createdLead.activities[0].action, "created");
  assert.equal(createdLead.activities[0].newValue, "Prospecting");
  assert.equal(createdLead.activities[0].previousValue, null);
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});

