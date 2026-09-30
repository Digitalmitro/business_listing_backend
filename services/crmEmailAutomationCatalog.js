"use strict";

/**
 * Static definitions and pure helpers for CRM email automation: the triggers a
 * business can automate, the dynamic variables templates may use, the ready-made
 * templates per trigger, timing rules, and template validation / rendering.
 *
 * Nothing in here touches the database, so it is shared by the service, the
 * controller (validation), the AI assistant (allowed variables) and the tests.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TONES = ["professional", "friendly", "promotional"];

/** Dynamic variables. `sample` is what the preview shows when no real lead is chosen. */
const VARIABLES = {
  name: { label: "Contact first name", sample: "Priya" },
  lead_name: { label: "Lead name", sample: "Priya Sharma" },
  business_name: { label: "Business name", sample: "Glow Beauty Studio" },
  store_name: { label: "Store / listing name", sample: "Glow Beauty Studio" },
  service_name: { label: "Service", sample: "Hair Spa" },
  booking_date: { label: "Booking date", sample: "Friday, October 2nd 2026" },
  booking_time: { label: "Booking time", sample: "10:30 AM" },
  booking_link: { label: "Booking link", sample: "https://urbancitations.com/bookinghistory" },
  listing_url: { label: "Listing page link", sample: "https://urbancitations.com/glow-beauty-studio/1" },
  viewed_item: { label: "Item they viewed", sample: "Hair Spa" },
  viewed_items: { label: "Items they viewed (up to 3)", sample: "Hair Spa, Facial and Manicure" },
};
const VARIABLE_KEYS = Object.keys(VARIABLES);
const BOOKING_VARIABLES = ["booking_date", "booking_time", "booking_link"];

/**
 * anchor decides what the timing is measured from:
 * - event:          delay after the event (0 = immediately)
 * - before_booking: amount before the booking starts
 * - booking_day:    on the booking day at `sendHour`
 * - after_booking:  amount after the booking starts
 */
const TRIGGERS = {
  new_lead: {
    label: "New lead",
    description: "A new lead enters this business's CRM (profile enquiry or added manually).",
    anchor: "event",
    defaultTiming: { amount: 0, unit: "minutes" },
    unavailableVariables: [...BOOKING_VARIABLES, "service_name"],
  },
  lead_viewed: {
    label: "Lead viewed your store",
    description: "An existing lead, signed in on UrbanCitations, opens this business's listing page.",
    anchor: "event",
    defaultTiming: { amount: 2, unit: "hours" },
    unavailableVariables: BOOKING_VARIABLES,
  },
  booking_created: {
    label: "Booking created",
    description: "A customer books an appointment with this business.",
    anchor: "event",
    defaultTiming: { amount: 0, unit: "minutes" },
    unavailableVariables: [],
  },
  booking_reminder: {
    label: "Booking reminder",
    description: "A reminder sent a set time before the booking.",
    anchor: "before_booking",
    defaultTiming: { amount: 1, unit: "days" },
    unavailableVariables: [],
  },
  booking_day: {
    label: "Booking day",
    description: "A \"today is your booking\" reminder on the morning of the booking.",
    anchor: "booking_day",
    defaultTiming: { sendHour: 8 },
    unavailableVariables: [],
  },
  booking_completed: {
    label: "Booking completed",
    description: "A thank-you sent shortly after the booking has taken place.",
    anchor: "after_booking",
    defaultTiming: { amount: 2, unit: "hours" },
    unavailableVariables: [],
  },
  booking_followup: {
    label: "Follow-up after booking",
    description: "A follow-up a few days after the booking, inviting the customer back.",
    anchor: "after_booking",
    defaultTiming: { amount: 3, unit: "days" },
    unavailableVariables: [],
  },
};
const TRIGGER_KEYS = Object.keys(TRIGGERS);
const EVENT_TRIGGERS = TRIGGER_KEYS.filter((k) => TRIGGERS[k].anchor === "event");
const SCHEDULED_TRIGGERS = TRIGGER_KEYS.filter((k) => TRIGGERS[k].anchor !== "event");

