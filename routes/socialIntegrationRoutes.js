// backend/routes/socialIntegrationRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const credentialController = require("../controllers/socialCredentialController");
const {
  getAuthUrl,
  connectAccount,
  disconnectAccount,
  getAccounts,
  refreshAccountToken,
  verifyOrPost,
  handleCallback,
} = require("../controllers/socialIntegrationController");

router.get("/auth-url", authMiddleware, getAuthUrl);
router.get("/config", authMiddleware, credentialController.list);
router.put("/config/:platform", authMiddleware, credentialController.save);
router.delete("/config/:platform", authMiddleware, credentialController.remove);
router.get("/callback/:platform", handleCallback);
router.post("/connect", authMiddleware, connectAccount);
router.post("/disconnect", authMiddleware, disconnectAccount);
router.get("/accounts", authMiddleware, getAccounts);
router.post("/refresh", authMiddleware, refreshAccountToken);
router.post("/verify-post", authMiddleware, verifyOrPost);

module.exports = router;
