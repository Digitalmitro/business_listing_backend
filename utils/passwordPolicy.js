"use strict";

const validator = require("validator");

/** Minimum password policy: 8+ characters with at least one letter and one number. */
function passwordPolicyError(password) {
  if (typeof password !== "string" || password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return "Password must be at least 8 characters and contain letters and numbers.";
  }
  if (password.length > 128) return "Password must be at most 128 characters.";
  return null;
}

/** A real address with a top-level domain (rejects "a@localhost", "bad@nodomain"). */
function isValidEmail(email) {
  return typeof email === "string" && validator.isEmail(email.trim(), { require_tld: true });
}

module.exports = { passwordPolicyError, isValidEmail };
