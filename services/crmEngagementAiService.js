"use strict";

/**
 * AI (Claude) for contact engagement. The model helps the business decide; it never
 * sends anything itself:
 *
 *   - draftTemplate: write, rewrite or improve an engagement email template.
 *   - planJourneys:  propose journeys (trigger, emails, waits, stop rules) for this
 *                    business, reusing its templates or drafting new ones. The owner
 *                    reviews the proposal; applying it creates switched-off journeys
 *                    and unapproved templates.
 *   - triageSegments: decide how imported contacts should be engaged (which approved
 *                    journey, or wait for activity), per anonymous segment.
 *   - suggestMapping: map spreadsheet column headers to contact fields.
 *
 * Privacy: prompts contain public business information (name, categories, services,
 * city, description), the owner's own instructions and templates, and aggregate
 * segment counts. Contact names, emails, phone numbers, notes and any other personal
 * CRM data are never sent to the model. Templates use {{variables}} filled at send time.
 *
 * All calls go through crmEmailAiService.callStructured (JSON-schema output,
 * server-side refusal fallbacks, safe error messages; the API key stays on the server).
 */

const mongoose = require("mongoose");
const Business = require("../models/Business");
const aiCore = require("./crmEmailAiService");
const automationCatalog = require("./crmEmailAutomationCatalog");
const catalog = require("./crmEngagementCatalog");
const logger = require("../utils/logger");

const INSTRUCTION_MAX = 500;
const { httpError } = aiCore;

/** Public facts about a business for prompts. */
async function businessContext(businessId) {
  if (!mongoose.isValidObjectId(businessId)) return { name: "a local business" };
  const b = await Business.findById(businessId)
    .select("businessName description category subCategory servicesTypes address.city address.country importedCategory")
    .populate("category", "name")
    .populate("subCategory", "name")
    .lean();
  if (!b) return { name: "a local business" };
  const categories = (b.category || []).map((c) => c?.name).filter(Boolean);
  if (!categories.length && b.importedCategory) categories.push(b.importedCategory);
  const services = [...(b.subCategory || []).map((s) => s?.name), ...(b.servicesTypes || [])].filter(Boolean);
  return {
    name: b.businessName,
    categories: categories.slice(0, 5),
    services: [...new Set(services)].slice(0, 20),
    city: [b.address?.city, b.address?.country].filter(Boolean).join(", "),
    description: String(b.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600),
  };
}

