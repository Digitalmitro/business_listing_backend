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
  photos: [{ type: String }], 
  rating: {
    type: Number,
    default: 0 
  },
  totalReviews: {
    type: Number,
    default: 0 
  },
  verified: {
    type: Boolean,
    default: false 
  },
  trust: {
    type: Boolean,
    default: false 
  },
  claimed: {
    type: Boolean,
    default: false
  },
  enquiryCount: {
    type: Number,
    default: 0 
  },
  openUntil: {
    type: String 
  },
  yearsOfEstablishment: {
    type: Number,
    default: 0 
  },
  servicesTypes: {
    type: [String] 
  },
  hygiene: {
    type: String,
    default: '' 
  },
  businessSummary: {
    type: String 
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

