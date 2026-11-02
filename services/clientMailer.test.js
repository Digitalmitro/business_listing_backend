"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const businessSender = require("./businessSenderService");
const clientMailer = require("./clientMailer");

const businessOn = (packageName) => ({ _id: "6ae6cf61a44612fe71e6b07a", subscription: packageName ? { status: "active", packageName } : { status: "inactive" } });

function stubVerifiedSender(context, { sendMail } = {}) {
  const sent = [];
  context.mock.method(businessSender, "getVerifiedTransport", async () => ({
    senderId: "s1",
    sender: { email: "owner@client-domain.test", displayName: "Sparkle Home Cleaners" },
    transport: { sendMail: sendMail || (async (msg) => { sent.push(msg); return { messageId: "<m1@client-domain.test>" }; }) },
  }));
  context.mock.method(businessSender, "recordUse", async () => {});
  return sent;
}

test("a Free business never sends customer emails, even with a verified sender", async (context) => {
  const sent = stubVerifiedSender(context);
  const res = await clientMailer.sendAsBusiness({ business: businessOn(null), kind: "booking", to: "c@x.test", subject: "s", html: "h" });
  assert.equal(res.skipped, true);
  assert.equal(res.code, clientMailer.SKIP.plan);
  assert.match(res.reason, /Free plan/);
  assert.equal(sent.length, 0);
});

test("reminders are sent only for the reminder keys the plan includes", async (context) => {
  const sent = stubVerifiedSender(context);
  const basic3d = await clientMailer.sendAsBusiness({ business: businessOn("Basic"), kind: "booking", reminderKey: "1d", to: "c@x.test", subject: "s", html: "h" });
  assert.equal(basic3d.skipped, true);
  assert.match(basic3d.reason, /needs Silver/);
  const silver1d = await clientMailer.sendAsBusiness({ business: businessOn("Silver"), kind: "booking", reminderKey: "1d", to: "c@x.test", subject: "s", html: "h" });
  assert.equal(silver1d.success, true);
  const silver3d = await clientMailer.sendAsBusiness({ business: businessOn("Silver"), kind: "booking", reminderKey: "3d", to: "c@x.test", subject: "s", html: "h" });
  assert.match(silver3d.reason, /needs Gold/);
  assert.equal(sent.length, 1);
});

test("emails go out FROM the business's own verified address (never a UC address)", async (context) => {
  const sent = stubVerifiedSender(context);
  const res = await clientMailer.sendAsBusiness({
    business: businessOn("Gold"),
    kind: "crm_automation",
    to: "lead@x.test",
    subject: "Hi",
    html: "<p>Hi</p>",
    replyTo: "owner-personal@x.test",
    headers: { "List-Unsubscribe": "<https://u>" },
  });
  assert.equal(res.success, true);
  assert.equal(res.from, "owner@client-domain.test");
  assert.deepEqual(sent[0].from, { name: "Sparkle Home Cleaners", address: "owner@client-domain.test" });
  assert.equal(sent[0].to, "lead@x.test");
  assert.equal(sent[0].replyTo, "owner-personal@x.test");
  assert.equal(sent[0].headers["List-Unsubscribe"], "<https://u>");
});

test("without a verified sender the email goes out through the platform sender", async (context) => {
  context.mock.method(businessSender, "getVerifiedTransport", async () => null);
  const platform = require("./sendMail");
  const sent = [];
  context.mock.method(platform, "sendMail", async (to, subject, html, options) => { sent.push({ to, subject, html, options }); return { success: true, info: { messageId: "<p1@uc.test>" } }; });
  const res = await clientMailer.sendAsBusiness({ business: businessOn("Premium"), kind: "booking", to: "c@x.test", subject: "s", html: "h", replyTo: "owner@x.test" });
  assert.equal(res.success, true);
  assert.equal(res.via, "platform");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "c@x.test");
  assert.equal(sent[0].options.replyTo, "owner@x.test");
});

test("a platform-sender failure is returned as an error to retry", async (context) => {
  context.mock.method(businessSender, "getVerifiedTransport", async () => null);
  context.mock.method(require("./sendMail"), "sendMail", async () => ({ success: false, error: new Error("535 auth failed") }));
  const res = await clientMailer.sendAsBusiness({ business: businessOn("Premium"), kind: "booking", to: "c@x.test", subject: "s", html: "h" });
  assert.equal(res.success, false);
  assert.equal(res.skipped, undefined);
  assert.match(res.error.message, /535/);
});

test("CLIENT_MAIL_PLATFORM_FALLBACK=false restores the strict own-sender-only rule", async (context) => {
  context.mock.method(businessSender, "getVerifiedTransport", async () => null);
  const prev = process.env.CLIENT_MAIL_PLATFORM_FALLBACK;
  process.env.CLIENT_MAIL_PLATFORM_FALLBACK = "false";
  try {
    const res = await clientMailer.sendAsBusiness({ business: businessOn("Premium"), kind: "booking", to: "c@x.test", subject: "s", html: "h" });
    assert.equal(res.skipped, true);
    assert.equal(res.code, clientMailer.SKIP.sender);
  } finally {
    if (prev === undefined) delete process.env.CLIENT_MAIL_PLATFORM_FALLBACK; else process.env.CLIENT_MAIL_PLATFORM_FALLBACK = prev;
  }
});

test("CRM emails need Gold, journeys and AI need Premium", async (context) => {
  stubVerifiedSender(context);
  const silverCrm = await clientMailer.sendAsBusiness({ business: businessOn("Silver"), kind: "crm_automation", to: "c@x.test", subject: "s", html: "h" });
  assert.match(silverCrm.reason, /needs Gold/);
  const goldJourney = await clientMailer.sendAsBusiness({ business: businessOn("Gold"), kind: "journey", to: "c@x.test", subject: "s", html: "h" });
  assert.match(goldJourney.reason, /needs Premium/);
  const premiumJourney = await clientMailer.sendAsBusiness({ business: businessOn("Premium"), kind: "journey", to: "c@x.test", subject: "s", html: "h" });
  assert.equal(premiumJourney.success, true);
});

test("an SMTP failure is returned as an error to retry, not a skip", async (context) => {
  stubVerifiedSender(context, { sendMail: async () => { throw new Error("421 try again later"); } });
  const res = await clientMailer.sendAsBusiness({ business: businessOn("Basic"), kind: "booking", to: "c@x.test", subject: "s", html: "h" });
  assert.equal(res.success, false);
  assert.equal(res.skipped, undefined);
  assert.match(res.error.message, /421/);
});
