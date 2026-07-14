// backend/routes/crmForecastRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const { getForecast } = require("../controllers/crmForecastController");

router.get("/", authMiddleware, getForecast);

module.exports = router;