/** Allowed timing ranges per anchor, in milliseconds. */
const TIMING_LIMITS = {
  event: { min: 0, max: 7 * DAY },
  before_booking: { min: HOUR, max: 14 * DAY },
  after_booking: { min: HOUR, max: 30 * DAY },
};
const UNIT_MS = { minutes: MINUTE, hours: HOUR, days: DAY };

const p = (text) => `<p>${text}</p>`;
const signOff = (line) => p(`${line}<br>{{business_name}}`);

/** Ready-made templates: three per trigger, one per tone. */
const PRESETS = {
  new_lead: [
    {
      key: "new_lead_professional",
      name: "Welcome lead",
      tone: "professional",
      subject: "Thank you for contacting {{business_name}}",
      body: [
        p("Dear {{lead_name}},"),
        p("Thank you for your interest in {{business_name}}. We have received your enquiry and a member of our team will get back to you shortly."),
        p("In the meantime, you can find our services, timings and reviews on our listing: <a href=\"{{listing_url}}\">{{store_name}}</a>."),
        signOff("Kind regards,"),
      ].join(""),
    },
    {
      key: "new_lead_friendly",
      name: "Friendly hello",
      tone: "friendly",
      subject: "Hi {{lead_name}}, thanks for reaching out!",
      body: [
        p("Hi {{lead_name}},"),
        p("Thanks so much for getting in touch with {{business_name}}! We're excited to help and will reply very soon."),
        p("Have a look around while you wait: <a href=\"{{listing_url}}\">{{store_name}}</a>."),
        signOff("Talk soon,"),
      ].join(""),
    },
    {
      key: "new_lead_promotional",
      name: "Welcome offer",
      tone: "promotional",
      subject: "Welcome to {{business_name}} - here's what we can do for you",
      body: [
        p("Hi {{lead_name}},"),
        p("Thanks for your enquiry! Customers love {{business_name}} for quality service and friendly prices."),
        p("Book your first visit today and see why: <a href=\"{{listing_url}}\">view {{store_name}}</a>."),
        signOff("See you soon,"),
      ].join(""),
    },
  ],
  lead_viewed: [
    {
      key: "lead_viewed_professional",
      name: "Listing follow-up",
      tone: "professional",
      subject: "Can we help you with anything at {{store_name}}?",
      body: [
        p("Dear {{lead_name}},"),
        p("We noticed you recently looked at {{store_name}}. If you have any questions about our services or availability, simply reply to this email."),
        p("You can revisit our listing here: <a href=\"{{listing_url}}\">{{store_name}}</a>."),
        signOff("Kind regards,"),
      ].join(""),
    },
    {
      key: "lead_viewed_friendly",
      name: "You viewed this store",
      tone: "friendly",
      subject: "Still thinking about {{store_name}}?",
      body: [
        p("Hi {{lead_name}},"),
        p("Saw you checking out {{store_name}} - great taste! If anything caught your eye, we'd love to help you book it."),
        p("<a href=\"{{listing_url}}\">Take another look</a> or just reply with any question."),
        signOff("Cheers,"),
      ].join(""),
    },
    {
      key: "lead_viewed_promotional",
      name: "Come back and book",
      tone: "promotional",
      subject: "{{store_name}} is ready when you are",
      body: [
        p("Hi {{lead_name}},"),
        p("You were just one step away! Slots at {{store_name}} fill up fast - book now to get the time that suits you."),
        p("<a href=\"{{listing_url}}\">Book at {{store_name}}</a>"),
        signOff("See you soon,"),
      ].join(""),
    },
  ],
  booking_created: [
    {
      key: "booking_created_professional",
      name: "Booking confirmation",
      tone: "professional",
      subject: "Your booking at {{business_name}} is confirmed",
      body: [
        p("Dear {{lead_name}},"),
        p("Your booking for <strong>{{service_name}}</strong> on <strong>{{booking_date}}</strong> at <strong>{{booking_time}}</strong> is confirmed."),
        p("You can view or reschedule your booking here: <a href=\"{{booking_link}}\">My bookings</a>."),
        signOff("We look forward to seeing you,"),
      ].join(""),
    },
    {
      key: "booking_created_friendly",
      name: "You're booked in!",
      tone: "friendly",
      subject: "You're booked in, {{lead_name}}!",
      body: [
        p("Hi {{lead_name}},"),
        p("Great news - you're all set for {{service_name}} on {{booking_date}} at {{booking_time}}."),
        p("Need to change something? <a href=\"{{booking_link}}\">Manage your booking</a>."),
        signOff("See you then,"),
      ].join(""),
    },
    {
      key: "booking_created_promotional",
      name: "Confirmation + extras",
      tone: "promotional",
      subject: "Confirmed: {{service_name}} on {{booking_date}}",
      body: [
        p("Hi {{lead_name}},"),
        p("Your {{service_name}} at {{business_name}} is confirmed for {{booking_date}} at {{booking_time}}."),
        p("Ask us about our add-on services when you visit - many customers pair them for the best results."),
        p("<a href=\"{{booking_link}}\">View booking</a>"),
        signOff("Thanks for choosing us,"),
      ].join(""),
    },
  ],
  booking_reminder: [
    {
      key: "booking_reminder_professional",
      name: "Booking reminder",
      tone: "professional",
      subject: "Reminder: your booking at {{business_name}}",
      body: [
        p("Dear {{lead_name}},"),
        p("This is a reminder of your upcoming booking for {{service_name}} on {{booking_date}} at {{booking_time}}."),
        p("If you need to reschedule, please use <a href=\"{{booking_link}}\">My bookings</a>."),
        signOff("Kind regards,"),
      ].join(""),
    },
    {
      key: "booking_reminder_friendly",
      name: "See you tomorrow",
      tone: "friendly",
      subject: "See you soon, {{lead_name}}!",
      body: [
        p("Hi {{lead_name}},"),
        p("Just a friendly reminder that your {{service_name}} is coming up on {{booking_date}} at {{booking_time}}. We can't wait to see you!"),
        p("Plans changed? <a href=\"{{booking_link}}\">Reschedule here</a>."),
        signOff("See you soon,"),
      ].join(""),
    },
    {
      key: "booking_reminder_promotional",
      name: "Reminder + upgrade",
      tone: "promotional",
      subject: "Your {{service_name}} is coming up",
      body: [
        p("Hi {{lead_name}},"),
        p("Your {{service_name}} at {{business_name}} is on {{booking_date}} at {{booking_time}}."),
        p("Want to make the most of your visit? Ask about our popular add-ons when you arrive."),
        p("<a href=\"{{booking_link}}\">View booking</a>"),
        signOff("See you soon,"),
      ].join(""),
    },
  ],
  booking_day: [
    {
      key: "booking_day_professional",
      name: "Today's booking",
      tone: "professional",
      subject: "Today: your booking at {{business_name}}",
      body: [
        p("Dear {{lead_name}},"),
        p("A reminder that your booking for {{service_name}} is today at {{booking_time}}."),
        p("<a href=\"{{listing_url}}\">Find directions and contact details</a>."),
        signOff("See you today,"),
      ].join(""),
    },
    {
      key: "booking_day_friendly",
      name: "Today is the day",
      tone: "friendly",
      subject: "Today's the day, {{lead_name}}!",
      body: [
        p("Hi {{lead_name}},"),
        p("It's today! We're looking forward to your {{service_name}} at {{booking_time}}."),
        p("<a href=\"{{listing_url}}\">Here's how to find us</a>."),
        signOff("See you shortly,"),
      ].join(""),
    },
    {
      key: "booking_day_promotional",
      name: "Today + offer",
      tone: "promotional",
      subject: "See you today at {{booking_time}}",
      body: [
        p("Hi {{lead_name}},"),
        p("Your {{service_name}} at {{business_name}} is today at {{booking_time}}."),
        p("Tip: arrive a few minutes early and ask about today's specials."),
        signOff("See you soon,"),
      ].join(""),
    },
  ],
  booking_completed: [
    {
      key: "booking_completed_professional",
      name: "Thank you",
      tone: "professional",
      subject: "Thank you for visiting {{business_name}}",
      body: [
        p("Dear {{lead_name}},"),
        p("Thank you for choosing {{business_name}} for your {{service_name}}. We hope you were happy with your visit."),
        p("If you have a moment, we would appreciate a review on our <a href=\"{{listing_url}}\">listing page</a>."),
        signOff("Kind regards,"),
      ].join(""),
    },
    {
      key: "booking_completed_friendly",
      name: "Thanks for coming",
      tone: "friendly",
      subject: "Thanks for coming in, {{lead_name}}!",
      body: [
        p("Hi {{lead_name}},"),
        p("It was lovely seeing you for your {{service_name}}! We hope you loved it."),
        p("Got 30 seconds? <a href=\"{{listing_url}}\">Leave us a review</a> - it really helps."),
        signOff("Thanks again,"),
      ].join(""),
    },
    {
      key: "booking_completed_promotional",
      name: "Thanks + rebook",
      tone: "promotional",
      subject: "Loved your {{service_name}}? Book your next one",
      body: [
        p("Hi {{lead_name}},"),
        p("Thanks for visiting {{business_name}}! Regular visits keep the results looking their best."),
        p("<a href=\"{{listing_url}}\">Book your next visit</a>"),
        signOff("See you again soon,"),
      ].join(""),
    },
  ],
  booking_followup: [
    {
      key: "booking_followup_professional",
      name: "Follow-up",
      tone: "professional",
      subject: "How was your experience at {{business_name}}?",
      body: [
        p("Dear {{lead_name}},"),
        p("We hope you are enjoying the results of your {{service_name}}. If there is anything we can do for you, please reply to this email."),
        p("When you are ready for your next visit, you can book on our <a href=\"{{listing_url}}\">listing page</a>."),
        signOff("Kind regards,"),
      ].join(""),
    },
    {
      key: "booking_followup_friendly",
      name: "Checking in",
      tone: "friendly",
      subject: "Just checking in, {{lead_name}}",
      body: [
        p("Hi {{lead_name}},"),
        p("It's been a few days since your {{service_name}} - how's everything going? We'd love to hear from you."),
        p("Whenever you fancy another visit, <a href=\"{{listing_url}}\">we're here</a>."),
        signOff("Warmly,"),
      ].join(""),
    },
    {
      key: "booking_followup_promotional",
      name: "Come back soon",
      tone: "promotional",
      subject: "Time for your next visit to {{business_name}}?",
      body: [
        p("Hi {{lead_name}},"),
        p("Ready for your next {{service_name}}? Book now to secure your favourite time slot."),
        p("<a href=\"{{listing_url}}\">Book again</a>"),
        signOff("See you soon,"),
      ].join(""),
    },
  ],
};

