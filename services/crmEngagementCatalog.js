"use strict";

/**
 * Static definitions and pure helpers for CRM contact engagement (AI email journeys):
 * the signals the CRM understands, the starter templates and journeys every business
 * begins with, step timing, frequency caps and send windows.
 *
 * Adding a new trigger is a matter of adding a signal here and emitting it from the
 * place where it happens (`crmSignalService.emit`). Journeys are data, so no journey
 * logic changes are needed for a new signal.
 *
 * Nothing in here touches the database.
 */

const moment = require("moment-timezone");
const automationCatalog = require("./crmEmailAutomationCatalog");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UNIT_MS = { minutes: MINUTE, hours: HOUR, days: DAY };

/**
 * Signals: things a contact does, or states the CRM detects.
 *
 * - `journeyTrigger`: can start a journey.
 * - `derived`: detected by the scheduler sweep rather than emitted by a request.
 * - `params`: trigger parameters a journey can set (with defaults and limits).
 * - `conversion`: a journey that exits on this signal counts the contact as converted.
 * - `activity`: recorded on the contact's timeline.
 */
const SIGNALS = {
  contact_captured: {
    label: "Contact captured",
    description: "A visitor gives their email on this business's listing page.",
    journeyTrigger: true,
    activity: true,
  },
  business_viewed: {
    label: "Business viewed",
    description: "A known contact opens this business's listing page.",
    journeyTrigger: true,
    activity: true,
  },
  service_viewed: {
    label: "Service viewed",
    description: "A known contact looks at one of this business's services.",
    journeyTrigger: true,
    activity: true,
  },
  repeat_visit: {
    label: "Repeat visit",
    description: "A known contact keeps coming back to the listing within a few days.",
    journeyTrigger: true,
    activity: false,
    params: { minVisits: { default: 3, min: 2, max: 20 }, withinDays: { default: 7, min: 1, max: 30 } },
  },
  booking_started: {
    label: "Booking started",
    description: "A contact opens the booking page but has not booked yet.",
    journeyTrigger: false,
    activity: true,
  },
  booking_abandoned: {
    label: "Interested but did not book",
    description: "A contact started a booking and did not finish it.",
    journeyTrigger: true,
    derived: true,
    activity: false,
    params: { afterHours: { default: 2, min: 1, max: 72 } },
  },
  booking_created: {
    label: "Booking made",
    description: "The contact books an appointment. Marketing journeys hand over to booking emails.",
    journeyTrigger: true,
    conversion: true,
    activity: true,
  },
  booking_canceled: {
    label: "Booking canceled",
    description: "The contact cancels a booking.",
    journeyTrigger: true,
    activity: true,
  },
  enquiry_submitted: {
    label: "Enquiry submitted",
    description: "The contact sends an enquiry from the listing page.",
    journeyTrigger: true,
    activity: true,
  },
  contact_imported: {
    label: "Contact imported",
    description: "The contact was added by a bulk import and reviewed for engagement.",
    journeyTrigger: true,
    activity: true,
  },
  inactive: {
    label: "No activity for a while",
    description: "An existing contact has not interacted with this business for a set period.",
    journeyTrigger: true,
    derived: true,
    activity: false,
    params: { inactiveDays: { default: 60, min: 14, max: 730 } },
  },
  email_clicked: {
    label: "Email link clicked",
    description: "The contact clicked a link in an engagement email.",
    journeyTrigger: false,
    activity: true,
  },
  email_replied: {
    label: "Replied to an email",
    description: "The contact replied to an email from this business.",
    journeyTrigger: false,
    conversion: true,
    activity: true,
  },
  lead_won: {
    label: "Became a customer",
    description: "The contact's lead was marked won.",
    journeyTrigger: false,
    conversion: true,
    activity: true,
  },
  unsubscribed: {
    label: "Unsubscribed",
    description: "The contact opted out. Every marketing journey stops.",
    journeyTrigger: false,
    activity: true,
  },
};
const SIGNAL_KEYS = Object.keys(SIGNALS);
const TRIGGER_SIGNALS = SIGNAL_KEYS.filter((k) => SIGNALS[k].journeyTrigger);
/** Signals a journey may stop on. Unsubscribes and bounces always stop every journey. */
const EXIT_SIGNALS = ["booking_created", "email_replied", "email_clicked", "enquiry_submitted", "lead_won", "business_viewed"];
const DEFAULT_EXIT_SIGNALS = ["booking_created", "email_replied", "lead_won"];
/** Activity types that are not signals (bookkeeping only). */
const EXTRA_ACTIVITY_TYPES = ["email_sent", "journey_enrolled", "journey_exited", "contact_updated", "resubscribed", "bounced"];
const ACTIVITY_TYPES = [...SIGNAL_KEYS.filter((k) => SIGNALS[k].activity), ...EXTRA_ACTIVITY_TYPES];
const VIEW_SIGNALS = ["business_viewed", "service_viewed"];

