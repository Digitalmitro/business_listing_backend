// backend/routes/adminCrmRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const { getAnalytics, getAuditLogs } = require("../controllers/adminCrmController");

// Protected by authMiddleware; authMiddleware verifies user/admin roles
router.get("/analytics", authMiddleware, getAnalytics);
router.get("/audit", authMiddleware, getAuditLogs);

module.exports = router;
