"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizePhoneNumber,
  resolveCountryCode,
  validatePhoneNumber,
} = require("./phoneNumber");

const validNumbers = [
  ["India mobile", "98765 43210", "India", "+919876543210"],
  ["US landline", "(213) 373-4253", "US", "+12133734253"],
  ["UK landline", "020 7946 0958", "United Kingdom", "+442079460958"],
  ["Australian landline", "02 9374 4000", "AU", "+61293744000"],
  ["Brazil mobile", "(11) 96123-4567", "Brazil", "+5511961234567"],
  ["Japan landline", "03-1234-5678", "Japan", "+81312345678"],
  ["South Africa landline", "011 123 4567", "South Africa", "+27111234567"],
  ["Germany variable length", "030 123456", "Germany", "+4930123456"],
];

for (const [name, input, country, expected] of validNumbers) {
  test(`normalizes ${name} to E.164`, () => {
    assert.equal(normalizePhoneNumber(input, { country }), expected);
  });
}

test("detects a shared +1 country code from the full number", () => {
  const result = validatePhoneNumber("+1 416 555 0123");
  assert.equal(result.valid, true);
  assert.equal(result.country, "CA");
  assert.equal(result.e164, "+14165550123");
});

test("accepts mobile and fixed-line number types", () => {
  assert.equal(validatePhoneNumber("+919876543210").type, "MOBILE");
  assert.match(validatePhoneNumber("+442079460958").type, /FIXED_LINE/);
});

test("returns actionable length and selected-country errors", () => {
  assert.equal(validatePhoneNumber("123", { country: "US" }).message, "Phone number is too short.");
  assert.equal(
    validatePhoneNumber("123456789012345678", { country: "US" }).message,
    "Phone number is too long.",
  );
  assert.equal(
    validatePhoneNumber("+919876543210", { country: "US", strictCountry: true }).message,
    "Invalid phone number for the selected country.",
  );
});

test("rejects invalid prefixes and malformed text", () => {
  assert.equal(validatePhoneNumber("+1 111 111 1111").valid, false);
  assert.equal(validatePhoneNumber("call me at +91 98765 43210").valid, false);
});

test("resolves ISO codes, aliases, names, and territories", () => {
  assert.equal(resolveCountryCode("UK"), "GB");
  assert.equal(resolveCountryCode("Curaçao"), "CW");
  assert.equal(resolveCountryCode("United States of America"), "US");
});
