"use strict";

// Validation for files accepted by config/multerConfig.js, whether multer stored
// them on disk (legacy /uploads) or kept them in memory for Cloudinary.
// The extension and client MIME type are checked before multer accepts the
// file; the bytes are then checked against the real file signature and
// scanned for script markers, so renamed scripts and polyglots are rejected.

const fs = require("node:fs/promises");
const path = require("node:path");

const IMAGE_EXTS = [".jpg", ".jpeg", ".jfif", ".png", ".gif", ".webp", ".avif"];
const IMAGE_MIMES = ["image/jpeg", "image/pjpeg", "image/png", "image/gif", "image/webp", "image/avif"];
const IMAGE_KINDS = ["jpeg", "png", "gif", "webp", "avif"];

const POLICIES = {
  image: {
    label: "JPG, PNG, GIF, WebP or AVIF images",
    exts: IMAGE_EXTS,
    mimes: IMAGE_MIMES,
    kinds: IMAGE_KINDS,
  },
  imageOrPdf: {
    label: "JPG, PNG, GIF, WebP or AVIF images, or PDF documents",
    exts: [...IMAGE_EXTS, ".pdf"],
    mimes: [...IMAGE_MIMES, "application/pdf"],
    kinds: [...IMAGE_KINDS, "pdf"],
  },
  video: {
    label: "MP4, MOV, WebM, MKV or AVI videos",
    exts: [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".3gp"],
    mimes: [/^video\//],
    kinds: ["isoVideo", "ebml", "avi"],
    headerOnly: true, // videos can be large; the signature check is enough
  },
  spreadsheet: {
    label: "CSV or Excel (.xlsx/.xls) files",
    exts: [".csv", ".xlsx", ".xls"],
    // Browsers and OSes disagree on CSV/Excel MIME types; the content check below is authoritative.
    mimes: [
      "text/csv",
      "application/csv",
      "text/plain",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
    ],
    kinds: ["text", "zip", "ole"],
  },
};

// Field names on the shared uploader that legitimately carry non-image files.
// Every other field is treated as an image.
const FIELD_POLICIES = {
  kycDocuments: "imageOrPdf",
  video: "video",
  csvFile: "spreadsheet",
  file: "spreadsheet",
};

// Long enough not to occur by chance in binary image data.
const SCRIPT_MARKERS = ["<?php", "<script", "<html", "<iframe"];

// Never served from /uploads and never accepted as an attachment.
const SCRIPT_EXTS = [
  ".php", ".php3", ".php4", ".php5", ".php7", ".phtml", ".phar", ".pht", ".phps",
  ".html", ".htm", ".xhtml", ".shtml", ".svg", ".svgz", ".xml",
  ".js", ".mjs", ".cjs", ".jsp", ".asp", ".aspx", ".cgi", ".pl", ".py", ".rb",
  ".sh", ".bash", ".bat", ".cmd", ".ps1", ".exe", ".dll", ".htaccess",
];

const HEADER_BYTES = 64;

function policyFor(fieldname) {
  return POLICIES[FIELD_POLICIES[fieldname] || "image"];
}

function uploadError(message) {
  return Object.assign(new Error(message), { status: 400, isOperational: true });
}

function mimeAllowed(policy, mimetype) {
  const type = String(mimetype || "").toLowerCase();
  return policy.mimes.some((m) => (m instanceof RegExp ? m.test(type) : m === type));
}

function detectKind(buf) {
  const ascii = (start, end) => buf.subarray(start, end).toString("latin1");
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "AVI ") return "avi";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return "heif";
    return "isoVideo";
  }
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return "ebml";
  if (ascii(0, 5) === "%PDF-") return "pdf";
  if (ascii(0, 4) === "PK\u0003\u0004") return "zip";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return "ole";
  if (buf.length > 0 && !buf.subarray(0, 8192).includes(0)) return "text";
  return "unknown";
}

