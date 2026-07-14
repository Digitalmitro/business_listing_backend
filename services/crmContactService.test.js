"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const service = require("./crmContactService");
const { closeQueueConnections } = require("../utils/queue");

test("createContact validates required ownerId and name before creating", async () => {
  await assert.rejects(async () => {
    await service.createContact(null, { name: "Alice" });
  }, /ownerId is required/i);

  await assert.rejects(async () => {
    await service.createContact("owner_1", { name: "" });
  }, /Contact name is required/i);

  const contact = await service.createContact("owner_1", {
    name: "Alice Smith",
    company: "Acme Corp",
    email: "alice@acme.com",
    industry: "Technology",
    source: "Referral",
  });

  assert.equal(String(contact.ownerId), "owner_1");
  assert.equal(contact.name, "Alice Smith");
  assert.equal(contact.company, "Acme Corp");
  assert.equal(contact.source, "Referral");
});

test("getContacts handles search, filters, sorting, and pagination options cleanly", async () => {
  await assert.rejects(async () => {
    await service.getContacts(null);
  }, /ownerId is required/i);

  const result = await service.getContacts("owner_2", {
    page: 2,
    limit: 15,
    search: "Acme",
    industry: "Finance",
    source: "Website",
    sortBy: "name",
    sortOrder: "asc",
  });

  assert.ok(Array.isArray(result.contacts));
  assert.equal(result.page, 2);
  assert.equal(result.limit, 15);
});

test("getContactById throws ContactNotFoundError (404) if contact does not exist or unauthorized", async () => {
  await assert.rejects(async () => {
    await service.getContactById("owner_3", "missing_contact_id");
  }, (err) => {
    return err instanceof service.ContactNotFoundError && err.status === 404;
  });

  const valid = await service.getContactById("owner_3", "valid_id_123");
  assert.equal(valid.name, "Mock Contact");
});

test("updateContact validates name and updates fields or throws 404 on missing record", async () => {
  await assert.rejects(async () => {
    await service.updateContact("owner_4", "contact_id", { name: "" });
  }, /Contact name cannot be empty/i);

  await assert.rejects(async () => {
    await service.updateContact("owner_4", "nonexistent_contact_id", { name: "Bob" });
  }, (err) => {
    return err instanceof service.ContactNotFoundError && err.status === 404;
  });

  const updated = await service.updateContact("owner_4", "valid_contact_id", {
    name: "Bob Jones",
    company: "Globe LLC",
  });
  assert.equal(updated.name, "Bob Jones");
  assert.equal(updated.company, "Globe LLC");
});

test("deleteContact deletes contact or throws 404 on missing record", async () => {
  await assert.rejects(async () => {
    await service.deleteContact("owner_5", "nonexistent_id");
  }, (err) => {
    return err instanceof service.ContactNotFoundError && err.status === 404;
  });

  const res = await service.deleteContact("owner_5", "valid_delete_id");
  assert.equal(res.success, true);
  assert.equal(res.contactId, "valid_delete_id");
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
