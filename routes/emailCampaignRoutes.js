// routes/emailCampaignRoutes.js
const express = require("express");
const router  = express.Router();

const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
  uploadTemplateImage,
  uploadCampaignAttachments,
  addSenderEmail,
  getSenderEmails,
  markSenderEmailAsSpam,
  createCampaign,
  getCampaigns,
  getCampaignById,
  updateCampaign,
  cancelScheduledCampaign,
  sendCampaign,
  deleteCampaign,
  getUsers,
  unsubscribe,
  toggleSenderEmailStatus,
  processCampaignExcel,
  downloadCampaignSampleExcel,
  sendTestEmail,
} = require("../controllers/emailCampaignController");
const { upload, attachmentUpload } = require("../config/multerConfig");

// ── Email Template Routes ────────────────────────────────────────────────────
router.post("/templates", authMiddleware, createTemplate);
router.post(
  "/templates/upload-image",
  authMiddleware,
  upload.single("image"),
  uploadTemplateImage
);
// NOTE: send-test must come BEFORE /:id to prevent route shadowing
router.post("/templates/send-test", authMiddleware, sendTestEmail);
router.get("/templates",     authMiddleware, getTemplates);
router.get("/templates/:id", authMiddleware, getTemplateById);
router.put("/templates/:id", authMiddleware, updateTemplate);
router.delete("/templates/:id", authMiddleware, deleteTemplate);

// ── Sender Email Routes ──────────────────────────────────────────────────────
router.post("/sender-emails", authMiddleware, addSenderEmail);
router.get("/sender-emails",  authMiddleware, getSenderEmails);
router.patch("/toggle-sender-email-status/:id", authMiddleware, toggleSenderEmailStatus);
router.patch("/sender-emails/:id",              authMiddleware, markSenderEmailAsSpam);

// ── Campaign Attachment Upload (standalone) ──────────────────────────────────
// POST /email/campaigns/attachments
// Accepts up to 5 files via multipart/form-data field name "attachments".
// Returns stored attachment metadata for use in the subsequent campaign create/update call.
router.post(
  "/campaigns/attachments",
  authMiddleware,
  attachmentUpload.array("attachments", 5),
  uploadCampaignAttachments
);

// ── Email Campaign Routes ────────────────────────────────────────────────────
// Campaign create — accepts both JSON body fields AND optional multipart attachments
router.post(
  "/campaigns",
  authMiddleware,
  attachmentUpload.array("attachments", 5),
  createCampaign
);

// Named sub-routes must come before /:id
router.post("/campaigns/process-excel",
  authMiddleware,
  upload.single("file"),
  processCampaignExcel
);
router.get("/campaigns/sample-excel", authMiddleware, downloadCampaignSampleExcel);

router.get("/campaigns",     authMiddleware, getCampaigns);
router.get("/campaigns/:id", authMiddleware, getCampaignById);

// Campaign update — also accepts new attachment files alongside JSON fields
router.put(
  "/campaigns/:id",
  authMiddleware,
  attachmentUpload.array("attachments", 5),
  updateCampaign
);

router.delete("/campaigns/:id",        authMiddleware, deleteCampaign);
router.patch("/campaigns/:id/cancel",  authMiddleware, cancelScheduledCampaign);
router.post("/campaigns/:id/send",     authMiddleware, sendCampaign);

// ── User Routes ──────────────────────────────────────────────────────────────
router.get("/users", authMiddleware, getUsers);

// ── Unsubscribe Route (Public) ───────────────────────────────────────────────
router.get("/unsubscribe", unsubscribe);

module.exports = router;
