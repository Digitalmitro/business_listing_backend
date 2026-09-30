// backend/routes/crmEngagementRoutes.js
const express = require("express");
const path = require("node:path");
const fs = require("node:fs");
const multer = require("multer");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const { aiLimiter, crmWriteLimiter, publicCaptureLimiter, publicTrackLimiter } = require("../middlewares/rateLimiter");
const c = require("../controllers/crmEngagementController");
const pub = require("../controllers/crmEngagementPublicController");
const { PRIVATE_DIR } = require("../services/crmContactImportService");

// Uploads go straight to a private directory (never under /public), and are
// removed after the import is committed or expires.
fs.mkdirSync(PRIVATE_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PRIVATE_DIR),
    filename: (req, file, cb) => cb(null, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: Number(process.env.IMPORT_FILE_SIZE_LIMIT || 10 * 1024 * 1024), files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = [".csv", ".xlsx", ".xls"].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : Object.assign(new Error("Only CSV and Excel (.xlsx/.xls) files are allowed"), { status: 400 }), ok);
  },
});
function uploadFile(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" ? "The file is too large (max 10 MB)" : err.message });
    return next();
  });
}

// ── Public (listing site and email links) ─────────────────────────────────
router.get("/public/widget/:businessId", publicTrackLimiter, pub.getWidget);
router.post("/public/capture", publicCaptureLimiter, pub.capture);
router.post("/public/track", publicTrackLimiter, pub.track);
router.get("/public/unsubscribe", pub.unsubscribePage);
// Mail providers send one-click unsubscribes from shared IPs: use the generous limiter.
router.post("/public/unsubscribe", publicTrackLimiter, pub.unsubscribe);
router.get("/public/r/:token", pub.redirect);

// ── Business CRM (authenticated) ──────────────────────────────────────────
router.get("/catalog", authMiddleware, c.getCatalog);
router.get("/overview", authMiddleware, c.getOverview);
router.put("/settings", authMiddleware, c.saveSettings);

router.get("/templates", authMiddleware, c.listTemplates);
router.post("/templates/preview", authMiddleware, c.previewTemplate);
router.post("/templates", authMiddleware, c.createTemplate);
router.put("/templates/:id", authMiddleware, c.updateTemplate);
router.post("/templates/:id/approve", authMiddleware, c.approveTemplate);
router.post("/templates/:id/duplicate", authMiddleware, c.duplicateTemplate);
router.patch("/templates/:id/archive", authMiddleware, c.archiveTemplate);

router.post("/ai/template", authMiddleware, aiLimiter, c.aiTemplate);
router.post("/ai/plan", authMiddleware, aiLimiter, c.aiPlan);
router.post("/ai/plan/apply", authMiddleware, c.aiPlanApply);

router.get("/journeys", authMiddleware, c.listJourneys);
router.post("/journeys", authMiddleware, c.createJourney);
router.put("/journeys/:id", authMiddleware, c.updateJourney);
router.patch("/journeys/:id/enabled", authMiddleware, c.setJourneyEnabled);
router.delete("/journeys/:id", authMiddleware, c.deleteJourney);

router.get("/enrollments", authMiddleware, c.listEnrollments);
router.post("/enrollments", authMiddleware, c.enrollContact);
router.post("/enrollments/:id/stop", authMiddleware, c.stopEnrollment);

router.get("/emails", authMiddleware, c.listEmails);

router.post("/contacts/bulk", authMiddleware, crmWriteLimiter, c.bulkContacts);
router.post("/contacts/sync-existing", authMiddleware, crmWriteLimiter, c.syncExisting);
router.get("/contacts/:id/profile", authMiddleware, c.getContactProfile);
router.patch("/contacts/:id/email-preferences", authMiddleware, c.setEmailPreferences);

router.post("/imports", authMiddleware, crmWriteLimiter, uploadFile, c.analyzeImport);
router.get("/imports", authMiddleware, c.listImports);
router.get("/imports/:id", authMiddleware, c.getImport);
router.get("/imports/:id/errors.csv", authMiddleware, c.importErrorsCsv);
router.post("/imports/:id/validate", authMiddleware, c.validateImport);
router.post("/imports/:id/commit", authMiddleware, crmWriteLimiter, c.commitImport);
router.post("/imports/:id/retriage", authMiddleware, c.retriageImport);

module.exports = router;
