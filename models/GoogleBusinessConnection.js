"use strict";
const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
  status: { type: String, enum: ["connected", "expired", "revoked"], default: "connected" },
  accessToken: { type: String, required: true, select: false },
  refreshToken: { type: String, required: true, select: false },
  tokenExpiresAt: { type: Date },
  googleAccountId: String,
  googleEmail: String,
  googleName: String,
  googlePicture: String,
  selectedProfileId: String,
  lastFetchedProfile: mongoose.Schema.Types.Mixed,
  connectedAt: { type: Date, default: Date.now },
}, { timestamps: true });
schema.index({ tenantId: 1, userId: 1 }, { unique: true });
module.exports = mongoose.model("GoogleBusinessConnection", schema);
