const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const { sendMail } = require("../utils/nodemailer");
const User = require("../models/User");
const Business = require("../models/Business");
const SenderEmail = require("../models/SenderEmail");
const { getTemplate } = require("../helpers/emailHelper");

const purchaseWorker = new Worker(
  "purchase-email",
  async (job) => {
    const { businessId, packageDetails } = job.data;
    try {
      const business = await Business.findById(businessId).populate("userId");
      if (!business) {
        throw new Error("Business not found");
      }

      const user = business.userId;
      if (!user) {
        throw new Error("User associated with business not found");
      }

      // Find an active sender email
      const sender = await SenderEmail.findOne({ isActive: true });
      if (!sender) {
        throw new Error("No active sender email found");
      }

      const { subject, html } = await getTemplate(
        "purchase",
        {
          "{{full_name}}": user.full_name,
          "{{business_name}}": business.businessName,
          "{{package_name}}": packageDetails.packageName,
          "{{start_date}}": new Date().toLocaleDateString(),
        },
        {
          subject: "Package Purchase Confirmation - UrbanCitations",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
              <h2 style="color: #4CAF50;">Thank You for Your Purchase!</h2>
              <p>Hi {{full_name}},</p>
              <p>Your purchase for the business <strong>{{business_name}}</strong> was successful.</p>
              <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p style="margin: 5px 0;"><strong>Package:</strong> {{package_name}}</p>
                <p style="margin: 5px 0;"><strong>Status:</strong> Active</p>
                <p style="margin: 5px 0;"><strong>Start Date:</strong> {{start_date}}</p>
              </div>
              <p>Your business will now benefit from the premium features included in the {{package_name}} plan.</p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="{{frontend_url}}/dashboard" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Go to Dashboard</a>
              </div>
              <p>If you have any questions regarding your subscription, please reach out to us.</p>
              <br>
              <p>Best Regards,<br>The UrbanCitations Team</p>
            </div>
          `,
        }
      );

      const unsubscribeLink = `${process.env.FRONTEND_URL}/unsubscribe?userId=${user._id}`;
      
      const result = await sendMail(
        sender.email,
        user.email,
        subject,
        html,
        unsubscribeLink
      );

      if (!result.success) {
        throw new Error(`Failed to send purchase email: ${result.error.message}`);
      }

      console.log(`Purchase confirmation email sent to ${user.email} for business ${business.businessName}`);
    } catch (error) {
      console.error(`Error in purchaseWorker for job ${job.id}:`, error);
      throw error;
    }
  },
  { connection: redisConnection }
);

module.exports = purchaseWorker;