function getPreset(key) {
  for (const trigger of TRIGGER_KEYS) {
    const preset = PRESETS[trigger].find((t) => t.key === key);
    if (preset) return { ...preset, trigger };
  }
  return null;
}

/** The template a trigger starts with before the owner picks one. */
function defaultPreset(trigger) {
  return PRESETS[trigger]?.[0] || null;
}

// ── Timing ──────────────────────────────────────────────────────────────────

function validationError(message, details) {
  const err = new Error(message);
  err.status = 400;
  if (details) err.details = details;
  return err;
}

/** Validates and normalizes a timing object for a trigger. Throws a 400 error when invalid. */
function normalizeTiming(trigger, timing) {
  const def = TRIGGERS[trigger];
  if (!def) throw validationError(`Unknown trigger '${trigger}'`);
  const input = timing && typeof timing === "object" ? timing : def.defaultTiming;

  if (def.anchor === "booking_day") {
    const sendHour = Number(input.sendHour ?? def.defaultTiming.sendHour);
    if (!Number.isInteger(sendHour) || sendHour < 0 || sendHour > 23) {
      throw validationError("Send hour must be a whole hour between 0 and 23");
    }
    return { sendHour };
  }

  const amount = Number(input.amount ?? def.defaultTiming.amount);
  const unit = input.unit || def.defaultTiming.unit;
  if (!UNIT_MS[unit]) throw validationError("Timing unit must be minutes, hours or days");
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(amount)) {
    throw validationError("Timing amount must be a whole number of zero or more");
  }
  const ms = amount * UNIT_MS[unit];
  const limits = TIMING_LIMITS[def.anchor];
  if (ms < limits.min || ms > limits.max) {
    const fmt = (v) => (v >= DAY ? `${v / DAY} day(s)` : v >= HOUR ? `${v / HOUR} hour(s)` : `${v / MINUTE} minute(s)`);
    throw validationError(`Timing for '${def.label}' must be between ${fmt(limits.min)} and ${fmt(limits.max)}`);
  }
  return { amount, unit };
}