/** Step conditions, checked when a step is due. */
const STEP_CONDITIONS = {
  always: { label: "Always send" },
  no_click: { label: "Only if they haven't clicked since the last email" },
  not_booked: { label: "Only if they still haven't booked" },
};

const TEMPLATE_PURPOSES = {
  viewed: "Recently viewed",
  still_interested: "Still interested",
  help_find: "Help finding something",
  complete_booking: "Complete booking",
  noticed_interest: "Noticed interest",
  win_back: "Win back",
  welcome: "Welcome / introduction",
  other: "Other",
};

const p = (text) => `<p>${text}</p>`;

/** Starter templates copied into every business's library (editable, must be approved before use). */
const STARTER_TEMPLATES = [
  {
    starterKey: "recently_viewed",
    name: "You recently viewed…",
    purpose: "viewed",
    tone: "friendly",
    subject: "You recently viewed {{viewed_item}}",
    body: [
      p("Hi {{name}},"),
      p("You recently viewed <strong>{{viewed_item}}</strong> at {{business_name}}. If you're still exploring options, you can take another look here:"),
      p('<a href="{{listing_url}}">See {{business_name}}</a>'),
      p("Any questions? Just reply to this email and we'll help."),
      p("Warm regards,<br>{{business_name}}"),
    ].join(""),
  },
  {
    starterKey: "still_interested",
    name: "Still interested?",
    purpose: "still_interested",
    tone: "friendly",
    subject: "Still interested in {{viewed_item}}?",
    body: [
      p("Hi {{name}},"),
      p("Just checking in. Are you still thinking about {{viewed_item}}? We'd be happy to help you pick a time that works."),
      p('<a href="{{booking_link}}">Book with {{business_name}}</a>'),
      p("Talk soon,<br>{{business_name}}"),
    ].join(""),
  },
  {
    starterKey: "help_find",
    name: "Can we help you find what you're looking for?",
    purpose: "help_find",
    tone: "professional",
    subject: "Can we help you find what you're looking for?",
    body: [
      p("Hello {{name}},"),
      p("We noticed you've been looking around {{business_name}}. If you haven't found quite the right option yet, reply with what you need and we'll point you in the right direction."),
      p('You can also browse everything we offer here: <a href="{{listing_url}}">{{business_name}}</a>.'),
      p("Kind regards,<br>{{business_name}}"),
    ].join(""),
  },
  {
    starterKey: "complete_booking",
    name: "Complete your booking",
    purpose: "complete_booking",
    tone: "friendly",
    subject: "Your booking at {{business_name}} is almost done",
    body: [
      p("Hi {{name}},"),
      p("It looks like you started booking with {{business_name}} but didn't get to finish. Your preferred time might still be available."),
      p('<a href="{{booking_link}}">Complete your booking</a>'),
      p("If something went wrong or you have a question, just reply and we'll sort it out."),
      p("See you soon,<br>{{business_name}}"),
    ].join(""),
  },
  {
    starterKey: "noticed_interest",
    name: "We noticed you were interested…",
    purpose: "noticed_interest",
    tone: "professional",
    subject: "We noticed you were interested in {{viewed_item}}",
    body: [
      p("Hello {{name}},"),
      p("We noticed you've looked at {{viewed_items}} a few times. If it helps, we're happy to answer questions or suggest the best option for you."),
      p('<a href="{{booking_link}}">Check availability</a>'),
      p("Kind regards,<br>{{business_name}}"),
    ].join(""),
  },
  {
    starterKey: "win_back",
    name: "It's been a while — come back and explore",
    purpose: "win_back",
    tone: "friendly",
    subject: "It's been a while, {{name}}. Come back and explore {{business_name}}",
    body: [
      p("Hi {{name}},"),
      p("It's been a while since we last saw you at {{business_name}}. Take a look at what we offer today; we'd love to welcome you back."),
      p('<a href="{{listing_url}}">Explore {{business_name}}</a>'),
      p("Warm regards,<br>{{business_name}}"),
    ].join(""),
  },
  {
    starterKey: "welcome_intro",
    name: "Hello from us (introduction)",
    purpose: "welcome",
    tone: "professional",
    subject: "Hello from {{business_name}}",
    body: [
      p("Hello {{name}},"),
      p("Thank you for staying in touch with {{business_name}}. You can find our services, timings and reviews on our page any time:"),
      p('<a href="{{listing_url}}">{{business_name}} on UrbanCitations</a>'),
      p("If there's anything we can help with, just reply to this email."),
      p("Kind regards,<br>{{business_name}}"),
    ].join(""),
  },
];

