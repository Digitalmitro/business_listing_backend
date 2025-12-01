// backend/routes/authRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware.js");
// const { upload } = require('../config/multerConfig');
const upload = require("../middlewares/uploadMiddleware");
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
  getUserPlan,
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
//use for admin
router.get("/get-all-user", getAllUsers);
router.delete("/:id", deleteById);
router.get('/fetch-user-location', fetchUserLocation)
router.post('/fetch-coordinates', fetchCoordinates)

router.get("/my-plan", authMiddleware, getUserPlan);

module.exports = router;
