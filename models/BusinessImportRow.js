"use strict";

const mongoose = require("mongoose");

const importedDataSchema = new mongoose.Schema(
  {
    businessName: { type: String, default: "" },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    address: { type: String, default: "" },
    website: { type: String, default: "" },
    rating: { type: Number, default: null },
    reviews: { type: Number, default: null },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    category: { type: String, default: "" },
    subcategory: { type: String, default: "" },
    country: { type: String, default: "" },
  },
  { _id: false }
);

const BusinessImportRowSchema = new mongoose.Schema(
  {
    batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessImportBatch",
      required: true,
      index: true,
    },
    rowNumber: { type: Number, required: true, min: 2 },
    status: {
      type: String,
      enum: ["processing", "imported", "skipped", "rejected"],
      required: true,
      index: true,
    },
    reason: { type: String, default: null },
    reasons: { type: [String], default: [] },
    rawData: { type: mongoose.Schema.Types.Mixed, default: {} },
    data: { type: importedDataSchema, default: () => ({}) },
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      default: null,
    },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

BusinessImportRowSchema.index({ batch: 1, rowNumber: 1 }, { unique: true });
BusinessImportRowSchema.index({ batch: 1, status: 1, rowNumber: 1 });

module.exports = mongoose.model("BusinessImportRow", BusinessImportRowSchema);
