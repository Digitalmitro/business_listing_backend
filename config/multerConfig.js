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

module.exports = { upload, dynamicUpload, attachmentUpload };
