// backend/routes/socialIntegrationRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  getAuthUrl,
  connectAccount,
  disconnectAccount,
  getAccounts,
  refreshAccountToken,
  verifyOrPost,
} = require("../controllers/socialIntegrationController");

router.get("/auth-url", authMiddleware, getAuthUrl);
router.post("/connect", authMiddleware, connectAccount);
router.post("/disconnect", authMiddleware, disconnectAccount);
router.get("/accounts", authMiddleware, getAccounts);
router.post("/refresh", authMiddleware, refreshAccountToken);
router.post("/verify-post", authMiddleware, verifyOrPost);

module.exports = router;