function describeBusiness(ctx) {
  return [
    `Business: ${ctx.name}`,
    ctx.categories?.length ? `Category: ${ctx.categories.join(", ")}` : "",
    ctx.services?.length ? `Services: ${ctx.services.join(", ")}` : "",
    ctx.city ? `Location: ${ctx.city}` : "",
    ctx.description ? `About (from their public listing): ${ctx.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function variablesLine() {
  return catalog
    .getCatalog()
    .variables.map((v) => `{{${v.key}}} (${v.label})`)
    .join(", ");
}

// ── Templates ───────────────────────────────────────────────────────────────

const TEMPLATE_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Email subject line, plain text" },
    body: { type: "string", description: "Email body as simple HTML" },
  },
  required: ["subject", "body"],
  additionalProperties: false,
};

function templateSystemPrompt() {
  return [
    "You write short, personal marketing emails that a local business listed on UrbanCitations sends to people who showed interest in it: visitors, past customers and imported contacts.",
    "The emails must feel written for the recipient's situation, never like a generic newsletter.",
    "",
    "Rules:",
    '- Body HTML may only use <p>, <br>, <strong>, <em>, <a href="...">, <ul> and <li>. No styles, images, scripts or tables.',
    `- Personalise only with these placeholders, written exactly like this: ${variablesLine()}. Never invent other {{...}} placeholders and never write a real name, date or link in their place.`,
    "- {{viewed_item}} is what the recipient last looked at (a service or the business itself); {{booking_link}} opens the booking page.",
    "- Keep the body under 130 words and the subject under 70 characters. One clear call to action.",
    "- Never mention tracking, data, or how you know what they viewed beyond a natural 'you recently viewed' / 'you were looking at'.",
    "- Do not add an unsubscribe line or address; they are added automatically.",
    "- Do not invent facts about the business (prices, discounts, awards, opening hours) unless the owner's instruction states them.",
    "- Sign off with {{business_name}}.",
    "- Write in the language of the owner's instruction; default to English.",
  ].join("\n");
}

/**
 * Drafts a template. action: generate (new), rewrite (change tone), improve (make the
 * owner's draft more personal and effective while keeping its intent).
 */
async function draftTemplate(input = {}, { client } = {}) {
  const action = input.action || "generate";
  if (!["generate", "rewrite", "improve"].includes(action)) throw httpError(400, "action must be generate, rewrite or improve");
  const purpose = catalog.TEMPLATE_PURPOSES[input.purpose] ? input.purpose : "other";
  const tone = input.tone || null;
  if (tone && !automationCatalog.TONES.includes(tone)) throw httpError(400, `tone must be one of ${automationCatalog.TONES.join(", ")}`);
  const instruction = String(input.instruction || "").trim();
  if (instruction.length > INSTRUCTION_MAX) throw httpError(400, `Instruction must be at most ${INSTRUCTION_MAX} characters`);
  let current = null;
  if (action !== "generate") current = catalog.validateEngagementTemplate({ subject: input.subject, body: input.body });

  const ctx = await businessContext(input.businessId);
  const lines = [
    describeBusiness(ctx),
    `Purpose of this email: ${catalog.TEMPLATE_PURPOSES[purpose]}`,
    `Tone: ${tone ? aiCore.TONE_GUIDE[tone] : "Warm and professional."}`,
  ];
  if (instruction) lines.push(`Owner's instruction: ${instruction}`);
  if (action === "generate") {
    lines.push("", "Write a new email for this purpose.");
    if (input.previousSubject) lines.push(`Make it clearly different from the last draft (subject was: "${String(input.previousSubject).slice(0, 200)}").`);
  } else {
    lines.push(
      "",
      action === "rewrite"
        ? "Rewrite the owner's email below in the requested tone, keeping its intent and any facts it states."
        : "Improve the owner's email below: make it more personal and contextual (use the placeholders where they help), clearer and more likely to get a reply or booking. Keep its intent and any facts it states.",
      "<current_email>",
      `Subject: ${current.subject}`,
      current.body,
      "</current_email>"
    );
  }

  const { parsed, model } = await aiCore.callStructured(
    { system: templateSystemPrompt(), user: lines.join("\n"), schema: TEMPLATE_SCHEMA, event: "crm_engagement_ai.template" },
    { client }
  );
  const subject = aiCore.stripUnknownVariables(parsed.subject);
  const body = aiCore.stripUnknownVariables(parsed.body);
  const removed = [...new Set([...subject.removed, ...body.removed])];
  const draft = catalog.validateEngagementTemplate({ subject: subject.cleaned, body: body.cleaned });
  const warnings = removed.length ? [`Removed unsupported placeholder(s): ${removed.map((k) => `{{${k}}}`).join(", ")}`] : [];
  return { subject: draft.subject, body: draft.body, warnings, model, purpose, tone };
}

// ── Journey planning ────────────────────────────────────────────────────────

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Two or three sentences explaining the overall engagement strategy for this business." },
    newTemplates: {
      type: "array",
      description: "New templates to create, only when no existing template fits.",
      items: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Short reference like new_1, used by journey steps" },
          name: { type: "string" },
          purpose: { type: "string", enum: Object.keys(catalog.TEMPLATE_PURPOSES) },
          tone: { type: "string", enum: automationCatalog.TONES },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["ref", "name", "purpose", "tone", "subject", "body"],
        additionalProperties: false,
      },
    },
    journeys: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          goal: { type: "string" },
          rationale: { type: "string", description: "Why this journey suits this business." },
          trigger: { type: "string", enum: catalog.TRIGGER_SIGNALS },
          triggerParam: { type: "integer", description: "repeat_visit: minimum visits; booking_abandoned: hours to wait; inactive: days without activity; otherwise 0." },
          priority: { type: "integer", description: "0-100; higher wins when a contact qualifies for several journeys." },
          reentryDays: { type: "integer" },
          exitOn: { type: "array", items: { type: "string", enum: catalog.EXIT_SIGNALS } },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                template: { type: "string", description: "An existing template id, or the ref of a new template." },
                delayAmount: { type: "integer" },
                delayUnit: { type: "string", enum: ["minutes", "hours", "days"] },
                condition: { type: "string", enum: Object.keys(catalog.STEP_CONDITIONS) },
              },
              required: ["template", "delayAmount", "delayUnit", "condition"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "goal", "rationale", "trigger", "triggerParam", "priority", "reentryDays", "exitOn", "steps"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "newTemplates", "journeys"],
  additionalProperties: false,
};

