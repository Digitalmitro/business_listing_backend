// backend/controllers/crmEngagementPublicController.js
"use strict";

/**
 * Public (unauthenticated) engagement endpoints used by the listing site and by
 * links in emails:
 *
 *   GET  /widget/:businessId   whether the listing shows the "get updates" email box
 *   POST /capture              a visitor leaves their email (explicit consent required)
 *   POST /track                a known visitor views the listing/a service/the booking page
 *   GET  /unsubscribe?t=       confirmation page (GET never changes anything, so mail
 *                              scanners that prefetch links can't unsubscribe people)
 *   POST /unsubscribe          unsubscribe (form, or RFC 8058 one-click)
 *   GET  /r/:token             tracked link: records the click, then redirects
 *
 * Responses never reveal whether an email or visitor is known to a business.
 */

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const validator = require("validator");
const User = require("../models/User");
const CrmContact = require("../models/CrmContact");
const UnsubscribedEmail = require("../models/UnsubscribedEmail");
const Business = require("../models/Business");
const links = require("../services/crmEngagementLinks");
const contactsService = require("../services/crmEngagementContactService");
const signals = require("../services/crmSignalService");
const automationService = require("../services/crmEmailAutomationService");
const { escapeHtml } = require("../services/crmEmailAutomationCatalog");
const logger = require("../utils/logger");

const TRACK_EVENTS = ["business_viewed", "service_viewed", "booking_started"];

/** Signed-in customer behind the request, if any. Never rejects the request. */
async function optionalUser(req) {
  try {
    const header = req.header("Authorization") || "";
    if (!header.startsWith("Bearer ") || !process.env.JWT_SECRET) return null;
    const decoded = jwt.verify(header.slice(7).trim(), process.env.JWT_SECRET);
    if (decoded.role === "admin") return null;
    return await User.findById(decoded.id).select("_id full_name email phone").lean();
  } catch {
    return null;
  }
}

