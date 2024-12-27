const moment = require('moment');
const Appointment = require('../models/Appointment');
const Business = require('../models/Business');
const sendMail = require('../services/sendMail');

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

    const business = await Business.findById(businessId);
    if (!business) {
      return res.status(404).json({ message: "Business not found." });
    }
   
   const appointmentDetails = `
    Appointment Details:
    - Business: ${business.businessName}
    - Business ID: ${businessId}
    - Date: ${moment(normalizedDate).format("YYYY-MM-DD")}
    - Time: ${timeSlot}
    - User ID: ${userId}
  `;
  
  if (business.subscriptionActive) {
    // Seller has a subscription - Send booking details to both seller and admin
    await sendMail(business?.contact?.email[0], "New Appointment Booked", `
      Dear ${business?.contact?.customerName},
      
      A new appointment has been booked for your business:
      
      ${appointmentDetails}
  
      Regards,
      Your Team
    `);
  
    await sendMail('soumen.digitalmitro@gmail.com', "New Appointment Booked", `
      Admin Notification:
      
      A new appointment has been booked for the following business:
      
      ${appointmentDetails}
  
      Regards,
      Your Team
    `);
  } else {
    // Seller does not have a subscription - Notify seller without appointment details
    await sendMail(business?.contact?.email[0], "Action Required: Subscription Inactive", `
      Dear ${business?.contact?.customerName},
      
      A customer has tried to book an appointment, but your subscription is inactive. Please subscribe to receive future bookings.
  
      Regards,
      Your Team
    `);
  
    // Notify admin with appointment details and subscription status
    await sendMail('soumen.digitalmitro@gmail.com', "Appointment Created Without Active Subscription", `
      Admin Notification:
      
      An appointment was created for the following business with an inactive subscription:
      
      ${appointmentDetails}
  
      Subscription Status: Inactive
  
      Regards,
      Your Team
    `);
  }
  
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

