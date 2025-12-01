// routes/pricing.js
const express = require("express");
const router = express.Router();
const {
  getAllPackages,
  getPackageById,
  createPackage,
  updatePackage,
  deletePackage,
  togglePackageActive,
} = require("../controllers/pricingController");
const { authMiddleware } = require("../middlewares/authMiddleware"); // Assuming you have auth

// PUBLIC
router.get("/", getAllPackages);
router.get("/:id", getPackageById);

// ADMIN ONLY
router.post("/", authMiddleware, createPackage);
router.put("/:id", authMiddleware, updatePackage);
router.delete("/:id", authMiddleware, deletePackage);
router.patch("/:id/toggle", authMiddleware, togglePackageActive);

module.exports = router;
