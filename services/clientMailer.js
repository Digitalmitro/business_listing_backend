"use strict";

/**
 * The single way to send an email FROM a business TO its own customers or leads
 * (booking confirmations and reminders, CRM automations, follow-ups, journeys).
 *
 * Two rules, both enforced here:
 *   1. The business's plan must include that kind of email (planEntitlements).
 *   2. It is sent only from the business's own verified address (businessSender);
 *      when the business hasn't connected and verified one, nothing is sent.
 *      A client email never goes out from a UrbanCitations address.
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
    return skipped(SKIP.sender, "The business hasn't connected and verified its own email address");
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
