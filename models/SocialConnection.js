"use strict";

const mongoose = require("mongoose");

const socialConnectionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    platform: { type: String, required: true, enum: ["facebook", "instagram", "linkedin", "twitter", "pinterest"], index: true },
    status: { type: String, enum: ["connected", "expired", "revoked", "not_connected"], default: "connected", index: true },
    providerAccountId: { type: String, required: true },
    providerUsername: { type: String, default: "" },
    profileName: { type: String, default: "" },
    profileImageUrl: { type: String, default: "" },
    accessToken: { type: String, required: true, select: false },
    refreshToken: { type: String, default: null, select: false },
    tokenExpiresAt: { type: Date, default: null },
    refreshTokenExpiresAt: { type: Date, default: null },
    scopes: { type: [String], default: [] },
    providerData: { type: mongoose.Schema.Types.Mixed, default: {}, select: false },
    connectedAt: { type: Date, default: Date.now },
    lastError: { type: String, default: null },
  },
  { timestamps: true, minimize: false }
);

socialConnectionSchema.index({ tenantId: 1, userId: 1, platform: 1 }, { unique: true });

module.exports = mongoose.model("SocialConnection", socialConnectionSchema);
