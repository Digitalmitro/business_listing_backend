const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
  uploadTemplateImage,
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
} = require("../controllers/emailCampaignController");
const { upload } = require("../config/multerConfig");

// Email Template Routes
router.post("/templates", authMiddleware, createTemplate);
router.post(
  "/templates/upload-image",
  authMiddleware,
  upload.single("image"),
  uploadTemplateImage
);
router.get("/templates", authMiddleware, getTemplates);
router.get("/templates/:id", authMiddleware, getTemplateById);
router.put("/templates/:id", authMiddleware, updateTemplate);
router.delete("/templates/:id", authMiddleware, deleteTemplate);

// Sender Email Routes
router.post("/sender-emails", authMiddleware, addSenderEmail);
router.get("/sender-emails", authMiddleware, getSenderEmails);
router.patch(
  "/toggle-sender-email-status/:id",
  authMiddleware,
  toggleSenderEmailStatus
);
router.patch("/sender-emails/:id", authMiddleware, markSenderEmailAsSpam); // Updated endpoint

// Email Campaign Routes
router.post("/campaigns", authMiddleware, createCampaign);
router.post(
  "/campaigns/process-excel",
  authMiddleware,
  upload.single("file"),
  processCampaignExcel
);
router.get("/campaigns/sample-excel", authMiddleware, downloadCampaignSampleExcel);
router.get("/campaigns", authMiddleware, getCampaigns);
router.get("/campaigns/:id", authMiddleware, getCampaignById);
router.put("/campaigns/:id", authMiddleware, updateCampaign);
router.delete("/campaigns/:id", authMiddleware, deleteCampaign);
router.patch("/campaigns/:id/cancel", authMiddleware, cancelScheduledCampaign);
router.post("/campaigns/:id/send", authMiddleware, sendCampaign);

// User Routes
router.get("/users", authMiddleware, getUsers);

// Unsubscribe Route (Public)
router.get("/unsubscribe", unsubscribe);

module.exports = router;
