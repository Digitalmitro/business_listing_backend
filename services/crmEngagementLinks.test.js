"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.CRM_LINK_SECRET = "unit-test-secret";
const links = require("./crmEngagementLinks");

test("unsubscribe tokens are signed and tamper-evident", () => {
  const t = links.unsubscribeToken({ contactId: "c1", businessId: "b1", email: "A@B.com" });
  assert.deepEqual(links.verifyUnsubscribe(t), { t: "u", c: "c1", b: "b1", e: "a@b.com" });
  const [body, mac] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ t: "u", c: "c2", b: "b1", e: "x@y.com" })).toString("base64url");
  assert.equal(links.verifyUnsubscribe(`${forged}.${mac}`), null);
  assert.equal(links.verifyUnsubscribe(`${body}.AAAA`), null);
  assert.equal(links.verifyUnsubscribe("garbage"), null);
  // A click token is not an unsubscribe token.
  const click = links.clickUrl({ dispatchId: "d1", url: "https://x.test" }).split("/r/")[1];
  assert.equal(links.verifyUnsubscribe(decodeURIComponent(click)), null);
});

test("click tokens only redirect to signed http(s) destinations", () => {
  const token = decodeURIComponent(links.clickUrl({ dispatchId: "d1", url: "https://shop.test/a?x=1&y=2" }).split("/r/")[1]);
  assert.deepEqual(links.verifyClick(token), { dispatchId: "d1", url: "https://shop.test/a?x=1&y=2" });
  const js = decodeURIComponent(links.clickUrl({ dispatchId: "d1", url: "javascript:alert(1)" }).split("/r/")[1]);
  assert.equal(links.verifyClick(js), null);
  const evil = Buffer.from(JSON.stringify({ t: "c", d: "d1", u: "https://evil.test" })).toString("base64url");
  assert.equal(links.verifyClick(`${evil}.${token.split(".")[1]}`), null);
});

test("trackLinks rewrites http(s) links only", () => {
  const html = '<a href="https://a.test/?p=1&amp;q=2">A</a> <a href="mailto:x@y.z">M</a> <a href="#top">T</a>';
  const out = links.trackLinks(html, "d9");
  assert.match(out, /\/public\/r\//);
  assert.match(out, /href="mailto:x@y.z"/);
  assert.match(out, /href="#top"/);
  const token = decodeURIComponent(/public\/r\/([^"]+)"/.exec(out)[1]);
  assert.equal(links.verifyClick(token).url, "https://a.test/?p=1&q=2");
});
