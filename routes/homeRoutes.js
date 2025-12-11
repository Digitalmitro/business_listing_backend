// routes/homeRoutes.js
const express = require("express");
const router = express.Router();
const {
  getPopularSearches,
  getFeaturedListings,
} = require("../controllers/homeController");

// ===========================================
// PUBLIC ROUTES — HOMEPAGE DATA
// ===========================================

// 1. Popular Searches (Top Banner Categories)
router.get("/popular-searches", getPopularSearches);

// 2. Featured Listings (Premium + High Rating Businesses)
router.get("/featured-listings", getFeaturedListings);

module.exports = router;
