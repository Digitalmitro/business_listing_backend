"use strict";

/**
 * Signed links in engagement emails: per-business unsubscribe and click tracking.
 *
 * Tokens are `base64url(JSON payload).base64url(HMAC-SHA256)`. The signature stops
 * anyone from unsubscribing other people or turning the click endpoint into an open
 * redirect: only URLs that were in an email we sent can be redirected to.
 *
 * The key is CRM_LINK_SECRET, or a key derived from JWT_SECRET when that is unset.
 */

const crypto = require("node:crypto");

function secret() {
  const explicit = process.env.CRM_LINK_SECRET;
  if (explicit) return explicit;
  if (process.env.JWT_SECRET) {
    return crypto.createHmac("sha256", process.env.JWT_SECRET).update("crm-engagement-links").digest("hex");
  }
  throw new Error("CRM_LINK_SECRET or JWT_SECRET must be set to build email links");
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac("sha256", secret()).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

/** Returns the payload of a valid token, or null. Constant-time signature check. */
function verify(token) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  let expected;
  try {
    expected = crypto.createHmac("sha256", secret()).update(body).digest();
  } catch {
    return null;
  }
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function backendUrl() {
  return (process.env.BACKEND_URL || "https://server.urbancitations.com").replace(/\/+$/, "");
}

/** Unsubscribe token for one contact of one business. */
function unsubscribeToken({ contactId, businessId, email }) {
  return sign({ t: "u", c: String(contactId), b: String(businessId), e: String(email || "").toLowerCase() });
}

function unsubscribeUrl(args) {
  return `${backendUrl()}/api/crm/engagement/public/unsubscribe?t=${encodeURIComponent(unsubscribeToken(args))}`;
}

function verifyUnsubscribe(token) {
  const payload = verify(token);
  return payload && payload.t === "u" && payload.c && payload.b ? payload : null;
}

function clickUrl({ dispatchId, url }) {
  const token = sign({ t: "c", d: String(dispatchId), u: url });
  return `${backendUrl()}/api/crm/engagement/public/r/${encodeURIComponent(token)}`;
}

/** Destination of a click token when valid and http(s); null otherwise. */
function verifyClick(token) {
  const payload = verify(token);
  if (!payload || payload.t !== "c" || !payload.d || typeof payload.u !== "string") return null;
  try {
    const url = new URL(payload.u);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return { dispatchId: payload.d, url: payload.u };
}

/**
 * Rewrites http(s) links in a rendered email body to tracked redirects. mailto:,
 * tel: and anchors are left alone.
 */
function trackLinks(html, dispatchId) {
  return String(html || "").replace(/href\s*=\s*"(https?:\/\/[^"]+)"/gi, (match, url) => {
    const decoded = url.replace(/&amp;/g, "&");
    return `href="${clickUrl({ dispatchId, url: decoded })}"`;
  });
}

module.exports = {
  sign,
  verify,
  unsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribe,
  clickUrl,
  verifyClick,
  trackLinks,
};
