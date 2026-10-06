// config/multerConfig.js
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const {
  uploadFileFilter,
  attachmentFileFilter,
  verifyUploadedFiles,
} = require("../utils/uploadValidation");
const { uploadDir } = require("../utils/uploadDir");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir());
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const multerUpload = multer({ storage, fileFilter: uploadFileFilter });

// Runs the multer middleware, then checks the stored bytes (signature and
// embedded scripts) before the route handler sees the files.
const withVerification = (middleware) => (req, res, next) => {
  middleware(req, res, (err) => {
    if (err) return next(err);
    verifyUploadedFiles(req).then(() => next(), next);
  });
};

const upload = {
  single: (name) => withVerification(multerUpload.single(name)),
  array: (name, maxCount) => withVerification(multerUpload.array(name, maxCount)),
  fields: (fields) => withVerification(multerUpload.fields(fields)),
};

// ── Cloudinary-bound image uploads ───────────────────────────────────────────
// Files are kept in memory (req.file.buffer / req.files[field][i].buffer), validated
// against the same extension, MIME, signature and script-marker rules, and then
// handed to services/imageStorageService.js. Nothing is ever written to disk.
const IMAGE_UPLOAD_MAX_BYTES = Number(process.env.IMAGE_UPLOAD_MAX_BYTES) || 5 * 1024 * 1024;

const memoryUploader = multer({
  storage: multer.memoryStorage(),
  fileFilter: uploadFileFilter,
  limits: { fileSize: IMAGE_UPLOAD_MAX_BYTES, files: 4 },
});

// Multer's own errors (too large, unexpected field) are client errors, not 500s.
const withMemoryVerification = (middleware) => (req, res, next) => {
  middleware(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        err.status = 400;
        err.isOperational = true;
        if (err.code === "LIMIT_FILE_SIZE") err.message = `Image is too large. Maximum size is ${Math.round(IMAGE_UPLOAD_MAX_BYTES / (1024 * 1024))} MB.`;
      }
      return next(err);
    }
    verifyUploadedFiles(req).then(() => next(), next);
  });
};

const memoryUpload = {
  single: (name) => withMemoryVerification(memoryUploader.single(name)),
  fields: (fields) => withMemoryVerification(memoryUploader.fields(fields)),
};

// ── Email campaign attachment storage ────────────────────────────────────────
// Files are stored in a dedicated sub-directory to keep them separate from
// images and other uploaded assets.
const attachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    // multer only creates string destinations; a fresh UPLOAD_DIR has no attachments/ yet.
    const dir = uploadDir("attachments");
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename: (req, file, cb) => {
    // Sanitise the original name to avoid path traversal and special chars
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

/** Use for campaign attachment uploads (max 5 files, 10 MB each). */
const attachmentUpload = multer({
  storage: attachmentStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB hard limit at transport layer
  fileFilter: attachmentFileFilter,
});

const dynamicUpload = (req, res, next) => {
  const fields = [
    { name: "icon", maxCountCount: 1 },
    { name: "galleryImages", maxCount: 30 },
  ];

  // MUST VISIT
  for (let i = 0; i < 20; i++) {
    fields.push({ name: `mustVisitPlacesImages_${i}`, maxCount: 1 });
  }

  // RESTAURANTS
  for (let i = 0; i < 20; i++) {
    fields.push({ name: `restaurantsImages_${i}`, maxCount: 1 });
  }

  // HOTELS
  for (let i = 0; i < 20; i++) {
    fields.push({ name: `hotelsImages_${i}`, maxCount: 1 });
  }

  upload.fields(fields)(req, res, next);
};

module.exports = { upload, dynamicUpload, attachmentUpload, memoryUpload, IMAGE_UPLOAD_MAX_BYTES };
