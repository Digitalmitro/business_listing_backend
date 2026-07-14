// backend/routes/unsubscribeRoutes.js
const express = require("express");
const router = express.Router();
const { unsubscribe, checkStatus } = require("../controllers/unsubscribeController");

// Both GET and POST supported for flexibility with email links and API clients
router.get("/", unsubscribe);
router.post("/", unsubscribe);
router.get("/check", checkStatus);

module.exports = router;
