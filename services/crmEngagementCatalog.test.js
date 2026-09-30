"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const catalog = require("./crmEngagementCatalog");

const HOUR = catalog.HOUR;
const DAY = catalog.DAY;

test("starter journeys only reference starter templates, and starter templates validate", () => {
  const keys = new Set(catalog.STARTER_TEMPLATES.map((t) => t.starterKey));
  for (const j of catalog.STARTER_JOURNEYS) {
    for (const s of j.steps) assert.ok(keys.has(s.template), `${j.starterKey} uses ${s.template}`);
    const normalized = catalog.normalizeJourney({ ...j, steps: j.steps.map((s) => ({ ...s, templateId: "x" })) });
    assert.equal(normalized.steps.length, j.steps.length);
    if (!["booking_created", "booking_canceled"].includes(j.trigger.signal)) assert.ok(normalized.exitOn.includes("booking_created"));
  }
  for (const t of catalog.STARTER_TEMPLATES) {
    assert.doesNotThrow(() => catalog.validateEngagementTemplate(t), t.starterKey);
  }
  // The six requested situations are all covered.
  for (const phrase of ["You recently viewed", "Still interested", "Can we help you find", "Complete your booking", "We noticed you were interested", "It's been a while"]) {
    assert.ok(catalog.STARTER_TEMPLATES.some((t) => t.name.includes(phrase)), phrase);
  }
});

test("journeys are validated: triggers, step limits, follow-up spacing, exit rules", () => {
  const base = { name: "J", trigger: { signal: "contact_captured" }, steps: [{ templateId: "a", delay: { amount: 0, unit: "minutes" } }] };
  assert.throws(() => catalog.normalizeJourney({ ...base, name: "" }), /name is required/);
  assert.throws(() => catalog.normalizeJourney({ ...base, trigger: { signal: "email_clicked" } }), /Trigger must be/);
  assert.throws(() => catalog.normalizeJourney({ ...base, steps: [] }), /at least one/);
  assert.throws(() => catalog.normalizeJourney({ ...base, steps: Array(7).fill(base.steps[0]) }), /at most 6/);
  assert.throws(
    () => catalog.normalizeJourney({ ...base, steps: [base.steps[0], { templateId: "b", delay: { amount: 10, unit: "minutes" } }] }),
    /at least 1 hour/
  );
  assert.throws(() => catalog.normalizeJourney({ ...base, steps: [{ templateId: "a", delay: { amount: 61, unit: "days" } }] }), /60 days/);
  const j = catalog.normalizeJourney({ ...base, trigger: { signal: "booking_created" }, exitOn: ["booking_created", "email_replied", "nonsense"] });
  assert.deepEqual(j.exitOn, ["email_replied"]); // never exits on its own trigger; unknown dropped
  const r = catalog.normalizeJourney({ ...base, trigger: { signal: "repeat_visit", params: { minVisits: 999, withinDays: "x" } } });
  assert.deepEqual(r.trigger.params, { minVisits: 20, withinDays: 7 });
});

test("frequency caps: minimum gap and weekly maximum", () => {
  const now = new Date(2026, 9, 10, 12);
  const caps = { maxPerWeek: 2, minHoursBetween: 48 };
  assert.equal(catalog.frequencyAllowedAt([], caps, now).getTime(), now.getTime());
  const oneHourAgo = new Date(now.getTime() - HOUR);
  assert.equal(catalog.frequencyAllowedAt([oneHourAgo], caps, now).getTime(), oneHourAgo.getTime() + 48 * HOUR);
  const a = new Date(now.getTime() - 6 * DAY);
  const b = new Date(now.getTime() - 3 * DAY);
  // Two this week already: wait until the older one leaves the 7-day window.
  assert.equal(catalog.frequencyAllowedAt([b, a], caps, now).getTime(), a.getTime() + 7 * DAY);
});

