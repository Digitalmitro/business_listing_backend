// routes/bannerRoutes.js
const express = require("express");
const router = express.Router();
const {
  createBanner,
  getBanners,
  updateBanner,
  deleteBanner,
} = require("../controllers/bannerController");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { upload } = require("../config/multerConfig"); // ← TERA MULTER!

// PUBLIC
router.get("/banners", getBanners);

// ADMIN ONLY
router.post(
  "/banners",
  authMiddleware,
  upload.fields([
    { name: "image", maxCount: 1 }, // Main banner
    { name: "bgImage", maxCount: 1 }, // Optional background
  ]),
  createBanner
);

router.put(
  "/banners/:id",
  authMiddleware,
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "bgImage", maxCount: 1 },
  ]),
  updateBanner
);

router.delete("/banners/:id", authMiddleware, deleteBanner);

module.exports = router;
