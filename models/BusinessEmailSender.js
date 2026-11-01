"use strict";

const mongoose = require("mongoose");

/**
 * The email address a business owner has authorized for emails sent to the
 * business's own customers and leads (booking emails, CRM automations, journeys).
 *
 * The owner connects the mailbox's SMTP account; the SMTP password is stored
 * encrypted (see services/businessSenderService.js) and never returned by the API.
 * The address is only used once `status` is "verified": the SMTP login succeeded
 * and the owner clicked the confirmation link that was sent through that SMTP
 * account to the address itself.
 */
const SENDER_STATUSES = ["pending", "verified", "failed", "disabled"];

const businessEmailSenderSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, unique: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    displayName: { type: String, trim: true, maxlength: 100, default: "" },
    smtpHost: { type: String, required: true, trim: true },
    smtpPort: { type: Number, required: true, min: 1, max: 65535 },
    /** true = implicit TLS (usually port 465); false = STARTTLS (usually 587). */
    secure: { type: Boolean, default: false },
    smtpUser: { type: String, required: true, trim: true },
    /** AES-256-GCM ciphertext "iv.tag.data" (base64url). Never selected by default. */
    smtpPassEnc: { type: String, required: true, select: false },
    status: { type: String, enum: SENDER_STATUSES, default: "pending" },
    /** sha256 of the emailed confirmation token; the raw token only exists in the email. */
    verificationTokenHash: { type: String, default: null, select: false },
    verificationExpiresAt: { type: Date, default: null },
    verificationSentAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BusinessEmailSender", businessEmailSenderSchema);
module.exports.SENDER_STATUSES = SENDER_STATUSES;
