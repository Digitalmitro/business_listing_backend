"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const catalog = require("./crmEmailAutomationCatalog");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test("every trigger ships three valid ready-made templates, one per tone", () => {
  for (const trigger of catalog.TRIGGER_KEYS) {
    const presets = catalog.PRESETS[trigger];
    assert.equal(presets.length, 3, trigger);
    assert.deepEqual(presets.map((t) => t.tone).sort(), [...catalog.TONES].sort(), trigger);
    for (const preset of presets) {
      const { warnings } = catalog.validateTemplate(trigger, preset);
      assert.deepEqual(warnings, [], `${preset.key} uses a variable that is blank for ${trigger}`);
      assert.equal(catalog.getPreset(preset.key).trigger, trigger);
    }
  }
  const keys = catalog.TRIGGER_KEYS.flatMap((t) => catalog.PRESETS[t].map((p) => p.key));
  assert.equal(new Set(keys).size, keys.length, "preset keys are unique");
});

test("the catalog covers the requested triggers and variables", () => {
  assert.deepEqual(catalog.TRIGGER_KEYS, [
    "new_lead",
    "lead_viewed",
    "booking_created",
    "booking_reminder",
    "booking_day",
    "booking_completed",
    "booking_followup",
  ]);
  for (const key of ["lead_name", "business_name", "booking_date", "booking_time", "store_name", "service_name", "booking_link"]) {
    assert.ok(catalog.VARIABLE_KEYS.includes(key), key);
  }
  const ui = catalog.getCatalog();
  assert.equal(ui.triggers.length, 7);
  assert.equal(ui.triggers[0].templates.length, 3);
});

test("normalizeTiming applies defaults and enforces per-trigger limits", () => {
  assert.deepEqual(catalog.normalizeTiming("new_lead"), { amount: 0, unit: "minutes" });
  assert.deepEqual(catalog.normalizeTiming("booking_day", {}), { sendHour: 8 });
  assert.deepEqual(catalog.normalizeTiming("booking_reminder", { amount: "2", unit: "days" }), { amount: 2, unit: "days" });

  assert.throws(() => catalog.normalizeTiming("booking_reminder", { amount: 0, unit: "hours" }), /between/);
  assert.throws(() => catalog.normalizeTiming("booking_reminder", { amount: 15, unit: "days" }), /between/);
  assert.throws(() => catalog.normalizeTiming("new_lead", { amount: 8, unit: "days" }), /between/);
  assert.throws(() => catalog.normalizeTiming("new_lead", { amount: 1.5, unit: "hours" }), /whole number/);
  assert.throws(() => catalog.normalizeTiming("new_lead", { amount: 1, unit: "weeks" }), /unit/);
  assert.throws(() => catalog.normalizeTiming("booking_day", { sendHour: 24 }), /hour/);
  assert.throws(() => catalog.normalizeTiming("nope", {}), /Unknown trigger/);
  try {
    catalog.normalizeTiming("new_lead", { amount: -1, unit: "hours" });
  } catch (error) {
    assert.equal(error.status, 400);
  }
});

test("describeTiming produces the labels shown in the automation list", () => {
  assert.equal(catalog.describeTiming("new_lead", { amount: 0, unit: "minutes" }), "Immediately");
  assert.equal(catalog.describeTiming("lead_viewed", { amount: 2, unit: "hours" }), "2 hours after");
  assert.equal(catalog.describeTiming("booking_reminder", { amount: 1, unit: "days" }), "1 day before booking");
  assert.equal(catalog.describeTiming("booking_followup", { amount: 3, unit: "days" }), "3 days after booking");
  assert.equal(catalog.describeTiming("booking_day", { sendHour: 8 }), "Morning of booking (8:00 AM)");
  assert.equal(catalog.describeTiming("booking_day", { sendHour: 13 }), "Morning of booking (1:00 PM)");
});

test("computeBookingSendAt measures from the booking start", () => {
  const start = new Date(2026, 9, 10, 15, 30);
  assert.equal(
    catalog.computeBookingSendAt("booking_reminder", { amount: 1, unit: "days" }, start).getTime(),
    start.getTime() - DAY
  );
  assert.equal(
    catalog.computeBookingSendAt("booking_completed", { amount: 2, unit: "hours" }, start).getTime(),
    start.getTime() + 2 * HOUR
  );
  assert.deepEqual(catalog.computeBookingSendAt("booking_day", { sendHour: 8 }, start), new Date(2026, 9, 10, 8, 0));
  // An early booking still gets its booking-day email an hour before, never after it starts.
  assert.deepEqual(catalog.computeBookingSendAt("booking_day", { sendHour: 8 }, new Date(2026, 9, 10, 8, 30)), new Date(2026, 9, 10, 7, 30));
  assert.deepEqual(catalog.computeBookingSendAt("booking_day", { sendHour: 8 }, new Date(2026, 9, 10, 0, 30)), new Date(2026, 9, 10, 0, 0));
  assert.equal(catalog.computeBookingSendAt("booking_day", { sendHour: 8 }, null), null);
});

