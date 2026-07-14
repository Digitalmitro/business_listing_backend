// backend/routes/crmConfigRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  getPipelineStages,
  updatePipelineStages,
  getEventTypes,
  getReplyKeywords,
  getSchedulerConfig,
} = require("../controllers/crmConfigController");

// Public/authenticated endpoints for fetching config values (frontend use)
router.get("/stages", authMiddleware, getPipelineStages);
router.put("/stages", authMiddleware, updatePipelineStages);
router.get("/event-types", authMiddleware, getEventTypes);
router.get("/reply-keywords", authMiddleware, getReplyKeywords);
router.get("/scheduler", authMiddleware, getSchedulerConfig);

module.exports = router;
