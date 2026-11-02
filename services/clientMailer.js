"use strict";

/**
 * The single way to send an email FROM a business TO its own customers or leads
 * (booking confirmations and reminders, CRM automations, follow-ups, journeys).
 *
 * Two rules, both enforced here:
 *   1. The business's plan must include that kind of email (planEntitlements).
 *   2. It is sent from the business's own verified address (businessSender) when
 *      it has one; otherwise through the platform sender in the business's name
 *      (see sendViaPlatform; CLIENT_MAIL_PLATFORM_FALLBACK=false disables that).
 *
 * Returns { success: true, info, from } when sent, or
 * { success: false, skipped: true, reason, code } when a rule stops it (callers
 * record it as "skipped", not as a failure to retry), or
 * { success: false, error } when the SMTP server failed (callers retry).
 */

const businessSender = require("./businessSenderService");
const plans = require("./planEntitlements");
const logger = require("../utils/logger");

const SKIP = {
  plan: "plan_not_entitled",
  sender: "sender_not_connected",
};

function skipped(code, reason) {
  return { success: false, skipped: true, code, reason };
}

/**
 * Until a business connects its own address, its customer and lead emails go out
 * through the UrbanCitations platform sender, named after the business, with
 * replies going to the owner. CLIENT_MAIL_PLATFORM_FALLBACK=false turns this off
 * (then nothing is sent until the business verifies a sender).
 */
function platformFallbackEnabled() {
  return String(process.env.CLIENT_MAIL_PLATFORM_FALLBACK || "").trim().toLowerCase() !== "false";
}

async function sendViaPlatform({ businessId, kind, reminderKey, to, subject, html, headers, replyTo, planName }) {
  // Required directly: the queue-worker process never registers these models by name.
  const mongoose = require("mongoose");
  const Business = require("../models/Business");
  const User = require("../models/User");
  const SenderEmail = require("../models/SenderEmail");

  let businessName = "";
  let ownerEmail = "";
  const dbReady = mongoose.connection.readyState === 1;
  if (dbReady && mongoose.isValidObjectId(businessId)) {
    const biz = await Business.findById(businessId).select("businessName userId").lean();
    businessName = biz?.businessName || "";
    if (biz?.userId) ownerEmail = (await User.findById(biz.userId).select("email").lean())?.email || "";
  }
  const senderName = businessName ? `${businessName} via UrbanCitations`.slice(0, 100) : "";
  const reply = replyTo || ownerEmail || undefined;

  let result;
  let from;
  const platformSender = dbReady ? await SenderEmail.findOne({ isActive: true }).select("email").lean() : null;
  if (platformSender) {
    from = platformSender.email;
    result = await require("../utils/nodemailer").sendMail(from, to, subject, html, null, { senderName, replyTo: reply, headers });
  } else {
    from = process.env.EMAIL_FROM || process.env.EMAIL_USER || "";
    result = await require("./sendMail").sendMail(to, subject, html, { replyTo: reply, headers });
  }

  if (result?.success) {
    logger.info("client_mail.sent_via_platform", "Email sent through the platform sender (business has no verified address)", { businessId, kind, reminderKey, to, from, messageId: result.info?.messageId });
    return { success: true, info: result.info, from, planName, via: "platform" };
  }
  const error = result?.error || new Error("Platform email delivery failed");
  logger.warn("client_mail.platform_failed", "Sending through the platform sender failed", { businessId, kind, to, error: String(error?.message || error).slice(0, 300) });
  return { success: false, error };
}

/**
 * @param {object} params
 * @param {object|string} params.business - Business doc (with subscription) or id.
 * @param {"booking"|"crm_automation"|"crm_followup"|"journey"|"ai"} params.kind
 * @param {string} [params.reminderKey] - "3d" | "2d" | "1d" | "30m" | "10m" for booking reminders.
 * @param {string} params.to
 * @param {string} params.subject
 * @param {string} params.html
 * @param {object} [params.headers]
 * @param {string} [params.replyTo]
 */
async function sendAsBusiness({ business, kind, reminderKey, to, subject, html, headers, replyTo }) {
  const businessId = String(business?._id || business || "");
  const { planName, entitlements } = await plans.getPlanEntitlements(business);
  if (!plans.allows(entitlements, kind, { reminderKey })) {
    const needed = plans.lowestPlanFor(kind, { reminderKey });
    return skipped(SKIP.plan, `The ${planName} plan doesn't include this email${needed ? ` (needs ${needed} or higher)` : ""}`);
  }
  if (!entitlements.ownSender) return skipped(SKIP.plan, `The ${planName} plan doesn't include sending from your own address`);

  const verified = await businessSender.getVerifiedTransport(businessId);
  if (!verified) {
    if (!platformFallbackEnabled()) {
      return skipped(SKIP.sender, "The business hasn't connected and verified its own email address");
    }
    return sendViaPlatform({ businessId, kind, reminderKey, to, subject, html, headers, replyTo, planName });
  }

  const from = { name: verified.sender.displayName || verified.sender.email, address: verified.sender.email };
  try {
    const info = await verified.transport.sendMail({
      from,
      to,
      subject,
      html,
      headers: headers || undefined,
      replyTo: replyTo && replyTo !== verified.sender.email ? replyTo : undefined,
    });
    await businessSender.recordUse(verified.senderId);
    logger.info("client_mail.sent", "Email sent from the business's own address", { businessId, kind, reminderKey, from: from.address, messageId: info?.messageId });
    return { success: true, info, from: from.address, planName };
  } catch (error) {
    await businessSender.recordUse(verified.senderId, error);
    logger.warn("client_mail.failed", "Sending from the business's own address failed", { businessId, kind, error: String(error?.message || error).slice(0, 300) });
    return { success: false, error };
  }
}

module.exports = { sendAsBusiness, SKIP };
