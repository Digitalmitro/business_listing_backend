"use strict";

const mongoose = require("mongoose");

const oauthStateSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    platform: { type: String, required: true, index: true },
    stateHash: { type: String, required: true, unique: true },
    codeVerifier: { type: String, default: null },
    redirectUri: { type: String, required: true },
    returnTo: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

module.exports = mongoose.model("OAuthState", oauthStateSchema);
