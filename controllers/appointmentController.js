const moment = require("moment");
const Appointment = require("../models/Appointment");
const Business = require("../models/Business");
const sendMail = require("../services/sendMail");

exports.CreateAppointment = async (req, res) => {
  try {
    const { businessId, appointmentDate, timeSlot, serviceId, serviceName } =
      req.body;
    const userId = req.user.id;

    // Validation
    if (!businessId || !appointmentDate || !timeSlot) {
      return res
        .status(400)
        .json({ message: "Business ID, date, and time slot are required." });
    }

    const normalizedDate = moment(appointmentDate).startOf("day").toISOString();

    // Check if slot already booked
    const existingAppointment = await Appointment.findOne({
      businessId,
      appointmentDate: normalizedDate,
      timeSlot,
      status: { $ne: "Canceled" },
    });

    if (existingAppointment) {
      return res
        .status(400)
        .json({ message: "This time slot is already booked." });
    }

    // Create new appointment
    const appointment = new Appointment({
      userId,
      businessId,
      serviceId: serviceId || null,
      serviceName: serviceName || "Service",
      appointmentDate: normalizedDate,
      timeSlot,
      status: "Scheduled",
    });

    await appointment.save();

    // Fetch business details
    const business = await Business.findById(businessId).select(
      "businessName contact subscriptionActive"
    );
    if (!business) {
      return res.status(404).json({ message: "Business not found." });
    }

    const formattedDate = moment(normalizedDate).format("dddd, MMMM Do YYYY");
    const appointmentDetails = `
      New Appointment Booked!
      
      Business: ${business.businessName}
      Service: ${serviceName || "Not specified"}
      Date: ${formattedDate}
      Time: ${timeSlot}
      Customer ID: ${userId}
      Appointment ID: ${appointment._id}
    `;

    // Email Logic
    if (business.subscriptionActive) {
      // Premium Business - Full details to owner
      await sendMail(
        business.contact?.email?.[0],
        "New Appointment Booked!",
        `
        Dear ${business.contact?.customerName || "Owner"},
        
        Great news! A customer has booked an appointment:
        
        ${appointmentDetails}
        
        Login to your dashboard to manage bookings.
        
        Regards,
        Team DigitalMitro
        `
      );

      // Admin notification
      await sendMail(
        "soumen.digitalmitro@gmail.com",
        `[NEW BOOKING] ${business.businessName}`,
        `New appointment created:\n\n${appointmentDetails}\n\nBusiness has active subscription.`
      );
    } else {
      // Free Business - Hide customer details
      await sendMail(
        business.contact?.email?.[0],
        "Customer Wants to Book – Upgrade Required!",
        `
        Dear ${business.contact?.customerName || "Owner"},
        
        A customer tried to book an appointment but your subscription is inactive.
        
        To receive bookings and grow your business, please upgrade your plan now!
        
        Click here to upgrade: https://yourapp.com/pricing
        
        Regards,
        Team DigitalMitro
        `
      );

      await sendMail(
        "soumen.digitalmitro@gmail.com",
        `[BLOCKED] Booking Attempt - Inactive Subscription`,
        `
        A customer tried to book but business has no active subscription.
        
        Business: ${business.businessName}
        Date: ${formattedDate}
        Time: ${timeSlot}
        Service: ${serviceName || "N/A"}
        Action Required: Follow up with business owner.
        `
      );
    }

    return res.status(201).json({
      success: true,
      message: "Appointment booked successfully!",
      appointment,
    });
  } catch (error) {
    console.error("Create Appointment Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error. Please try again." });
  }
};

exports.GetAppointment = async (req, res) => {
  try {
    const userId = req.user.id;
    const appointments = await Appointment.find({ userId })
      .populate("businessId", "businessName businessLogo address")
      .sort({ appointmentDate: -1, createdAt: -1 })
      .lean();

    return res.status(200).json(appointments);
  } catch (error) {
    console.error("Get Appointments Error:", error);
    return res.status(500).json({ message: "Failed to fetch appointments" });
  }
};

exports.CancelAppointment = async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const userId = req.user.id;

    const appointment = await Appointment.findOneAndUpdate(
      { _id: appointmentId, userId },
      { status: "Canceled", updatedAt: Date.now() },
      { new: true }
    ).populate("businessId", "businessName contact");

    if (!appointment) {
      return res
        .status(404)
        .json({ message: "Appointment not found or already canceled" });
    }

    // Notify business owner
    const business = appointment.businessId;
    if (business?.contact?.email?.[0]) {
      await sendMail(
        business.contact.email[0],
        "Appointment Canceled",
        `
        Dear ${business.contact?.customerName || "Owner"},
        
        A customer has canceled their appointment:
        
        Service: ${appointment.serviceName}
        Was scheduled for: ${moment(appointment.appointmentDate).format(
          "dddd, MMMM Do YYYY"
        )} at ${appointment.timeSlot}
        
        Regards,
        Team DigitalMitro
        `
      );
    }

    return res.status(200).json({
      success: true,
      message: "Appointment canceled successfully",
    });
  } catch (error) {
    console.error("Cancel Appointment Error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.RescheduleAppointment = async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const { appointmentDate, timeSlot } = req.body;
    const userId = req.user.id;

    if (!appointmentDate || !timeSlot) {
      return res
        .status(400)
        .json({ message: "New date and time are required" });
    }

    const oldAppointment = await Appointment.findOne({
      _id: appointmentId,
      userId,
    });
    if (!oldAppointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    if (oldAppointment.status === "Canceled") {
      return res
        .status(400)
        .json({ message: "Cannot reschedule a canceled appointment" });
    }

    const normalizedNewDate = moment(appointmentDate)
      .startOf("day")
      .toISOString();

    // Check if new slot is already taken
    const slotTaken = await Appointment.findOne({
      businessId: oldAppointment.businessId,
      appointmentDate: normalizedNewDate,
      timeSlot,
      status: { $ne: "Canceled" },
      _id: { $ne: oldAppointment._id },
    });

    if (slotTaken) {
      return res
        .status(400)
        .json({ message: "This new time slot is already booked" });
    }

    // Mark old as Rescheduled
    oldAppointment.status = "Rescheduled";
    oldAppointment.updatedAt = Date.now();
    await oldAppointment.save();

    // Create new appointment
    const newAppointment = new Appointment({
      ...oldAppointment.toObject(),
      _id: undefined,
      appointmentDate: normalizedNewDate,
      timeSlot,
      status: "Scheduled",
      rescheduledFrom: oldAppointment._id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await newAppointment.save();

    // Notify business
    const business = await Business.findById(oldAppointment.businessId);
    if (business?.contact?.email?.[0]) {
      await sendMail(
        business.contact.email[0],
        "Appointment Rescheduled",
        `
        Dear ${business.contact?.customerName || "Owner"},
        
        A customer has rescheduled their appointment:
        
        Service: ${newAppointment.serviceName}
        New Date & Time: ${moment(normalizedNewDate).format(
          "dddd, MMMM Do YYYY"
        )} at ${timeSlot}
        Old Slot: ${moment(oldAppointment.appointmentDate).format(
          "dddd, MMMM Do YYYY"
        )} at ${oldAppointment.timeSlot}
        
        Regards,
        Team DigitalMitro
        `
      );
    }

    return res.status(200).json({
      success: true,
      message: "Appointment rescheduled successfully!",
      newAppointment,
    });
  } catch (error) {
    console.error("Reschedule Error:", error);
    return res.status(500).json({ message: "Server error during reschedule" });
  }
};