/**
 * Starter journeys (created switched off). `template` refers to a starter template's
 * starterKey and is resolved to the business's own template id when seeded.
 */
const STARTER_JOURNEYS = [
  {
    starterKey: "recently_viewed_followup",
    name: "Recently viewed follow-up",
    goal: "Turn visitors who left their email into a booking.",
    trigger: { signal: "contact_captured", params: {} },
    priority: 50,
    reentryDays: 30,
    exitOn: DEFAULT_EXIT_SIGNALS,
    steps: [
      { template: "recently_viewed", delay: { amount: 1, unit: "hours" }, condition: "always" },
      { template: "still_interested", delay: { amount: 3, unit: "days" }, condition: "no_click" },
    ],
  },
  {
    starterKey: "repeat_visitor",
    name: "Repeat visitor",
    goal: "Help contacts who keep coming back make a decision.",
    trigger: { signal: "repeat_visit", params: { minVisits: 3, withinDays: 7 } },
    priority: 60,
    reentryDays: 30,
    exitOn: DEFAULT_EXIT_SIGNALS,
    steps: [
      { template: "noticed_interest", delay: { amount: 2, unit: "hours" }, condition: "always" },
      { template: "help_find", delay: { amount: 4, unit: "days" }, condition: "not_booked" },
    ],
  },
  {
    starterKey: "abandoned_booking",
    name: "Complete your booking",
    goal: "Recover bookings that were started but not finished.",
    trigger: { signal: "booking_abandoned", params: { afterHours: 2 } },
    priority: 80,
    reentryDays: 14,
    exitOn: DEFAULT_EXIT_SIGNALS,
    steps: [
      { template: "complete_booking", delay: { amount: 0, unit: "minutes" }, condition: "always" },
      { template: "still_interested", delay: { amount: 2, unit: "days" }, condition: "not_booked" },
    ],
  },
  {
    starterKey: "win_back",
    name: "Win back inactive contacts",
    goal: "Re-engage contacts who have gone quiet.",
    trigger: { signal: "inactive", params: { inactiveDays: 60 } },
    priority: 20,
    reentryDays: 120,
    exitOn: [...DEFAULT_EXIT_SIGNALS, "business_viewed"],
    steps: [
      { template: "win_back", delay: { amount: 0, unit: "minutes" }, condition: "always" },
      { template: "help_find", delay: { amount: 7, unit: "days" }, condition: "no_click" },
    ],
  },
  {
    starterKey: "imported_intro",
    name: "Introduce yourself to imported contacts",
    goal: "Warm up imported contacts that have no recent activity with a low-pressure hello.",
    trigger: { signal: "contact_imported", params: {} },
    priority: 30,
    reentryDays: 180,
    exitOn: [...DEFAULT_EXIT_SIGNALS, "email_clicked"],
    steps: [
      { template: "welcome_intro", delay: { amount: 0, unit: "minutes" }, condition: "always" },
      { template: "help_find", delay: { amount: 5, unit: "days" }, condition: "no_click" },
    ],
  },
];

const STEP_DELAY_MAX_MS = 60 * DAY;
const MAX_STEPS = 6;

const DEFAULT_SETTINGS = {
  enabled: false,
  frequency: { maxPerWeek: 2, minHoursBetween: 48 },
  sendWindow: { startHour: 9, endHour: 20 },
  timezone: "Asia/Kolkata",
  importDailyLimit: 200,
  aiTriage: true,
  captureWidget: true,
};

function validationError(message, details) {
  const err = new Error(message);
  err.status = 400;
  if (details) err.details = details;
  return err;
}