function findScriptMarker(buf) {
  const text = buf.toString("latin1").toLowerCase();
  return SCRIPT_MARKERS.find((marker) => text.includes(marker));
}

function hasScriptExtension(filename) {
  const name = String(filename || "").toLowerCase();
  // Catch double extensions such as "shell.php.jpg" as well as the final one.
  return path.basename(name).split(".").slice(1).some((part) => SCRIPT_EXTS.includes(`.${part}`));
}

// multer fileFilter: runs before anything is written to disk.
function uploadFileFilter(req, file, cb) {
  const policy = policyFor(file.fieldname);
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (!policy.exts.includes(ext) || hasScriptExtension(file.originalname) || !mimeAllowed(policy, file.mimetype)) {
    return cb(uploadError(`Invalid file "${file.originalname}". Only ${policy.label} are allowed.`));
  }
  return cb(null, true);
}

// multer fileFilter for email attachments, which may be any document type.
function attachmentFileFilter(req, file, cb) {
  if (hasScriptExtension(file.originalname)) {
    return cb(uploadError(`Invalid file "${file.originalname}". Script and web files cannot be attached.`));
  }
  return cb(null, true);
}

async function readForCheck(file, headerOnly) {
  if (Buffer.isBuffer(file.buffer)) return headerOnly ? file.buffer.subarray(0, HEADER_BYTES) : file.buffer;
  const filePath = file.path;
  if (!headerOnly) return fs.readFile(filePath);
  const handle = await fs.open(filePath, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEADER_BYTES), 0, HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function storedFiles(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === "object") return Object.values(req.files).flat();
  return [];
}

async function checkStoredFile(file) {
  const policy = policyFor(file.fieldname);
  const buf = await readForCheck(file, policy.headerOnly);
  const kind = detectKind(buf);
  if (!policy.kinds.includes(kind)) {
    return `Invalid file "${file.originalname}". The file content is not one of: ${policy.label}.`;
  }
  if (!policy.headerOnly && findScriptMarker(buf)) {
    return `Invalid file "${file.originalname}". The file contains embedded script content.`;
  }
  return null;
}

// Verifies every file multer accepted for this request (disk or memory). If any
// file fails, all disk files from the request are deleted and a 400 error is thrown.
async function verifyUploadedFiles(req) {
  const files = storedFiles(req);
  let problem = null;
  for (const file of files) {
    problem = await checkStoredFile(file).catch(() => `Invalid file "${file.originalname}". The file could not be read.`);
    if (problem) break;
  }
  if (!problem) return;
  await Promise.all(files.filter((file) => file.path).map((file) => fs.rm(file.path, { force: true })));
  throw uploadError(problem);
}

// Full image check for bytes already in memory (used before any Cloudinary upload):
// extension and MIME when known, then the real signature and embedded script markers.
// Returns an error message, or null when the buffer is an acceptable image.
function validateImageBuffer(buf, { filename, mimetype } = {}) {
  const policy = POLICIES.image;
  const name = filename || "image";
  if (!Buffer.isBuffer(buf) || buf.length === 0) return `Invalid file "${name}". The file is empty.`;
  if (filename) {
    const ext = path.extname(filename).toLowerCase();
    if (!policy.exts.includes(ext) || hasScriptExtension(filename)) {
      return `Invalid file "${name}". Only ${policy.label} are allowed.`;
    }
  }
  if (mimetype && !mimeAllowed(policy, mimetype)) {
    return `Invalid file "${name}". Only ${policy.label} are allowed.`;
  }
  const kind = detectKind(buf);
  if (!policy.kinds.includes(kind)) {
    return `Invalid file "${name}". The file content is not one of: ${policy.label}.`;
  }
  if (findScriptMarker(buf)) {
    return `Invalid file "${name}". The file contains embedded script content.`;
  }
  return null;
}

module.exports = {
  uploadFileFilter,
  attachmentFileFilter,
  verifyUploadedFiles,
  validateImageBuffer,
  hasScriptExtension,
  detectKind,
  SCRIPT_EXTS,
};
