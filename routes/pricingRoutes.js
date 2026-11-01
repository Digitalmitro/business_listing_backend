const express = require("express");
const router = express.Router();
const { upload } = require("../config/multerConfig");
const {
  getAllPackages,
  getAllPackagesForAdmin,
  getPackageById,
  createPackage,
  updatePackage,
  deletePackage,
  togglePackageActive,
  uploadFeatureIcon,
} = require("../controllers/pricingController");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAdmin } = require("../middlewares/requireAdmin");

// Packages decide what every business pays and which emails it may send: admins with
// the "packages" permission (super-admins always).
const adminOnly = requireAdmin("packages");

// PUBLIC
router.get("/", getAllPackages);

// ADMIN ONLY (static paths before /:id)
router.get("/admin/all", authMiddleware, adminOnly, getAllPackagesForAdmin);
router.post("/upload-feature-icon", authMiddleware, adminOnly, upload.single("icon"), uploadFeatureIcon);
router.post("/", authMiddleware, adminOnly, createPackage);
router.put("/:id", authMiddleware, adminOnly, updatePackage);
router.delete("/:id", authMiddleware, adminOnly, deletePackage);
router.patch("/:id/toggle", authMiddleware, adminOnly, togglePackageActive);

// PUBLIC
router.get("/:id", getPackageById);

module.exports = router;
