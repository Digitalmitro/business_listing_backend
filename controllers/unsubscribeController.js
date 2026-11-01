// backend/controllers/unsubscribeController.js
"use strict";

const UnsubscribedEmail = require("../models/UnsubscribedEmail");
const User = require("../models/User");
const { CrmLead } = require("../models/CrmLead");
const logger = require("../utils/logger");
const { escapeHtml } = require("../services/crmEmailAutomationCatalog");
const links = require("../services/crmEngagementLinks");

function page(res, status, title, body) {
  return res.status(status).type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:#1e293b;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;padding:2.5rem;border-radius:12px;box-shadow:0 4px 6px -1px rgba(0,0,0,.1);max-width:440px;text-align:center}h1{font-size:1.4rem}p{color:#64748b;line-height:1.5}
button{background:#0f172a;color:#fff;border:0;border-radius:8px;padding:.7rem 1.2rem;font-size:1rem;cursor:pointer}</style></head><body><div class="card">${body}</div></body></html>`);
}

/** Applies a global unsubscribe for an address (and/or user). Returns the address. */
async function applyGlobalUnsubscribe({ email, userId, reason, source }) {
  let targetEmail = String(email || "").trim().toLowerCase();
  if (userId) {
    const user = await User.findById(userId).catch(() => null);
    if (user) {
      user.subscribedToEmails = false;
      await user.save();
      if (!targetEmail && user.email) targetEmail = user.email.trim().toLowerCase();
    }
  }
  if (!targetEmail) return null;

  // 1. Global suppression list
  await UnsubscribedEmail.findOneAndUpdate(
    { email: targetEmail },
    { $set: { email: targetEmail, reason, source, unsubscribedAt: new Date() } },
    { upsert: true, new: true }
  );
  // 2. Matching user accounts
  await User.updateMany({ email: targetEmail }, { $set: { subscribedToEmails: false } });
  // 3. Active CRM leads with this address go cold
  const matchingLeads = await CrmLead.find({ email: targetEmail, status: { $nin: ["Closed Won", "Completed", "Closed Lost", "Cold Lead"] } });
  for (const lead of matchingLeads) {
    const previous = lead.status;
    lead.status = "Cold Lead";
    lead.activities.push({
      action: "status_change",
      type: "status_change",
      description: `Lead automatically moved to Cold Lead due to unsubscribe request (${reason})`,
      previousValue: previous,
      newValue: "Cold Lead",
      timestamp: new Date(),
      performedAt: new Date(),
    });
    await lead.save();
  }
  // 4. Every business's CRM contact with this address stops receiving journeys.
  const contactsAffected = await require("../services/crmSignalService").onGlobalUnsubscribe(targetEmail, { reason });
  logger.info("Global email unsubscription completed", { email: targetEmail, crmLeadsAffected: matchingLeads.length, crmContactsAffected: contactsAffected });
  return targetEmail;
}

/**
 * GET  /api/unsubscribe?t=<signed token>  -> confirmation page only (link scanners change nothing)
 * POST /api/unsubscribe  (form field t, or ?t= with List-Unsubscribe=One-Click) -> unsubscribes
 *
 * Only signed links from our own emails work. Bare ?email= / ?userId= links are refused,
 * so nobody can unsubscribe someone else's address.
 */
exports.unsubscribe = async (req, res) => {
  const wantsHtml = req.method === "GET" || req.query?.format === "html" || (req.headers.accept || "").includes("text/html");
  try {
    const token = String(req.body?.t || req.query?.t || "");
    const payload = links.verifyPlatformUnsubscribe(token);
    const oneClick = req.body?.["List-Unsubscribe"] === "One-Click";
    if (!payload) {
      if (!wantsHtml || oneClick) return res.status(400).json({ success: false, message: "This unsubscribe link is not valid" });
      return page(res, 400, "Link not valid", "<h1>This unsubscribe link is not valid</h1><p>Please use the unsubscribe link from the latest email you received.</p>");
    }
    const shownEmail = escapeHtml(payload.e || "your address");
    if (req.method === "GET") {
      return page(
        res,
        200,
        "Unsubscribe",
        `<h1>Unsubscribe ${shownEmail}?</h1><p>You'll stop receiving UrbanCitations emails such as campaigns and CRM messages.</p>
<form method="post" action=""><input type="hidden" name="t" value="${escapeHtml(token)}"><button type="submit">Unsubscribe</button></form>`
      );
    }
    const email = await applyGlobalUnsubscribe({
      email: payload.e,
      userId: payload.u,
      reason: oneClick ? "One-click unsubscribe" : "Unsubscribed via email link",
      source: payload.c ? "email_campaign" : "platform",
    });
    if (oneClick || !wantsHtml) return res.status(200).json({ success: true, message: "Successfully unsubscribed", email });
    return page(res, 200, "Unsubscribed", `<h1>You have been unsubscribed</h1><p><strong>${escapeHtml(email || "")}</strong> will no longer receive these emails.</p>`);
  } catch (error) {
    logger.error("Error handling unsubscribe request", { error: error.message });
    return res.status(500).json({ success: false, message: "An error occurred while processing your unsubscribe request." });
  }
};

exports.applyGlobalUnsubscribe = applyGlobalUnsubscribe;

/**
 * GET /api/unsubscribe/check?email=foo@bar.com
 * Internal helper to check if an email is unsubscribed.
 */
exports.checkStatus = async (req, res) => {
  try {
    const email = (req.query.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }
    const record = await UnsubscribedEmail.findOne({ email }).lean();
    return res.status(200).json({ success: true, isUnsubscribed: Boolean(record), record });
  } catch (error) {
    logger.error("Error checking unsubscribe status", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};
