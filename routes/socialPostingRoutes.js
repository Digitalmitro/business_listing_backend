// backend/routes/socialPostingRoutes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  publishPost,
  getHistory,
  schedulePost,
  getScheduledPosts,
  cancelScheduledPost,
  uploadMedia,
} = require("../controllers/socialPostingController");

// In-memory upload (streamed to Cloudinary); 50 MB cap, images and videos only.
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /^(image|video)\//.test(file.mimetype || "");
    cb(ok ? null : new Error("Only image or video files are allowed"), ok);
  },
});

const handleMediaUpload = (req, res, next) =>
  mediaUpload.single("media")(req, res, (err) => {
    if (err) {
      const tooLarge = err.code === "LIMIT_FILE_SIZE";
      return res.status(400).json({ success: false, message: tooLarge ? "Media file exceeds the 50 MB limit" : err.message });
    }
    next();
  });

router.post("/publish", authMiddleware, publishPost);
router.post("/upload-media", authMiddleware, handleMediaUpload, uploadMedia);
router.get("/history", authMiddleware, getHistory);
router.post("/schedule", authMiddleware, schedulePost);
router.get("/scheduled", authMiddleware, getScheduledPosts);
router.delete("/scheduled/:id", authMiddleware, cancelScheduledPost);

module.exports = router;
