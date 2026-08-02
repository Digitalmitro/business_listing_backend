// backend/models/ScheduledSocialPost.js
"use strict";

const mongoose = require("mongoose");

const scheduledSocialPostSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    caption: {
      type: String,
      default: "",
    },
    media: {
      type: [String],
      default: [],
    },
    platforms: {
      type: [String],
      required: true,
    },
    platformOptions: { type: mongoose.Schema.Types.Mixed, default: {} },
    scheduledFor: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["scheduled", "processing", "published", "failed", "cancelled"],
      default: "scheduled",
      index: true,
    },
    bullmqJobId: {
      type: String,
      default: null,
    },
    results: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    error: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

scheduledSocialPostSchema.index({ status: 1, scheduledFor: 1 });

const ScheduledSocialPost = mongoose.model("ScheduledSocialPost", scheduledSocialPostSchema);

module.exports = ScheduledSocialPost;