function page(res, status, title, bodyHtml) {
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader("X-Robots-Tag", "noindex");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:#1e293b;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
.card{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 4px 6px -1px rgba(0,0,0,.1);max-width:440px;width:100%;text-align:center}
h1{font-size:1.4rem;margin:0 0 .75rem}p{color:#64748b;line-height:1.5}
button{font:inherit;border:0;border-radius:8px;padding:.7rem 1.2rem;cursor:pointer;margin:.3rem;width:100%}
.primary{background:#1e3a8a;color:#fff}.secondary{background:#f1f5f9;color:#334155}
</style></head><body><div class="card">${bodyHtml}</div></body></html>`);
}

// ── Listing site ────────────────────────────────────────────────────────────

/** GET /widget/:businessId */
exports.getWidget = async (req, res) => {
  try {
    const { businessId } = req.params;
    if (!mongoose.isValidObjectId(businessId)) return res.status(200).json({ success: true, enabled: false });
    const business = await Business.findById(businessId).select("_id userId businessName isBlocked").lean();
    if (!business || !business.userId || business.isBlocked) return res.status(200).json({ success: true, enabled: false });
    const settings = await contactsService.getSettings(business._id);
    return res.status(200).json({ success: true, enabled: Boolean(settings.captureWidget), businessName: business.businessName });
  } catch (error) {
    logger.warn("crm_engagement.widget_failed", "Widget lookup failed", { error: error.message });
    return res.status(200).json({ success: true, enabled: false });
  }
};

/** POST /capture { businessId, email, name?, consent: true, visitorId?, item? } */
exports.capture = async (req, res) => {
  const { businessId, email, name, consent, visitorId, item, website } = req.body || {};
  // Honeypot: bots fill every field. Pretend it worked.
  if (website) return res.status(201).json({ success: true });
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!mongoose.isValidObjectId(businessId)) return res.status(400).json({ success: false, message: "Unknown business" });
  if (!cleanEmail || cleanEmail.length > 254 || !validator.isEmail(cleanEmail)) {
    return res.status(400).json({ success: false, message: "Please enter a valid email address" });
  }
  if (consent !== true) {
    return res.status(400).json({ success: false, message: "Please tick the box to agree to receive emails" });
  }
  const settings = await contactsService.getSettings(businessId).catch(() => null);
  if (settings && !settings.captureWidget) return res.status(403).json({ success: false, message: "This business is not accepting sign-ups right now" });
  const viewer = await optionalUser(req);
  await signals.onContactCaptured({
    businessId,
    email: cleanEmail,
    name: String(name || "").trim().slice(0, 120),
    visitorId,
    item,
    viewer,
  });
  return res.status(201).json({ success: true, message: "Thanks! We'll be in touch." });
};

/** POST /track { businessId, event, item?, visitorId? } — always 202. */
exports.track = async (req, res) => {
  const { businessId, event, item, visitorId } = req.body || {};
  if (mongoose.isValidObjectId(businessId) && TRACK_EVENTS.includes(event)) {
    const viewer = await optionalUser(req);
    if (viewer || contactsService.validVisitorId(visitorId)) {
      signals.onListingActivity({ businessId, event, item, viewer, visitorId }).catch(() => {});
      if (viewer && event === "business_viewed") {
        // Keeps the "Lead viewed your store" email automation working.
        automationService.onListingViewed({ businessId, viewer, serviceName: item?.kind === "service" ? item.name : undefined }).catch(() => {});
      }
    }
  }
  return res.status(202).json({ success: true });
};

// ── Email links ─────────────────────────────────────────────────────────────

async function unsubscribeTarget(token) {
  const payload = links.verifyUnsubscribe(token);
  if (!payload || !mongoose.isValidObjectId(payload.c) || !mongoose.isValidObjectId(payload.b)) return null;
  const [contact, business] = await Promise.all([
    CrmContact.findOne({ _id: payload.c, businessId: payload.b }).select("_id email emailStatus businessId").lean(),
    Business.findById(payload.b).select("businessName").lean(),
  ]);
  return { payload, contact, businessName: business?.businessName || "this business" };
}

/** GET /unsubscribe?t= — confirmation page only. */
exports.unsubscribePage = async (req, res) => {
  const target = await unsubscribeTarget(String(req.query.t || "")).catch(() => null);
  if (!target) return page(res, 400, "Link not valid", "<h1>This link is not valid</h1><p>It may be incomplete. Please use the unsubscribe link from the latest email.</p>");
  const name = escapeHtml(target.businessName);
  const t = escapeHtml(String(req.query.t));
  if (target.contact?.emailStatus === "unsubscribed") {
    return page(res, 200, "Unsubscribed", `<h1>You're already unsubscribed</h1><p>You won't receive marketing emails from ${name}.</p>
<form method="post" action="unsubscribe"><input type="hidden" name="t" value="${t}"><input type="hidden" name="scope" value="all"><button class="secondary" type="submit">Also stop all UrbanCitations emails</button></form>`);
  }
  return page(res, 200, "Unsubscribe", `<h1>Unsubscribe from ${name}?</h1><p>You'll stop receiving marketing emails from ${name}. Emails about bookings you make are not affected.</p>
<form method="post" action="unsubscribe"><input type="hidden" name="t" value="${t}"><input type="hidden" name="scope" value="business"><button class="primary" type="submit">Unsubscribe from ${name}</button></form>
<form method="post" action="unsubscribe"><input type="hidden" name="t" value="${t}"><input type="hidden" name="scope" value="all"><button class="secondary" type="submit">Unsubscribe from all UrbanCitations emails</button></form>`);
};

/** POST /unsubscribe — form submit (t, scope) or one-click (t in query, body List-Unsubscribe=One-Click). */
exports.unsubscribe = async (req, res) => {
  const token = String(req.body?.t || req.query?.t || "");
  const oneClick = req.body?.["List-Unsubscribe"] === "One-Click";
  const scope = req.body?.scope === "all" ? "all" : "business";
  try {
    const target = await unsubscribeTarget(token);
    if (!target) {
      return oneClick ? res.status(400).json({ success: false }) : page(res, 400, "Link not valid", "<h1>This link is not valid</h1><p>Please use the unsubscribe link from the latest email.</p>");
    }
    if (target.contact && target.contact.emailStatus !== "unsubscribed") {
      await signals.onContactUnsubscribed(target.contact._id, { reason: oneClick ? "One-click unsubscribe" : "Unsubscribed via email link" });
    }
    if (scope === "all" && target.payload.e && validator.isEmail(target.payload.e)) {
      await UnsubscribedEmail.findOneAndUpdate(
        { email: target.payload.e },
        { $set: { email: target.payload.e, reason: "Unsubscribed from all emails via CRM email link", source: "crm_followup", unsubscribedAt: new Date() } },
        { upsert: true }
      );
      await User.updateMany({ email: target.payload.e }, { $set: { subscribedToEmails: false } });
      await signals.onGlobalUnsubscribe(target.payload.e);
    }
    logger.info("crm_engagement.unsubscribed", "Contact unsubscribed via email link", { businessId: target.payload.b, scope, oneClick });
    if (oneClick) return res.status(200).json({ success: true });
    const name = escapeHtml(target.businessName);
    return page(
      res,
      200,
      "Unsubscribed",
      scope === "all"
        ? "<h1>You're unsubscribed</h1><p>You won't receive marketing emails from UrbanCitations or businesses on it.</p>"
        : `<h1>You're unsubscribed</h1><p>You won't receive marketing emails from ${name} any more.</p>`
    );
  } catch (error) {
    logger.error("crm_engagement.unsubscribe_failed", "Unsubscribe failed", { error: error.message });
    return oneClick ? res.status(500).json({ success: false }) : page(res, 500, "Something went wrong", "<h1>Something went wrong</h1><p>Please try again in a moment.</p>");
  }
};

/** GET /r/:token — records the click, then redirects to the original link. */
exports.redirect = async (req, res) => {
  const target = links.verifyClick(req.params.token);
  if (!target) return page(res, 404, "Link not found", "<h1>This link is not valid</h1>");
  signals.onEmailClicked(target.dispatchId).catch(() => {});
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  return res.redirect(302, target.url);
};
