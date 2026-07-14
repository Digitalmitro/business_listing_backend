// backend/routes/crmAuditRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  getAuditLogs,
  exportAuditLogs,
  getAuditLogsForLead,
} = require("../controllers/crmAuditController");

router.get("/", authMiddleware, getAuditLogs);
router.get("/export", authMiddleware, exportAuditLogs);
router.get("/:leadId", authMiddleware, getAuditLogsForLead);

module.exports = router;
