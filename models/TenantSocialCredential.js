"use strict";
const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
  platform: { type: String, enum: ["facebook", "instagram", "linkedin", "twitter", "pinterest", "google_business"], required: true },
  clientId: { type: String, required: true, select: false },
  clientSecret: { type: String, required: true, select: false },
  redirectUri: { type: String, required: true },
  enabled: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });
schema.index({ tenantId: 1, platform: 1 }, { unique: true });
module.exports = mongoose.model("TenantSocialCredential", schema);
