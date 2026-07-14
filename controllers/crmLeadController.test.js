"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const controller = require("./crmLeadController");
const { closeQueueConnections } = require("../utils/queue");

function createMockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
}

test("createLead returns 401 when unauthenticated, 400 on missing leadName/invalid status, 201 on success", async () => {
  const unauthRes = createMockRes();
  await controller.createLead({ body: { leadName: "Bob" } }, unauthRes);
  assert.equal(unauthRes.statusCode, 401);

  const badRes = createMockRes();
  await controller.createLead({ user: { _id: "u1" }, body: { leadName: "" } }, badRes);
  assert.equal(badRes.statusCode, 400);

  const badStatusRes = createMockRes();
  await controller.createLead({ user: { _id: "u1" }, body: { leadName: "Lead A", status: "Invalid" } }, badStatusRes);
  assert.equal(badStatusRes.statusCode, 400);

  const successRes = createMockRes();
  await controller.createLead({ user: { _id: "u1" }, body: { leadName: "Lead A", status: "New" } }, successRes);
  assert.equal(successRes.statusCode, 201);
  assert.equal(successRes.body.success, true);
  assert.equal(successRes.body.lead.leadName, "Lead A");
});

test("getLeads returns 200 with leads array and pagination structure", async () => {
  const req = { user: { _id: "u2" }, query: { page: 1, limit: 10, search: "Lead" } };
  const res = createMockRes();
  await controller.getLeads(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.leads));
});

test("getLeadById returns 200 on valid ID and 404 when ID does not exist", async () => {
  const notFoundRes = createMockRes();
  await controller.getLeadById({ user: { _id: "u3" }, params: { id: "missing_lead_1" } }, notFoundRes);
  assert.equal(notFoundRes.statusCode, 404);

  const foundRes = createMockRes();
  await controller.getLeadById({ user: { _id: "u3" }, params: { id: "valid_lead_id_88" } }, foundRes);
  assert.equal(foundRes.statusCode, 200);
  assert.equal(foundRes.body.success, true);
});

test("updateLead returns 200 on valid update and 400/404 on invalid data or ID", async () => {
  const badStatusRes = createMockRes();
  await controller.updateLead({ user: { _id: "u4" }, params: { id: "valid_lead" }, body: { status: "Fake" } }, badStatusRes);
  assert.equal(badStatusRes.statusCode, 400);

  const notFoundRes = createMockRes();
  await controller.updateLead({ user: { _id: "u4" }, params: { id: "missing_lead_99" }, body: { status: "Proposal" } }, notFoundRes);
  assert.equal(notFoundRes.statusCode, 404);

  const successRes = createMockRes();
  await controller.updateLead({ user: { _id: "u4" }, params: { id: "valid_lead_77" }, body: { status: "Meeting/Demo" } }, successRes);
  assert.equal(successRes.statusCode, 200);
  assert.equal(successRes.body.success, true);
});

test("addActivity returns 201 on success and 400 when description missing", async () => {
  const badDescRes = createMockRes();
  await controller.addActivity({ user: { _id: "u5" }, params: { id: "lead_1" }, body: { description: "" } }, badDescRes);
  assert.equal(badDescRes.statusCode, 400);

  const successRes = createMockRes();
  await controller.addActivity({ user: { _id: "u5" }, params: { id: "lead_1" }, body: { type: "note_added", description: "Called lead today" } }, successRes);
  assert.equal(successRes.statusCode, 201);
  assert.equal(successRes.body.success, true);
});

test("deleteLead returns 200 when deleted and 404 when ID does not exist", async () => {
  const notFoundRes = createMockRes();
  await controller.deleteLead({ user: { _id: "u6" }, params: { id: "missing_delete_id" } }, notFoundRes);
  assert.equal(notFoundRes.statusCode, 404);

  const successRes = createMockRes();
  await controller.deleteLead({ user: { _id: "u6" }, params: { id: "valid_delete_id_33" } }, successRes);
  assert.equal(successRes.statusCode, 200);
  assert.equal(successRes.body.success, true);
});

test("reorderKanban returns 401 unauth, 400 when updates not array, and 200 when valid", async () => {
  const unauthRes = createMockRes();
  await controller.reorderKanban({ body: { updates: [] } }, unauthRes);
  assert.equal(unauthRes.statusCode, 401);

  const badRes = createMockRes();
  await controller.reorderKanban({ user: { _id: "u7" }, body: { updates: "not_an_array" } }, badRes);
  assert.equal(badRes.statusCode, 400);

  const successRes = createMockRes();
  await controller.reorderKanban({
    user: { _id: "u7" },
    body: {
      updates: [
        { leadId: "lead_a", status: "Prospecting", pipelineOrder: 0 },
        { leadId: "lead_b", status: "Qualification", pipelineOrder: 1 },
      ],
    },
  }, successRes);
  assert.equal(successRes.statusCode, 200);
  assert.equal(successRes.body.success, true);
  assert.equal(successRes.body.leads.length, 2);
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
