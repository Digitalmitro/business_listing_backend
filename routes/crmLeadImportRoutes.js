// backend/routes/crmLeadImportRoutes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { importLeads } = require("../controllers/crmLeadImportController");

const uploadDir = path.join(__dirname, "../public/uploads/imports");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `import-${Date.now()}-${Math.random().toString(36).substring(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: Number(process.env.IMPORT_FILE_SIZE_LIMIT || 10 * 1024 * 1024) }, // 10MB default
  fileFilter: (req, file, cb) => {
    const allowedExtensions = [".csv", ".xlsx", ".xls"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV and Excel (.xlsx/.xls) files are allowed"));
    }
  },
});

router.post("/", authMiddleware, upload.single("file"), importLeads);

module.exports = router;
