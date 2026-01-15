const mongoose = require('mongoose');

const emailCampaignSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  template: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EmailTemplate',
    required: true,
  },
  recipients: {
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    customEmails: [
      {
        email: { type: String, required: true },
        businessName: { type: String },
      },
    ],
  },
  fromEmail: {
    type: String,
    required: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'sent', 'failed'],
    default: 'draft',
  },
  scheduledAt: {
    type: Date,
  },
  timeZone: {
    type: String,
    // Example: 'Asia/Kolkata', 'America/New_York'
  },
  sentAt: {
    type: Date,
  },
}, { timestamps: true });

module.exports = mongoose.model('EmailCampaign', emailCampaignSchema);