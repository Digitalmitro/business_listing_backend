"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const multer = require("multer");

const configuredMaxFileBytes = Number.parseInt(process.env.BUSINESS_IMPORT_MAX_FILE_BYTES, 10);
const MAX_IMPORT_FILE_BYTES =
  Number.isInteger(configuredMaxFileBytes) && configuredMaxFileBytes > 0
    ? Math.min(configuredMaxFileBytes, 100 * 1024 * 1024)
    : 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".csv", ".xlsx"]);

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, os.tmpdir()),
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    callback(null, `business-import-${randomUUID()}${extension}`);
  },
});

const uploader = multer({
  storage,
  limits: {
    fileSize: MAX_IMPORT_FILE_BYTES,
    files: 1,
    fields: 10,
  },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      const error = new Error(
        "Unsupported file type. Upload a .csv or .xlsx file. Save legacy .xls files as .xlsx first."
      );
      error.statusCode = 400;
      callback(error);
      return;
    }
    callback(null, true);
  },
});

const acceptImportFile = uploader.fields([
  { name: "file", maxCount: 1 },
  { name: "csvFile", maxCount: 1 },
]);

function removeUploadedFiles(files) {
  for (const file of files) {
    if (file?.path) fs.unlink(file.path, () => {});
  }
}

function businessImportUpload(req, res, next) {
  acceptImportFile(req, res, (error) => {
    if (error) {
      removeUploadedFiles(Object.values(req.files || {}).flat());
      const isTooLarge = error.code === "LIMIT_FILE_SIZE";
      res.status(isTooLarge ? 413 : error.statusCode || 400).json({
        success: false,
        message: isTooLarge
          ? `Import file is too large. Maximum size is ${Math.floor(MAX_IMPORT_FILE_BYTES / 1024 / 1024)} MB.`
          : error.message,
      });
      return;
    }

    const uploadedFiles = [
      ...(req.files?.file || []),
      ...(req.files?.csvFile || []),
    ];

    if (uploadedFiles.length > 1) {
      removeUploadedFiles(uploadedFiles);
      res.status(400).json({
        success: false,
        message: "Upload exactly one CSV or XLSX file.",
      });
      return;
    }

    req.file = uploadedFiles[0];
    next();
  });
}

module.exports = {
  businessImportUpload,
  MAX_IMPORT_FILE_BYTES,
};
