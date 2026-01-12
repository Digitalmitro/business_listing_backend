const express = require("express");
const router = express.Router();
const { upload } = require("../config/multerConfig");
const {
  getAllPackages,
  getPackageById,
  createPackage,
  updatePackage,
  deletePackage,
  togglePackageActive,
  uploadFeatureIcon,
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
router.post("/upload-feature-icon", authMiddleware, upload.single("icon"), uploadFeatureIcon);

module.exports = router;
