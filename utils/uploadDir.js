"use strict";

// Where user uploads are stored and served from (/uploads/<file>).
// Production sets UPLOAD_DIR=/srv/urbancitations/uploads so uploads live outside
// the deploy directory and a deploy can never delete them. Without it, the old
// public/uploads location inside the backend is used (local development).

const path = require("node:path");

const BACKEND_ROOT = path.join(__dirname, "..");
const LEGACY_PREFIX = "public/uploads/";

function uploadDir(...parts) {
  return path.resolve(BACKEND_ROOT, process.env.UPLOAD_DIR || "public/uploads", ...parts);
}

// Attachment paths saved before UPLOAD_DIR existed are relative, e.g.
// "public/uploads/attachments/x.pdf"; map them into the current upload directory.
function resolveStoredUploadPath(storedPath) {
  if (path.isAbsolute(storedPath)) return storedPath;
  const normalized = storedPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith(LEGACY_PREFIX)) return uploadDir(normalized.slice(LEGACY_PREFIX.length));
  return path.resolve(process.cwd(), storedPath);
}

module.exports = { uploadDir, resolveStoredUploadPath };
