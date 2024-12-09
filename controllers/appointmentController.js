const moment = require('moment');
const Appointment = require('../models/Appointment');

exports.CreateAppointment = async (req, res) => {
  try {
    const { businessId, appointmentDate, timeSlot } = req.body;
    const userId = req.user.id;
    const normalizedDate = moment(appointmentDate).startOf('day').toISOString();
    const existingAppointment = await Appointment.findOne({
      businessId,
      appointmentDate: normalizedDate,
      timeSlot,
      status: { $ne: "Canceled" },
    });

    if (existingAppointment) {
      return res.status(400).json({ message: "Time slot already booked." });
    }
    const appointment = new Appointment({
      userId,
      businessId,
      appointmentDate: normalizedDate,
      timeSlot,
    });

    await appointment.save();

    res.status(201).json({
      message: "Appointment booked successfully.",
      appointment,
    });
  } catch (error) {
    console.error("Error creating appointment:", error);
    res.status(500).json({ error: error.message });
  }
};

exports.GetAppointment = async (req, res) => {
  try {
    const userId = req.user.id;
    if (!userId) return res.status(400).json({ message: 'missing userid' })
    const appointments = await Appointment.find({ userId })
      .populate("businessId", "businessName address")
      .sort({ appointmentDate: -1 });
    return res.status(200).json(appointments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

exports.CancelAppointment = async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const result = await Appointment.updateOne(
      { _id: appointmentId },
      { $set: { status: "Canceled", updatedAt: Date.now() } }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Appointment not found" });
    }
    res.status(200).json({ message: "Appointment canceled successfully." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.RescheduleAppointment = async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const { appointmentDate, timeSlot } = req.body;
    const oldAppointment = await Appointment.findById(appointmentId);
    if (!oldAppointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }
    const existingAppointment = await Appointment.findOne({
      businessId: oldAppointment.businessId,
      appointmentDate: appointmentDate,
      timeSlot: timeSlot,
      status: { $ne: "Canceled" }
    });
    if (existingAppointment) {
      return res.status(400).json({ message: "Time slot already booked." });
    }

    const newAppointmentData = {
      ...oldAppointment._doc,
      appointmentDate: appointmentDate,
      timeSlot: timeSlot,
      status: "Scheduled",
      rescheduledFrom: oldAppointment._id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    delete newAppointmentData._id;
    const newAppointment = new Appointment(newAppointmentData);
    oldAppointment.status = "Rescheduled";
    oldAppointment.updatedAt = Date.now();
    await oldAppointment.save();
    await newAppointment.save();
    return res.status(200).json({ message: "Appointment rescheduled successfully.", newAppointment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

