"use strict";

const mongoose = require("mongoose");

const importedDataSchema = new mongoose.Schema(
  {
    businessName: { type: mongoose.Schema.Types.Mixed, default: "" },
    phone: { type: mongoose.Schema.Types.Mixed, default: "" },
    email: { type: mongoose.Schema.Types.Mixed, default: "" },
    address: { type: mongoose.Schema.Types.Mixed, default: "" },
    website: { type: mongoose.Schema.Types.Mixed, default: "" },
    rating: { type: mongoose.Schema.Types.Mixed, default: null },
    reviews: { type: mongoose.Schema.Types.Mixed, default: null },
    latitude: { type: mongoose.Schema.Types.Mixed, default: null },
    longitude: { type: mongoose.Schema.Types.Mixed, default: null },
    category: { type: mongoose.Schema.Types.Mixed, default: "" },
    subcategory: { type: mongoose.Schema.Types.Mixed, default: "" },
    country: { type: mongoose.Schema.Types.Mixed, default: "" },
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
