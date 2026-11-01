// backend/controllers/kycFileController.js
"use strict";

const kycFiles = require("../services/kycFileService");

/**
 * GET /api/business/kyc-file/:filename?exp=&sig=
 * Serves a KYC document to whoever holds a valid signed link. Links are only put into
 * responses for the business owner (or claimant) and admins, and expire after
 * kycFiles.LINK_TTL_SECONDS.
 */
exports.serveKycFile = (req, res) => {
  const filename = kycFiles.safeFilename(req.params.filename);
  if (!filename || !kycFiles.verifySignature(filename, req.query.exp, req.query.sig)) {
    return res.status(403).json({ success: false, message: "This document link is invalid or has expired." });
  }
  const filePath = kycFiles.resolveKycFile(filename);
  if (!filePath) {
    return res.status(404).json({ success: false, message: "Document not found" });
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `inline; filename="${filename.replace(/["\\\r\n]/g, "_")}"`);
  return res.sendFile(filePath);
};
