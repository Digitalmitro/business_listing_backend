// backend/controllers/unsubscribeController.js
"use strict";

const UnsubscribedEmail = require("../models/UnsubscribedEmail");
const User = require("../models/User");
const { CrmLead } = require("../models/CrmLead");
const logger = require("../utils/logger");

/**
 * GET or POST /api/unsubscribe
 * Globally unsubscribe an email address or user from email campaigns and CRM automated follow-ups.
 * Handles query params (`?email=foo@bar.com` or `?userId=123`) or JSON body `{ email, userId, reason }`.
 */
exports.unsubscribe = async (req, res) => {
  try {
    const emailInput = req.body?.email || req.query?.email || "";
    const userIdInput = req.body?.userId || req.query?.userId || "";
    const reason = req.body?.reason || req.query?.reason || "User clicked unsubscribe link";
    const source = req.body?.source || req.query?.source || "email_campaign";

    let targetEmail = typeof emailInput === "string" ? emailInput.trim().toLowerCase() : "";

    // If userId provided, look up the user's email and disable subscribedToEmails
    if (userIdInput) {
      try {
        const user = await User.findById(userIdInput);
        if (user) {
          user.subscribedToEmails = false;
          await user.save();
          if (!targetEmail && user.email) {
            targetEmail = user.email.trim().toLowerCase();
          }
          logger.info("User unsubscribed via userId", { userId: user._id, email: targetEmail });
        }
      } catch (userLookupErr) {
        logger.warn("Could not find or update User during unsubscribe", { userIdInput, error: userLookupErr.message });
      }
    }

    if (!targetEmail) {
      if (userIdInput) {
        return res.status(200).json({ success: true, message: "Successfully unsubscribed" });
      }
      return res.status(400).json({ success: false, message: "Email or userId is required to unsubscribe" });
    }

    // 1. Add or update in UnsubscribedEmail global collection
    await UnsubscribedEmail.findOneAndUpdate(
      { email: targetEmail },
      { $set: { email: targetEmail, reason, source, unsubscribedAt: new Date() } },
      { upsert: true, new: true }
    );

    // 2. Also check if there's any matching User document and update their subscribedToEmails flag
    await User.updateMany(
      { email: targetEmail },
      { $set: { subscribedToEmails: false } }
    );

    // 3. Check if there are any CRM Leads matching this email and set status to "Cold Lead" if currently active
    const matchingLeads = await CrmLead.find({
      email: targetEmail,
      status: { $nin: ["Closed Won", "Completed", "Closed Lost", "Cold Lead"] },
    });

    for (const lead of matchingLeads) {
      lead.status = "Cold Lead";
      lead.activities.push({
        action: "status_change",
        type: "status_change",
        description: `Lead automatically moved to Cold Lead due to unsubscribe request (${reason})`,
        previousValue: lead.status,
        newValue: "Cold Lead",
        timestamp: new Date(),
        performedAt: new Date(),
      });
      await lead.save();
    }

    logger.info("Global email unsubscription completed", { email: targetEmail, crmLeadsAffected: matchingLeads.length });

    // Return HTML or JSON depending on Accept header or ?format=html
    if (req.query?.format === "html" || (req.headers.accept && req.headers.accept.includes("text/html"))) {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Unsubscribed Successfully</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: white; padding: 2.5rem; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); max-width: 420px; text-align: center; }
            h1 { font-size: 1.5rem; margin-bottom: 1rem; color: #0f172a; }
            p { color: #64748b; line-height: 1.5; margin-bottom: 1.5rem; }
            .icon { font-size: 3rem; margin-bottom: 1rem; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">✓</div>
            <h1>You have been unsubscribed</h1>
            <p>Your email address (<strong>${targetEmail}</strong>) has been removed from our mailing list and automated CRM campaigns. You will no longer receive these communications.</p>
          </div>
        </body>
        </html>
      `;
      return res.status(200).send(html);
    }

    return res.status(200).json({ success: true, message: "Successfully unsubscribed", email: targetEmail });
  } catch (error) {
    logger.error("Error handling unsubscribe request", { error: error.message });
    return res.status(500).json({ success: false, message: "An error occurred while processing your unsubscribe request." });
  }
};

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