function timingOffsetMs(timing) {
  return (Number(timing?.amount) || 0) * (UNIT_MS[timing?.unit] || 0);
}

/** Human label for the automation list, e.g. "Immediately", "1 day before booking". */
function describeTiming(trigger, timing) {
  const def = TRIGGERS[trigger];
  if (!def) return "";
  if (def.anchor === "booking_day") {
    const hour = Number(timing?.sendHour ?? def.defaultTiming.sendHour);
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    return `Morning of booking (${h12}:00 ${hour < 12 ? "AM" : "PM"})`;
  }
  const amount = Number(timing?.amount) || 0;
  const unit = timing?.unit || "minutes";
  const span = `${amount} ${amount === 1 ? unit.replace(/s$/, "") : unit}`;
  if (def.anchor === "event") return amount === 0 ? "Immediately" : `${span} after`;
  if (def.anchor === "before_booking") return `${span} before booking`;
  return `${span} after booking`;
}

/**
 * When a scheduled trigger should send for a booking that starts at `start`.
 * booking_day never sends later than one hour before the booking or earlier
 * than the start of the booking day.
 */
function computeBookingSendAt(trigger, timing, start) {
  const def = TRIGGERS[trigger];
  if (!def || !(start instanceof Date) || isNaN(start.getTime())) return null;
  if (def.anchor === "before_booking") return new Date(start.getTime() - timingOffsetMs(timing));
  if (def.anchor === "after_booking") return new Date(start.getTime() + timingOffsetMs(timing));
  if (def.anchor === "booking_day") {
    const dayStart = new Date(start);
    dayStart.setHours(0, 0, 0, 0);
    const atHour = new Date(dayStart);
    atHour.setHours(Number(timing?.sendHour ?? def.defaultTiming.sendHour), 0, 0, 0);
    const latest = new Date(start.getTime() - HOUR);
    return new Date(Math.max(dayStart.getTime(), Math.min(atHour.getTime(), latest.getTime())));
  }
  return null;
}

