"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const service = require("./crmEmailAutomationService");
const catalog = require("./crmEmailAutomationCatalog");
const { closeQueueConnections } = require("../utils/queue");

const HOUR = 60 * 60 * 1000;
const id = () => new mongoose.Types.ObjectId();

test("dedupe keys are stable per lead/booking so a trigger can only email once", () => {
  const leadId = id();
  const appointmentId = id();
  assert.equal(service.buildDedupeKey("new_lead", { leadId }), service.buildDedupeKey("new_lead", { leadId }));
  assert.equal(service.buildDedupeKey("new_lead", { leadId }), `new_lead:lead:${leadId}`);
  assert.equal(service.buildDedupeKey("booking_created", { appointmentId }), `booking_created:appt:${appointmentId}`);
  for (const trigger of catalog.SCHEDULED_TRIGGERS) {
    assert.equal(service.buildDedupeKey(trigger, { appointmentId }), `${trigger}:appt:${appointmentId}`);
  }
  // Different triggers for the same booking do not collide.
  assert.notEqual(
    service.buildDedupeKey("booking_reminder", { appointmentId }),
    service.buildDedupeKey("booking_day", { appointmentId })
  );
});

test("listing-view emails are limited to one per lead per calendar month", () => {
  const leadId = id();
  const a = service.buildDedupeKey("lead_viewed", { leadId, now: new Date(2026, 9, 1) });
  const b = service.buildDedupeKey("lead_viewed", { leadId, now: new Date(2026, 9, 30) });
  const c = service.buildDedupeKey("lead_viewed", { leadId, now: new Date(2026, 10, 1) });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("failed deliveries back off exponentially", () => {
  const now = new Date(2026, 0, 1, 12, 0);
  assert.equal(service.nextRetryAt(1, now) - now, 5 * 60 * 1000);
  assert.equal(service.nextRetryAt(2, now) - now, 10 * 60 * 1000);
  assert.equal(service.nextRetryAt(3, now) - now, 20 * 60 * 1000);
});

test("the appointment scan window covers every booking whose email is due now", () => {
  const now = new Date(2026, 9, 10, 9, 0);
  const cases = [
    ["booking_reminder", { amount: 1, unit: "days" }, new Date(2026, 9, 11, 8, 30)],
    ["booking_day", { sendHour: 8 }, new Date(2026, 9, 10, 17, 0)],
    ["booking_completed", { amount: 2, unit: "hours" }, new Date(2026, 9, 10, 6, 30)],
    ["booking_followup", { amount: 3, unit: "days" }, new Date(2026, 9, 7, 8, 0)],
  ];
  for (const [trigger, timing, start] of cases) {
    const sendAt = catalog.computeBookingSendAt(trigger, timing, start);
    assert.ok(catalog.isBookingSendDue(trigger, { sendAt, start, now }), `${trigger} should be due`);
    const appointmentDate = new Date(start);
    appointmentDate.setHours(0, 0, 0, 0);
    const window = service.appointmentScanWindow(trigger, timing, now);
    assert.ok(appointmentDate >= window.from && appointmentDate <= window.to, `${trigger} booking is inside the scan window`);
  }
});

test("skipReason re-checks the automation, booking and lead at send time", () => {
  const now = new Date(2026, 9, 10, 9, 0);
  const automation = { isEnabled: true, template: { approvedAt: new Date() } };
  const business = { _id: id(), businessName: "Glow" };
  const upcoming = { status: "Scheduled", appointmentDate: new Date(2026, 9, 11), timeSlot: "10:00 AM" };
  const reminder = { trigger: "booking_reminder" };

  assert.equal(service.skipReason(reminder, { automation, business, appointment: upcoming }, now), null);
  assert.match(service.skipReason(reminder, { automation: { ...automation, isEnabled: false }, business, appointment: upcoming }, now), /switched off/);
  assert.match(service.skipReason(reminder, { automation: { isEnabled: true, template: { approvedAt: null } }, business, appointment: upcoming }, now), /not approved/);
  assert.match(service.skipReason(reminder, { automation, business, appointment: { ...upcoming, status: "Canceled" } }, now), /canceled/);
  assert.match(service.skipReason(reminder, { automation, business, appointment: { ...upcoming, status: "Rescheduled" } }, now), /rescheduled/);
  assert.match(service.skipReason(reminder, { automation, business, appointment: null }, now), /no longer exists/);
  const started = { status: "Scheduled", appointmentDate: new Date(2026, 9, 10), timeSlot: "8:00 AM" };
  assert.match(service.skipReason(reminder, { automation, business, appointment: started }, now), /already started/);
  // After-booking emails are sent after the booking started.
  assert.equal(service.skipReason({ trigger: "booking_followup" }, { automation, business, appointment: started }, now), null);

  assert.match(service.skipReason({ trigger: "new_lead" }, { automation, business, lead: null }, now), /Lead no longer exists/);
  assert.equal(service.skipReason({ trigger: "new_lead" }, { automation, business, lead: { status: "New" } }, now), null);
  assert.match(service.skipReason({ trigger: "lead_viewed" }, { automation, business, lead: { status: "Booked" } }, now), /already Booked/);
});

test("variable values come from the lead, booking and business", () => {
  const business = { _id: id(), businessName: "Glow Studio" };
  const values = service.buildVariableValues({
    business,
    lead: { leadName: "Priya" },
    appointment: { serviceName: "Hair Spa", appointmentDate: new Date(2026, 9, 2), timeSlot: "10:30 AM" },
  });
  assert.equal(values.lead_name, "Priya");
  assert.equal(values.business_name, "Glow Studio");
  assert.equal(values.store_name, "Glow Studio");
  assert.equal(values.service_name, "Hair Spa");
  assert.equal(values.booking_date, "Friday, October 2nd 2026");
  assert.equal(values.booking_time, "10:30 AM");
  assert.match(values.booking_link, /\/bookinghistory$/);
  assert.match(values.listing_url, new RegExp(`/glow-studio/${business._id}$`));
  // Falls back to the customer's name, then a neutral greeting.
  assert.equal(service.buildVariableValues({ business, customer: { full_name: "Sam" } }).lead_name, "Sam");
  assert.equal(service.buildVariableValues({ business }).lead_name, "there");
  assert.equal(service.buildVariableValues({ business, context: { serviceName: "Facial" } }).service_name, "Facial");
});

test("unsubscribe links point at the public unsubscribe endpoint", () => {
  const link = service.buildUnsubscribeLink("a+b@example.com");
  assert.match(link, /\/api\/unsubscribe\?email=a%2Bb%40example\.com&source=crm_followup&format=html$/);
});

test("event handlers and the scheduler never throw without a database", async () => {
  assert.equal(await service.onLeadCreated(null), null);
  assert.equal(await service.onLeadCreated({ _id: id(), businessId: id(), status: "New" }), null);
  assert.equal(await service.onListingViewed({ businessId: id(), viewer: { _id: id(), email: "a@b.co" } }), null);
  assert.equal(await service.onListingViewed({ businessId: "not-an-id", viewer: { _id: id() } }), null);
  assert.equal(await service.onBookingCreated({ _id: id(), businessId: id() }, { _id: id() }), null);
  assert.deepEqual(await service.processDispatch(id()), { status: "ignored" });
  assert.deepEqual(await service.runScheduler(), { skipped: true });
});

after(async () => {
  try { await closeQueueConnections(); } catch { /* ignore */ }
});
