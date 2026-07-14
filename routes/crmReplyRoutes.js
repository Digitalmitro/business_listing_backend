// backend/routes/crmReplyRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const { handleInboundWebhook, handleManualReply, getLogs } = require("../controllers/crmReplyController");

// Public/inbound webhook for external mail servers / APIs
router.post("/reply-webhook", handleInboundWebhook);

// Authenticated endpoints for sales reps / dashboard
router.get("/logs", authMiddleware, getLogs);
router.post("/:id/reply", authMiddleware, handleManualReply);

module.exports = router;
