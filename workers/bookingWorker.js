const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const { sendMail } = require("../utils/nodemailer");
const Business = require("../models/Business");
const User = require("../models/User");
const SenderEmail = require("../models/SenderEmail");
const { getTemplate } = require("../helpers/emailHelper");

const bookingWorker = new Worker(
  "booking-email",
  async (job) => {
    const { triggerType, userId, businessId, replacements } = job.data;
    try {
      const business = await Business.findById(businessId).populate("userId");
      const user = await User.findById(userId);
      
      if (!business) {
        throw new Error("Business not found");
      }
      if (!user) {
        throw new Error("User not found");
      }

      const sender = await SenderEmail.findOne({ isActive: true });
      if (!sender) {
        throw new Error("No active sender email found");
      }

      const owner = business.userId;
      const frontendUrl = process.env.FRONTEND_URL || "https://urbancitations.com";

      // 1. Send to Business Owner
      if (owner && owner.email) {
        const { subject, html } = await getTemplate(
          `${triggerType}_owner`,
          {
            ...replacements,
            "{{recipient_name}}": owner.full_name || owner.name || "Owner",
          },
          {
            subject: triggerType === 'booking_confirmed' ? "New Appointment Booked" : triggerType === 'booking_rescheduled' ? "Appointment Rescheduled" : "Appointment Canceled",
            html: `<h3>Notification</h3><p>Booking details for ${business.businessName}: ${replacements["{{service_name}}"]} on ${replacements["{{appointment_date}}"]} at ${replacements["{{appointment_time}}"]}.</p>`,
          }
        );

        const unsubscribeLink = `${frontendUrl}/unsubscribe?userId=${owner._id}`;
        await sendMail(sender.email, owner.email, subject, html, unsubscribeLink);
      }

      // 2. Send to User
      if (user.email) {
        const { subject, html } = await getTemplate(
          `${triggerType}_user`,
          {
            ...replacements,
            "{{recipient_name}}": user.full_name || user.name || "Customer",
          },
          {
            subject: triggerType === 'booking_confirmed' ? "Booking Confirmation" : triggerType === 'booking_rescheduled' ? "Booking Rescheduled" : "Booking Canceled",
            html: `<h3>Confirmation</h3><p>Your booking at ${business.businessName} for ${replacements["{{service_name}}"]} is confirmed for ${replacements["{{appointment_date}}"]} at ${replacements["{{appointment_time}}"]}.</p>`,
          }
        );

        const unsubscribeLink = `${frontendUrl}/unsubscribe?userId=${user._id}`;
        await sendMail(sender.email, user.email, subject, html, unsubscribeLink);
      }

      console.log(`Booking emails sent for trigger ${triggerType}`);
    } catch (error) {
      console.error(`Error in bookingWorker for job ${job.id}:`, error);
      throw error;
    }
  },
  { connection: redisConnection }
);

module.exports = bookingWorker;
