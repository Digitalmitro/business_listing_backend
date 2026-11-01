"use strict";

const businessSender = require("../services/businessSenderService");
const plans = require("../services/planEntitlements");
const { resolveWriteScope } = require("../services/crmScope");
const logger = require("../utils/logger");

function sendError(res, error, fallback) {
  const status = error.status || 500;
  if (status >= 500) logger.error("business_sender.request_failed", fallback, { error: error.message });
  return res.status(status).json({ success: false, message: status >= 500 ? fallback : error.message, code: error.code });
}

async function ownedBusiness(req) {
  const scope = await resolveWriteScope(req, req.params.businessId);
  if (!scope.businessId) {
    const err = new Error("Business not found");
    err.status = 404;
    throw err;
  }
  return scope;
}

/** GET /api/business-email-sender/:businessId — connection status + what the plan includes. */
exports.getStatus = async (req, res) => {
  try {
    const scope = await ownedBusiness(req);
    const [doc, plan] = await Promise.all([businessSender.getSender(scope.businessId), plans.getPlanEntitlements(scope.businessId)]);
    return res.json({
      success: true,
      businessId: String(scope.businessId),
      businessName: scope.business?.businessName || "",
      sender: businessSender.toView(doc),
      plan: { name: plan.planName, entitlements: plan.entitlements },
    });
  } catch (error) {
    return sendError(res, error, "Could not load the business email settings");
  }
};

/** POST /api/business-email-sender/:businessId — connect (or reconnect) and send the confirmation email. */
exports.connect = async (req, res) => {
  try {
    const scope = await ownedBusiness(req);
    const plan = await plans.getPlanEntitlements(scope.businessId);
    if (!plan.entitlements.ownSender) {
      return res.status(403).json({
        success: false,
        code: "plan_required",
        message: `Sending from your own email address is included from the Basic plan. Your business is on the ${plan.planName} plan.`,
      });
    }
    const sender = await businessSender.connect({ business: scope.business, ownerId: scope.ownerId, input: req.body || {} });
    return res.status(200).json({
      success: true,
      message: `We sent a confirmation link to ${sender.email} through your mail server. Open it to start sending from this address.`,
      sender,
    });
  } catch (error) {
    return sendError(res, error, "Could not connect the email address");
  }
};

/** POST /api/business-email-sender/:businessId/test — sends a test email from the verified address. */
exports.sendTest = async (req, res) => {
  try {
    const scope = await ownedBusiness(req);
    const verified = await businessSender.getVerifiedTransport(scope.businessId);
    if (!verified) return res.status(409).json({ success: false, message: "Connect and confirm an email address first." });
    const to = String(req.body?.to || req.user?.email || verified.sender.email).trim();
    const validator = require("validator");
    if (!validator.isEmail(to, { require_tld: true })) return res.status(400).json({ success: false, message: "Enter a valid recipient address." });
    const from = { name: verified.sender.displayName || verified.sender.email, address: verified.sender.email };
    try {
      const info = await verified.transport.sendMail({
        from,
        to,
        subject: `Test email from ${from.name}`,
        html: `<p>This is a test email sent from <strong>${from.address}</strong> through your connected mail server.</p><p>Your customers' booking and CRM emails will come from this address.</p>`,
      });
      await businessSender.recordUse(verified.senderId);
      return res.json({ success: true, message: `Test email sent to ${to} from ${from.address}.`, messageId: info?.messageId || null, from: from.address });
    } catch (smtpError) {
      await businessSender.recordUse(verified.senderId, smtpError);
      return res.status(502).json({ success: false, message: businessSender.friendlySmtpError(smtpError) });
    }
  } catch (error) {
    return sendError(res, error, "Could not send the test email");
  }
};

/** DELETE /api/business-email-sender/:businessId — forget the address and its credentials. */
exports.disconnect = async (req, res) => {
  try {
    const scope = await ownedBusiness(req);
    await businessSender.disconnect(scope.businessId);
    return res.json({ success: true, message: "Email address disconnected. Customer emails will not be sent until you connect one again." });
  } catch (error) {
    return sendError(res, error, "Could not disconnect the email address");
  }
};

function page(res, status, title, body) {
  const frontend = (process.env.FRONTEND_URL || "https://urbancitations.com").replace(/\/+$/, "");
  return res
    .status(status)
    .type("html")
    .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#1f2933}h1{font-size:22px}a{color:#0b6bcb}</style></head>
<body>${body}<p><a href="${frontend}/businesPersonalInfo">Back to UrbanCitations</a></p></body></html>`);
}

/** GET /api/business-email-sender/verify?token= — the link in the confirmation email. */
exports.verify = async (req, res) => {
  try {
    const result = await businessSender.confirm(String(req.query.token || ""));
    const email = String(result.email).replace(/[<>&"]/g, "");
    return page(res, 200, "Email address confirmed", `<h1>${email} is confirmed</h1><p>Your customers' booking and CRM emails will now be sent from this address.</p>`);
  } catch (error) {
    const status = error.status && error.status < 500 ? error.status : 400;
    return page(res, status, "Link not valid", `<h1>We couldn't confirm this address</h1><p>${String(error.message).replace(/[<>&"]/g, "")}</p>`);
  }
};
