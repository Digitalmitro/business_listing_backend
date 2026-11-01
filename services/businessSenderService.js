"use strict";

/**
 * Connects, verifies and uses a business's own email address (its SMTP account)
 * for emails the business sends to its customers and leads.
 *
 *   connect()  -> validates the settings, logs in to the SMTP server, stores the
 *                 password encrypted, and sends a confirmation link THROUGH that
 *                 SMTP account TO the address itself (status "pending").
 *   confirm()  -> the owner clicked the link: status "verified".
 *   getVerifiedTransport() -> what clientMailer uses to send as the business.
 *
 * The SMTP password is encrypted with AES-256-GCM. The key is
 * SENDER_CREDENTIALS_KEY (any long random string), or a key derived from
 * JWT_SECRET when that is unset. Changing the key makes stored passwords
 * unreadable; owners would then have to reconnect.
 */

const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const net = require("node:net");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const validator = require("validator");
const BusinessEmailSender = require("../models/BusinessEmailSender");
const logger = require("../utils/logger");

const ALLOWED_PORTS = [25, 465, 587, 2525];
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const TRANSPORT_TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 };

class SenderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ── Credential encryption ────────────────────────────────────────────────────

function encryptionKey() {
  const explicit = process.env.SENDER_CREDENTIALS_KEY;
  if (explicit) return crypto.createHash("sha256").update(explicit).digest();
  if (process.env.JWT_SECRET) {
    return crypto.createHmac("sha256", process.env.JWT_SECRET).update("business-email-sender-credentials").digest();
  }
  throw new SenderError("SENDER_CREDENTIALS_KEY or JWT_SECRET must be set to store email credentials", 503);
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

function decrypt(blob) {
  const [iv, tag, data] = String(blob || "").split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !data) throw new SenderError("Stored email credentials are unreadable; please reconnect", 409);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new SenderError("Stored email credentials are unreadable; please reconnect", 409);
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// ── Validation ───────────────────────────────────────────────────────────────

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:127.") || v6.startsWith("::ffff:10.") || v6.startsWith("::ffff:192.168.");
}

function privateHostsAllowed() {
  return process.env.SENDER_ALLOW_PRIVATE_HOSTS === "true" || process.env.NODE_ENV !== "production";
}

/** Refuses hosts that resolve to private/loopback addresses in production (no internal network probing). */
async function assertPublicHost(host) {
  if (privateHostsAllowed()) return;
  let addresses = [];
  try {
    addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new SenderError(`The SMTP server "${host}" could not be found. Check the host name.`);
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new SenderError("That SMTP server address is not allowed.");
  }
}

function normalizeSettings(input = {}) {
  const email = String(input.email || "").trim().toLowerCase();
  const smtpHost = String(input.smtpHost || "").trim().toLowerCase();
  const smtpPort = Number(input.smtpPort);
  const smtpUser = String(input.smtpUser || email).trim();
  const smtpPass = typeof input.smtpPass === "string" ? input.smtpPass : "";
  const displayName = String(input.displayName || "").trim().slice(0, 100);
  const secure = input.secure === undefined || input.secure === null || input.secure === "" ? smtpPort === 465 : input.secure === true || input.secure === "true";

  if (!validator.isEmail(email, { require_tld: true })) throw new SenderError("Enter a valid email address.");
  const hostLooksValid = validator.isFQDN(smtpHost, { require_tld: !privateHostsAllowed() }) || net.isIP(smtpHost) || smtpHost === "localhost";
  if (!smtpHost || !hostLooksValid) {
    throw new SenderError("Enter the SMTP server host name, for example smtp.gmail.com.");
  }
  if (!ALLOWED_PORTS.includes(smtpPort)) throw new SenderError(`SMTP port must be one of ${ALLOWED_PORTS.join(", ")}.`);
  if (!smtpUser) throw new SenderError("Enter the SMTP user name (usually your email address).");
  return { email, smtpHost, smtpPort, smtpUser, smtpPass, displayName, secure };
}

