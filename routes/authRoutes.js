// backend/routes/authRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware.js");
const { upload } = require("../config/multerConfig");
const {
  register,
  login,
  forgotPassword,
  googleLogin,
  getUserProfile,
  getAllUsers,
  updateUserProfile,
  sendOTP,
  deleteById,
  fetchUserLocation,
  fetchCoordinates,
  exportUsersToExcel,
} = require("../controllers/authController.js");

router.post("/register", register);
router.post("/login", login);
router.post("/google-login", googleLogin);
router.post("/forgot-password", forgotPassword);
router.post("/sendOtp", sendOTP);

router.get("/user-profile", authMiddleware, getUserProfile);
router.put(
  "/update-profile",
  authMiddleware,
  upload.fields([{ name: "image", maxCount: 1 }]),
  updateUserProfile
);

// Admin routes
router.get("/get-all-user", authMiddleware, getAllUsers);
router.delete("/:id", authMiddleware, deleteById);

router.get("/fetch-user-location", fetchUserLocation);
router.post("/fetch-coordinates", fetchCoordinates);

router.get("/export-users-excel", exportUsersToExcel);

module.exports = router;
