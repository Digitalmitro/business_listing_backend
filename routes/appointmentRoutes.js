const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAdmin } = require("../middlewares/requireAdmin");
const {
  CreateAppointment,
  GetAppointment,
  CancelAppointment,
  RescheduleAppointment,
  getAllAppointments,
  getAppointmentsByBusinessId,
  getAppointmentNotifications,
} = require("../controllers/appointmentController");

router.post("/appointment", authMiddleware, CreateAppointment);
router.get("/appointment", authMiddleware, GetAppointment);
router.get("/appointment/business/:businessId", authMiddleware, getAppointmentsByBusinessId);
router.get("/appointment/:appointmentId/notifications", authMiddleware, getAppointmentNotifications);
router.get("/all-appointments", authMiddleware, requireAdmin("bookings"), getAllAppointments);
router.put(
  "/appointment/:appointmentId",
  authMiddleware,
  RescheduleAppointment
);
router.patch("/appointment/:appointmentId", authMiddleware, CancelAppointment);

module.exports = router;
