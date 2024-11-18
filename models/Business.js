const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Business Schema
const BusinessSchema = new Schema({
  name: {
    type: String,
    required: true
  },
  description: {
    type: String
  },
  address: {
    type: String
  },
  phone: {
    type: String
  },
  whatsapp: {
    type: String // WhatsApp contact number
  },
  email: {
    type: String
  },
  category: {
    type: Schema.Types.ObjectId,
    ref: 'Category',
    required: true
  },
  subCategory: {
    type: Schema.Types.ObjectId,
    ref: 'SubCategory',
    required: false // Now optional
  },
  image: {
    type: String, // URL for the business image
    required: true
  },
  rating: {
    type: Number,
    default: 0 // Average rating
  },
  totalReviews: {
    type: Number,
    default: 0 // Total number of reviews
  },
  verified: {
    type: Boolean,
    default: false // Indicates if the business is verified
  },
  trust: {
    type: Boolean,
    default: false // Indicates if the business is trusted
  },
  claimed: {
    type: Boolean,
    default: false // Indicates if the business is claimed
  },
  enquiryCount: {
    type: Number,
    default: 0 // Tracks number of enquiries
  },
  openUntil: {
    type: String // Closing time (e.g., "10:00 PM")
  },
  yearsOfEstablishment: {
    type: Number, // Years the business has been established
    default: 0
  },
  timings: {
    type: String // Operating hours (e.g., "9:00 AM - 10:00 PM")
  },
  businessSummary: {
    type: String // Summary of the business
  },
  servicesTypes: {
    type: [String], 
    required: false,
  },
  hygiene: {
    type: String,
    default: '' 
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Business', BusinessSchema);
