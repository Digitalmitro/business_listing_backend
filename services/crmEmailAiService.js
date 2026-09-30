"use strict";

/**
 * AI drafting for CRM automation emails (Claude via the Anthropic SDK).
 *
 * The assistant only ever returns a draft to the CRM UI. Nothing here saves or
 * enables an automation: the owner edits, previews and approves the draft, and
 * crmEmailAutomationService.saveAutomation enforces that approval.
 *
 * Privacy: prompts contain the business name, the trigger and the owner's own
 * instruction/draft. Lead or customer data is never sent; templates use
 * {{variables}} that are filled in at send time.
 *
 * The API key stays on the server (ANTHROPIC_API_KEY); the frontend only calls
 * POST /api/crm/email-automation/ai/generate.
 */

const Anthropic = require("@anthropic-ai/sdk");
const catalog = require("./crmEmailAutomationCatalog");
const logger = require("../utils/logger");

const MODEL = process.env.CRM_AI_EMAIL_MODEL || "claude-opus-5";
const EFFORT = ["low", "medium", "high"].includes(process.env.CRM_AI_EMAIL_EFFORT)
  ? process.env.CRM_AI_EMAIL_EFFORT
  : "medium";
const ACTIONS = ["generate", "rewrite"];
const INSTRUCTION_MAX = 500;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Email subject line, plain text" },
    body: { type: "string", description: "Email body as simple HTML" },
  },
  required: ["subject", "body"],
  additionalProperties: false,
};

const TONE_GUIDE = {
  professional: "Professional: courteous, clear and concise; no slang or exclamation marks.",
  friendly: "Friendly: warm, personal and conversational, like a message from a local business owner who knows their customers.",
  promotional: "Promotional: upbeat and persuasive with a clear call to action. Do not invent discounts, prices or offers unless the owner's instruction states them.",
};

let client = null;

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function getClient() {
  if (!client) client = new Anthropic.Anthropic({ timeout: 60_000, maxRetries: 1 });
  return client;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function systemPrompt() {
  const variables = catalog.VARIABLE_KEYS.map((k) => `{{${k}}} (${catalog.VARIABLES[k].label})`).join(", ");
  return [
    "You write short automated emails that a local business listed on UrbanCitations sends to its leads and customers.",
    "Return a subject line and an HTML body.",
    "",
    "Rules:",
    "- Body HTML may only use <p>, <br>, <strong>, <em>, <a href=\"...\">, <ul> and <li>. No styles, images, scripts or tables.",
    `- Personalise only with these placeholders, written exactly like this: ${variables}. Never use any other {{...}} placeholder and never write a real name, date or link in their place.`,
    "- Placeholders listed as unavailable for the trigger will be blank, so do not use them.",
    "- Keep the body under 150 words and the subject under 80 characters.",
    "- Do not add an unsubscribe line or a physical address; they are added automatically.",
    "- Do not invent facts about the business (prices, discounts, opening hours, awards).",
    "- Sign off with {{business_name}}.",
    "- Write in the language of the owner's instruction; default to English.",
  ].join("\n");
}

function userPrompt({ trigger, tone, instruction, subject, body, action, businessName, previousSubject }) {
  const def = catalog.TRIGGERS[trigger];
  const unavailable = def.unavailableVariables.length
    ? def.unavailableVariables.map((k) => `{{${k}}}`).join(", ")
    : "none";
  const lines = [
    `Business: ${businessName || "a local business"}`,
    `Trigger: ${def.label} - ${def.description}`,
    `Unavailable placeholders for this trigger: ${unavailable}`,
    `Tone: ${tone ? TONE_GUIDE[tone] : "Match the trigger; professional and warm."}`,
  ];
  if (instruction) lines.push(`Owner's instruction: ${instruction}`);
  if (action === "rewrite") {
    lines.push(
      "",
      "Rewrite the owner's current email below in the requested tone, keeping its intent and any facts it states.",
      "<current_email>",
      `Subject: ${subject}`,
      body,
      "</current_email>"
    );
  } else {
    lines.push("", "Write a new email for this trigger.");
    if (previousSubject) {
      lines.push(`The owner asked for a different version than their last draft (subject was: "${previousSubject}").`);
    }
  }
  return lines.join("\n");
}

/** Drops placeholders the model made up so the draft always passes validation. */
function stripUnknownVariables(text) {
  const removed = new Set();
  const cleaned = String(text || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (catalog.VARIABLE_KEYS.includes(key)) return `{{${key}}}`;
    removed.add(key);
    return "";
  });
  return { cleaned, removed: [...removed] };
}

