const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Business Schema
const BusinessSchema = new Schema({
  businessName: { type: String, required: true },
  description: { type: String },
  address: {
    blockName: { type: String },
    streetName: { type: String },
    area: { type: String },
    landmark: { type: String },
    pincode: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true }
  },
  contact: {
    customerName: { type: String, required: true },
    mobile: { type: String, required: true },
    whatsapp: { type: String },
    email: { type: String }
  },
  businessTiming: {
    weeksSet: {
      type: [String],
      enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      required: true
    },
    timing: {
      start: { type: String, required: true },  // Example: "9:00 AM"
      end: { type: String, required: true }    // Example: "6:00 PM"
    }
  },
  category: {
    type: Schema.Types.ObjectId,
    ref: 'Category',
    required: true
  },
  subCategory: {
    type: Schema.Types.ObjectId,
    ref: 'SubCategory',
    required: false
  },
  photos: [{ type: String }], // URLs or file paths
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
    default: 0 // Tracks the number of enquiries
  },
  openUntil: {
    type: String // Closing time (e.g., "10:00 PM")
  },
  yearsOfEstablishment: {
    type: Number,
    default: 0 // Years the business has been established
  },
  servicesTypes: {
    type: [String] // Array of service types
  },
  hygiene: {
    type: String,
    default: '' // Hygiene-related information
  },
  businessSummary: {
    type: String // Summary of the business
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

module.exports = mongoose.model('Business', BusinessSchema);