function planSystemPrompt() {
  const signals = catalog.TRIGGER_SIGNALS.map((k) => `- ${k}: ${catalog.SIGNALS[k].description}`).join("\n");
  const exits = catalog.EXIT_SIGNALS.map((k) => `- ${k}: ${catalog.SIGNALS[k].label}`).join("\n");
  const conditions = Object.entries(catalog.STEP_CONDITIONS).map(([k, v]) => `- ${k}: ${v.label}`).join("\n");
  return [
    "You design automated email journeys for a local business's CRM on UrbanCitations. A journey starts on a signal, sends one or more emails with waits between them, and stops when the contact books, replies or otherwise engages.",
    "",
    "Available trigger signals:",
    signals,
    "",
    "Signals a journey can stop on (unsubscribes and bounces always stop every journey):",
    exits,
    "",
    "Step conditions:",
    conditions,
    "",
    "Guidelines:",
    "- Propose 2 to 5 journeys that fit this kind of business. Favour fewer, well-timed emails: at most 3 steps per journey, follow-ups at least a day apart.",
    "- Contacts get at most a couple of marketing emails a week across all journeys, so do not stack journeys that would fire for the same moment.",
    "- Reuse the business's existing templates when they fit (refer to them by id). Only draft a new template when none fits.",
    "- A contact who books must stop receiving marketing: include booking_created in exitOn unless the journey starts on booking_created or booking_canceled.",
    "- Journeys starting on booking_created are post-booking (thank you, rebook later); keep them light.",
    "- Delays: first step may be immediate (0) or a few hours; follow-ups 1-14 days.",
    `- New templates follow the same rules as the owner's emails: simple HTML (<p>, <br>, <strong>, <em>, <a>, <ul>, <li>), placeholders only from: ${variablesLine()}, under 130 words, signed {{business_name}}, no invented prices or offers.`,
  ].join("\n");
}

/**
 * Proposes journeys for a business. Returns a validated proposal; nothing is saved.
 * @param {object} args { businessId, templates: [{_id,name,purpose,subject}], existingJourneys, instruction }
 */
async function planJourneys({ businessId, templates = [], existingJourneys = [], instruction = "" }, { client } = {}) {
  const cleanInstruction = String(instruction || "").trim();
  if (cleanInstruction.length > INSTRUCTION_MAX) throw httpError(400, `Instruction must be at most ${INSTRUCTION_MAX} characters`);
  const ctx = await businessContext(businessId);
  const templateLines = templates.map((t) => `- id ${t._id}: "${t.name}" (${t.purpose}) subject "${t.subject}"`).join("\n") || "(none)";
  const journeyLines = existingJourneys.map((j) => `- "${j.name}" on ${j.trigger?.signal}${j.isEnabled ? " (on)" : " (off)"}`).join("\n") || "(none)";
  const user = [
    describeBusiness(ctx),
    "",
    "Existing templates:",
    templateLines,
    "",
    "Existing journeys:",
    journeyLines,
    "",
    cleanInstruction ? `Owner's request: ${cleanInstruction}` : "Propose the journeys that would work best for this business.",
  ].join("\n");

  const { parsed, model } = await aiCore.callStructured(
    { system: planSystemPrompt(), user, schema: PLAN_SCHEMA, event: "crm_engagement_ai.plan", effort: "high" },
    { client }
  );
  return { ...validatePlan(parsed, templates), model };
}

