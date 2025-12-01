
const mongoose = require('mongoose');

const PageSEOSchema = new mongoose.Schema({
  pageKey: {
    type: String,
    required: true,
    unique: true,
    enum: [
      'home',
      'about',
      'privacy',
      'terms',
      'customer-care',
      'media',
      'freelisting',
      'advertise',
      'contact',
      'explore',
      'more-categories',
      // add more as needed
    ]
  },
  title: { type: String, required: true },
  description: { type: String, required: true },
  keywords: [{ type: String }],
  ogImage: { type: String },
  canonicalUrl: { type: String },
  robots: { type: String, default: 'index, follow' },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('PageSEO', PageSEOSchema);