"use strict";

const mongoose = require("mongoose");

const BusinessImportRowSchema = new mongoose.Schema(
  {
    batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessImportBatch",
      required: true,
    },
    rowNumber: { type: Number, required: true, min: 2 },
    status: {
      type: String,
      enum: ["processing", "imported", "skipped", "rejected"],
      required: true,
    },
    reason: { type: String, default: null },
    reasons: { type: [String], default: [] },
    data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      default: null,
    },
    processedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

BusinessImportRowSchema.index({ batch: 1, rowNumber: 1 }, { unique: true });
BusinessImportRowSchema.index({ batch: 1, status: 1, rowNumber: 1 });
BusinessImportRowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("BusinessImportRow", BusinessImportRowSchema);
