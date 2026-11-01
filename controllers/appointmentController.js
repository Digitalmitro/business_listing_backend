const mongoose = require("mongoose");
const Appointment = require("../models/Appointment");
const Business = require("../models/Business");
const User = require("../models/User");
const { notifyAdmins, createNotification } = require("../helpers/notificationHelper");
const { createLeadFromAppointment, recordAppointmentCanceled } = require("../services/crmLeadIntakeService");
const { invalidateCrmSnapshots } = require("../services/crmScope");
const { onBookingCreated } = require("../services/crmEmailAutomationService");
const crmSignals = require("../services/crmSignalService");
const timeService = require("../services/appointmentTimeService");
const appointmentNotifications = require("../services/appointmentNotificationService");
const { hasPermission } = require("../middlewares/requireAdmin");

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const toMinutes = (hhmm) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 24 * 60 ? minutes : null;
};

/**
 * Whether the slot falls inside the business's opening hours for that weekday.
 * `dateString` and `timeSlot` are in the booking timezone (the business's timezone when it
 * has one). Businesses with no hours configured at all are not restricted (nothing to
 * check against); a day not listed, or listed without times, is closed.
 */
function isWithinBusinessHours(businessTiming, dateString, timeSlot) {
  const timing = businessTiming || {};
  if (timing.isOpen24Hours) return true;
  const days = Array.isArray(timing.daysOfWeek) ? timing.daysOfWeek : [];
  const schedule = timing.schedule instanceof Map ? Object.fromEntries(timing.schedule) : timing.schedule || {};
  if (days.length === 0 && Object.keys(schedule).length === 0) return true;

  const day = WEEKDAYS[new Date(`${dateString}T00:00:00Z`).getUTCDay()];
  if (days.length && !days.includes(day)) return false;
  const slot = timeService.parseTimeSlot(timeSlot);
  if (!slot) return false;
  const start = slot.hours * 60 + slot.minutes;
  return (schedule[day] || []).some(({ openAt, closeAt } = {}) => {
    const open = toMinutes(openAt);
    const close = toMinutes(closeAt);
    if (open === null || close === null) return false;
    if (close > open) return start >= open && start < close;
    if (close < open) return start >= open || start < close; // overnight, e.g. 18:00–02:00
    return true; // open == close: open all day
  });
}

/** Rejects past starts and slots outside opening hours; returns an error message or null. */
function bookingRuleError(business, schedule, timeSlot) {
  if (!schedule.startsAt || schedule.startsAt.getTime() <= Date.now()) {
    return "This time has already passed. Please choose a future date and time.";
  }
  if (!isWithinBusinessHours(business.businessTiming, schedule.dateString, timeSlot)) {
    return "The business is closed at the selected time. Please choose a time within its opening hours.";
  }
  return null;
}

// Only a booking that is still scheduled can be canceled or moved.
const ACTIVE_STATUSES = ["Scheduled"];

/**
 * Resolves what a booking request means in time: the timezone the date and slot
 * are in, the calendar date, the stored date (midnight UTC) and the exact start
 * instant. Returns { error } with a user-facing message when the input is invalid.
 */
async function resolveSchedule({ appointmentDate, timeSlot, requestedTimezone, business, customer }) {
  if (!timeService.parseTimeSlot(timeSlot)) {
    return { error: "Invalid time slot. Use a time like 11:00 AM." };
  }
  const owner = business.userId ? await User.findById(business.userId).select("timeZone").lean() : null;
  const timezone = await appointmentNotifications.resolveTimezone({
    requested: requestedTimezone,
    businessId: business._id,
    owner,
    customer,
  });
  const dateString = timeService.calendarDate(appointmentDate, timezone);
  if (!dateString) {
    return { error: "Invalid appointment date." };
  }
  return {
    timezone,
    dateString,
    normalizedDate: timeService.storedAppointmentDate(dateString),
    startsAt: timeService.startInstant(dateString, timeSlot, timezone),
  };
}

