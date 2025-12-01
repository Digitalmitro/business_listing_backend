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

// ========================
// STATIC PAGES SEO
// ========================

// GET /api/seo/static          → List all static pages (Home, About, etc.)
router.get("/static", authMiddleware, getAllStaticPages);

// GET /api/seo/static/home     → Get SEO for "home"
router.get("/static/:pageKey", getStaticPageByKey);

// PUT /api/seo/static/home     → Update SEO for "home" (Admin only)
router.put("/static/:pageKey", authMiddleware, updateStaticPageSEO);

// ========================
// BUSINESS SEO
// ========================

// GET /api/seo/business        → Search businesses + pagination (for SEO Manager)
router.get("/business", authMiddleware, getBusinessesForSEO);

// GET /api/seo/business/123    → Get SEO of a single business (frontend + admin)
router.get("/business/:id", getBusinessSEO);

// PUT /api/seo/business/123    → Update business SEO (Admin only)
router.put("/business/:id", authMiddleware, updateBusinessSEO);

module.exports = router;