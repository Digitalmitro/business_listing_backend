// backend/routes/unsubscribeRoutes.js
const express = require("express");
const router = express.Router();
const { unsubscribe, checkStatus } = require("../controllers/unsubscribeController");

// Both GET and POST supported for flexibility with email links and API clients
router.get("/", unsubscribe);
router.post("/", unsubscribe);
// Reveals whether an address opted out: admins (email marketing) only.
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAdmin } = require("../middlewares/requireAdmin");
router.get("/check", authMiddleware, requireAdmin("email_marketing"), checkStatus);

module.exports = router;
