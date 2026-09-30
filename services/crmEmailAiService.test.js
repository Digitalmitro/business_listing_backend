"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const ai = require("./crmEmailAiService");

function fakeClient(response) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        async create(params) {
          calls.push(params);
          return typeof response === "function" ? response(params) : response;
        },
      },
    },
  };
}

const ok = (payload) => ({
  model: "claude-opus-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify(payload) }],
  usage: { input_tokens: 10, output_tokens: 20 },
});

test("generateEmail returns a validated draft and requests structured JSON output", async () => {
  const client = fakeClient(ok({
    subject: "See you tomorrow, {{lead_name}}!",
    body: "<p>Hi {{lead_name}}, your {{service_name}} is on {{booking_date}} at {{booking_time}}.</p><p>{{business_name}}</p>",
  }));
  const draft = await ai.generateEmail(
    { trigger: "booking_reminder", tone: "friendly", instruction: "Generate a friendly reminder for tomorrow's booking.", businessName: "Glow" },
    { client }
  );
  assert.equal(draft.subject, "See you tomorrow, {{lead_name}}!");
  assert.match(draft.body, /\{\{booking_time\}\}/);
  assert.deepEqual(draft.warnings, []);

  const params = client.calls[0];
  assert.equal(params.model, ai.MODEL);
  assert.equal(params.output_config.format.type, "json_schema");
  assert.deepEqual(params.output_config.format.schema.required, ["subject", "body"]);
  assert.equal(params.fallbacks, "default");
  assert.match(params.messages[0].content, /Glow/);
  assert.match(params.messages[0].content, /friendly reminder for tomorrow/);
});

test("rewrite sends the owner's draft, and prompts never include lead data", async () => {
  const client = fakeClient(ok({ subject: "Your booking", body: "<p>Dear {{lead_name}}</p>" }));
  await ai.generateEmail(
    { trigger: "booking_created", action: "rewrite", tone: "professional", subject: "hey {{lead_name}}", body: "<p>yo</p>" },
    { client }
  );
  const prompt = client.calls[0].messages[0].content;
  assert.match(prompt, /<current_email>/);
  assert.match(prompt, /hey \{\{lead_name\}\}/);
  assert.match(ai.systemPrompt(), /\{\{lead_name\}\}/);
});

test("made-up placeholders are removed and reported", async () => {
  const client = fakeClient(ok({ subject: "Hi {{first_name}}", body: "<p>Use code {{promo_code}} at {{business_name}}</p>" }));
  const draft = await ai.generateEmail({ trigger: "new_lead" }, { client });
  assert.equal(draft.subject, "Hi");
  assert.doesNotMatch(draft.body, /promo_code/);
  assert.ok(draft.warnings.some((w) => /first_name/.test(w) && /promo_code/.test(w)));
});

test("refusals and malformed output become clear errors", async () => {
  await assert.rejects(
    ai.generateEmail({ trigger: "new_lead" }, { client: fakeClient({ stop_reason: "refusal", content: [], stop_details: { category: null } }) }),
    (err) => err.status === 422
  );
  await assert.rejects(
    ai.generateEmail({ trigger: "new_lead" }, { client: fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] }) }),
    (err) => err.status === 502
  );
  await assert.rejects(
    ai.generateEmail({ trigger: "new_lead" }, { client: fakeClient({ stop_reason: "max_tokens", content: [] }) }),
    (err) => err.status === 502
  );
});

test("requests are validated before calling the model", async () => {
  const client = fakeClient(ok({ subject: "x", body: "<p>x</p>" }));
  await assert.rejects(ai.generateEmail({ trigger: "nope" }, { client }), (e) => e.status === 400);
  await assert.rejects(ai.generateEmail({ trigger: "new_lead", tone: "angry" }, { client }), (e) => e.status === 400);
  await assert.rejects(ai.generateEmail({ trigger: "new_lead", action: "delete" }, { client }), (e) => e.status === 400);
  await assert.rejects(ai.generateEmail({ trigger: "new_lead", instruction: "x".repeat(501) }, { client }), (e) => e.status === 400);
  await assert.rejects(ai.generateEmail({ trigger: "new_lead", action: "rewrite", subject: "", body: "" }, { client }), (e) => e.status === 400);
  assert.equal(client.calls.length, 0);
});

test("without an API key the assistant reports that it is not configured", async () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    assert.equal(ai.isConfigured(), false);
    await assert.rejects(ai.generateEmail({ trigger: "new_lead" }), (e) => e.status === 503);
  } finally {
    if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
  }
});

test("stripUnknownVariables keeps supported placeholders", () => {
  assert.deepEqual(ai.stripUnknownVariables("Hi {{ lead_name }} {{x}}"), { cleaned: "Hi {{lead_name}} ", removed: ["x"] });
});
