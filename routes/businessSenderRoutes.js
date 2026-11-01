"use strict";

const express = require("express");
const { authMiddleware } = require("../middlewares/authMiddleware");
const controller = require("../controllers/businessSenderController");

const router = express.Router();

// Public: the confirmation link in the email (the token is the credential).
router.get("/verify", controller.verify);

// Owner (or admin) of the business.
router.get("/:businessId", authMiddleware, controller.getStatus);
router.post("/:businessId", authMiddleware, controller.connect);
router.post("/:businessId/test", authMiddleware, controller.sendTest);
router.delete("/:businessId", authMiddleware, controller.disconnect);

module.exports = router;
