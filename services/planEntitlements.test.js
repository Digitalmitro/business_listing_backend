"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const plans = require("./planEntitlements");

const active = (packageName, extra = {}) => ({ subscription: { status: "active", packageName, ...extra } });

test("the plan in force is Free unless the subscription is active and not past its end date", () => {
  assert.equal(plans.activePlanName(null), "Free");
  assert.equal(plans.activePlanName({ subscription: { status: "pending", packageName: "Gold" } }), "Free");
  assert.equal(plans.activePlanName({ subscription: { status: "canceled", packageName: "Gold" } }), "Free");
  assert.equal(plans.activePlanName(active("Gold")), "Gold");
  assert.equal(plans.activePlanName(active("Gold", { endDate: new Date(Date.now() - 1000) })), "Free");
  assert.equal(plans.activePlanName(active("Gold", { endDate: new Date(Date.now() + 86400000) })), "Gold");
  assert.equal(plans.activePlanName(active("premium")), "Premium", "names are case-insensitive");
  assert.equal(plans.activePlanName(active("Unknown")), "Free");
});

test("legacy package names map to the new plans", () => {
  assert.equal(plans.activePlanName(active("Platinum")), "Gold");
  assert.equal(plans.activePlanName(active("Diamond")), "Premium");
});

test("default entitlements follow the agreed matrix", () => {
  const e = plans.DEFAULT_ENTITLEMENTS;
  // Free: nothing
  for (const kind of Object.keys(plans.EMAIL_KINDS)) assert.equal(plans.allows(e.Free, kind), false, `Free must not allow ${kind}`);
  // Basic: booking confirmation/reschedule/cancel only, from own address
  assert.equal(plans.allows(e.Basic, "booking"), true);
  assert.equal(plans.allows(e.Basic, "booking", { reminderKey: "1d" }), false);
  assert.equal(plans.allows(e.Basic, "crm_automation"), false);
  assert.equal(e.Basic.ownSender, true);
  assert.equal(e.Basic.googleBusiness, false);
  // Silver: + 1d and 30m reminders + Google
  assert.equal(plans.allows(e.Silver, "booking", { reminderKey: "1d" }), true);
  assert.equal(plans.allows(e.Silver, "booking", { reminderKey: "30m" }), true);
  assert.equal(plans.allows(e.Silver, "booking", { reminderKey: "3d" }), false);
  assert.equal(plans.allows(e.Silver, "booking", { reminderKey: "10m" }), false);
  assert.equal(e.Silver.googleBusiness, true);
  assert.equal(plans.allows(e.Silver, "crm_automation"), false);
  // Gold: all reminders, CRM lead emails, custom templates; no AI/journeys
  for (const key of plans.ALL_REMINDER_KEYS) assert.equal(plans.allows(e.Gold, "booking", { reminderKey: key }), true);
  assert.equal(plans.allows(e.Gold, "crm_automation"), true);
  assert.equal(plans.allows(e.Gold, "crm_followup"), true);
  assert.equal(e.Gold.customTemplates, true);
  assert.equal(plans.allows(e.Gold, "ai"), false);
  assert.equal(plans.allows(e.Gold, "journey"), false);
  // Premium: everything
  for (const kind of Object.keys(plans.EMAIL_KINDS)) assert.equal(plans.allows(e.Premium, kind), true, `Premium must allow ${kind}`);
});

test("lowestPlanFor names the cheapest plan that includes an email", () => {
  assert.equal(plans.lowestPlanFor("booking"), "Basic");
  assert.equal(plans.lowestPlanFor("booking", { reminderKey: "1d" }), "Silver");
  assert.equal(plans.lowestPlanFor("booking", { reminderKey: "3d" }), "Gold");
  assert.equal(plans.lowestPlanFor("crm_automation"), "Gold");
  assert.equal(plans.lowestPlanFor("ai"), "Premium");
  assert.equal(plans.lowestPlanFor("journey"), "Premium");
});

test("package overrides apply over defaults, but never to Free", () => {
  const merged = plans.mergeEntitlements("Basic", { bookingReminders: ["1d", "nonsense"], aiEmails: true });
  assert.deepEqual(merged.bookingReminders, ["1d"]);
  assert.equal(merged.aiEmails, true);
  assert.equal(merged.bookingEmails, true, "unspecified keys keep the plan default");
  assert.deepEqual(plans.mergeEntitlements("Free", { bookingEmails: true }), { ...plans.DEFAULT_ENTITLEMENTS.Free });
});

test("getPlanEntitlements uses defaults without a database and Free for unknown businesses", async () => {
  assert.equal((await plans.getPlanEntitlements(active("Silver"))).planName, "Silver");
  assert.deepEqual((await plans.getPlanEntitlements(active("Silver"))).entitlements.bookingReminders, ["1d", "30m"]);
  assert.equal((await plans.getPlanEntitlements("not-an-id")).planName, "Free");
});

test("assertAllows throws a 403 plan_required naming the plan to upgrade to", async () => {
  await assert.rejects(() => plans.assertAllows(active("Gold"), "ai"), (err) => err.status === 403 && err.code === "plan_required" && /Premium/.test(err.message));
  const ok = await plans.assertAllows(active("Premium"), "ai");
  assert.equal(ok.planName, "Premium");
});
