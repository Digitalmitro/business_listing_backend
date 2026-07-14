// backend/models/EmailTemplate.js
const mongoose = require('mongoose');

const customVariableSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    trim: true,
    match: [/^[a-zA-Z0-9_]+$/, 'Variable key must be alphanumeric with underscores only'],
  },
  defaultValue: {
    type: String,
    default: '',
    trim: true,
  },
}, { _id: false });

const emailTemplateSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  triggerType: {
    type: String,
    enum: [
      "welcome",
      "purchase",
      "claim_approved",
      "claim_rejected",
      "kyc_approved",
      "kyc_rejected",
      "enquiry_received",
      "booking_confirmed_user",
      "booking_confirmed_owner",
      "booking_rescheduled_user",
      "booking_rescheduled_owner",
      "booking_canceled_user",
      "booking_canceled_owner",
      "password_reset",
      "campaign",
      "lead_followup",
    ],
    default: "campaign",
  },
  subject: {
    type: String,
    required: true,
    trim: true,
    maxlength: [200, 'Subject must not exceed 200 characters'],
  },
  previewText: {
    type: String,
    trim: true,
    maxlength: [200, 'Preview text must not exceed 200 characters'],
    default: '',
  },
  body: {
    type: String,
    required: true, // HTML content for the email
  },
  senderName: {
    type: String,
    trim: true,
    maxlength: [100, 'Sender name must not exceed 100 characters'],
    default: '',
  },
  replyTo: {
    type: String,
    trim: true,
    lowercase: true,
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Reply-To must be a valid email address'],
    default: '',
  },
  customVariables: {
    type: [customVariableSchema],
    default: [],
    validate: {
      validator: function (vars) {
        // Enforce unique keys
        const keys = vars.map(v => v.key);
        return keys.length === new Set(keys).size;
      },
      message: 'Custom variable keys must be unique within a template',
    },
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

emailTemplateSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('EmailTemplate', emailTemplateSchema);