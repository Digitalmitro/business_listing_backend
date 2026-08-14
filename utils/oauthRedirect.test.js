"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveFrontendReturnTo, oauthResultUrl } = require("./oauthRedirect");

test("OAuth redirects accept frontend-local paths and reject foreign origins", () => {
  const previous = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = "https://urbancitations.com";
  assert.equal(resolveFrontendReturnTo("/settings/integrations").toString(), "https://urbancitations.com/settings/integrations");
  assert.equal(resolveFrontendReturnTo("https://evil.example/path").toString(), "https://urbancitations.com/settings/integrations");
  const result = new URL(oauthResultUrl("/settings/integrations", { social: "connected", platform: "threads" }));
  assert.equal(result.searchParams.get("platform"), "threads");
  process.env.FRONTEND_URL = previous;
});
