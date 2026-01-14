const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  CreateAppointment,
  GetAppointment,
  CancelAppointment,
  RescheduleAppointment,
  getAllAppointments,
  getAppointmentsByBusinessId,
} = require("../controllers/appointmentController");

router.post("/appointment", authMiddleware, CreateAppointment);
router.get("/appointment", authMiddleware, GetAppointment);
router.get("/appointment/business/:businessId", authMiddleware, getAppointmentsByBusinessId);
router.get("/all-appointments", authMiddleware, getAllAppointments);
router.put(
  "/appointment/:appointmentId",
  authMiddleware,
  RescheduleAppointment
);
router.patch("/appointment/:appointmentId", authMiddleware, CancelAppointment);

module.exports = router;
