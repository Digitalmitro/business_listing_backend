// backend/routes/socialPostingRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  publishPost,
  getHistory,
  schedulePost,
  getScheduledPosts,
  cancelScheduledPost,
} = require("../controllers/socialPostingController");

router.post("/publish", authMiddleware, publishPost);
router.get("/history", authMiddleware, getHistory);
router.post("/schedule", authMiddleware, schedulePost);
router.get("/scheduled", authMiddleware, getScheduledPosts);
router.delete("/scheduled/:id", authMiddleware, cancelScheduledPost);

module.exports = router;
