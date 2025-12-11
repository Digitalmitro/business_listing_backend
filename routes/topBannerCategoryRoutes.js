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
const { upload } = require("../config/multerConfig"); 

// PUBLIC - Get all active top banner categories
router.get("/top-banner-category", getAllTopBannerCategories);

// ADMIN ONLY
router.post(
  "/top-banner-category",
  authMiddleware,
  upload.single("image"),
  createTopBannerCategory
);

router.put(
  "/top-banner-category/:id",
  authMiddleware,
  upload.single("image"), // Optional image update
  updateTopBannerCategory
);

router.delete(
  "/top-banner-category/:id",
  authMiddleware,
  deleteTopBannerCategory
);

module.exports = router;
