// backend/controllers/crmForecastController.js
"use strict";

const logger = require("../utils/logger");
const crmForecastService = require("../services/crmForecastService");

/**
 * GET /api/crm/forecast
 * Retrieve revenue forecasting metrics, pipeline breakdown, and trend charts.
 */
exports.getForecast = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }

    const data = await crmForecastService.getRevenueForecast(req.user._id, req.query);
    return res.status(200).json(data);
  } catch (error) {
    logger.error("Error retrieving CRM revenue forecast", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};
