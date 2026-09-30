// backend/routes/crmEmailAutomationRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const { aiLimiter } = require("../middlewares/rateLimiter");
const {
  getCatalog,
  listAutomations,
  saveAutomation,
  setEnabled,
  preview,
  generateWithAi,
  getLogs,
  recordListingView,
} = require("../controllers/crmEmailAutomationController");

router.get("/catalog", authMiddleware, getCatalog);
router.get("/logs", authMiddleware, getLogs);
router.post("/preview", authMiddleware, preview);
router.post("/ai/generate", authMiddleware, aiLimiter, generateWithAi);
router.post("/events/view", authMiddleware, recordListingView);
router.get("/", authMiddleware, listAutomations);
router.put("/:trigger", authMiddleware, saveAutomation);
router.patch("/:trigger/enabled", authMiddleware, setEnabled);

module.exports = router;
