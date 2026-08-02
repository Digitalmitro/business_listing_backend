// backend/models/SocialPostHistory.js
const mongoose = require("mongoose");

const platformResultSchema = new mongoose.Schema(
  {
    platform: { type: String, required: true },
    status: { type: String, enum: ["SUCCESS", "FAILURE"], required: true },
    externalPostId: { type: String },
    failureReason: { type: String },
  },
  { _id: false }
);

const socialPostHistorySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    platforms: [
      {
        type: String,
        required: true,
      },
    ],
    content: {
      type: String,
      required: false,
      default: "",
    },
    media: [
      {
        type: {
          type: String,
          enum: ["image", "video"],
          default: "image",
        },
        url: {
          type: String,
          required: true,
        },
        _id: false,
      },
    ],
    results: [platformResultSchema],
    overallStatus: {
      type: String,
      enum: ["SUCCESS", "PARTIAL_SUCCESS", "FAILURE"],
      required: true,
    },
    postedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

module.exports = mongoose.model("SocialPostHistory", socialPostHistorySchema);
