const mongoose = require("mongoose");

const AppointmentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Business",
    required: true,
  },
  serviceId: { type: String },
  serviceName: { type: String, required: true },
  /** Calendar date of the appointment, stored as midnight UTC of that date. */
  appointmentDate: {
    type: Date,
    required: true,
  },
  /** Wall-clock time of the appointment in `timezone`, e.g. "11:00 AM". */
  timeSlot: {
    type: String,
    required: false,
  },
  /** IANA timezone the date and time slot are expressed in, e.g. "Asia/Kolkata". */
  timezone: {
    type: String,
    default: null,
  },
  /**
   * Exact start instant (appointmentDate + timeSlot in timezone). Booking
   * reminders are measured from this, so it is the one field to trust for "when".
   */
  startsAt: {
    type: Date,
    default: null,
  },
  /** When confirmation/reminder emails were planned for this appointment (null = not yet). */
  notificationsScheduledAt: {
    type: Date,
    default: null,
  },
  fee: {
    type: Number,
    required: false,
  },
  status: {
    type: String,
    enum: ["Scheduled", "Canceled", "Completed", "Rescheduled"],
    default: "Scheduled",
  },
  rescheduledFrom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Appointment",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Slot-conflict check on booking / reschedule.
AppointmentSchema.index({ businessId: 1, appointmentDate: 1, timeSlot: 1 });
// Upcoming appointments (reminder planning, "what is next").
AppointmentSchema.index({ status: 1, startsAt: 1 });
// Appointments that still need their notifications planned (worker backfill).
AppointmentSchema.index({ status: 1, notificationsScheduledAt: 1, appointmentDate: 1 });

module.exports = mongoose.model("Appointment", AppointmentSchema);
