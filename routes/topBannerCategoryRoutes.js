// routes/topBannerRoutes.js
const express = require("express");
const router = express.Router();
const {
  createTopBannerCategory,
  getAllTopBannerCategories,
  updateTopBannerCategory,
  deleteTopBannerCategory,
} = require("../controllers/topBannerCategoryController");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAdmin } = require("../middlewares/requireAdmin");
const { upload } = require("../config/multerConfig"); 

// PUBLIC - Get all active top banner categories
router.get("/top-banner-category", getAllTopBannerCategories);

// ADMIN ONLY
router.post(
  "/top-banner-category",
  authMiddleware,
  requireAdmin("cms"),
  upload.single("image"),
  createTopBannerCategory
);

router.put(
  "/top-banner-category/:id",
  authMiddleware,
  requireAdmin("cms"),
  upload.single("image"), // Optional image update
  updateTopBannerCategory
);

router.delete(
  "/top-banner-category/:id",
  authMiddleware,
  requireAdmin("cms"),
  deleteTopBannerCategory
);

module.exports = router;