function delayMs(delay) {
  return (Number(delay?.amount) || 0) * (UNIT_MS[delay?.unit] || 0);
}

function describeDelay(delay) {
  const amount = Number(delay?.amount) || 0;
  if (!amount) return "Immediately";
  const unit = delay.unit || "minutes";
  return `${amount} ${amount === 1 ? unit.replace(/s$/, "") : unit}`;
}

/** Normalizes trigger params: unknown keys dropped, values clamped to the signal's limits. */
function normalizeTriggerParams(signal, params = {}) {
  const defs = SIGNALS[signal]?.params || {};
  const out = {};
  for (const [key, def] of Object.entries(defs)) {
    const raw = Number(params?.[key]);
    const value = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : def.default;
    out[key] = Math.min(def.max, Math.max(def.min, value));
  }
  return out;
}

/**
 * Validates a journey definition (from the owner or an AI proposal) and returns the
 * normalized shape. Template ids are checked by the service; here they only need to exist.
 */
function normalizeJourney(input = {}) {
  const name = String(input.name || "").trim().slice(0, 100);
  if (!name) throw validationError("Journey name is required");
  const signal = input.trigger?.signal;
  if (!TRIGGER_SIGNALS.includes(signal)) {
    throw validationError(`Trigger must be one of: ${TRIGGER_SIGNALS.join(", ")}`);
  }
  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (!steps.length) throw validationError("A journey needs at least one email step");
  if (steps.length > MAX_STEPS) throw validationError(`A journey can have at most ${MAX_STEPS} email steps`);
  const normalizedSteps = steps.map((step, index) => {
    if (!step?.templateId) throw validationError(`Step ${index + 1} needs a template`);
    const amount = Number(step.delay?.amount ?? 0);
    const unit = step.delay?.unit || "hours";
    if (!UNIT_MS[unit]) throw validationError(`Step ${index + 1}: delay unit must be minutes, hours or days`);
    if (!Number.isInteger(amount) || amount < 0) throw validationError(`Step ${index + 1}: delay must be a whole number of zero or more`);
    if (amount * UNIT_MS[unit] > STEP_DELAY_MAX_MS) throw validationError(`Step ${index + 1}: delay can be at most 60 days`);
    if (index > 0 && amount * UNIT_MS[unit] < HOUR) {
      throw validationError(`Step ${index + 1}: follow-ups must wait at least 1 hour after the previous email`);
    }
    const condition = STEP_CONDITIONS[step.condition] ? step.condition : "always";
    return { templateId: String(step.templateId), delay: { amount, unit }, condition };
  });
  const exitOn = [...new Set((Array.isArray(input.exitOn) ? input.exitOn : DEFAULT_EXIT_SIGNALS).filter((s) => EXIT_SIGNALS.includes(s)))];
  // A journey started by a signal must not stop on that same signal.
  const effectiveExitOn = exitOn.filter((s) => s !== signal);
  const priority = Math.min(100, Math.max(0, Math.round(Number(input.priority ?? 50)) || 0));
  const reentryDays = Math.min(365, Math.max(1, Math.round(Number(input.reentryDays ?? 30)) || 30));
  return {
    name,
    goal: String(input.goal || "").trim().slice(0, 300),
    trigger: { signal, params: normalizeTriggerParams(signal, input.trigger?.params) },
    steps: normalizedSteps,
    exitOn: effectiveExitOn,
    priority,
    reentryDays,
  };
}

