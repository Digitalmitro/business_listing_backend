const mongoose = require('mongoose');

const senderEmailSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  },
  displayName: {
    type: String,
    required: true,
    trim: true,
  },
  smtpHost: {
    type: String,
    required: true,
    trim: true,
  },
  smtpPort: {
    type: Number,
    required: true,
  },
  smtpUser: {
    type: String,
    required: true,
    trim: true,
  },
  smtpPass: {
    type: String,
    required: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

module.exports = mongoose.model('SenderEmail', senderEmailSchema);