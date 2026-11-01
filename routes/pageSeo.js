// routes/seoRoutes.js
const express = require("express");
const router = express.Router();
const {
  getAllStaticPages,
  getStaticPageByKey,
  updateStaticPageSEO,
  getBusinessesForSEO,
  updateBusinessSEO,
  getBusinessSEO,
} = require("../controllers/seoController");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { upload } = require("../config/multerConfig");
const { requireAdmin } = require("../middlewares/requireAdmin");

// ========================
// STATIC PAGES SEO
// ========================

// GET /api/seo/static          → List all static pages (Home, About, etc.)
router.get("/static", authMiddleware, requireAdmin("seo"), getAllStaticPages);

// GET /api/seo/static/home     → Get SEO for "home"
router.get("/static/:pageKey", getStaticPageByKey);

// PUT /api/seo/static/home     → Update SEO for "home" (Admin only)
router.put(
  "/static/:pageKey",
  authMiddleware,
  requireAdmin("seo"),
  upload.fields([{ name: "bannerImage", maxCount: 1 }]),
  updateStaticPageSEO
);

// ========================
// BUSINESS SEO
// ========================

// GET /api/seo/business        → Search businesses + pagination (for SEO Manager)
router.get("/business", authMiddleware, requireAdmin("seo"), getBusinessesForSEO);

// GET /api/seo/business/123    → Get SEO of a single business (frontend + admin)
router.get("/business/:id", getBusinessSEO);

// PUT /api/seo/business/123    → Update business SEO (Admin only)
// The SEO Manager sends multipart/form-data (field "seo" = JSON); parse it, text only.
router.put("/business/:id", authMiddleware, requireAdmin("seo"), upload.fields([]), updateBusinessSEO);

module.exports = router;