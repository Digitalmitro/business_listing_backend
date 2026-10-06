"use strict";

// Stored representation of an image that lives in an external image store
// (currently Cloudinary). Embedded in documents that own an uploaded image,
// e.g. Category.icon and SubCategory.icon. The owning document keeps its
// legacy display-URL string (iconUrl) in sync with `url` so existing API
// consumers keep working; this sub-document carries everything needed to
// render, replace, de-duplicate and safely delete the asset.

const mongoose = require("mongoose");

const ImageAssetSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ["cloudinary"], required: true },
    url: { type: String, required: true }, // Cloudinary secure_url
    publicId: { type: String, required: true },
    resourceType: { type: String, default: "image" },
    format: { type: String },
    width: { type: Number },
    height: { type: Number },
    bytes: { type: Number },
    version: { type: Number },
    // SHA-256 of the uploaded bytes. The public_id is derived from it, which
    // makes identical uploads share one asset and makes migrations idempotent.
    sha256: { type: String },
    uploadedAt: { type: Date, default: Date.now },
    // The display URL this asset replaced (legacy /uploads/<file> or default
    // placeholder). Kept for the migration rollback and for audits.
    legacyUrl: { type: String },
  },
  { _id: false }
);

module.exports = { ImageAssetSchema };