exports.CreateAppointment = async (req, res) => {
  try {
    const { businessId, appointmentDate, timeSlot, serviceId, serviceName, timezone: requestedTimezone } = req.body;
    const userId = req.user.id;

    // Validation
    if (!businessId || !appointmentDate || !timeSlot) {
      return res
        .status(400)
        .json({ message: "Business ID, date, and time slot are required." });
    }
    if (!mongoose.isValidObjectId(businessId)) {
      return res.status(404).json({ message: "Business not found." });
    }

    // Fetch business and customer details before anything is written
    const business = await Business.findById(businessId).select(
      "businessName contact userId businessTiming"
    );
    if (!business) {
      return res.status(404).json({ message: "Business not found." });
    }
    const user = await User.findById(userId).select("full_name email phone timeZone");

    const schedule = await resolveSchedule({ appointmentDate, timeSlot, requestedTimezone, business, customer: user });
    if (schedule.error) {
      return res.status(400).json({ message: schedule.error });
    }
    const { timezone, normalizedDate, startsAt } = schedule;

    const ruleError = bookingRuleError(business, schedule, timeSlot);
    if (ruleError) {
      return res.status(400).json({ message: ruleError });
    }

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
      timezone,
      startsAt,
      status: "Scheduled",
    });

    await appointment.save();

    // Move the customer's lead to Booked, or create it there (idempotent, never throws)
    await createLeadFromAppointment(appointment, user);
    await invalidateCrmSnapshots();
    // Business's "Booking created" email automation, if enabled (never throws)
    await onBookingCreated(appointment, user);
    // CRM contact: record the booking and hand marketing journeys over to booking emails (never throws)
    await crmSignals.onBookingCreated(appointment, user);

    const formattedDate = timeService.formatInTimezone(startsAt, timezone);

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

    // 4. Booking emails: confirmation to customer and owner now, reminders before
    //    the appointment starts (rows + queue; never throws).
    await appointmentNotifications.onAppointmentBooked(appointment);

    // Tell the customer honestly whether a confirmation email will come: only when the
    // business's plan includes booking emails and its own address is verified.
    let customerEmail = false;
    try {
      const { entitlements } = await require("../services/planEntitlements").getPlanEntitlements(appointment.businessId);
      customerEmail = Boolean(entitlements.bookingEmails && (await require("../services/businessSenderService").getVerifiedTransport(appointment.businessId)));
    } catch {
      customerEmail = false;
    }

    return res.status(201).json({
      success: true,
      message: "Appointment booked successfully!",
      appointment,
      customerEmail,
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
      .populate("userId", "full_name email phone country")
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
    if (!mongoose.isValidObjectId(appointmentId)) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    // Customers cancel their own bookings; admins (bookings permission) cancel any.
    const asAdmin = Boolean(req.isAdmin) && hasPermission(req.user, ["bookings"]);
    const scope = asAdmin ? { _id: appointmentId } : { _id: appointmentId, userId };

    const appointment = await Appointment.findOneAndUpdate(
      { ...scope, status: { $in: ACTIVE_STATUSES } },
      { status: "Canceled", updatedAt: Date.now() },
      { new: true }
    ).populate("businessId", "businessName contact userId");

    if (!appointment) {
      const existing = await Appointment.findOne(scope).select("status").lean();
      if (!existing) {
        return res.status(404).json({ message: "Appointment not found" });
      }
      return res.status(400).json({
        message: existing.status === "Rescheduled"
          ? "This booking was already rescheduled; cancel the new booking instead."
          : `This booking is already ${String(existing.status).toLowerCase()} and can't be canceled.`,
      });
    }

    // Log the cancellation on the customer's CRM lead and contact (never throw)
    await recordAppointmentCanceled(appointment);
    await crmSignals.onBookingCanceled(appointment);

    // Notify business owner
    const business = appointment.businessId;
    const canceledBy = asAdmin ? "an administrator" : "the customer";
    if (business?.userId) {
       await createNotification({
        recipientId: business.userId,
        recipientType: "User",
        title: "Appointment Canceled",
        description: `Booking for ${appointment.serviceName} was canceled by ${canceledBy}.`,
        link: `/business-bookings/${business._id}`,
        category: "booking",
      });
    }

    // 2. Notify the customer who made the booking
    await createNotification({
      recipientId: appointment.userId,
      recipientType: "User",
      title: "Booking Canceled",
      description: `Your booking for ${appointment.serviceName} at ${business?.businessName || "the business"} has been canceled${asAdmin ? " by an administrator" : ""}.`,
      link: `/bookinghistory`,
      category: "booking",
    });

    // 3. Stop pending reminders and send the cancellation emails (never throws)
    await appointmentNotifications.onAppointmentCanceled(appointment);

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
    const { appointmentDate, timeSlot, timezone: requestedTimezone } = req.body;
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

    if (!ACTIVE_STATUSES.includes(oldAppointment.status)) {
      return res.status(400).json({
        message: oldAppointment.status === "Rescheduled"
          ? "This booking was already rescheduled; change the new booking instead."
          : `Cannot reschedule a ${String(oldAppointment.status).toLowerCase()} appointment`,
      });
    }

    const business = oldAppointment.businessId;
    const user = await User.findById(userId).select("full_name email phone timeZone");

    const schedule = await resolveSchedule({
      appointmentDate,
      timeSlot,
      requestedTimezone: requestedTimezone || oldAppointment.timezone,
      business,
      customer: user,
    });
    if (schedule.error) {
      return res.status(400).json({ message: schedule.error });
    }
    const { timezone, normalizedDate: normalizedNewDate, startsAt } = schedule;

    const ruleError = bookingRuleError(business, schedule, timeSlot);
    if (ruleError) {
      return res.status(400).json({ message: ruleError });
    }

    // Check if new slot is already taken
    const slotTaken = await Appointment.findOne({
      businessId: business._id,
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

    // Mark old as Rescheduled (only if nobody changed it meanwhile)
    const marked = await Appointment.updateOne(
      { _id: oldAppointment._id, status: { $in: ACTIVE_STATUSES } },
      { $set: { status: "Rescheduled", updatedAt: Date.now() } }
    );
    if (!marked.modifiedCount) {
      return res.status(409).json({ message: "This booking was changed in the meantime. Please refresh and try again." });
    }
    oldAppointment.status = "Rescheduled";
    oldAppointment.updatedAt = Date.now();

    // Create new appointment
    const newAppointment = new Appointment({
      ...oldAppointment.toObject(),
      _id: undefined,
      businessId: business._id,
      appointmentDate: normalizedNewDate,
      timeSlot,
      timezone,
      startsAt,
      notificationsScheduledAt: null,
      status: "Scheduled",
      rescheduledFrom: oldAppointment._id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await newAppointment.save();

    // Record the new slot on the same CRM lead and contact (never throw)
    await createLeadFromAppointment(newAppointment, user);
    await crmSignals.onBookingCreated(newAppointment, user);

    const formattedDate = timeService.formatInTimezone(startsAt, timezone);

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

    // Stop the old appointment's reminders; confirm the new slot and plan its reminders (never throws)
    await appointmentNotifications.onAppointmentRescheduled(oldAppointment, newAppointment);

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
      .populate("userId", "full_name email phone country")
      .sort({ appointmentDate: -1, createdAt: -1 })
      .lean();

    return res.status(200).json(appointments);
  } catch (error) {
    console.error("Get Business Appointments Error:", error);
    return res.status(500).json({ message: "Failed to fetch business appointments" });
  }
};

/**
 * GET /api/appointment/:appointmentId/notifications
 * Delivery log of an appointment's emails (confirmation, reminders, notices).
 * Visible to the customer, the business owner and admins.
 */
exports.getAppointmentNotifications = async (req, res) => {
  try {
    const { appointmentId } = req.params;
    if (!mongoose.isValidObjectId(appointmentId)) {
      return res.status(404).json({ success: false, message: "Appointment not found" });
    }
    const appointment = await Appointment.findById(appointmentId)
      .select("userId businessId status serviceName appointmentDate timeSlot timezone startsAt notificationsScheduledAt")
      .lean();
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found" });
    }
    const business = await Business.findById(appointment.businessId).select("userId").lean();
    const me = String(req.user._id);
    const allowed =
      req.isAdmin || String(appointment.userId) === me || (business && String(business.userId) === me);
    if (!allowed) {
      return res.status(403).json({ success: false, message: "Not allowed to view this appointment" });
    }
    const rows = await appointmentNotifications.listForAppointment(appointmentId);
    return res.status(200).json({ success: true, appointment, notifications: rows });
  } catch (error) {
    console.error("Get Appointment Notifications Error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.isWithinBusinessHours = isWithinBusinessHours;
