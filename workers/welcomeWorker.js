const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const { sendMail } = require("../utils/nodemailer");
const User = require("../models/User");
const SenderEmail = require("../models/SenderEmail");

const welcomeWorker = new Worker(
  "welcome-email",
  async (job) => {
    const { userId } = job.data;
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error("User not found");
      }

      // Find an active sender email
      const sender = await SenderEmail.findOne({ isActive: true });
      if (!sender) {
        throw new Error("No active sender email found");
      }

      const subject = "Welcome to UrbanCitations!";
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
          <h2 style="color: #1976D2;">Welcome to UrbanCitations, ${user.full_name}!</h2>
          <p>We are thrilled to have you on board. UrbanCitations is your one-stop solution for finding and listing local businesses.</p>
          <p>Explore our platform to find local services or list your own business to reach more customers.</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL}" style="background-color: #1976D2; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Explore Now</a>
          </div>
          <p>If you have any questions, feel free to contact our support team.</p>
          <br>
          <p>Best Regards,<br>The UrbanCitations Team</p>
        </div>
      `;

      const unsubscribeLink = `${process.env.FRONTEND_URL}/unsubscribe?userId=${user._id}`;
      
      const result = await sendMail(
        sender.email,
        user.email,
        subject,
        html,
        unsubscribeLink
      );

      if (!result.success) {
        throw new Error(`Failed to send welcome email: ${result.error.message}`);
      }

      console.log(`Welcome email sent to ${user.email}`);
    } catch (error) {
      console.error(`Error in welcomeWorker for job ${job.id}:`, error);
      throw error;
    }
  },
  { connection: redisConnection }
);

module.exports = welcomeWorker;