test("send window keeps email in business hours in the business timezone", () => {
  const opts = { sendWindow: { startHour: 9, endHour: 20 }, timezone: "Asia/Kolkata" };
  const night = new Date("2026-10-10T17:00:00Z"); // 22:30 IST
  assert.equal(catalog.nextSendWindowTime(night, opts).toISOString(), "2026-10-11T03:30:00.000Z"); // 09:00 IST next day
  const early = new Date("2026-10-10T01:00:00Z"); // 06:30 IST
  assert.equal(catalog.nextSendWindowTime(early, opts).toISOString(), "2026-10-10T03:30:00.000Z");
  const inside = new Date("2026-10-10T06:00:00Z"); // 11:30 IST
  assert.equal(catalog.nextSendWindowTime(inside, opts).getTime(), inside.getTime());
});

test("step conditions and lifecycle", () => {
  const enrolledAt = new Date(2026, 0, 1);
  const lastSentAt = new Date(2026, 0, 2);
  const enrollment = { enrolledAt, lastSentAt };
  assert.equal(catalog.stepConditionMet("no_click", { contact: { engagement: { lastClickedAt: new Date(2026, 0, 3) } }, enrollment }), false);
  assert.equal(catalog.stepConditionMet("no_click", { contact: { engagement: { lastClickedAt: new Date(2025, 11, 1) } }, enrollment }), true);
  assert.equal(catalog.stepConditionMet("not_booked", { contact: { bookings: { lastBookedAt: new Date(2026, 0, 5) } }, enrollment }), false);
  assert.equal(catalog.stepConditionMet("always", { contact: {}, enrollment }), true);

  const now = new Date(2026, 5, 1);
  assert.equal(catalog.computeLifecycle({ bookings: { count: 1 } }, now), "customer");
  assert.equal(catalog.computeLifecycle({ leadId: "x" }, now), "lead");
  assert.equal(catalog.computeLifecycle({ engagement: { lastActivityAt: new Date(2025, 0, 1) } }, now), "inactive");
  assert.equal(catalog.computeLifecycle({ engagement: { lastActivityAt: new Date(2026, 4, 25), activityCount: 3 } }, now), "engaged");
  assert.equal(catalog.computeLifecycle({}, now), "subscriber");
});

test("personalisation uses only the recipient's own activity and public business facts", () => {
  const values = catalog.buildEngagementValues({
    business: { businessName: "ABC Salon" },
    contact: {
      name: "Priya Sharma",
      notes: "VIP, owes money",
      tags: ["difficult"],
      interests: [
        { kind: "business", name: "ABC Salon", lastViewedAt: new Date(2026, 0, 2) },
        { kind: "service", name: "Facial", lastViewedAt: new Date(2026, 0, 1) },
        { kind: "service", name: "Hair Spa", lastViewedAt: new Date(2026, 0, 3) },
      ],
    },
    enrollment: { context: { itemName: "Manicure" } },
    listingUrl: "https://l",
    bookingPageUrl: "https://b",
    bookingHistoryUrl: "https://h",
  });
  assert.equal(values.name, "Priya");
  assert.equal(values.viewed_item, "Manicure");
  assert.equal(values.viewed_items, "Manicure, Hair Spa and Facial");
  assert.equal(values.booking_link, "https://b");
  assert.doesNotMatch(JSON.stringify(values), /VIP|owes|difficult/);
  const anon = catalog.buildEngagementValues({ business: { businessName: "ABC Salon" }, contact: {}, listingUrl: "", bookingPageUrl: "", bookingHistoryUrl: "" });
  assert.equal(anon.name, "there");
  assert.equal(anon.viewed_item, "ABC Salon");
});

test("settings validation", () => {
  const s = catalog.normalizeSettings({ frequency: { maxPerWeek: 3, minHoursBetween: 24 }, sendWindow: { startHour: 8, endHour: 21 }, timezone: "Europe/London" });
  assert.deepEqual(s.frequency, { maxPerWeek: 3, minHoursBetween: 24 });
  assert.equal(s.timezone, "Europe/London");
  assert.equal(s.enabled, false);
  assert.throws(() => catalog.normalizeSettings({ frequency: { maxPerWeek: 20 } }), /per week/);
  assert.throws(() => catalog.normalizeSettings({ sendWindow: { startHour: 10, endHour: 11 } }), /2 hours/);
  assert.throws(() => catalog.normalizeSettings({ timezone: "Mars/Olympus" }), /timezone/);
});