/**
 * Keeps only valid parts of an AI plan: templates that pass validation, journeys whose
 * steps reference a known or proposed template, normalized timing and rules.
 */
function validatePlan(parsed, templates = []) {
  const warnings = [];
  const existingIds = new Set(templates.map((t) => String(t._id)));
  const newTemplates = [];
  for (const t of (parsed.newTemplates || []).slice(0, 8)) {
    try {
      const subject = aiCore.stripUnknownVariables(t.subject).cleaned;
      const body = aiCore.stripUnknownVariables(t.body).cleaned;
      const clean = catalog.validateEngagementTemplate({ subject, body });
      newTemplates.push({
        ref: String(t.ref).slice(0, 40),
        name: String(t.name || "AI template").slice(0, 100),
        purpose: catalog.TEMPLATE_PURPOSES[t.purpose] ? t.purpose : "other",
        tone: automationCatalog.TONES.includes(t.tone) ? t.tone : null,
        subject: clean.subject,
        body: clean.body,
      });
    } catch (error) {
      warnings.push(`Dropped a proposed template ("${t?.name}"): ${error.message}`);
    }
  }
  const newRefs = new Set(newTemplates.map((t) => t.ref));
  const journeys = [];
  for (const j of (parsed.journeys || []).slice(0, 6)) {
    const paramKey = Object.keys(catalog.SIGNALS[j.trigger]?.params || {})[0];
    const draft = {
      name: j.name,
      goal: j.goal,
      rationale: String(j.rationale || "").slice(0, 600),
      // `triggerParams` (full object) comes back from the UI on apply; the model returns one `triggerParam`.
      trigger: {
        signal: j.trigger,
        params: j.triggerParams && typeof j.triggerParams === "object" ? j.triggerParams : paramKey && j.triggerParam ? { [paramKey]: j.triggerParam } : {},
      },
      priority: j.priority,
      reentryDays: j.reentryDays,
      exitOn: j.exitOn,
      steps: (j.steps || []).map((s) => ({
        templateId: s.template,
        delay: { amount: Math.max(0, Math.round(Number(s.delayAmount) || 0)), unit: s.delayUnit },
        condition: s.condition,
      })),
    };
    const unknownRef = draft.steps.find((s) => !existingIds.has(String(s.templateId)) && !newRefs.has(String(s.templateId)));
    if (unknownRef) {
      warnings.push(`Dropped journey "${j.name}": it referenced a template that does not exist.`);
      continue;
    }
    try {
      const normalized = catalog.normalizeJourney(draft);
      if (!["booking_created", "booking_canceled"].includes(normalized.trigger.signal) && !normalized.exitOn.includes("booking_created")) {
        normalized.exitOn.push("booking_created");
      }
      journeys.push({ ...normalized, rationale: draft.rationale });
    } catch (error) {
      warnings.push(`Dropped journey "${j.name}": ${error.message}`);
    }
  }
  return { summary: String(parsed.summary || "").slice(0, 800), newTemplates, journeys, warnings };
}

// ── Import triage ───────────────────────────────────────────────────────────

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          segment: { type: "string" },
          action: { type: "string", enum: ["enroll", "wait"] },
          journeyId: { type: "string", description: "Required when action is enroll; empty otherwise." },
          reason: { type: "string", description: "One short sentence the business owner will read." },
        },
        required: ["segment", "action", "journeyId", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["decisions"],
  additionalProperties: false,
};

/**
 * Decides, per anonymous segment of imported contacts, which journey (if any) they
 * should enter. Segments only carry counts and coarse attributes.
 * @returns {Promise<Array<{segment, action, journeyId, reason}>>}
 */
