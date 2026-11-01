// routes/topCountryRoutes.js
const express = require("express");
const router = express.Router();
const { dynamicUpload } = require("../config/multerConfig"); 
const {
  createTopcountry,
  getTopcountry,
  getCountryByName,
  updateTopCountry,
  deleteTopCountry,
} = require("../controllers/topCountryController");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAdmin } = require("../middlewares/requireAdmin");

// PUBLIC
router.get("/top-country", getTopcountry);
router.get("/top-country/name/:name", getCountryByName);

// ADMIN ONLY
router.post(
  "/top-country",
  authMiddleware,
  requireAdmin("top_countries"),
  dynamicUpload, // ← MULTIPLE IMAGES
  createTopcountry
);

router.put(
  "/top-country/:id",
  authMiddleware,
  requireAdmin("top_countries"),
  dynamicUpload, // ← MULTIPLE IMAGES
  updateTopCountry
);

router.delete("/top-country/:id", authMiddleware, requireAdmin("top_countries"), deleteTopCountry);

module.exports = router;