function validateRequest(input) {
  const trigger = input.trigger;
  if (!catalog.TRIGGERS[trigger]) throw httpError(400, `Unknown trigger '${trigger}'`);
  const action = input.action || "generate";
  if (!ACTIONS.includes(action)) throw httpError(400, "action must be 'generate' or 'rewrite'");
  const tone = input.tone || null;
  if (tone && !catalog.TONES.includes(tone)) throw httpError(400, `tone must be one of ${catalog.TONES.join(", ")}`);
  const instruction = String(input.instruction || "").trim();
  if (instruction.length > INSTRUCTION_MAX) throw httpError(400, `Instruction must be at most ${INSTRUCTION_MAX} characters`);
  let subject = "";
  let body = "";
  if (action === "rewrite") {
    ({ subject, body } = catalog.validateTemplate(trigger, { subject: input.subject, body: input.body }));
  }
  const previousSubject = String(input.previousSubject || "").slice(0, 200);
  return { trigger, action, tone, instruction, subject, body, previousSubject };
}

/**
 * Generates or rewrites an email draft for a trigger.
 * @returns {Promise<{subject: string, body: string, warnings: string[], model: string}>}
 */
async function generateEmail(input = {}, { client: injectedClient } = {}) {
  const request = validateRequest(input);
  if (!injectedClient && !isConfigured()) {
    throw httpError(503, "The AI email assistant is not configured on this server");
  }
  const api = injectedClient || getClient();

  let response;
  try {
    response = await api.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: EFFORT, format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      system: systemPrompt(),
      messages: [{ role: "user", content: userPrompt({ ...request, businessName: input.businessName }) }],
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      throw httpError(429, "The AI assistant is busy. Please try again in a minute.");
    }
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      logger.error("crm_email_ai.auth_failed", "AI email assistant credentials were rejected", { status: error.status });
      throw httpError(503, "The AI email assistant is not available right now");
    }
    if (error instanceof Anthropic.APIError) {
      logger.error("crm_email_ai.api_error", "AI email generation failed", { status: error.status, error: error.message });
      throw httpError(502, "The AI assistant could not generate an email. Please try again.");
    }
    throw error;
  }

  if (response.stop_reason === "refusal") {
    logger.warn("crm_email_ai.refused", "AI declined to write an email", { category: response.stop_details?.category });
    throw httpError(422, "The AI assistant could not write this email. Try rephrasing your instruction.");
  }
  if (response.stop_reason === "max_tokens") {
    throw httpError(502, "The AI response was cut off. Please try again.");
  }

  const text = (response.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.error("crm_email_ai.bad_output", "AI returned output that is not valid JSON", { length: text.length });
    throw httpError(502, "The AI assistant returned an unexpected response. Please try again.");
  }

  const subject = stripUnknownVariables(parsed.subject);
  const body = stripUnknownVariables(parsed.body);
  const removed = [...new Set([...subject.removed, ...body.removed])];
  const draft = catalog.validateTemplate(request.trigger, { subject: subject.cleaned, body: body.cleaned });
  const warnings = [...draft.warnings];
  if (removed.length) warnings.push(`Removed unsupported placeholder(s): ${removed.map((k) => `{{${k}}}`).join(", ")}`);

  logger.info("crm_email_ai.generated", "AI email draft generated", {
    trigger: request.trigger,
    action: request.action,
    tone: request.tone,
    model: response.model,
    usageIn: response.usage?.input_tokens,
    usageOut: response.usage?.output_tokens,
  });
  return { subject: draft.subject, body: draft.body, warnings, model: response.model };
}

module.exports = {
  MODEL,
  isConfigured,
  generateEmail,
  stripUnknownVariables,
  systemPrompt,
  userPrompt,
};