/** How late a scheduled email may still go out (e.g. after worker downtime). */
const LATENESS = {
  before_booking: 12 * HOUR,
  booking_day: 12 * HOUR,
  after_booking: 48 * HOUR,
};

/**
 * Whether a scheduled trigger is due now for a booking.
 * - Reminders only go out while the booking is still in the future.
 * - After-booking emails only go out for bookings whose send time is after the
 *   automation was switched on, so enabling one never emails old customers.
 */
function isBookingSendDue(trigger, { sendAt, start, now = new Date(), activatedAt = null }) {
  const def = TRIGGERS[trigger];
  if (!def || !sendAt || !start) return false;
  const lateness = LATENESS[def.anchor];
  if (sendAt > now || now - sendAt > lateness) return false;
  if (def.anchor === "after_booking") {
    return !activatedAt || sendAt >= new Date(activatedAt);
  }
  return now < start;
}

// ── Templates ───────────────────────────────────────────────────────────────

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const SUBJECT_MAX = 200;
const BODY_MAX = 20000;

function extractVariables(text) {
  const found = new Set();
  String(text || "").replace(VARIABLE_PATTERN, (_, key) => found.add(key));
  return [...found];
}

/**
 * Removes active content from owner/AI-authored HTML. Emails are rendered by mail
 * clients that ignore scripts anyway, but the same HTML is shown in the CRM preview.
 */