function normalizeSettings(input = {}, current = DEFAULT_SETTINGS) {
  const base = { ...DEFAULT_SETTINGS, ...current };
  const out = {
    enabled: input.enabled === undefined ? Boolean(base.enabled) : Boolean(input.enabled),
    aiTriage: input.aiTriage === undefined ? Boolean(base.aiTriage) : Boolean(input.aiTriage),
    captureWidget: input.captureWidget === undefined ? Boolean(base.captureWidget) : Boolean(input.captureWidget),
    frequency: { ...base.frequency },
    sendWindow: { ...base.sendWindow },
    timezone: base.timezone,
    importDailyLimit: base.importDailyLimit,
  };
  if (input.frequency) {
    const maxPerWeek = Math.round(Number(input.frequency.maxPerWeek ?? out.frequency.maxPerWeek));
    const minHours = Math.round(Number(input.frequency.minHoursBetween ?? out.frequency.minHoursBetween));
    if (!(maxPerWeek >= 1 && maxPerWeek <= 7)) throw validationError("Emails per week must be between 1 and 7");
    if (!(minHours >= 12 && minHours <= 336)) throw validationError("Minimum gap between emails must be between 12 hours and 14 days");
    out.frequency = { maxPerWeek, minHoursBetween: minHours };
  }
  if (input.sendWindow) {
    const startHour = Math.round(Number(input.sendWindow.startHour ?? out.sendWindow.startHour));
    const endHour = Math.round(Number(input.sendWindow.endHour ?? out.sendWindow.endHour));
    if (!(startHour >= 0 && startHour <= 23 && endHour >= 1 && endHour <= 24)) throw validationError("Send window hours must be between 0 and 24");
    if (endHour - startHour < 2) throw validationError("The send window must be at least 2 hours long");
    out.sendWindow = { startHour, endHour };
  }
  if (input.timezone !== undefined) {
    if (!moment.tz.zone(String(input.timezone))) throw validationError("Unknown timezone");
    out.timezone = String(input.timezone);
  }
  if (input.importDailyLimit !== undefined) {
    const limit = Math.round(Number(input.importDailyLimit));
    if (!(limit >= 10 && limit <= 2000)) throw validationError("Daily import email limit must be between 10 and 2000");
    out.importDailyLimit = limit;
  }
  return out;
}

/**
 * Earliest time at or after `at` inside the business's send window, e.g. 9:00-20:00
 * in its timezone. Keeps marketing email out of the night.
 */
function nextSendWindowTime(at, { sendWindow = DEFAULT_SETTINGS.sendWindow, timezone = DEFAULT_SETTINGS.timezone } = {}) {
  const tz = moment.tz.zone(timezone) ? timezone : DEFAULT_SETTINGS.timezone;
  const local = moment.tz(at, tz);
  const start = local.clone().startOf("day").add(sendWindow.startHour, "hours");
  const end = local.clone().startOf("day").add(sendWindow.endHour, "hours");
  if (local.isBefore(start)) return start.toDate();
  if (!local.isBefore(end)) return start.add(1, "day").toDate();
  return new Date(at);
}

/**
 * Earliest time a marketing email may go to a contact under the frequency caps,
 * given the send times of their recent marketing emails (sent or queued).
 * Returns `now` when nothing blocks it.
 */
function frequencyAllowedAt(recentSendTimes, { maxPerWeek, minHoursBetween }, now = new Date()) {
  const times = recentSendTimes.map((t) => new Date(t).getTime()).filter((t) => !isNaN(t)).sort((a, b) => a - b);
  let allowed = now.getTime();
  if (times.length) {
    allowed = Math.max(allowed, times[times.length - 1] + minHoursBetween * HOUR);
  }
  const weekAgo = now.getTime() - 7 * DAY;
  const inWeek = times.filter((t) => t > weekAgo);
  if (inWeek.length >= maxPerWeek) {
    // Wait until enough of this week's emails age out of the 7-day window.
    allowed = Math.max(allowed, inWeek[inWeek.length - maxPerWeek] + 7 * DAY);
  }
  return new Date(allowed);
}

/** Whether a due step's condition still holds for the contact. */
function stepConditionMet(condition, { contact, enrollment }) {
  if (condition === "no_click") {
    const since = enrollment?.lastSentAt || enrollment?.enrolledAt;
    const clicked = contact?.engagement?.lastClickedAt;
    return !(clicked && since && new Date(clicked) > new Date(since));
  }
  if (condition === "not_booked") {
    const booked = contact?.bookings?.lastBookedAt;
    return !(booked && enrollment?.enrolledAt && new Date(booked) > new Date(enrollment.enrolledAt));
  }
  return true;
}

/** Lifecycle stage from what we know about a contact. */
function computeLifecycle(contact, now = new Date()) {
  if ((contact?.bookings?.count || 0) > 0) return "customer";
  if (contact?.leadId) return "lead";
  const last = contact?.engagement?.lastActivityAt ? new Date(contact.engagement.lastActivityAt) : null;
  if (last && now - last > 180 * DAY) return "inactive";
  if (last && now - last <= 30 * DAY && (contact?.engagement?.activityCount || 0) > 1) return "engaged";
  return "subscriber";
}

// ── Variables ───────────────────────────────────────────────────────────────

