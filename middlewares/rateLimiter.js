// backend/middlewares/rateLimiter.js
"use strict";

const rateLimit = require("express-rate-limit");
const logger = require("../utils/logger");

// ── Generic handler ────────────────────────────────────────────────────────────
function createLimiter(options = {}) {
  return rateLimit({
    windowMs:   options.windowMs || 15 * 60 * 1000, // 15 minutes default
    max:        options.max      || 100,
    standardHeaders: true,
    legacyHeaders:   false,
    message: {
      success: false,
      message: options.message || "Too many requests, please try again later.",
    },
    handler(req, res, next, opts) {
      logger.warn("rate_limit.exceeded", "Rate limit exceeded", {
        ip:     req.ip,
        path:   req.path,
        method: req.method,
        window: opts.windowMs,
        max:    opts.max,
      });
      res.status(429).json(opts.message);
    },
    skip: (req) => {
      // Never rate-limit health checks or internal monitoring
      return req.path === "/health/live" || req.path === "/health/ready";
    },
  });
}

// ── Auth routes: strict (prevents brute-force) ────────────────────────────────
const authLimiter = createLimiter({
  windowMs: Number(process.env.AUTH_RATE_WINDOW_MS  || 15 * 60 * 1000),
  max:      Number(process.env.AUTH_RATE_MAX         || 20),
  message:  "Too many login attempts. Please wait 15 minutes.",
});

// ── General API: relaxed ─────────────────────────────────────────────────────
const apiLimiter = createLimiter({
  windowMs: Number(process.env.API_RATE_WINDOW_MS   || 15 * 60 * 1000),
  max:      Number(process.env.API_RATE_MAX          || 500),
});

// ── Webhook endpoints: medium (prevents spam) ─────────────────────────────────
const webhookLimiter = createLimiter({
  windowMs: Number(process.env.WEBHOOK_RATE_WINDOW_MS || 5 * 60 * 1000),
  max:      Number(process.env.WEBHOOK_RATE_MAX        || 60),
  message:  "Too many webhook calls. Please slow down.",
});

// ── CRM write operations: medium ──────────────────────────────────────────────
const crmWriteLimiter = createLimiter({
  windowMs: Number(process.env.CRM_WRITE_RATE_WINDOW_MS || 15 * 60 * 1000),
  max:      Number(process.env.CRM_WRITE_RATE_MAX        || 200),
});

module.exports = {
  authLimiter,
  apiLimiter,
  webhookLimiter,
  crmWriteLimiter,
};
