"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const controller = require("./crmContactController");
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

test("createContact returns 401 when user not authenticated, 400 on missing name, 201 on success", async () => {
  const unauthRes = createMockRes();
  await controller.createContact({ body: { name: "Bob" } }, unauthRes);
  assert.equal(unauthRes.statusCode, 401);

  const missingRes = createMockRes();
  await controller.createContact({ user: { _id: "u1" }, body: { name: "" } }, missingRes);
  assert.equal(missingRes.statusCode, 400);

  const successRes = createMockRes();
  await controller.createContact({ user: { _id: "u1" }, body: { name: "Bob Smith", email: "bob@test.com" } }, successRes);
  assert.equal(successRes.statusCode, 201);
  assert.equal(successRes.body.success, true);
  assert.equal(successRes.body.contact.name, "Bob Smith");
});

test("getContacts returns 200 with contacts array and pagination metadata", async () => {
  const req = { user: { _id: "u2" }, query: { page: 1, limit: 10, search: "Bob" } };
  const res = createMockRes();
  await controller.getContacts(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.contacts));
  assert.equal(res.body.page, 1);
});

test("getContactById returns 200 on valid ID and 404 on nonexistent ID", async () => {
  const notFoundRes = createMockRes();
  await controller.getContactById({ user: { _id: "u3" }, params: { id: "missing_1" } }, notFoundRes);
  assert.equal(notFoundRes.statusCode, 404);

  const foundRes = createMockRes();
  await controller.getContactById({ user: { _id: "u3" }, params: { id: "valid_id_888" } }, foundRes);
  assert.equal(foundRes.statusCode, 200);
  assert.equal(foundRes.body.success, true);
});

test("updateContact returns 200 on valid update and 400/404 on invalid data or ID", async () => {
  const badNameRes = createMockRes();
  await controller.updateContact({ user: { _id: "u4" }, params: { id: "contact_1" }, body: { name: "" } }, badNameRes);
  assert.equal(badNameRes.statusCode, 400);

  const notFoundRes = createMockRes();
  await controller.updateContact({ user: { _id: "u4" }, params: { id: "missing_id_99" }, body: { name: "Joe" } }, notFoundRes);
  assert.equal(notFoundRes.statusCode, 404);

  const successRes = createMockRes();
  await controller.updateContact({ user: { _id: "u4" }, params: { id: "valid_contact_77" }, body: { name: "Joe Jones", company: "Acme" } }, successRes);
  assert.equal(successRes.statusCode, 200);
  assert.equal(successRes.body.success, true);
  assert.equal(successRes.body.contact.name, "Joe Jones");
});

test("deleteContact returns 200 when deleted cleanly and 404 when ID does not exist", async () => {
  const notFoundRes = createMockRes();
  await controller.deleteContact({ user: { _id: "u5" }, params: { id: "nonexistent_delete_id" } }, notFoundRes);
  assert.equal(notFoundRes.statusCode, 404);

  const successRes = createMockRes();
  await controller.deleteContact({ user: { _id: "u5" }, params: { id: "valid_delete_id_22" } }, successRes);
  assert.equal(successRes.statusCode, 200);
  assert.equal(successRes.body.success, true);
  assert.equal(successRes.body.contactId, "valid_delete_id_22");
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