/**
 * Engagement templates use the same variable set as email automations, so both
 * share one validator and renderer. Only public or recipient-owned information is
 * ever inserted: their own name, what they viewed, their own booking. Notes, tags,
 * lead status and other internal CRM data are never available to templates.
 */
function validateEngagementTemplate({ subject, body } = {}) {
  // `new_lead` has the widest set of available variables; booking variables are
  // always present for journeys (booking_link falls back to the booking page).
  const { subject: s, body: b } = automationCatalog.validateTemplate("booking_created", { subject, body });
  return { subject: s, body: b, warnings: [] };
}

function firstName(name) {
  const clean = String(name || "").trim();
  if (!clean) return "";
  return clean.split(/\s+/)[0];
}

function joinItems(items) {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] || "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * Values for a journey email. `viewed_item` prefers what triggered the journey, then
 * the contact's most recent interest, then the business itself.
 */
function buildEngagementValues({ business, contact, enrollment, appointment, listingUrl, bookingPageUrl, bookingHistoryUrl }) {
  const interests = [...(contact?.interests || [])].sort((a, b) => new Date(b.lastViewedAt) - new Date(a.lastViewedAt));
  const services = interests.filter((i) => i.kind === "service").map((i) => i.name);
  const contextItem = enrollment?.context?.itemName;
  const viewedItem = contextItem || services[0] || interests[0]?.name || business?.businessName || "";
  const viewedItems = joinItems([...new Set([contextItem, ...services].filter(Boolean))].slice(0, 3)) || viewedItem;
  const serviceName = appointment?.serviceName || enrollment?.context?.serviceName || contact?.bookings?.lastServiceName || services[0] || "";
  const name = firstName(contact?.name) || "there";
  return {
    name,
    lead_name: name,
    business_name: business?.businessName || "",
    store_name: business?.businessName || "",
    service_name: serviceName || viewedItem,
    viewed_item: viewedItem,
    viewed_items: viewedItems,
    booking_date: appointment?.appointmentDate ? moment(appointment.appointmentDate).format("dddd, MMMM Do YYYY") : "",
    booking_time: appointment?.timeSlot || "",
    booking_link: appointment ? bookingHistoryUrl : bookingPageUrl,
    listing_url: listingUrl,
  };
}

function getCatalog() {
  return {
    signals: SIGNAL_KEYS.map((key) => ({
      key,
      label: SIGNALS[key].label,
      description: SIGNALS[key].description,
      journeyTrigger: Boolean(SIGNALS[key].journeyTrigger),
      derived: Boolean(SIGNALS[key].derived),
      conversion: Boolean(SIGNALS[key].conversion),
      params: SIGNALS[key].params || null,
    })),
    exitSignals: EXIT_SIGNALS,
    defaultExitSignals: DEFAULT_EXIT_SIGNALS,
    stepConditions: Object.entries(STEP_CONDITIONS).map(([key, v]) => ({ key, label: v.label })),
    purposes: Object.entries(TEMPLATE_PURPOSES).map(([key, label]) => ({ key, label })),
    tones: automationCatalog.TONES,
    variables: automationCatalog.VARIABLE_KEYS.filter((k) => k !== "lead_name" && k !== "store_name").map((key) => ({
      key,
      token: `{{${key}}}`,
      label: automationCatalog.VARIABLES[key].label,
      sample: automationCatalog.VARIABLES[key].sample,
    })),
    defaults: DEFAULT_SETTINGS,
    maxSteps: MAX_STEPS,
  };
}

module.exports = {
  HOUR,
  DAY,
  UNIT_MS,
  SIGNALS,
  SIGNAL_KEYS,
  TRIGGER_SIGNALS,
  EXIT_SIGNALS,
  DEFAULT_EXIT_SIGNALS,
  ACTIVITY_TYPES,
  VIEW_SIGNALS,
  STEP_CONDITIONS,
  TEMPLATE_PURPOSES,
  STARTER_TEMPLATES,
  STARTER_JOURNEYS,
  DEFAULT_SETTINGS,
  MAX_STEPS,
  delayMs,
  describeDelay,
  normalizeTriggerParams,
  normalizeJourney,
  normalizeSettings,
  nextSendWindowTime,
  frequencyAllowedAt,
  stepConditionMet,
  computeLifecycle,
  validateEngagementTemplate,
  buildEngagementValues,
  firstName,
  joinItems,
  getCatalog,
};
