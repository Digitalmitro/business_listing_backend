const moment = require("moment");
const Appointment = require("../models/Appointment");
const Business = require("../models/Business");
const User = require("../models/User");
const { notifyAdmins, createNotification } = require("../helpers/notificationHelper");
const { addJob } = require("../utils/queue");

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
      "businessName contact subscriptionActive userId"
    );
    if (!business) {
      return res.status(404).json({ message: "Business not found." });
    }

    // Fetch user details
    const user = await User.findById(userId).select("full_name email");

    const formattedDate = moment(normalizedDate).format("dddd, MMMM Do YYYY");
    const replacements = {
      "{{customer_name}}": user?.full_name || "Customer",
      "{{business_name}}": business.businessName,
      "{{service_name}}": serviceName || "Requested Service",
      "{{appointment_date}}": formattedDate,
      "{{appointment_time}}": timeSlot,
      "{{appointment_id}}": appointment._id.toString(),
    };

    // 1. Notify Admins
    await notifyAdmins({
      title: "New Booking Received",
      description: `${user?.full_name || "A user"} has booked ${serviceName || "a service"} at ${business.businessName}.`,
      link: "/bookings",
      category: "booking",
    });

    // 2. Notify Business Owner
    if (business.userId) {
      await createNotification({
        recipientId: business.userId,
        recipientType: "User",
        title: "New Appointment Booked",
        description: `New booking for ${serviceName || "your service"} on ${formattedDate} at ${timeSlot}.`,
        link: `/business-bookings/${businessId}`,
        category: "booking",
      });
    }

    // 3. Notify User
    await createNotification({
      recipientId: userId,
      recipientType: "User",
      title: "Booking Confirmed",
      description: `Your booking at ${business.businessName} for ${serviceName || "service"} is confirmed.`,
      link: `/bookinghistory`,
      category: "booking",
    });

    // Queue Email Job
    if (business.subscriptionActive) {
      await addJob("booking-email", {
        triggerType: "booking_confirmed",
        userId,
        businessId,
        replacements,
      });
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

exports.getAllAppointments = async (req, res) => {
  try {
    const appointments = await Appointment.find({})
      .populate("businessId", "businessName contact")
      .populate("userId", "full_name email phone")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: appointments.length,
      appointments,
    });
  } catch (error) {
    console.error("Get All Appointments Error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
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
    ).populate("businessId", "businessName contact userId");

    if (!appointment) {
      return res
        .status(404)
        .json({ message: "Appointment not found or already canceled" });
    }

    // Notify business owner
    const business = appointment.businessId;
    if (business?.userId) {
       await createNotification({
        recipientId: business.userId,
        recipientType: "User",
        title: "Appointment Canceled",
        description: `Booking for ${appointment.serviceName} was canceled by the customer.`,
        link: `/business-bookings/${business._id}`,
        category: "booking",
      });
    }

    // 2. Notify User
    await createNotification({
      recipientId: userId,
      recipientType: "User",
      title: "Booking Canceled",
      description: `Your booking for ${appointment.serviceName} at ${business.businessName} has been canceled.`,
      link: `/bookinghistory`,
      category: "booking",
    });

    // 3. Queue Cancel Email
    await addJob("booking-email", {
      triggerType: "booking_canceled",
      userId,
      businessId: business._id,
      replacements: {
        "{{customer_name}}": appointment.userId?.full_name || "Customer",
        "{{business_name}}": business.businessName,
        "{{service_name}}": appointment.serviceName,
        "{{appointment_date}}": moment(appointment.appointmentDate).format("dddd, MMMM Do YYYY"),
        "{{appointment_time}}": appointment.timeSlot,
      }
    });

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
    }).populate("businessId");
    
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
      businessId: oldAppointment.businessId._id,
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
    const business = oldAppointment.businessId;
    const user = await User.findById(userId);

    const formattedDate = moment(normalizedNewDate).format("dddd, MMMM Do YYYY");
    const oldFormattedDate = moment(oldAppointment.appointmentDate).format("dddd, MMMM Do YYYY");

    const replacements = {
      "{{customer_name}}": user?.full_name || "Customer",
      "{{business_name}}": business.businessName,
      "{{service_name}}": newAppointment.serviceName,
      "{{appointment_date}}": formattedDate,
      "{{appointment_time}}": timeSlot,
      "{{old_date}}": oldFormattedDate,
      "{{old_time}}": oldAppointment.timeSlot,
    };

    if (business.userId) {
      await createNotification({
        recipientId: business.userId,
        recipientType: "User",
        title: "Appointment Rescheduled",
        description: `Booking for ${newAppointment.serviceName} rescheduled to ${formattedDate} at ${timeSlot}.`,
        link: `/business-bookings/${business._id}`,
        category: "booking",
      });
    }

    // Notify User
    await createNotification({
      recipientId: userId,
      recipientType: "User",
      title: "Booking Rescheduled",
      description: `Your booking at ${business.businessName} has been rescheduled to ${formattedDate}.`,
      link: `/bookinghistory`,
      category: "booking",
    });

    // Queue Reschedule Email
    await addJob("booking-email", {
      triggerType: "booking_rescheduled",
      userId,
      businessId: business._id,
      replacements
    });

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

exports.getAppointmentsByBusinessId = async (req, res) => {
  try {
    const { businessId } = req.params;
    const userId = req.user.id;

    // Verify ownership
    const business = await Business.findOne({ _id: businessId, userId });
    if (!business) {
      return res.status(403).json({ message: "Unauthorized access to this business" });
    }

    const appointments = await Appointment.find({ businessId })
      .populate("userId", "full_name email phone")
      .sort({ appointmentDate: -1, createdAt: -1 })
      .lean();

    return res.status(200).json(appointments);
  } catch (error) {
    console.error("Get Business Appointments Error:", error);
    return res.status(500).json({ message: "Failed to fetch business appointments" });
  }
};
