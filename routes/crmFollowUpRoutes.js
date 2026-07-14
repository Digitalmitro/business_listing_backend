// backend/routes/crmFollowUpRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  getConfig,
  updateConfig,
  getLogs,
  processFollowUps,
  retryFailed,
  triggerForLead,
} = require("../controllers/crmFollowUpController");

router.get("/config", authMiddleware, getConfig);
router.put("/config", authMiddleware, updateConfig);
router.get("/logs", authMiddleware, getLogs);
router.post("/process", authMiddleware, processFollowUps);
router.post("/retry", authMiddleware, retryFailed);
router.post("/:id/trigger", authMiddleware, triggerForLead);

module.exports = router;
