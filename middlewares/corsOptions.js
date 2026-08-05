"use strict";

const LOCAL_ORIGINS = ["http://localhost:3000", "http://localhost:5173"];

function normalizeOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  const origin = value.trim();
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/+$/, "");
  }
}

function getAllowedOrigins(env = process.env) {
  const configuredOrigins = [
    ...(env.CORS_ORIGINS || "").split(","),
    env.FRONTEND_URL,
    env.ADMIN_URL,
  ];

  if (env.NODE_ENV !== "production") {
    configuredOrigins.push(...LOCAL_ORIGINS);
  }

  return new Set(configuredOrigins.map(normalizeOrigin).filter(Boolean));
}

function createCorsOptions(env = process.env) {
  const allowedOrigins = getAllowedOrigins(env);

  return {
    credentials: true,
    origin(origin, callback) {
      // Non-browser clients do not send Origin and are not subject to CORS.
      if (!origin || allowedOrigins.has(normalizeOrigin(origin))) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
  };
}

module.exports = { createCorsOptions, getAllowedOrigins, normalizeOrigin };
