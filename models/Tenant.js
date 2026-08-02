"use strict";
const mongoose = require("mongoose");
const tenantSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  status: { type: String, enum: ["active", "suspended"], default: "active" },
}, { timestamps: true });
module.exports = mongoose.model("Tenant", tenantSchema);
