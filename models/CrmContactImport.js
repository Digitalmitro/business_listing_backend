// backend/models/CrmContactImport.js
const mongoose = require("mongoose");

/**
 * One bulk contact upload: the analysed file, the column mapping the owner confirmed,
 * and the outcome. Doubles as import history. The uploaded file itself is kept in a
 * private directory only until the import is committed or expires.
 */
const crmContactImportSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    fileName: { type: String, default: "" },
    /** Private path of the uploaded file; never returned by the API. */
    storedPath: { type: String, default: null, select: false },
    status: { type: String, enum: ["analyzed", "processing", "completed", "failed", "expired"], default: "analyzed" },
    rowCount: { type: Number, default: 0 },
    headers: { type: [String], default: [] },
    suggestedMapping: { type: mongoose.Schema.Types.Mixed, default: {} },
    mapping: { type: mongoose.Schema.Types.Mixed, default: undefined },
    mappedBy: { type: String, enum: ["rules", "ai", null], default: null },
    options: {
      duplicateMode: { type: String, enum: ["fill_empty", "overwrite", "skip"], default: "fill_empty" },
      tags: { type: [String], default: [] },
      consentConfirmed: { type: Boolean, default: false },
      engagement: { type: String, enum: ["auto", "none"], default: "auto" },
    },
    summary: {
      created: { type: Number, default: 0 },
      updated: { type: Number, default: 0 },
      unchanged: { type: Number, default: 0 },
      invalid: { type: Number, default: 0 },
      duplicatesInFile: { type: Number, default: 0 },
      suppressed: { type: Number, default: 0 },
    },
    /** Row-level problems (capped). */
    rowErrors: {
      type: [
        new mongoose.Schema(
          { row: Number, field: String, message: String, value: String },
          { _id: false }
        ),
      ],
      default: [],
    },
    /** How imported contacts were handled for engagement (per segment). */
    triage: {
      status: { type: String, enum: ["none", "pending", "running", "done", "failed"], default: "none" },
      startedAt: { type: Date, default: null },
      decidedBy: { type: String, enum: ["ai", "rules", null], default: null },
      segments: { type: mongoose.Schema.Types.Mixed, default: undefined },
      enrolled: { type: Number, default: 0 },
      waiting: { type: Number, default: 0 },
      completedAt: { type: Date, default: null },
      error: { type: String, default: null },
    },
    completedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true }
);

crmContactImportSchema.index({ businessId: 1, createdAt: -1 });
crmContactImportSchema.index({ "triage.status": 1 });

module.exports = mongoose.model("CrmContactImport", crmContactImportSchema);