function sanitizeHtml(html) {
  return String(html || "")
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta)[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, '$1="#"');
}

/**
 * Validates a subject/body pair for a trigger. Returns the cleaned template and
 * non-blocking warnings (variables that will be empty for this trigger). Throws a
 * 400 error for empty/oversized content or unknown variables.
 */
function validateTemplate(trigger, { subject, body } = {}) {
  const def = TRIGGERS[trigger];
  if (!def) throw validationError(`Unknown trigger '${trigger}'`);
  const cleanSubject = String(subject || "").replace(/[\r\n]+/g, " ").trim();
  const cleanBody = sanitizeHtml(body).trim();
  if (!cleanSubject) throw validationError("Subject is required");
  if (cleanSubject.length > SUBJECT_MAX) throw validationError(`Subject must be at most ${SUBJECT_MAX} characters`);
  if (!cleanBody) throw validationError("Email body is required");
  if (cleanBody.length > BODY_MAX) throw validationError(`Email body must be at most ${BODY_MAX} characters`);

  const used = [...extractVariables(cleanSubject), ...extractVariables(cleanBody)];
  const unknown = [...new Set(used.filter((k) => !VARIABLE_KEYS.includes(k)))];
  if (unknown.length) {
    throw validationError(
      `Unknown variable(s): ${unknown.map((k) => `{{${k}}}`).join(", ")}. Allowed: ${VARIABLE_KEYS.map((k) => `{{${k}}}`).join(", ")}`,
      { unknownVariables: unknown }
    );
  }
  const empty = [...new Set(used.filter((k) => def.unavailableVariables.includes(k)))];
  const warnings = empty.length
    ? [`${empty.map((k) => `{{${k}}}`).join(", ")} will be blank for '${def.label}' emails`]
    : [];
  return { subject: cleanSubject, body: cleanBody, warnings };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Replaces {{variables}}. Values are HTML-escaped in the body (lead names come from
 * customer input) and inserted as plain text in the subject. Unknown variables are
 * left blank rather than leaking braces to the recipient.
 */
function renderTemplate({ subject, body }, values = {}) {
  const lookup = (key, escape) => {
    const v = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : "";
    return escape ? escapeHtml(v) : String(v ?? "");
  };
  return {
    subject: String(subject || "").replace(VARIABLE_PATTERN, (_, k) => lookup(k, false)).trim(),
    body: String(body || "").replace(VARIABLE_PATTERN, (_, k) => lookup(k, true)),
  };
}

function sampleValues() {
  return Object.fromEntries(VARIABLE_KEYS.map((k) => [k, VARIABLES[k].sample]));
}

/** Public catalog for the CRM UI. */
function getCatalog() {
  return {
    tones: TONES,
    variables: VARIABLE_KEYS.map((key) => ({ key, token: `{{${key}}}`, label: VARIABLES[key].label, sample: VARIABLES[key].sample })),
    triggers: TRIGGER_KEYS.map((key) => ({
      key,
      label: TRIGGERS[key].label,
      description: TRIGGERS[key].description,
      anchor: TRIGGERS[key].anchor,
      defaultTiming: TRIGGERS[key].defaultTiming,
      timingLimits: TIMING_LIMITS[TRIGGERS[key].anchor] || null,
      unavailableVariables: TRIGGERS[key].unavailableVariables,
      templates: PRESETS[key],
    })),
  };
}

module.exports = {
  TONES,
  VARIABLES,
  VARIABLE_KEYS,
  TRIGGERS,
  TRIGGER_KEYS,
  EVENT_TRIGGERS,
  SCHEDULED_TRIGGERS,
  PRESETS,
  LATENESS,
  getPreset,
  defaultPreset,
  normalizeTiming,
  timingOffsetMs,
  describeTiming,
  computeBookingSendAt,
  isBookingSendDue,
  extractVariables,
  sanitizeHtml,
  validateTemplate,
  renderTemplate,
  escapeHtml,
  sampleValues,
  getCatalog,
};
