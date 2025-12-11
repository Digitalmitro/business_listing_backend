
const express = require("express");
const router = express.Router();
const {
  getFooterLinks
} = require("../controllers/footerController");

router.get("/footer-links", getFooterLinks);

module.exports = router;