function buildTransport({ smtpHost, smtpPort, secure, smtpUser, smtpPass }) {
  return nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure,
    auth: { user: smtpUser, pass: smtpPass },
    requireTLS: !secure && smtpPort !== 25,
    ...TRANSPORT_TIMEOUTS,
  });
}

function friendlySmtpError(error) {
  const msg = String(error?.message || error || "");
  if (/Invalid login|auth|535|534|Username and Password/i.test(msg)) {
    return "The SMTP server rejected the user name or password. For Gmail/Google Workspace use an App Password (Google Account → Security → App passwords).";
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return "The SMTP server could not be found. Check the host name.";
  if (/ECONNREFUSED|ETIMEDOUT|ESOCKET|timeout/i.test(msg)) return "Could not connect to the SMTP server. Check the host, port and SSL setting.";
  return `The SMTP server returned an error: ${msg.slice(0, 200)}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** What the owner's UI may see. Never includes the password or token. */
function toView(doc) {
  if (!doc) return { connected: false, status: "not_connected" };
  return {
    connected: true,
    status: doc.status,
    email: doc.email,
    displayName: doc.displayName,
    smtpHost: doc.smtpHost,
    smtpPort: doc.smtpPort,
    secure: doc.secure,
    smtpUser: doc.smtpUser,
    verifiedAt: doc.verifiedAt,
    verificationSentAt: doc.verificationSentAt,
    verificationExpiresAt: doc.verificationExpiresAt,
    lastError: doc.lastError,
    lastUsedAt: doc.lastUsedAt,
    updatedAt: doc.updatedAt,
  };
}

async function getSender(businessId) {
  if (!mongoose.isValidObjectId(businessId)) return null;
  return BusinessEmailSender.findOne({ businessId }).lean();
}

function verifyUrl(token) {
  const base = (process.env.BACKEND_URL || "https://server.urbancitations.com").replace(/\/+$/, "");
  return `${base}/api/business-email-sender/verify?token=${encodeURIComponent(token)}`;
}

function verificationEmail({ businessName, email, link }) {
  const safeName = String(businessName || "your business").replace(/[<>&"]/g, "");
  return {
    subject: `Confirm ${email} as the sender for ${safeName}`,
    html: `<p>Hello,</p>
<p>You asked UrbanCitations to send emails to <strong>${safeName}</strong>'s customers from <strong>${email}</strong>.</p>
<p>This message was sent through the mail server you connected, so it is already working. Click below to confirm the address:</p>
<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#0b6bcb;color:#fff;border-radius:6px;text-decoration:none;">Confirm ${email}</a></p>
<p>The link expires in 24 hours. If you didn't ask for this, ignore this email; nothing will be sent from this address.</p>`,
  };
}

/**
 * Saves the settings, checks the SMTP login, and sends the confirmation email
 * through the connected account. Keeps the existing password when `smtpPass` is
 * blank and the server settings didn't change (so owners can resend the link).
 */
