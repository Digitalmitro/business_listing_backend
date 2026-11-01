// routes/emailCampaignRoutes.js
const express = require("express");
const router  = express.Router();

const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAdmin } = require("../middlewares/requireAdmin");

// Templates and campaigns are scoped to their creator and used by both admins (admin
// panel, /api/...) and business owners (CRM suite, /api/email/...): owners pass, admins
// need the email_marketing permission. Platform-wide data (sender SMTP accounts, the
// user directory, Excel cross-referencing against all businesses) is admin-only.
const ownerOrMarketingAdmin = [authMiddleware, requireAdmin.ifAdmin("email_marketing")];
const marketingAdmin = [authMiddleware, requireAdmin("email_marketing")];
const {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
  uploadTemplateImage,
  uploadCampaignAttachments,
  addSenderEmail,
  updateSenderEmail,
  deleteSenderEmail,
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
  toggleSenderEmailStatus,
  processCampaignExcel,
  downloadCampaignSampleExcel,
  sendTestEmail,
} = require("../controllers/emailCampaignController");
const { upload, attachmentUpload } = require("../config/multerConfig");

// ── Email Template Routes ────────────────────────────────────────────────────
router.post("/templates", ownerOrMarketingAdmin, createTemplate);
router.post(
  "/templates/upload-image",
  ownerOrMarketingAdmin,
  upload.single("image"),
  uploadTemplateImage
);
// NOTE: send-test must come BEFORE /:id to prevent route shadowing
router.post("/templates/send-test", ownerOrMarketingAdmin, sendTestEmail);
router.get("/templates",     ownerOrMarketingAdmin, getTemplates);
router.get("/templates/:id", ownerOrMarketingAdmin, getTemplateById);
router.put("/templates/:id", ownerOrMarketingAdmin, updateTemplate);
router.delete("/templates/:id", ownerOrMarketingAdmin, deleteTemplate);

// ── Sender Email Routes ──────────────────────────────────────────────────────
router.post("/sender-emails", marketingAdmin, addSenderEmail);
router.get("/sender-emails",  ownerOrMarketingAdmin, getSenderEmails);
router.patch("/toggle-sender-email-status/:id", marketingAdmin, toggleSenderEmailStatus);
router.patch("/sender-emails/:id",              marketingAdmin, markSenderEmailAsSpam);
router.put("/sender-emails/:id/details",         marketingAdmin, updateSenderEmail);
router.delete("/sender-emails/:id",             marketingAdmin, deleteSenderEmail);

// ── Campaign Attachment Upload (standalone) ──────────────────────────────────
// POST /email/campaigns/attachments
// Accepts up to 5 files via multipart/form-data field name "attachments".
// Returns stored attachment metadata for use in the subsequent campaign create/update call.
router.post(
  "/campaigns/attachments",
  ownerOrMarketingAdmin,
  attachmentUpload.array("attachments", 5),
  uploadCampaignAttachments
);

// ── Email Campaign Routes ────────────────────────────────────────────────────
// Campaign create — accepts both JSON body fields AND optional multipart attachments
router.post(
  "/campaigns",
  ownerOrMarketingAdmin,
  attachmentUpload.array("attachments", 5),
  createCampaign
);

// Named sub-routes must come before /:id
router.post("/campaigns/process-excel",
  marketingAdmin,
  upload.single("file"),
  processCampaignExcel
);
router.get("/campaigns/sample-excel", ownerOrMarketingAdmin, downloadCampaignSampleExcel);

router.get("/campaigns",     ownerOrMarketingAdmin, getCampaigns);
router.get("/campaigns/:id", ownerOrMarketingAdmin, getCampaignById);

// Campaign update — also accepts new attachment files alongside JSON fields
router.put(
  "/campaigns/:id",
  ownerOrMarketingAdmin,
  attachmentUpload.array("attachments", 5),
  updateCampaign
);

router.delete("/campaigns/:id",        ownerOrMarketingAdmin, deleteCampaign);
router.patch("/campaigns/:id/cancel",  ownerOrMarketingAdmin, cancelScheduledCampaign);
router.post("/campaigns/:id/send",     ownerOrMarketingAdmin, sendCampaign);

// ── User Routes ──────────────────────────────────────────────────────────────
router.get("/users", marketingAdmin, getUsers);

// ── Unsubscribe Route (Public) ───────────────────────────────────────────────
// Unsubscribing is handled only by the signed links of /api/unsubscribe (unsubscribeController).

module.exports = router;
