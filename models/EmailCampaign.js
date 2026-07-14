// backend/models/EmailCampaign.js
const mongoose = require('mongoose');

const validateEmail = (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const attachmentSchema = new mongoose.Schema({
  originalName: { type: String, required: true },
  storedPath:   { type: String, required: true },
  mimeType:     { type: String, default: 'application/octet-stream' },
  size:         { type: Number, default: 0 }, // bytes
}, { _id: false });

const campaignCustomVarSchema = new mongoose.Schema({
  key:   { type: String, required: true, trim: true, match: /^[a-zA-Z0-9_]+$/ },
  value: { type: String, default: '', trim: true },
}, { _id: false });

const emailCampaignSchema = new mongoose.Schema({
  // ── Campaign identity ──────────────────────────────────────────────
  name: {
    type: String,
    required: [true, 'Campaign name is required'],
    trim: true,
  },
  tags: {
    type: [String],
    default: [],
    validate: {
      validator: (tags) => tags.length <= 20 && tags.every(t => t.length <= 50),
      message: 'Max 20 tags; each tag must be ≤ 50 characters',
    },
  },

  // ── Email composition ──────────────────────────────────────────────
  template: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EmailTemplate',
    required: [true, 'An email template is required'],
  },
  /** Subject override — falls back to template.subject when blank */
  subject: {
    type: String,
    trim: true,
    maxlength: [200, 'Subject must not exceed 200 characters'],
    default: '',
  },
  /** Preview text shown in email client snippet — overrides template.previewText */
  previewText: {
    type: String,
    trim: true,
    maxlength: [200, 'Preview text must not exceed 200 characters'],
    default: '',
  },

  // ── Sender / routing ───────────────────────────────────────────────
  fromEmail: {
    type: String,
    required: [true, 'A sender email address is required'],
    trim: true,
    lowercase: true,
  },
  /** Display name override for the "From:" header */
  senderName: {
    type: String,
    trim: true,
    maxlength: [100, 'Sender name must not exceed 100 characters'],
    default: '',
  },
  /** Reply-To header — must be a valid email when provided */
  replyTo: {
    type: String,
    trim: true,
    lowercase: true,
    validate: {
      validator: validateEmail,
      message: 'Reply-To must be a valid email address',
    },
    default: '',
  },
  /** CC recipients — max 10, each must be a valid email */
  cc: {
    type: [String],
    default: [],
    validate: {
      validator: (arr) => arr.length <= 10 && arr.every(e => validateEmail(e)),
      message: 'CC: max 10 addresses; each must be a valid email',
    },
  },
  /** BCC recipients — max 10, each must be a valid email */
  bcc: {
    type: [String],
    default: [],
    validate: {
      validator: (arr) => arr.length <= 10 && arr.every(e => validateEmail(e)),
      message: 'BCC: max 10 addresses; each must be a valid email',
    },
  },

  // ── Attachments ────────────────────────────────────────────────────
  /** Up to 5 file attachments stored in public/uploads/attachments/ */
  attachments: {
    type: [attachmentSchema],
    default: [],
    validate: {
      validator: (arr) => arr.length <= 5,
      message: 'A campaign may have at most 5 attachments',
    },
  },

  // ── Custom variables ───────────────────────────────────────────────
  /** Per-campaign variable overrides applied during placeholder substitution */
  customVariables: {
    type: [campaignCustomVarSchema],
    default: [],
    validate: {
      validator: (vars) => {
        const keys = vars.map(v => v.key);
        return keys.length === new Set(keys).size;
      },
      message: 'Custom variable keys must be unique within a campaign',
    },
  },

  // ── Recipients ─────────────────────────────────────────────────────
  recipients: {
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    customEmails: [
      {
        email:        { type: String, required: true },
        businessName: { type: String },
        address:      { type: String },
        website:      { type: String },
        phone:        { type: String },
        category:     { type: String },
        subcategory:  { type: String },
        country:      { type: String },
        listingUrl:   { type: String },
      },
    ],
  },

  // ── Status & scheduling ────────────────────────────────────────────
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'processing', 'sent', 'failed'],
    default: 'draft',
  },
  scheduledAt: { type: Date },
  timeZone: {
    type: String,
    // e.g. 'Asia/Kolkata', 'America/New_York'
  },
  sentAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('EmailCampaign', emailCampaignSchema);
