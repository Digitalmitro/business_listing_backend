"use strict";

const mongoose = require("mongoose");

const BusinessImportBatchSchema = new mongoose.Schema(
  {
    file: {
      originalName: { type: String, required: true },
      mimeType: { type: String, default: "application/octet-stream" },
      extension: { type: String, required: true },
      sizeBytes: { type: Number, required: true, min: 0 },
      reference: { type: String, required: true, unique: true },
    },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    uploaderModel: {
      type: String,
      enum: ["Admin", "User"],
      required: true,
    },
    status: {
      type: String,
      enum: ["processing", "completed", "completed_with_errors", "failed"],
      default: "processing",
      index: true,
    },
    totals: {
      found: { type: Number, default: 0, min: 0 },
      imported: { type: Number, default: 0, min: 0 },
      skipped: { type: Number, default: 0, min: 0 },
      rejected: { type: Number, default: 0, min: 0 },
    },
    reasonCounts: {
      type: Map,
      of: Number,
      default: {},
    },
    selectedCountry: { type: String, default: "" },
    failureReason: { type: String, default: null },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

BusinessImportBatchSchema.index({ createdAt: -1 });

module.exports = mongoose.model("BusinessImportBatch", BusinessImportBatchSchema);
