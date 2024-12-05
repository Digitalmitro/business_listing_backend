const Appointment = require('../models/Appointment');

 const moment = require('moment'); 

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

exports.GetAppointment = async (req,res) =>{
    try {
        const { userId } = req.params;
        const appointments = await Appointment.find({ userId })
          .populate("businessId")
          .sort({ appointmentDate: -1 });
        return res.status(200).json(appointments);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
}

exports.CancelAppointment = async (req,res) =>{
    try {
        const { appointmentId } = req.params;
    
        const appointment = await Appointment.findByIdAndUpdate(
          appointmentId,
          { status: "Canceled", updatedAt: Date.now() },
          { new: true }
        );
    
        if (!appointment) {
          return res.status(404).json({ message: "Appointment not found" });
        }
    
        res.status(200).json({ message: "Appointment canceled successfully.", appointment });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
}

exports.RescheduleAppointment = async (req,res) =>{
    try {
        const { appointmentId } = req.params;
        const { newDate, newTimeSlot } = req.body;
    
        const oldAppointment = await Appointment.findById(appointmentId);
    
        if (!oldAppointment) {
          return res.status(404).json({ message: "Appointment not found" });
        }
        const existingAppointment = await Appointment.findOne({
          businessId: oldAppointment.businessId,
          appointmentDate: newDate,
          timeSlot: newTimeSlot,
          status: { $ne: "Canceled" }
        });
    
        if (existingAppointment) {
          return res.status(400).json({ message: "Time slot already booked." });
        }

        const newAppointment = new Appointment({
          ...oldAppointment._doc,
          appointmentDate: newDate,
          timeSlot: newTimeSlot,
          status: "Rescheduled",
          rescheduledFrom: oldAppointment._id,
          createdAt: Date.now()
        });
    
        oldAppointment.status = "Rescheduled";
        await oldAppointment.save();
        await newAppointment.save();
    
        res.status(200).json({ message: "Appointment rescheduled successfully.", newAppointment });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
}
