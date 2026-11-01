// backend/services/kycFileService.js
"use strict";

// KYC documents (PAN, Aadhaar, incorporation papers...) are private:
//  - new uploads are stored outside the public /uploads directory (privateKycDir);
//  - they are served by GET /api/business/kyc-file/:filename, which needs a short-lived
//    HMAC signature that only owner/admin responses carry (signedKycUrl);
//  - files uploaded before this change still sit in the public upload directory; the
//    /uploads guard (isLegacyKycFile) refuses them there, and the signed route still
//    finds them, so stored filenames keep working for the owner and admins.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { uploadDir } = require("../utils/uploadDir");
const logger = require("../utils/logger");

const LINK_TTL_SECONDS = Number(process.env.KYC_LINK_TTL_SECONDS) || 60 * 60;
const LEGACY_REFRESH_MS = Number(process.env.KYC_LEGACY_REFRESH_MS) || 15 * 60 * 1000;

function privateKycDir() {
  const base = process.env.PRIVATE_UPLOAD_DIR
    ? path.resolve(process.env.PRIVATE_UPLOAD_DIR)
    : path.join(path.dirname(uploadDir()), "private-uploads");
  return path.join(base, "kyc");
}

function ensurePrivateKycDir() {
  const dir = privateKycDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function secret() {
  return process.env.KYC_FILE_SECRET || process.env.JWT_SECRET || "";
}

/** A stored KYC value reduced to a bare file name (never a path). */
function safeFilename(value) {
  if (typeof value !== "string" || !value) return null;
  let name = value;
  try { name = decodeURIComponent(value); } catch { /* keep raw */ }
  name = path.basename(name.replace(/\\/g, "/"));
  if (!name || name === "." || name === ".." || name.startsWith(".")) return null;
  return name;
}

function sign(filename, exp) {
  return crypto.createHmac("sha256", secret()).update(`kyc:${filename}:${exp}`).digest("hex");
}

function verifySignature(filename, exp, sig) {
  const expNum = Number(exp);
  if (!secret() || !Number.isFinite(expNum) || expNum * 1000 < Date.now()) return false;
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = Buffer.from(sign(filename, expNum), "hex");
  return crypto.timingSafeEqual(expected, Buffer.from(sig, "hex"));
}

function backendOrigin(req) {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL.replace(/\/+$/, "");
  if (req && typeof req.get === "function" && req.get("host")) return `${req.protocol}://${req.get("host")}`;
  return "";
}

function signedKycUrl(storedValue, req) {
  const filename = safeFilename(storedValue);
  if (!filename) return null;
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  return `${backendOrigin(req)}/api/business/kyc-file/${encodeURIComponent(filename)}?exp=${exp}&sig=${sign(filename, exp)}`;
}

function documentEntries(documents) {
  if (!documents) return [];
  if (documents instanceof Map) return [...documents.entries()];
  if (typeof documents === "object") return Object.entries(documents);
  return [];
}

/** { docName: signedUrl } for a KYC documents map (Map or plain object). */
function signedDocumentUrls(documents, req) {
  const urls = {};
  for (const [docName, value] of documentEntries(documents)) {
    const url = signedKycUrl(value, req);
    if (url) urls[docName] = url;
  }
  return urls;
}

/**
 * Returns a copy of `kyc` fit for the viewer: the owner/admin keep `documents` (the stored
 * file names, which the edit forms send back) plus `documentUrls`; everyone else gets the
 * KYC status without any document.
 */
function presentKyc(kyc, req, { canSeeDocuments }) {
  if (!kyc || typeof kyc !== "object") return kyc;
  const plain = typeof kyc.toObject === "function" ? kyc.toObject() : { ...kyc };
  if (!canSeeDocuments) {
    delete plain.documents;
    delete plain.documentUrls;
    return plain;
  }
  const documents = Object.fromEntries(documentEntries(plain.documents));
  return { ...plain, documents, documentUrls: signedDocumentUrls(documents, req) };
}

/** Absolute path of a KYC file: the private directory first, then legacy public uploads. */
function resolveKycFile(filename) {
  const name = safeFilename(filename);
  if (!name) return null;
  for (const dir of [privateKycDir(), uploadDir()]) {
    const candidate = path.join(dir, name);
    if (path.dirname(candidate) !== path.resolve(dir)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

// ── Legacy KYC files still in the public upload directory ─────────────────────
let legacyNames = null;
let legacyLoadedAt = 0;
let legacyLoading = null;

async function loadLegacyNames() {
  const Business = require("../models/Business");
  const Claim = require("../models/Claim");
  const pipeline = [
    { $match: { "kyc.documents": { $type: "object", $ne: {} } } },
    { $project: { docs: { $objectToArray: "$kyc.documents" } } },
    { $unwind: "$docs" },
    { $group: { _id: null, files: { $addToSet: "$docs.v" } } },
  ];
  const [biz, claims] = await Promise.all([Business.aggregate(pipeline), Claim.aggregate(pipeline)]);
  const names = new Set();
  for (const row of [...biz, ...claims]) {
    for (const value of row.files || []) {
      const name = safeFilename(value);
      if (name) names.add(name);
    }
  }
  return names;
}

function refreshLegacyNames() {
  if (!legacyLoading) {
    legacyLoading = loadLegacyNames()
      .then((names) => {
        legacyNames = names;
        legacyLoadedAt = Date.now();
      })
      .catch((error) => {
        logger.warn("kyc.legacy_index_failed", "Could not load KYC file names for the /uploads guard", { error: error.message });
      })
      .finally(() => {
        legacyLoading = null;
      });
  }
  return legacyLoading;
}

/** Remember a KYC file name (e.g. right after an upload or a DB edit). */
function rememberKycFile(value) {
  const name = safeFilename(value);
  if (name && legacyNames) legacyNames.add(name);
}

/** True when `requestPath` under /uploads is a KYC document that must not be public. */
async function isLegacyKycFile(requestPath) {
  const name = safeFilename(requestPath);
  if (!name) return false;
  if (!legacyNames) await refreshLegacyNames();
  else if (Date.now() - legacyLoadedAt > LEGACY_REFRESH_MS) refreshLegacyNames();
  if (!legacyNames) return false;
  return legacyNames.has(name);
}

function resetLegacyIndexForTests() {
  legacyNames = null;
  legacyLoadedAt = 0;
}

module.exports = {
  privateKycDir,
  ensurePrivateKycDir,
  safeFilename,
  signedKycUrl,
  signedDocumentUrls,
  presentKyc,
  verifySignature,
  resolveKycFile,
  isLegacyKycFile,
  refreshLegacyNames,
  rememberKycFile,
  resetLegacyIndexForTests,
  LINK_TTL_SECONDS,
};
