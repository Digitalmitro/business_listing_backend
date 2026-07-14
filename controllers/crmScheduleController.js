// backend/controllers/crmScheduleController.js
"use strict";

const logger = require("../utils/logger");
const crmScheduleService = require("../services/crmScheduleService");

/**
 * GET /api/crm/calendar/events
 * Retrieve calendar scheduling events within a date range and filters.
 */
exports.getEvents = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }
    const data = await crmScheduleService.getEvents(req.user._id, req.query);
    return res.status(200).json(data);
  } catch (error) {
    logger.error("Error retrieving CRM calendar events", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/crm/calendar/events
 * Create a new calendar scheduling event.
 */
exports.createEvent = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }
    const created = await crmScheduleService.createEvent(req.user._id, req.body);
    return res.status(201).json({ success: true, event: created });
  } catch (error) {
    logger.error("Error creating CRM calendar event", { error: error.message });
    return res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/crm/calendar/events/:id
 * Update an existing calendar event.
 */
exports.updateEvent = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }
    const updated = await crmScheduleService.updateEvent(req.user._id, req.params.id, req.body);
    return res.status(200).json({ success: true, event: updated });
  } catch (error) {
    const status = error.statusCode || 400;
    logger.error("Error updating CRM calendar event", { error: error.message });
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /api/crm/calendar/events/:id
 * Delete an existing calendar event.
 */
exports.deleteEvent = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "User not authenticated" });
    }
    const result = await crmScheduleService.deleteEvent(req.user._id, req.params.id);
    return res.status(200).json(result);
  } catch (error) {
    const status = error.statusCode || 400;
    logger.error("Error deleting CRM calendar event", { error: error.message });
    return res.status(status).json({ success: false, message: error.message });
  }
};
