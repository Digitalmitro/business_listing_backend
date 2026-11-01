"use strict";

/**
 * Which customer-facing email features a business's subscription plan includes.
 *
 * Plans are Free (no active subscription), Basic, Silver, Gold and Premium.
 * Each PricingPackage document may carry its own `entitlements`; anything it
 * leaves out falls back to DEFAULT_ENTITLEMENTS below, so a package edited in the
 * admin panel can never accidentally grant or lose a feature it doesn't mention.
 *
 * Emails covered here are the ones a business sends to ITS customers and leads.
 * Platform emails to the owner (welcome, "new booking for you", claims) are not
 * plan-gated.
 */

const mongoose = require("mongoose");
// Required here (not looked up by name) so the plan check also works in the separate
// queue-worker process (startWorker.js), which never loads the routes that register them.
const Business = require("../models/Business");
const PricingPackage = require("../models/PricingPackage");

const PLAN_NAMES = ["Free", "Basic", "Silver", "Gold", "Premium"];
const PAID_PLAN_NAMES = PLAN_NAMES.slice(1);
const ALL_REMINDER_KEYS = ["3d", "2d", "1d", "30m", "10m"];

/** Older package names still stored on some businesses. */
const LEGACY_PLAN_NAMES = { Platinum: "Gold", Diamond: "Premium" };

const NONE = Object.freeze({
  ownSender: false,
  bookingEmails: false,
  bookingReminders: [],
  customTemplates: false,
  crmLeadEmails: false,
  aiEmails: false,
  journeys: false,
  googleBusiness: false,
});

const DEFAULT_ENTITLEMENTS = Object.freeze({
  Free: NONE,
  Basic: { ...NONE, ownSender: true, bookingEmails: true },
  Silver: { ...NONE, ownSender: true, bookingEmails: true, bookingReminders: ["1d", "30m"], googleBusiness: true },
  Gold: {
    ...NONE,
    ownSender: true,
    bookingEmails: true,
    bookingReminders: ALL_REMINDER_KEYS,
    customTemplates: true,
    crmLeadEmails: true,
    googleBusiness: true,
  },
  Premium: {
    ownSender: true,
    bookingEmails: true,
    bookingReminders: ALL_REMINDER_KEYS,
    customTemplates: true,
    crmLeadEmails: true,
    aiEmails: true,
    journeys: true,
    googleBusiness: true,
  },
});

/** Email kinds that callers pass to `allows()`. */
const EMAIL_KINDS = {
  booking: (e) => e.bookingEmails,
  crm_automation: (e) => e.crmLeadEmails,
  crm_followup: (e) => e.crmLeadEmails,
  journey: (e) => e.journeys,
  ai: (e) => e.aiEmails,
};

function normalizePlanName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "Free";
  if (LEGACY_PLAN_NAMES[raw]) return LEGACY_PLAN_NAMES[raw];
  const match = PLAN_NAMES.find((p) => p.toLowerCase() === raw.toLowerCase());
  return match || "Free";
}

/**
 * The plan in force for a business right now: its package only while the
 * subscription is active and not past its end date; otherwise Free.
 */
function activePlanName(business, now = new Date()) {
  const sub = business?.subscription || {};
  if (sub.status !== "active") return "Free";
  if (sub.endDate && new Date(sub.endDate).getTime() < now.getTime()) return "Free";
  return normalizePlanName(sub.packageName);
}

function mergeEntitlements(planName, overrides) {
  const base = DEFAULT_ENTITLEMENTS[planName] || NONE;
  if (planName === "Free" || !overrides || typeof overrides !== "object") return { ...base };
  const merged = { ...base };
  for (const key of Object.keys(NONE)) {
    if (overrides[key] === undefined || overrides[key] === null) continue;
    if (key === "bookingReminders") {
      merged.bookingReminders = Array.isArray(overrides.bookingReminders)
        ? ALL_REMINDER_KEYS.filter((k) => overrides.bookingReminders.includes(k))
        : base.bookingReminders;
    } else {
      merged[key] = Boolean(overrides[key]);
    }
  }
  return merged;
}

/**
 * @param {object|string} businessOrId - a Business document (needs `subscription`) or its id.
 * @returns {Promise<{ planName: string, entitlements: object }>}
 */
async function getPlanEntitlements(businessOrId, { now = new Date() } = {}) {
  const dbConnected = mongoose.connection.readyState === 1;
  let business = businessOrId;
  if (!business || typeof business !== "object" || !business.subscription) {
    const id = business?._id || business;
    business = dbConnected && mongoose.isValidObjectId(id)
      ? await Business.findById(id).select("subscription").lean()
      : null;
  }
  const planName = activePlanName(business, now);
  let overrides = null;
  // Without a database (unit tests, startup) the built-in plan defaults apply.
  if (planName !== "Free" && dbConnected) {
    const pkg = await PricingPackage.findOne({ name: planName }).select("entitlements").lean();
    overrides = pkg?.entitlements || null;
  }
  return { planName, entitlements: mergeEntitlements(planName, overrides) };
}

/** Whether the entitlements allow an email of `kind` (and, for reminders, `reminderKey`). */
function allows(entitlements, kind, { reminderKey } = {}) {
  const check = EMAIL_KINDS[kind];
  if (!check || !entitlements || !check(entitlements)) return false;
  if (reminderKey) return entitlements.bookingReminders.includes(reminderKey);
  return true;
}

const FEATURE_LABELS = {
  booking: "Booking emails to customers",
  crm_automation: "CRM lead emails",
  crm_followup: "CRM follow-up emails",
  journey: "Engagement journeys",
  ai: "AI-written emails",
};

/**
 * Throws a 403 (code "plan_required") unless the business's plan includes `kind`.
 * @returns {Promise<{ planName, entitlements }>}
 */
async function assertAllows(businessOrId, kind) {
  const plan = await getPlanEntitlements(businessOrId);
  if (!allows(plan.entitlements, kind)) {
    const needed = lowestPlanFor(kind);
    const err = new Error(`${FEATURE_LABELS[kind] || "This feature"} ${needed ? `are included from the ${needed} plan` : "are not included in any plan"}. This business is on the ${plan.planName} plan.`);
    err.status = 403;
    err.code = "plan_required";
    throw err;
  }
  return plan;
}

/** Lowest plan that includes an email `kind` (and reminder key), for user-facing messages. */
function lowestPlanFor(kind, { reminderKey } = {}) {
  return PAID_PLAN_NAMES.find((p) => allows(DEFAULT_ENTITLEMENTS[p], kind, { reminderKey })) || null;
}

module.exports = {
  PLAN_NAMES,
  PAID_PLAN_NAMES,
  ALL_REMINDER_KEYS,
  LEGACY_PLAN_NAMES,
  DEFAULT_ENTITLEMENTS,
  EMAIL_KINDS,
  normalizePlanName,
  activePlanName,
  mergeEntitlements,
  getPlanEntitlements,
  allows,
  assertAllows,
  lowestPlanFor,
};
