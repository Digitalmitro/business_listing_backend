"use strict";

// User input that ends up in a MongoDB $regex must be escaped: unescaped input
// throws ("Regular expression is invalid" → 500) or allows catastrophic patterns.

const MAX_SEARCH_LENGTH = 200;

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Escaped, trimmed and length-capped search text for a "contains" match. */
function searchPattern(value, maxLength = MAX_SEARCH_LENGTH) {
  return escapeRegex(String(value ?? "").trim().slice(0, maxLength));
}

/** Case-insensitive exact-match RegExp for a literal value. */
function exactInsensitive(value) {
  return new RegExp(`^${escapeRegex(String(value ?? "").trim())}$`, "i");
}

module.exports = { escapeRegex, searchPattern, exactInsensitive, MAX_SEARCH_LENGTH };
