// backend/models/EmailTemplate.js
const mongoose = require('mongoose');

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
      "campaign",
    ],
    default: "campaign",
  },
  subject: {
    type: String,
    required: true,
    trim: true,
  },
  body: {
    type: String,
    required: true, // HTML content for the email
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true, // Admin who created the template
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