test("isBookingSendDue only sends reminders before the booking and never emails old bookings", () => {
  const now = new Date(2026, 9, 10, 9, 0);
  const start = new Date(2026, 9, 11, 10, 0);

  // Reminder is due (send time passed recently, booking still ahead).
  assert.equal(catalog.isBookingSendDue("booking_reminder", { sendAt: new Date(now - HOUR), start, now }), true);
  // Not yet due.
  assert.equal(catalog.isBookingSendDue("booking_reminder", { sendAt: new Date(+now + HOUR), start, now }), false);
  // Too late (worker was down for more than 12 hours).
  assert.equal(catalog.isBookingSendDue("booking_reminder", { sendAt: new Date(now - 13 * HOUR), start, now }), false);
  // Booking already started.
  assert.equal(catalog.isBookingSendDue("booking_day", { sendAt: new Date(now - HOUR), start: new Date(now - 1), now }), false);

  // After-booking emails respect when the automation was switched on.
  const sendAt = new Date(now - HOUR);
  assert.equal(catalog.isBookingSendDue("booking_followup", { sendAt, start: new Date(now - 3 * DAY), now, activatedAt: new Date(now - 2 * HOUR) }), true);
  assert.equal(catalog.isBookingSendDue("booking_followup", { sendAt, start: new Date(now - 3 * DAY), now, activatedAt: new Date(now - 30 * 60 * 1000) }), false);
  assert.equal(catalog.isBookingSendDue("booking_completed", { sendAt: new Date(now - 49 * HOUR), start, now }), false);
});

test("validateTemplate rejects unknown variables and empty or oversized content", () => {
  assert.throws(() => catalog.validateTemplate("new_lead", { subject: "", body: "<p>x</p>" }), /Subject is required/);
  assert.throws(() => catalog.validateTemplate("new_lead", { subject: "Hi", body: "  " }), /body is required/);
  assert.throws(() => catalog.validateTemplate("new_lead", { subject: "x".repeat(201), body: "b" }), /at most 200/);
  try {
    catalog.validateTemplate("new_lead", { subject: "Hi {{first_name}}", body: "<p>{{discount_code}}</p>" });
    assert.fail("expected an error");
  } catch (error) {
    assert.equal(error.status, 400);
    assert.deepEqual(error.details.unknownVariables.sort(), ["discount_code", "first_name"]);
  }
});

test("validateTemplate warns about variables that are blank for the trigger", () => {
  const { warnings } = catalog.validateTemplate("new_lead", { subject: "See you {{booking_date}}", body: "<p>Hi {{ lead_name }}</p>" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /booking_date/);
  assert.deepEqual(catalog.validateTemplate("booking_created", { subject: "{{booking_date}}", body: "<p>x</p>" }).warnings, []);
});

test("validateTemplate strips active content and header injection", () => {
  const { subject, body } = catalog.validateTemplate("new_lead", {
    subject: "Hello\r\nBcc: victim@example.com",
    body: '<p onclick="steal()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><iframe src="x"></iframe>',
  });
  assert.equal(subject, "Hello Bcc: victim@example.com");
  assert.doesNotMatch(body, /script|onclick|javascript:|iframe/i);
  assert.match(body, /<p>Hi<\/p>/);
});

test("renderTemplate fills variables and escapes customer-supplied values in the body", () => {
  const rendered = catalog.renderTemplate(
    { subject: "Hi {{lead_name}} from {{business_name}}", body: "<p>Hi {{lead_name}}, {{unknown}}see you {{booking_date}}</p>" },
    { lead_name: "<b>Sam</b> & Co", business_name: "Glow", booking_date: "Friday" }
  );
  assert.equal(rendered.subject, "Hi <b>Sam</b> & Co from Glow");
  assert.equal(rendered.body, "<p>Hi &lt;b&gt;Sam&lt;/b&gt; &amp; Co, see you Friday</p>");
});
