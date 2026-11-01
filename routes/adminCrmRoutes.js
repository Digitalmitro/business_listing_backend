// backend/routes/adminCrmRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAdmin } = require("../middlewares/requireAdmin");
const { getAnalytics, getAuditLogs } = require("../controllers/adminCrmController");

// Protected by authMiddleware; authMiddleware verifies user/admin roles
router.get("/analytics", authMiddleware, requireAdmin("crm"), getAnalytics);
router.get("/audit", authMiddleware, requireAdmin("crm"), getAuditLogs);

module.exports = router;
