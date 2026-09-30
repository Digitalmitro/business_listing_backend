"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const ai = require("./crmEngagementAiService");
const { closeQueueConnections } = require("../utils/queue");

after(async () => {
  await closeQueueConnections().catch(() => {});
});

/** Fake Anthropic client: records requests, returns canned JSON. */
function fakeClient(output, { stopReason = "end_turn" } = {}) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (req) => {
          calls.push(req);
          return { model: req.model, stop_reason: stopReason, content: [{ type: "text", text: JSON.stringify(output) }], usage: {} };
        },
      },
    },
  };
}

test("template drafts are validated and invented placeholders removed", async () => {
  const client = fakeClient({ subject: "Still thinking about {{viewed_item}}?", body: "<p>Hi {{name}}, {{secret_discount}} <script>x</script></p>" });
  const draft = await ai.draftTemplate({ action: "generate", purpose: "still_interested", tone: "friendly", instruction: "short" }, { client });
  assert.equal(draft.subject, "Still thinking about {{viewed_item}}?");
  assert.doesNotMatch(draft.body, /secret_discount|script/);
  assert.match(draft.warnings[0], /secret_discount/);
  const req = client.calls[0];
  assert.equal(req.output_config.format.type, "json_schema");
  assert.equal(req.fallbacks, "default");
  await assert.rejects(ai.draftTemplate({ action: "improve", subject: "", body: "" }, { client }), /Subject is required/);
  await assert.rejects(ai.draftTemplate({ action: "delete" }, { client }), /action must be/);
});

test("journey plans keep only valid journeys and templates", () => {
  const plan = ai.validatePlan(
    {
      summary: "s",
      newTemplates: [
        { ref: "new_1", name: "Nudge", purpose: "still_interested", tone: "friendly", subject: "Hi {{name}}", body: "<p>Hello {{made_up}}</p>" },
        { ref: "new_bad", name: "Empty", purpose: "other", tone: "friendly", subject: "", body: "" },
      ],
      journeys: [
        { name: "Good", goal: "g", rationale: "r", trigger: "contact_captured", triggerParam: 0, priority: 50, reentryDays: 30, exitOn: ["email_replied"], steps: [{ template: "t1", delayAmount: 1, delayUnit: "hours", condition: "always" }, { template: "new_1", delayAmount: 2, delayUnit: "days", condition: "no_click" }] },
        { name: "Unknown template", goal: "", rationale: "", trigger: "contact_captured", triggerParam: 0, priority: 1, reentryDays: 1, exitOn: [], steps: [{ template: "nope", delayAmount: 0, delayUnit: "hours", condition: "always" }] },
        { name: "Spammy", goal: "", rationale: "", trigger: "business_viewed", triggerParam: 0, priority: 1, reentryDays: 1, exitOn: [], steps: [{ template: "t1", delayAmount: 0, delayUnit: "hours", condition: "always" }, { template: "t1", delayAmount: 5, delayUnit: "minutes", condition: "always" }] },
        { name: "Repeat", goal: "", rationale: "", trigger: "repeat_visit", triggerParam: 4, priority: 60, reentryDays: 30, exitOn: [], steps: [{ template: "t1", delayAmount: 0, delayUnit: "hours", condition: "always" }] },
      ],
    },
    [{ _id: "t1" }]
  );
  assert.equal(plan.newTemplates.length, 1);
  assert.doesNotMatch(plan.newTemplates[0].body, /made_up/);
  assert.deepEqual(plan.journeys.map((j) => j.name), ["Good", "Repeat"]);
  assert.ok(plan.journeys[0].exitOn.includes("booking_created"), "booking always stops marketing");
  assert.equal(plan.journeys[1].trigger.params.minVisits, 4);
  assert.equal(plan.warnings.length, 3);
});

test("import triage sends only anonymous segments and accepts only offered journeys", async () => {
  const client = fakeClient({
    decisions: [
      { segment: "0-30d|none|", action: "enroll", journeyId: "j1", reason: "Recent" },
      { segment: "365d+|none|", action: "enroll", journeyId: "not-offered", reason: "?" },
      { segment: "ghost", action: "enroll", journeyId: "j1", reason: "?" },
    ],
  });
  const decisions = await ai.triageSegments(
    {
      businessId: null,
      segments: [
        { key: "0-30d|none|", count: 3, description: "last active within 30 days" },
        { key: "365d+|none|", count: 2, description: "last active over a year ago" },
      ],
      candidates: [{ _id: "j1", name: "Intro", goal: "", trigger: { signal: "contact_imported" } }],
    },
    { client }
  );
  assert.deepEqual(decisions.map((d) => [d.segment, d.action, d.journeyId]), [
    ["0-30d|none|", "enroll", "j1"],
    ["365d+|none|", "wait", null],
  ]);
  const prompt = JSON.stringify(client.calls[0]);
  assert.doesNotMatch(prompt, /@|\bphone\b/i);
});

test("column mapping sends header names only", async () => {
  const client = fakeClient({ mapping: [{ header: "Correo", field: "email" }, { header: "Nombre", field: "name" }, { header: "Other", field: "ignore" }, { header: "Invented", field: "email" }] });
  const mapping = await ai.suggestMapping(["Correo", "Nombre", "Other"], [{ key: "email", label: "Email" }, { key: "name", label: "Name" }], { client });
  assert.deepEqual(mapping, { Correo: "email", Nombre: "name" });
  assert.match(client.calls[0].messages[0].content, /Correo/);
});

test("refusals become a clear error", async () => {
  const client = fakeClient({}, { stopReason: "refusal" });
  await assert.rejects(ai.draftTemplate({ action: "generate", purpose: "welcome" }, { client }), (e) => e.status === 422);
});

test("applying a plan keeps every trigger parameter", () => {
  const plan = ai.validatePlan(
    { summary: "", newTemplates: [], journeys: [{ name: "R", goal: "", rationale: "", trigger: "repeat_visit", triggerParams: { minVisits: 4, withinDays: 14 }, priority: 1, reentryDays: 1, exitOn: [], steps: [{ template: "t1", delayAmount: 0, delayUnit: "hours", condition: "always" }] }] },
    [{ _id: "t1" }]
  );
  assert.deepEqual(plan.journeys[0].trigger.params, { minVisits: 4, withinDays: 14 });
});
