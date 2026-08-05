"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createCorsOptions, getAllowedOrigins } = require("./corsOptions");

function isOriginAllowed(options, origin) {
  return new Promise((resolve, reject) => {
    options.origin(origin, (error, allowed) => {
      if (error) reject(error);
      else resolve(allowed);
    });
  });
}

test("allows the configured frontend and admin origins", async () => {
  const options = createCorsOptions({
    NODE_ENV: "production",
    FRONTEND_URL: "https://urbancitations.com/",
    ADMIN_URL: "https://admin.urbancitations.com/",
  });

  assert.equal(await isOriginAllowed(options, "https://urbancitations.com"), true);
  assert.equal(await isOriginAllowed(options, "https://admin.urbancitations.com"), true);
  assert.equal(await isOriginAllowed(options, "https://untrusted.example.com"), false);
});

test("supports additional comma-separated origins", () => {
  const origins = getAllowedOrigins({
    NODE_ENV: "production",
    CORS_ORIGINS: "https://preview.example.com, https://admin-preview.example.com/",
  });

  assert.deepEqual(
    [...origins],
    ["https://preview.example.com", "https://admin-preview.example.com"]
  );
});

test("allows both local Vite applications outside production", async () => {
  const options = createCorsOptions({ NODE_ENV: "development" });

  assert.equal(await isOriginAllowed(options, "http://localhost:5173"), true);
  assert.equal(await isOriginAllowed(options, "http://localhost:3000"), true);
  assert.equal(await isOriginAllowed(options, undefined), true);
});
