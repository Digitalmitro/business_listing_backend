"use strict";

/**
 * Uploading a contact list with email permission starts the introduction journey
 * automatically, and contacts left waiting are picked up when such a journey is
 * switched on. Runs against a LOCAL MongoDB only (see crmEngagement.integration.test.js):
 *
 *   CRM_TEST_MONGO_URI=mongodb://127.0.0.1:27999/uc_engagement_test \
 *   REDIS_HOST=127.0.0.1 REDIS_PORT=6399 npm run test:integration
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BASE_URI = process.env.CRM_TEST_MONGO_URI || "";
const LOCAL = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(BASE_URI);
// Own database, so this file never disturbs the main engagement suite.
const URI = LOCAL ? BASE_URI.replace(/\/[^/?]*(\?|$)/, "/uc_import_auto_journey_test$1") : "";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.CRM_LINK_SECRET = "test-link-secret";
process.env.FRONTEND_URL = "https://front.test";
process.env.BACKEND_URL = "https://api.test";

const mongoose = require("mongoose");
const User = require("../models/User");
const Business = require("../models/Business");
const CrmContact = require("../models/CrmContact");
const CrmContactImport = require("../models/CrmContactImport");
const CrmJourney = require("../models/CrmJourney");
const CrmJourneyEnrollment = require("../models/CrmJourneyEnrollment");
const CrmEngagementTemplate = require("../models/CrmEngagementTemplate");
const CrmEngagementSettings = require("../models/CrmEngagementSettings");
const UnsubscribedEmail = require("../models/UnsubscribedEmail");
const { CrmLead } = require("../models/CrmLead");
const automation = require("../services/crmEmailAutomationService");
const journeys = require("../services/crmJourneyService");
const imports = require("../services/crmContactImportService");
const { closeQueueConnections } = require("../utils/queue");

const skip = !LOCAL && "set CRM_TEST_MONGO_URI to a localhost MongoDB to run";

async function makeBusiness(name, email) {
  const owner = await User.create({ full_name: `${name} Owner`, email });
  const _id = new mongoose.Types.ObjectId();
  await Business.collection.insertOne({
    _id,
    businessName: name,
    userId: owner._id,
    isBlocked: false,
    address: { city: "Kolkata", country: "India", state: "WB", pincode: "700001" },
    location: { type: "Point", coordinates: [88.36, 22.57] },
    category: [],
  });
  return { owner, business: await Business.findById(_id).lean() };
}

async function importCsv({ business, owner, rows, consentConfirmed = true }) {
  const tmp = path.join(os.tmpdir(), `leads-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  fs.writeFileSync(tmp, ["name,email,phone", ...rows].join("\n"));
  const analyzed = await imports.analyzeImport({ business, file: { path: tmp, originalname: "leads.csv" }, userId: owner._id, useAi: false });
  const result = await imports.commitImport({
    business,
    importId: analyzed.importId,
    mapping: analyzed.suggestedMapping,
    options: { duplicateMode: "fill_empty", tags: [], consentConfirmed, engagement: "auto" },
    userId: owner._id,
  });
  return { importId: analyzed.importId, result };
}

async function waitFor(check, { tries = 80, ms = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, ms));
  }
  return null;
}

async function introEnrollments(businessId) {
  const intro = await CrmJourney.findOne({ businessId, starterKey: "imported_intro" }).lean();
  return CrmJourneyEnrollment.countDocuments({ businessId, journeyId: intro._id });
}

before(async () => {
  if (skip) return;
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  await automation.ensureIndexes();
  await CrmLead.createIndexes();
  await UnsubscribedEmail.createIndexes();
  automation.deliver = async () => ({ success: true, info: { messageId: "stub" } });
});

after(async () => {
  if (skip) return;
  await mongoose.disconnect();
  await closeQueueConnections().catch(() => {});
});

test("uploading a list with permission switches the introduction journey on and enrols the list", { skip }, async () => {
  // A business that never opened the engagement tab: nothing seeded, emails off.
  const { owner, business } = await makeBusiness("Fresh Studio", "fresh-owner@biz.test");
  assert.equal(await CrmEngagementSettings.countDocuments({ businessId: business._id }), 0);

  const { importId, result } = await importCsv({
    business,
    owner,
    rows: ["Riya Sen,riya@leads.test,9876500101", "Amit Roy,amit@leads.test,9876500102", "Tina Paul,tina@leads.test,"],
  });
  assert.equal(result.summary.created, 3);
  assert.ok(result.engagementSetup.includes("Engagement emails switched on"));
  assert.ok(result.engagementSetup.some((c) => /journey switched on/.test(c)));

  const settings = await CrmEngagementSettings.findOne({ businessId: business._id }).lean();
  assert.equal(settings.enabled, true);
  const intro = await CrmJourney.findOne({ businessId: business._id, starterKey: "imported_intro" }).lean();
  assert.equal(intro.isEnabled, true);
  const introTemplates = await CrmEngagementTemplate.find({ _id: { $in: intro.steps.map((s) => s.templateId) } }).lean();
  assert.ok(introTemplates.every((t) => t.approvedAt), "introduction templates approved");
  // Only the introduction journey is switched on; the others stay off.
  assert.equal(await CrmJourney.countDocuments({ businessId: business._id, isEnabled: true }), 1);

  const done = await waitFor(async () => (await CrmContactImport.findById(importId).lean()).triage.status === "done");
  assert.ok(done, "import triage finished");
  assert.equal(await introEnrollments(business._id), 3);
});

test("a second upload doesn't change anything that is already set up", { skip }, async () => {
  const business = await Business.findOne({ businessName: "Fresh Studio" }).lean();
  const owner = await User.findById(business.userId).lean();
  const { importId, result } = await importCsv({ business, owner, rows: ["Neel Das,neel@leads.test,9876500103"] });
  assert.deepEqual(result.engagementSetup, []);
  await waitFor(async () => (await CrmContactImport.findById(importId).lean()).triage.status === "done");
  assert.equal(await introEnrollments(business._id), 4);
});

test("an upload without email permission emails nobody and switches nothing on", { skip }, async () => {
  const { owner, business } = await makeBusiness("No Consent Cafe", "noconsent-owner@biz.test");
  const { result } = await importCsv({ business, owner, rows: ["Sam Bose,sam@leads.test,9876500104"], consentConfirmed: false });
  assert.equal(result.summary.created, 1);
  assert.deepEqual(result.engagementSetup, []);
  assert.equal(await CrmJourney.countDocuments({ businessId: business._id, isEnabled: true }), 0);
  assert.equal(await CrmJourneyEnrollment.countDocuments({ businessId: business._id }), 0);
});

test("contacts left waiting are enrolled as soon as the introduction journey is switched on", { skip }, async () => {
  const { owner, business } = await makeBusiness("Waiting Room", "waiting-owner@biz.test");
  const { importId } = await importCsv({ business, owner, rows: ["Ola Ghosh,ola@leads.test,9876500105", "Pia Sur,pia@leads.test,9876500106"] });
  await waitFor(async () => (await CrmContactImport.findById(importId).lean()).triage.status === "done");

  // Recreate what happened before this change: the journey off, the list parked as waiting.
  const intro = await CrmJourney.findOne({ businessId: business._id, starterKey: "imported_intro" });
  await journeys.setJourneyEnabled({ businessId: business._id, journeyId: intro._id, isEnabled: false });
  await CrmJourneyEnrollment.deleteMany({ businessId: business._id });
  await CrmContact.updateMany({ businessId: business._id }, { $set: { "triage.status": "waiting", "triage.reason": "No journey for imported or inactive contacts is switched on." } });

  await journeys.setJourneyEnabled({ businessId: business._id, journeyId: intro._id, isEnabled: true, userId: owner._id });
  const enrolled = await waitFor(async () => (await introEnrollments(business._id)) === 2);
  assert.ok(enrolled, "waiting contacts were enrolled after the journey was switched on");
  assert.equal(await CrmContact.countDocuments({ businessId: business._id, "triage.status": "waiting" }), 0);
});
