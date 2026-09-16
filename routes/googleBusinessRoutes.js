// backend/routes/googleBusinessRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  handleCallback,
  getAuthUrl,
  connectAccount,
  disconnectAccount,
  getConnectionStatus,
  getProfiles,
  selectProfile,
  getSelectedProfile,
  populateProfile,
  importLocation,
} = require("../controllers/googleBusinessController");

const requireCustomerUser = (req, res, next) => {
  if (req.isAdmin || ["admin", "super-admin"].includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: "Google Business Profile connections are available to business-owner accounts only." });
  }
  return next();
};

// Public — no authMiddleware: Google redirects here after OAuth consent (no JWT available)
router.get("/callback", handleCallback);

// Protected — require user JWT
router.get("/auth-url", authMiddleware, requireCustomerUser, getAuthUrl);
router.get("/status", authMiddleware, requireCustomerUser, getConnectionStatus);
router.post("/connect", authMiddleware, requireCustomerUser, connectAccount);
router.post("/disconnect", authMiddleware, requireCustomerUser, disconnectAccount);
router.get("/profiles", authMiddleware, requireCustomerUser, getProfiles);
router.post("/select-profile", authMiddleware, requireCustomerUser, selectProfile);
router.get("/selected-profile", authMiddleware, requireCustomerUser, getSelectedProfile);
router.post("/populate-profile", authMiddleware, requireCustomerUser, populateProfile);
router.post("/import-location", authMiddleware, requireCustomerUser, importLocation);

module.exports = router;