async function triageSegments({ businessId, segments, candidates }, { client } = {}) {
  const ctx = await businessContext(businessId);
  const system = [
    "You help a local business decide how to engage contacts they just imported into their CRM, without spamming them.",
    "For each segment, choose one of the business's switched-on journeys, or 'wait' (no email now; they will be engaged when they next interact).",
    "Guidelines:",
    "- Never email for the sake of it: a segment gets an email only if the chosen journey genuinely fits its situation.",
    "- Recently active customers usually need nothing ('wait').",
    "- Contacts who have not interacted for a long time fit a re-engagement / win-back journey if one exists.",
    "- Contacts with no known history fit a low-pressure introduction journey if one exists; otherwise wait.",
    "- Contacts marked lost in the pipeline should usually wait.",
    "- Only use journey ids from the list.",
  ].join("\n");
  const user = [
    describeBusiness(ctx),
    "",
    "Switched-on journeys that imported contacts may enter:",
    candidates.map((j) => `- id ${j._id}: "${j.name}" (starts on ${j.trigger.signal}; ${j.goal || ""})`).join("\n"),
    "",
    "Segments of imported contacts:",
    segments.map((s) => `- segment ${s.key}: ${s.count} contact(s); ${s.description}`).join("\n"),
  ].join("\n");
  const { parsed } = await aiCore.callStructured({ system, user, schema: TRIAGE_SCHEMA, event: "crm_engagement_ai.triage", effort: "low" }, { client });
  const validIds = new Set(candidates.map((j) => String(j._id)));
  const validSegments = new Set(segments.map((s) => s.key));
  return (parsed.decisions || [])
    .filter((d) => validSegments.has(d.segment))
    .map((d) => ({
      segment: d.segment,
      action: d.action === "enroll" && validIds.has(String(d.journeyId)) ? "enroll" : "wait",
      journeyId: d.action === "enroll" && validIds.has(String(d.journeyId)) ? String(d.journeyId) : null,
      reason: String(d.reason || "").slice(0, 300),
    }));
}

// ── Column mapping ──────────────────────────────────────────────────────────

/**
 * Maps spreadsheet headers to contact fields. Only header names are sent (no cell
 * values), so no personal data leaves the server.
 */
async function suggestMapping(headers, fields, { client } = {}) {
  const schema = {
    type: "object",
    properties: {
      mapping: {
        type: "array",
        items: {
          type: "object",
          properties: {
            header: { type: "string" },
            field: { type: "string", enum: [...fields.map((f) => f.key), "ignore"] },
          },
          required: ["header", "field"],
          additionalProperties: false,
        },
      },
    },
    required: ["mapping"],
    additionalProperties: false,
  };
  const system = "You map spreadsheet column headers from a contact list to CRM contact fields. Map each header to the single best field, or 'ignore' if none fits. Never map two headers to the same field unless the field is 'tags' or 'notes'.";
  const user = [
    "Contact fields:",
    fields.map((f) => `- ${f.key}: ${f.label}`).join("\n"),
    "",
    "Headers:",
    headers.map((h) => `- ${h}`).join("\n"),
  ].join("\n");
  const { parsed } = await aiCore.callStructured({ system, user, schema, event: "crm_engagement_ai.mapping", effort: "low", maxTokens: 4000 }, { client });
  const known = new Set(headers);
  const out = {};
  for (const m of parsed.mapping || []) {
    if (known.has(m.header) && m.field !== "ignore") out[m.header] = m.field;
  }
  logger.info("crm_engagement_ai.mapping_suggested", "AI suggested import column mapping", { headers: headers.length, mapped: Object.keys(out).length });
  return out;
}

module.exports = {
  isConfigured: aiCore.isConfigured,
  businessContext,
  draftTemplate,
  planJourneys,
  validatePlan,
  triageSegments,
  suggestMapping,
  templateSystemPrompt,
  planSystemPrompt,
};