async function connect({ business, ownerId, input }) {
  if (!business?._id) throw new SenderError("Business not found", 404);
  const settings = normalizeSettings(input);
  const existing = await BusinessEmailSender.findOne({ businessId: business._id }).select("+smtpPassEnc").lean();

  let smtpPass = settings.smtpPass;
  if (!smtpPass) {
    const sameAccount = existing && existing.smtpHost === settings.smtpHost && existing.smtpUser === settings.smtpUser && existing.smtpPort === settings.smtpPort;
    if (!sameAccount) throw new SenderError("Enter the SMTP password (for Gmail, an App Password).");
    smtpPass = decrypt(existing.smtpPassEnc);
  }

  await assertPublicHost(settings.smtpHost);
  const transport = buildTransport({ ...settings, smtpPass });
  try {
    await transport.verify();
  } catch (error) {
    const message = friendlySmtpError(error);
    await BusinessEmailSender.updateOne({ businessId: business._id }, { $set: { lastError: message } });
    logger.warn("business_sender.smtp_login_failed", "SMTP login failed while connecting a business sender", { businessId: String(business._id), host: settings.smtpHost, error: String(error?.message || error).slice(0, 200) });
    throw new SenderError(message, 422);
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const doc = await BusinessEmailSender.findOneAndUpdate(
    { businessId: business._id },
    {
      $set: {
        ownerId,
        email: settings.email,
        displayName: settings.displayName || business.businessName || "",
        smtpHost: settings.smtpHost,
        smtpPort: settings.smtpPort,
        secure: settings.secure,
        smtpUser: settings.smtpUser,
        smtpPassEnc: encrypt(smtpPass),
        status: "pending",
        verificationTokenHash: hashToken(token),
        verificationExpiresAt: new Date(now.getTime() + VERIFY_TTL_MS),
        verificationSentAt: now,
        verifiedAt: null,
        lastError: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  const { subject, html } = verificationEmail({ businessName: business.businessName, email: settings.email, link: verifyUrl(token) });
  try {
    await transport.sendMail({ from: { name: doc.displayName || settings.email, address: settings.email }, to: settings.email, subject, html });
  } catch (error) {
    const message = friendlySmtpError(error);
    await BusinessEmailSender.updateOne({ _id: doc._id }, { $set: { status: "failed", lastError: message } });
    throw new SenderError(message, 422);
  }
  logger.info("business_sender.verification_sent", "Business sender confirmation email sent", { businessId: String(business._id), email: settings.email });
  return toView(await BusinessEmailSender.findById(doc._id).lean());
}

/** Confirms the address from the emailed link. Returns the sender view or throws. */
async function confirm(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) throw new SenderError("This confirmation link is not valid.");
  const doc = await BusinessEmailSender.findOne({ verificationTokenHash: hashToken(token) }).lean();
  if (!doc) throw new SenderError("This confirmation link is not valid or has already been used.");
  if (doc.verificationExpiresAt && doc.verificationExpiresAt.getTime() < Date.now()) {
    throw new SenderError("This confirmation link has expired. Send a new one from your business email settings.", 410);
  }
  await BusinessEmailSender.updateOne(
    { _id: doc._id },
    { $set: { status: "verified", verifiedAt: new Date(), lastError: null }, $unset: { verificationTokenHash: 1, verificationExpiresAt: 1 } }
  );
  logger.info("business_sender.verified", "Business sender verified", { businessId: String(doc.businessId), email: doc.email });
  return { ...toView({ ...doc, status: "verified", verifiedAt: new Date() }), businessId: String(doc.businessId) };
}

async function disconnect(businessId) {
  const res = await BusinessEmailSender.deleteOne({ businessId });
  return res.deletedCount > 0;
}

const transportCache = new Map();

/**
 * The verified sender of a business with a ready nodemailer transport, or null
 * when the business has no verified address.
 */
async function getVerifiedTransport(businessId) {
  if (!mongoose.isValidObjectId(businessId)) return null;
  const doc = await BusinessEmailSender.findOne({ businessId, status: "verified" }).select("+smtpPassEnc").lean();
  if (!doc) return null;
  const cacheKey = `${doc._id}:${doc.updatedAt?.getTime?.() || 0}`;
  let transport = transportCache.get(cacheKey);
  if (!transport) {
    for (const key of transportCache.keys()) if (key.startsWith(`${doc._id}:`)) transportCache.delete(key);
    transport = buildTransport({ ...doc, smtpPass: decrypt(doc.smtpPassEnc) });
    transportCache.set(cacheKey, transport);
  }
  return { sender: toView(doc), senderId: doc._id, transport };
}

async function recordUse(senderId, error = null) {
  const set = error ? { lastError: friendlySmtpError(error) } : { lastUsedAt: new Date(), lastError: null };
  await BusinessEmailSender.updateOne({ _id: senderId }, { $set: set }).catch(() => {});
}

module.exports = {
  SenderError,
  ALLOWED_PORTS,
  encrypt,
  decrypt,
  hashToken,
  isPrivateAddress,
  normalizeSettings,
  friendlySmtpError,
  toView,
  getSender,
  connect,
  confirm,
  disconnect,
  getVerifiedTransport,
  recordUse,
};
