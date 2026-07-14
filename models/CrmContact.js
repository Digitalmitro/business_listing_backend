// backend/models/CrmContact.js
const mongoose = require("mongoose");

const addressSchema = new mongoose.Schema(
  {
    street: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    zip: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const crmContactSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    company: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      default: "",
      index: true,
    },
    phone: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    alternatePhone: {
      type: String,
      trim: true,
      default: "",
    },
    website: {
      type: String,
      trim: true,
      default: "",
    },
    address: {
      type: addressSchema,
      default: () => ({ street: "", city: "", state: "", zip: "", country: "" }),
    },
    industry: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    source: {
      type: String,
      enum: ["Website", "Referral", "Cold Call", "Social Media", "Advertisement", "Event", "Other", ""],
      default: "Other",
      index: true,
    },
    assignedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    notes: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Index for fast multi-tenant searches across core fields
crmContactSchema.index({ ownerId: 1, name: 1, company: 1 });

// Full-text search index across name, company, email, and notes
crmContactSchema.index({ name: "text", company: "text", email: "text", notes: "text" }, { name: "contact_text_index" });

module.exports = mongoose.model("CrmContact", crmContactSchema);
