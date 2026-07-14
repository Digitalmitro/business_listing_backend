// backend/middlewares/webhookAuth.js
"use strict";

const crypto = require("node:crypto");
const logger  = require("../utils/logger");

/**
 * HMAC-SHA256 webhook signature validation middleware.
 *
 * Verifies the `X-Webhook-Signature` header against the raw request body
 * using the shared secret stored in `WEBHOOK_SECRET` environment variable.
 *
 * Header format expected: `sha256=<hex_signature>`
 *
 * Usage:
 *   router.post("/reply-webhook", webhookAuth("REPLY_WEBHOOK_SECRET"), handleInboundWebhook);
 *
 * @param {string} secretEnvKey - Name of the environment variable holding the secret.
 * @returns {Function} Express middleware
 */
function webhookAuth(secretEnvKey = "WEBHOOK_SECRET") {
  return (req, res, next) => {
    const secret = process.env[secretEnvKey];

    // If no secret is configured, skip validation in development but warn loudly
    if (!secret) {
      if (process.env.NODE_ENV === "production") {
        logger.error(
          "webhook_auth.missing_secret",
          `Webhook secret '${secretEnvKey}' is not configured. Rejecting all webhook calls in production.`,
          { path: req.path }
        );
        return res.status(500).json({ success: false, message: "Webhook security not configured" });
      }
      logger.warn(
        "webhook_auth.skipped",
        `Webhook secret '${secretEnvKey}' not set. Skipping validation in non-production environment.`,
        { path: req.path }
      );
      return next();
    }

    const signature = req.headers["x-webhook-signature"] || req.headers["x-hub-signature-256"] || "";
    if (!signature) {
      logger.warn("webhook_auth.missing_header", "Webhook request missing signature header", {
        path: req.path,
        ip: req.ip,
      });
      return res.status(401).json({ success: false, message: "Missing webhook signature" });
    }

    // Compute expected signature from raw body or JSON body
    const rawBody = req.rawBody || JSON.stringify(req.body) || "";
    const expectedSig = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;

    // Use timingSafeEqual to prevent timing attacks
    const sigBuffer      = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSig);

    let valid = false;
    if (sigBuffer.length === expectedBuffer.length) {
      try {
        valid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
      } catch {
        valid = false;
      }
    }

    if (!valid) {
      logger.warn("webhook_auth.invalid_signature", "Webhook signature validation failed", {
        path: req.path,
        ip: req.ip,
        received: signature.substring(0, 16) + "...", // log only prefix for safety
      });
      return res.status(401).json({ success: false, message: "Invalid webhook signature" });
    }

    logger.info("webhook_auth.verified", "Webhook signature verified", { path: req.path });
    next();
  };
}

module.exports = { webhookAuth };
