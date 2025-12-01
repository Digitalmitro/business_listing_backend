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

// PUBLIC
router.get("/top-country", getTopcountry);
router.get("/top-country/name/:name", getCountryByName);

// ADMIN ONLY
router.post(
  "/top-country",
  authMiddleware,
  dynamicUpload, // ← MULTIPLE IMAGES
  createTopcountry
);

router.put(
  "/top-country/:id",
  authMiddleware,
  dynamicUpload, // ← MULTIPLE IMAGES
  updateTopCountry
);

router.delete("/top-country/:id", authMiddleware, deleteTopCountry);

module.exports = router;