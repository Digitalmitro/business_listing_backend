"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyEmailPlaceholders } = require("./emailPlaceholders");

test("subjects and bodies get business placeholders, with or without inner spaces", () => {
  const out = applyEmailPlaceholders("Hello {{business_name}} in {{ country }}!", { business_name: "Sparkle", country: "India" });
  assert.equal(out, "Hello Sparkle in India!");
});

test("custom variables are substituted; unknown placeholders are left alone", () => {
  const out = applyEmailPlaceholders("Use {{promo}} at {{unknown_thing}}", { promo: "CODE10" });
  assert.equal(out, "Use CODE10 at {{unknown_thing}}");
});

test("built-in keys keep their fallbacks", () => {
  assert.equal(applyEmailPlaceholders("Hi {{full_name}}", {}), "Hi User");
  assert.equal(applyEmailPlaceholders("{{category_name}}", { category: "Spa" }), "Spa");
});
