// models/Enquiry.js
const mongoose = require("mongoose");

const EnquirySchema = new mongoose.Schema({
  // businessId is now OPTIONAL — because user is asking for general list, not a single business
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Business",
    required: false,
  },

  // categoryId is now OPTIONAL — we don't always have it from frontend
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Category",
    required: false,
  },
  
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: false,
  },

  interest: {
    type: [String],
    required: true,
    validate: {
      validator: (v) => v.length > 0,
      message: "At least one interest is required",
    },
  },

  name: {
    type: String,
    required: true,
    trim: true,
    minlength: [2, "Name too short"],
  },

  phone: {
    type: String,
    required: true,
    trim: true,
    // match: [/^\d{10,15}$/, "Please enter a valid phone number"], // Relaxed for global use
  },

  location: {
    type: String,
    default: "Unknown",
  },

  source: {
    type: String,
    default: "TopList Sidebar",
  },

  status: {
    type: String,
    enum: ["pending", "resolved"],
    default: "pending",
  },
  
  resolvedAt: {
    type: Date,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Enquiry", EnquirySchema);