// backend/routes/googleBusinessRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  handleCallback,
  getAuthUrl,
  connectAccount,
  disconnectAccount,
  getProfiles,
  selectProfile,
  getSelectedProfile,
  populateProfile,
} = require("../controllers/googleBusinessController");

// Public — no authMiddleware: Google redirects here after OAuth consent (no JWT available)
router.get("/callback", handleCallback);

// Protected — require user JWT
router.get("/auth-url", authMiddleware, getAuthUrl);
router.post("/connect", authMiddleware, connectAccount);
router.post("/disconnect", authMiddleware, disconnectAccount);
router.get("/profiles", authMiddleware, getProfiles);
router.post("/select-profile", authMiddleware, selectProfile);
router.get("/selected-profile", authMiddleware, getSelectedProfile);
router.post("/populate-profile", authMiddleware, populateProfile);

module.exports = router;
