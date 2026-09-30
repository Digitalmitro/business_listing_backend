"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const imports = require("./crmContactImportService");
const { closeQueueConnections } = require("../utils/queue");

after(async () => {
  await closeQueueConnections().catch(() => {});
});

test("rule mapping recognises common header names", () => {
  const mapping = imports.ruleMapping(["Customer Name", "Email Address", "Mobile No", "Last Visit Date", "Segment", "Accepts Marketing", "Random"]);
  assert.equal(mapping["Customer Name"], "name");
  assert.equal(mapping["Email Address"], "email");
  assert.equal(mapping["Mobile No"], "phone");
  assert.equal(mapping["Last Visit Date"], "last_activity");
  assert.equal(mapping.Segment, "tags");
  assert.equal(mapping["Accepts Marketing"], "email_status");
  assert.equal(mapping.Random, undefined);
});

test("a mapping needs an email or phone column and one column per field", () => {
  assert.throws(() => imports.cleanMapping(["A"], { A: "name" }), /Email address/);
  assert.throws(() => imports.cleanMapping(["A", "B"], { A: "email", B: "email" }), /Two columns/);
  assert.deepEqual(imports.cleanMapping(["A", "B", "C"], { A: "email", B: "tags", C: "ignore" }), { A: "email", B: "tags" });
});

test("rows are validated, split names joined, opt-outs and dates parsed", () => {
  const mapping = { E: "email", F: "first_name", L: "last_name", P: "phone", S: "email_status", D: "last_activity", T: "tags" };
  const ok = imports.mapRow({ E: " Mailto:Ann@Example.COM ", F: "Ann", L: "Lee", P: "+91 98765-43210", S: "No", D: "05/03/2026", T: "vip; gold" }, mapping);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.record.email, "ann@example.com");
  assert.equal(ok.record.name, "Ann Lee");
  assert.equal(ok.record.phone, "+919876543210");
  assert.equal(ok.record.unsubscribed, true);
  assert.equal(ok.record.lastActivityAt.getMonth(), 2); // 5 March (day-first)
  assert.deepEqual(ok.record.tags, ["vip", "gold"]);
  assert.equal(imports.mapRow({ E: "bad@", F: "x" }, mapping).errors[0].message, "Invalid email address");
  assert.match(imports.mapRow({ F: "Nobody" }, mapping).errors[0].message, /no email address or phone/);
  const future = imports.mapRow({ E: "f@x.io", D: "2999-01-01" }, mapping);
  assert.equal(future.record.lastActivityAt, null);
});

test("duplicate rows in a file are merged", () => {
  const mapping = { E: "email", N: "name", T: "tags" };
  const { records, duplicatesInFile, invalidRows } = imports.prepareRows(
    [{ E: "a@x.io", N: "", T: "one" }, { E: "A@x.io", N: "Ann", T: "two" }, { E: "nope", N: "Bad" }],
    mapping
  );
  assert.equal(records.length, 1);
  assert.equal(duplicatesInFile, 1);
  assert.equal(invalidRows, 1);
  assert.equal(records[0].name, "Ann");
  assert.deepEqual(records[0].tags, ["one", "two"]);
  assert.equal(records[0].row, 2);
});

test("updating existing contacts never loses data or re-subscribes anyone", () => {
  const now = new Date();
  const existing = { name: "Old Name", company: "", email: "a@x.io", emailStatus: "unsubscribed", consent: { basis: "opt_in" }, engagement: { lastActivityAt: new Date(2026, 5, 1) }, notes: "n1" };
  const record = { name: "New Name", company: "Acme", tags: ["t"], notes: "n2", lastActivityAt: new Date(2025, 0, 1), unsubscribed: false };
  const fill = imports.updateForExisting(existing, record, imports.normalizeOptions({ duplicateMode: "fill_empty", consentConfirmed: true }), now);
  assert.equal(fill.$set.name, undefined);
  assert.equal(fill.$set.company, "Acme");
  assert.equal(fill.$set.notes, "n1\nn2");
  assert.equal(fill.$set.emailStatus, undefined);
  assert.equal(fill.$set.consent, undefined); // stronger consent kept
  assert.equal(fill.$set["engagement.lastActivityAt"], undefined); // older date ignored
  const over = imports.updateForExisting(existing, record, imports.normalizeOptions({ duplicateMode: "overwrite" }), now);
  assert.equal(over.$set.name, "New Name");
  const skip = imports.updateForExisting({ ...existing, emailStatus: "subscribed" }, { ...record, unsubscribed: true }, imports.normalizeOptions({ duplicateMode: "skip" }), now);
  assert.deepEqual(Object.keys(skip.$set).sort(), ["emailStatus", "emailStatusChangedAt"]); // opt-outs always honoured
});

test("triage segments are anonymous and the rules prefer waiting over a poor fit", () => {
  const now = new Date(2026, 9, 1);
  const seg = imports.segmentOf({ name: "Ann", email: "a@x.io", engagement: { lastActivityAt: new Date(2025, 0, 1) }, tags: ["vip"] }, null, now);
  assert.equal(seg.key, "365d+|none|vip");
  assert.doesNotMatch(JSON.stringify(seg), /Ann|a@x\.io/);
  const intro = { _id: "i", trigger: { signal: "contact_imported" } };
  const winBack = { _id: "w", trigger: { signal: "inactive" } };
  assert.equal(imports.ruleDecision(seg, [intro, winBack]).journeyId, "w");
  assert.equal(imports.ruleDecision({ recency: "0-30d", relation: "customer" }, [intro, winBack]).action, "wait");
  assert.equal(imports.ruleDecision({ recency: "unknown", relation: "lost_lead" }, [intro]).action, "wait");
  assert.equal(imports.ruleDecision({ recency: "unknown", relation: "none" }, [intro]).journeyId, "i");
  assert.equal(imports.ruleDecision({ recency: "unknown", relation: "none" }, []).action, "wait");
});
