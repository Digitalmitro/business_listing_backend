"use strict";

/**
 * End-to-end tests for contact engagement against a LOCAL MongoDB and Redis.
 *
 *   CRM_TEST_MONGO_URI=mongodb://127.0.0.1:27999/uc_engagement_test \
 *   REDIS_HOST=127.0.0.1 REDIS_PORT=6399 npm run test:integration
 *
 * The suite refuses to run against anything but localhost: the app's normal
 * MONGO_URI is a shared production cluster. Email delivery is stubbed.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const URI = process.env.CRM_TEST_MONGO_URI || "";
const LOCAL = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(URI);
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.CRM_LINK_SECRET = "test-link-secret";
process.env.FRONTEND_URL = "https://front.test";
process.env.BACKEND_URL = "https://api.test";

const mongoose = require("mongoose");
const User = require("../models/User");
const Business = require("../models/Business");
const CrmContact = require("../models/CrmContact");
const CrmContactActivity = require("../models/CrmContactActivity");
const CrmJourney = require("../models/CrmJourney");
const CrmJourneyEnrollment = require("../models/CrmJourneyEnrollment");
const CrmEngagementTemplate = require("../models/CrmEngagementTemplate");
const CrmEmailDispatch = require("../models/CrmEmailDispatch");
const CrmContactImport = require("../models/CrmContactImport");
const UnsubscribedEmail = require("../models/UnsubscribedEmail");
const { CrmLead } = require("../models/CrmLead");
const automation = require("../services/crmEmailAutomationService");
const journeys = require("../services/crmJourneyService");
const contacts = require("../services/crmEngagementContactService");
const templates = require("../services/crmEngagementTemplateService");
const signals = require("../services/crmSignalService");
const imports = require("../services/crmContactImportService");
const links = require("../services/crmEngagementLinks");
const publicController = require("../controllers/crmEngagementPublicController");
const { closeQueueConnections } = require("../utils/queue");

const skip = !LOCAL && "set CRM_TEST_MONGO_URI to a localhost MongoDB to run";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const sent = [];
let deliverImpl = null;
let owner;
let customer;
let business;
let T0;

function mockRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; },
    type() { return this; },
    send(d) { this.body = d; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    redirect(c, u) { this.statusCode = c; this.location = u; return this; },
  };
}

async function journeyByKey(key) {
  return CrmJourney.findOne({ businessId: business._id, starterKey: key });
}

async function enableJourneys(...keys) {
  for (const key of keys) {
    const j = await journeyByKey(key);
    await journeys.setJourneyEnabled({ businessId: business._id, journeyId: j._id, isEnabled: true });
  }
}

before(async () => {
  if (skip) return;
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  await automation.ensureIndexes();
  await CrmLead.createIndexes();
  await UnsubscribedEmail.createIndexes();

  // Stub email delivery: record instead of sending.
  automation.deliver = async (args) => {
    if (deliverImpl) return deliverImpl(args);
    sent.push(args);
    return { success: true, info: { messageId: `msg-${sent.length}` } };
  };

  owner = await User.create({ full_name: "Owner Person", email: "owner@biz.test" });
  customer = await User.create({ full_name: "Bina Customer", email: "bina@example.com", phone: "9990001111" });
  const bizId = new mongoose.Types.ObjectId();
  await Business.collection.insertOne({
    _id: bizId,
    businessName: "ABC Salon",
    userId: owner._id,
    isBlocked: false,
    address: { city: "Pune", country: "India", state: "MH", pincode: "411001" },
    location: { type: "Point", coordinates: [73.8, 18.5] },
    category: [],
  });
  business = await Business.findById(bizId).lean();

  await contacts.saveSettings({
    ownerId: owner._id,
    businessId: business._id,
    input: { enabled: true, sendWindow: { startHour: 0, endHour: 24 }, timezone: "UTC" },
  });
  assert.equal(await journeys.seedBusiness(business), true);
  const all = await CrmEngagementTemplate.find({ businessId: business._id });
  for (const t of all) await templates.approveTemplate({ businessId: business._id, templateId: t._id, userId: owner._id });
  T0 = new Date(Date.now() + 60 * DAY); // future, so the real clock never interferes
});

after(async () => {
  if (skip) return;
  await mongoose.disconnect();
  await closeQueueConnections().catch(() => {});
});

test("seeding copies starter templates and switched-off journeys once", { skip }, async () => {
  assert.equal(await CrmEngagementTemplate.countDocuments({ businessId: business._id }), 7);
  assert.equal(await CrmJourney.countDocuments({ businessId: business._id }), 5);
  assert.equal(await CrmJourney.countDocuments({ businessId: business._id, isEnabled: true }), 0);
  assert.equal(await journeys.seedBusiness(business), false);
  assert.equal(await CrmEngagementTemplate.countDocuments({ businessId: business._id }), 7);
});

test("capture → recently-viewed journey → personalised, tracked email → no-click follow-up skipped after a click", { skip }, async () => {
  await enableJourneys("recently_viewed_followup");
  const out = await signals.onContactCaptured({
    businessId: business._id,
    email: "Asha.Rao@Example.com",
    name: "Asha Rao",
    visitorId: "vid_abcdefghijklmnop1234",
    item: { kind: "service", name: "Hair Spa" },
    now: T0,
  });
  assert.ok(out.created);
  const contact = await CrmContact.findOne({ businessId: business._id, email: "asha.rao@example.com" }).select("+visitorIds").lean();
  assert.equal(contact.consent.basis, "opt_in");
  assert.equal(contact.source, "Listing Visitor");
  assert.deepEqual(contact.visitorIds, ["vid_abcdefghijklmnop1234"]);
  assert.equal(contact.interests[0].name, "Hair Spa");

  const enrollment = await CrmJourneyEnrollment.findOne({ contactId: contact._id }).lean();
  assert.equal(enrollment.status, "active");
  assert.equal(enrollment.nextRunAt.getTime(), T0.getTime() + HOUR);

  // Not due yet.
  await automation.runScheduler({ now: new Date(T0.getTime() + 30 * MIN) });
  assert.equal(sent.length, 0);

  const t1 = new Date(T0.getTime() + HOUR + MIN);
  await automation.runScheduler({ now: t1 });
  assert.equal(sent.length, 1);
  const email = sent[0];
  assert.equal(email.to, "asha.rao@example.com");
  assert.equal(email.subject, "You recently viewed Hair Spa");
  assert.match(email.html, /Hi Asha,/);
  assert.match(email.html, /https:\/\/api\.test\/api\/crm\/engagement\/public\/r\//);
  assert.doesNotMatch(email.html, /href="https:\/\/front\.test/); // every link is tracked
  assert.match(email.unsubscribeLink, /\/api\/crm\/engagement\/public\/unsubscribe\?t=/);
  assert.equal(email.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

  const afterSend = await CrmJourneyEnrollment.findById(enrollment._id).lean();
  assert.equal(afterSend.currentStep, 1);
  assert.equal(afterSend.emailsSent, 1);
  assert.equal(afterSend.nextRunAt.getTime(), t1.getTime() + 3 * DAY);
  const dispatch = await CrmEmailDispatch.findOne({ enrollmentId: enrollment._id }).lean();
  assert.equal(dispatch.status, "sent");
  assert.equal(dispatch.category, "marketing");

  // Click a tracked link through the public redirect.
  const token = decodeURIComponent(/public\/r\/([^"]+)"/.exec(email.html)[1]);
  const res = mockRes();
  await publicController.redirect({ params: { token } }, res);
  assert.equal(res.statusCode, 302);
  assert.match(res.location, /^https:\/\/front\.test\//);
  await signals.onEmailClicked(dispatch._id, { now: new Date(t1.getTime() + 10 * MIN) }); // wait for the async click
  const clicked = await CrmEmailDispatch.findById(dispatch._id).lean();
  assert.ok(clicked.clickCount >= 1);

  // Follow-up condition is "no click since last email": skipped, journey completes.
  await automation.runScheduler({ now: new Date(t1.getTime() + 3 * DAY + MIN) });
  assert.equal(sent.length, 1);
  const done = await CrmJourneyEnrollment.findById(enrollment._id).lean();
  assert.equal(done.status, "completed");
  assert.ok(done.history.some((h) => h.type === "skipped"));
});

test("browsing is attributed only to known contacts", { skip }, async () => {
  const known = await signals.onListingActivity({
    businessId: business._id,
    event: "service_viewed",
    item: { kind: "service", name: "Facial" },
    visitorId: "vid_abcdefghijklmnop1234",
    now: new Date(T0.getTime() + 5 * DAY),
  });
  assert.ok(known);
  const contact = await CrmContact.findOne({ email: "asha.rao@example.com" }).lean();
  assert.ok(contact.interests.some((i) => i.name === "Facial"));

  const before = await CrmContact.countDocuments();
  const unknown = await signals.onListingActivity({ businessId: business._id, event: "business_viewed", visitorId: "vid_zzzzzzzzzzzzzzzzzzzz" });
  assert.equal(unknown, null);
  const ownerView = await signals.onListingActivity({ businessId: business._id, event: "business_viewed", viewer: owner });
  assert.equal(ownerView, null);
  assert.equal(await CrmContact.countDocuments(), before);
});

test("abandoned booking replaces a lower-priority journey, then a booking converts it", { skip }, async () => {
  await enableJourneys("abandoned_booking");
  const t = new Date(T0.getTime() + 10 * DAY);
  await signals.onContactCaptured({ businessId: business._id, email: "bina@example.com", name: "Bina Customer", visitorId: "vid_binabinabinabina0001", now: t });
  await signals.onListingActivity({ businessId: business._id, event: "booking_started", item: { kind: "service", name: "Pedicure" }, visitorId: "vid_binabinabinabina0001", now: new Date(t.getTime() + 5 * MIN) });
  const contact = await CrmContact.findOne({ email: "bina@example.com" }).lean();
  assert.ok(contact.bookings.lastStartedAt);

  const sweepAt = new Date(t.getTime() + 2 * HOUR + 10 * MIN);
  journeys._resetDerivedTimer();
  const countBefore = sent.length;
  await automation.runScheduler({ now: sweepAt });
  const enrollments = await CrmJourneyEnrollment.find({ contactId: contact._id }).populate("journeyId", "starterKey").lean();
  const recently = enrollments.find((e) => e.journeyId.starterKey === "recently_viewed_followup");
  const abandoned = enrollments.find((e) => e.journeyId.starterKey === "abandoned_booking");
  assert.equal(recently.status, "exited");
  assert.match(recently.exitReason, /Moved to/);
  assert.equal(abandoned.status, "active");
  assert.equal(sent.length, countBefore + 1);
  const email = sent[sent.length - 1];
  assert.match(email.subject, /almost done/);

  // The booking itself: contact becomes a customer and the journey converts.
  const appointment = { _id: new mongoose.Types.ObjectId(), userId: customer._id, businessId: business._id, serviceName: "Pedicure", appointmentDate: new Date(t.getTime() + 3 * DAY), timeSlot: "10:30 AM", status: "Scheduled" };
  await signals.onBookingCreated(appointment, customer, { now: new Date(sweepAt.getTime() + HOUR) });
  const converted = await CrmJourneyEnrollment.findById(abandoned._id).lean();
  assert.equal(converted.status, "converted");
  const customerContact = await CrmContact.findById(contact._id).lean();
  assert.equal(customerContact.bookings.count, 1);
  assert.equal(customerContact.lifecycle, "customer");
  assert.equal(String(customerContact.userId), String(customer._id));
});

test("frequency caps defer the next marketing email instead of sending it", { skip }, async () => {
  const contact = await CrmContact.findOne({ email: "bina@example.com" }).lean();
  const lastSent = await CrmEmailDispatch.findOne({ contactId: contact._id, status: "sent" }).sort({ sentAt: -1 }).lean();
  await enableJourneys("win_back");
  const winBack = await journeyByKey("win_back");
  const now = new Date(lastSent.sentAt.getTime() + 2 * HOUR);
  const res = await journeys.enroll(contact, winBack.toObject(), { signal: "inactive", now });
  assert.ok(res.enrollment, res.skipped);
  const enrollment = await CrmJourneyEnrollment.findById(res.enrollment._id).lean();
  assert.equal(enrollment.awaitingDispatchId, null);
  assert.equal(enrollment.nextRunAt.getTime(), lastSent.sentAt.getTime() + 48 * HOUR);
  assert.equal(enrollment.history[enrollment.history.length - 1].type, "deferred");
  await journeys.stopEnrollment({ businessId: business._id, enrollmentId: enrollment._id, userName: "Owner" });
  assert.equal((await CrmJourneyEnrollment.findById(enrollment._id).lean()).status, "exited");
});

test("signed unsubscribe: GET only confirms, POST unsubscribes from this business or everything", { skip }, async () => {
  const contact = await CrmContact.findOne({ email: "asha.rao@example.com" }).lean();
  const t = links.unsubscribeToken({ contactId: contact._id, businessId: business._id, email: contact.email });

  const page = mockRes();
  await publicController.unsubscribePage({ query: { t } }, page);
  assert.equal(page.statusCode, 200);
  assert.equal((await CrmContact.findById(contact._id).lean()).emailStatus, "subscribed");

  const bad = mockRes();
  await publicController.unsubscribePage({ query: { t: `${t}x` } }, bad);
  assert.equal(bad.statusCode, 400);

  const res = mockRes();
  await publicController.unsubscribe({ body: { t, scope: "all" }, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal((await CrmContact.findById(contact._id).lean()).emailStatus, "unsubscribed");
  assert.ok(await UnsubscribedEmail.exists({ email: "asha.rao@example.com" }));
  const activity = await CrmContactActivity.findOne({ contactId: contact._id, type: "unsubscribed" }).lean();
  assert.ok(activity);
});

test("bulk import: mapping, validation, duplicates, preserved data, opt-outs and AI-free triage with pacing", { skip }, async () => {
  await enableJourneys("imported_intro");
  await contacts.saveSettings({ ownerId: owner._id, businessId: business._id, input: { importDailyLimit: 10 } });
  const recent = new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10);
  const old = new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10);
  const csv = [
    "Full Name,E-mail,Mobile,Last Visit,Tags,Subscribed",
    `Chen Li,chen@example.com,9876500001,${recent},vip,yes`,
    `Old Friend,old@example.com,9876500002,${old},,yes`,
    "No History,nohistory@example.com,,,,",
    "Bad Email,not-an-email,,,,",
    "Chen Again,CHEN@example.com,,,regular,",
    "Asha Imported,asha.rao@example.com,9876500003,,,yes",
    "Opted Out,optout@example.com,,,,no",
    ",,,,,",
  ].join("\n");
  const tmp = path.join(os.tmpdir(), `contacts-${Date.now()}.csv`);
  fs.writeFileSync(tmp, csv);

  const analyzed = await imports.analyzeImport({ business, file: { path: tmp, originalname: "contacts.csv" }, userId: owner._id, useAi: false });
  assert.equal(analyzed.suggestedMapping["E-mail"], "email");
  assert.equal(analyzed.suggestedMapping["Full Name"], "name");
  assert.equal(analyzed.suggestedMapping["Last Visit"], "last_activity");
  assert.equal(analyzed.suggestedMapping.Subscribed, "email_status");
  assert.equal(analyzed.rowCount, 7);
  assert.equal(analyzed.dryRun.invalidRows, 1);
  assert.equal(analyzed.dryRun.duplicatesInFile, 1);
  assert.equal(analyzed.dryRun.matchesExisting, 1);
  assert.ok(!fs.existsSync(tmp), "upload moved to private storage");

  const result = await imports.commitImport({
    business,
    importId: analyzed.importId,
    mapping: analyzed.suggestedMapping,
    options: { duplicateMode: "fill_empty", tags: ["spring-list"], consentConfirmed: true, engagement: "auto" },
    userId: owner._id,
  });
  assert.equal(result.summary.created, 4);
  assert.equal(result.summary.updated, 1);
  assert.equal(result.summary.invalid, 1);
  assert.equal(result.summary.duplicatesInFile, 1);
  assert.equal(result.summary.suppressed, 1);
  assert.equal(result.errors[0].field, "email");

  const chen = await CrmContact.findOne({ email: "chen@example.com" }).lean();
  assert.deepEqual([...chen.tags].sort(), ["regular", "spring-list", "vip"]);
  assert.equal(chen.consent.basis, "import_confirmed");
  // Existing contact kept its name, activity and opt-out.
  const asha = await CrmContact.findOne({ email: "asha.rao@example.com" }).lean();
  assert.equal(asha.name, "Asha Rao");
  assert.equal(asha.emailStatus, "unsubscribed");
  assert.equal(asha.phone, "9876500003");
  assert.ok(asha.interests.length >= 2);
  const optout = await CrmContact.findOne({ email: "optout@example.com" }).lean();
  assert.equal(optout.emailStatus, "unsubscribed");
  assert.equal(optout.triage.status, null);

  // Triage (rules; AI is not configured in tests). Win-back is on from the previous test.
  let doc;
  for (let i = 0; i < 50; i++) {
    doc = await CrmContactImport.findById(analyzed.importId).lean();
    if (doc.triage.status === "done") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(doc.triage.status, "done");
  assert.equal(doc.triage.decidedBy, "rules");
  const byEmail = async (email) => CrmContact.findOne({ email }).lean();
  const enrolledIn = async (email) => {
    const c = await byEmail(email);
    const e = await CrmJourneyEnrollment.findOne({ contactId: c._id, "context.importId": analyzed.importId }).populate("journeyId", "starterKey").lean();
    return e?.journeyId?.starterKey || null;
  };
  assert.equal(await enrolledIn("chen@example.com"), "imported_intro");
  assert.equal(await enrolledIn("old@example.com"), "win_back");
  assert.equal(await enrolledIn("nohistory@example.com"), "imported_intro");

  // Pacing: only importDailyLimit first emails per day.
  await contacts.saveSettings({ ownerId: owner._id, businessId: business._id, input: { importDailyLimit: 10 } });
  await CrmEngagementSettingsLimit(2);
  const sendAt = new Date(T0.getTime() + 20 * DAY);
  const before = sent.length;
  await automation.runScheduler({ now: sendAt });
  assert.equal(sent.length - before, 2);
  const deferred = await CrmJourneyEnrollment.findOne({ "context.importId": analyzed.importId, status: "active", awaitingDispatchId: null, currentStep: 0 }).lean();
  assert.ok(deferred && deferred.nextRunAt > sendAt);
  assert.match(deferred.history[deferred.history.length - 1].note, /Paced/);

  const csvErrors = await imports.errorsCsv(business._id, analyzed.importId);
  assert.match(csvErrors.csv, /Invalid email address/);
});

async function CrmEngagementSettingsLimit(limit) {
  // importDailyLimit has a minimum of 10 through the API; set it directly for the test.
  await require("../models/CrmEngagementSettings").updateOne({ businessId: business._id }, { $set: { importDailyLimit: limit } });
}

test("a hard bounce marks the contact bounced and ends the journey", { skip }, async () => {
  const contact = await CrmContact.findOne({ email: "nohistory@example.com" }).lean();
  const enrollment = await CrmJourneyEnrollment.findOne({ contactId: contact._id, status: "active" }).lean();
  deliverImpl = async () => ({ success: false, error: Object.assign(new Error("550 5.1.1 User unknown"), { responseCode: 550 }) });
  const now = new Date(Math.max(enrollment.nextRunAt?.getTime() || 0, T0.getTime() + 22 * DAY) + MIN);
  await CrmJourneyEnrollment.updateOne({ _id: enrollment._id }, { $set: { nextRunAt: now } });
  await automation.runScheduler({ now });
  deliverImpl = null;
  assert.equal((await CrmContact.findById(contact._id).lean()).emailStatus, "bounced");
  const ended = await CrmJourneyEnrollment.findById(enrollment._id).lean();
  assert.equal(ended.status, "exited");
  assert.match(ended.exitReason, /bounced/i);
});

test("editing an approved template clears approval and switches its journeys off", { skip }, async () => {
  const journey = await journeyByKey("imported_intro");
  assert.equal(journey.isEnabled, true);
  const template = await CrmEngagementTemplate.findById(journey.steps[0].templateId);
  const { notices } = await templates.saveTemplate({
    ownerId: owner._id,
    businessId: business._id,
    templateId: template._id,
    input: { name: template.name, subject: "Hello again from {{business_name}}", body: template.body },
  });
  assert.ok(notices.some((n) => /switched off/.test(n)));
  assert.equal((await CrmEngagementTemplate.findById(template._id).lean()).approvedAt, null);
  assert.equal((await CrmJourney.findById(journey._id).lean()).isEnabled, false);
  await assert.rejects(journeys.setJourneyEnabled({ businessId: business._id, journeyId: journey._id, isEnabled: true }), /approve/);
});

test("public capture validates input and never reveals whether a contact exists", { skip }, async () => {
  const cases = [
    [{ businessId: business._id, email: "x@example.com" }, 400], // no consent
    [{ businessId: business._id, email: "nope", consent: true }, 400],
    [{ businessId: "bad", email: "x@example.com", consent: true }, 400],
    [{ businessId: business._id, email: "bot@example.com", consent: true, website: "spam" }, 201],
    [{ businessId: business._id, email: "chen@example.com", consent: true }, 201],
  ];
  for (const [body, status] of cases) {
    const res = mockRes();
    await publicController.capture({ body, header: () => "" }, res);
    assert.equal(res.statusCode, status, JSON.stringify(body));
  }
  assert.equal(await CrmContact.countDocuments({ email: "bot@example.com" }), 0);
  const track = mockRes();
  await publicController.track({ body: { businessId: business._id, event: "business_viewed" }, header: () => "" }, track);
  assert.equal(track.statusCode, 202);
});
