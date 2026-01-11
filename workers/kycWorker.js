const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const { sendMail } = require("../utils/nodemailer");
const User = require("../models/User");
const Business = require("../models/Business");
const SenderEmail = require("../models/SenderEmail");
const { getTemplate } = require("../helpers/emailHelper");

const kycWorker = new Worker(
  "kyc-email",
  async (job) => {
    const { businessId, status, rejectionReason } = job.data;
    try {
      const business = await Business.findById(businessId).populate("userId");
      if (!business) {
        throw new Error("Business not found");
      }

      const user = business.userId;
      if (!user) {
        throw new Error("User not found for business KYC");
      }

      const sender = await SenderEmail.findOne({ isActive: true });
      if (!sender) {
        throw new Error("No active sender email found");
      }

      const isVerified = status === "verified";
      const triggerType = isVerified ? "kyc_approved" : "kyc_rejected";

      const { subject, html } = await getTemplate(
        triggerType,
        {
          "{{full_name}}": user.full_name,
          "{{business_name}}": business.businessName,
          "{{business_id}}": business._id,
          "{{status}}": status,
          "{{rejection_reason}}": rejectionReason || "Documents provided were insufficient or unclear.",
        },
        {
          subject: `KYC Verification ${isVerified ? "Approved" : "Rejected"} - UrbanCitations`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
              <h2 style="color: ${isVerified ? "#4CAF50" : "#F44336"};">KYC Verification ${isVerified ? "Approved" : "Rejected"}</h2>
              <p>Hi {{full_name}},</p>
              <p>The KYC verification for your business <strong>{{business_name}}</strong> has been <strong>{{status}}</strong>.</p>
              
              ${isVerified 
                ? `<p>Your business is now fully verified on our platform, which builds more trust with your customers.</p>
                   <div style="text-align: center; margin: 30px 0;">
                     <a href="{{frontend_url}}/serviceprofile/{{business_id}}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">View Profile</a>
                   </div>`
                : `<div style="background-color: #FFF3E0; padding: 15px; border-radius: 5px; border-left: 5px solid #FF9800; margin: 20px 0;">
                     <p style="margin: 0;"><strong>Reason for Rejection:</strong> {{rejection_reason}}</p>
                   </div>
                   <p>Please log in to your dashboard and re-submit the required documents to complete your verification.</p>
                   <div style="text-align: center; margin: 30px 0;">
                     <a href="{{frontend_url}}/dashboard" style="background-color: #2196F3; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Update KYC</a>
                   </div>`
              }
              
              <p>If you have any questions, feel free to contact us.</p>
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
        throw new Error(`Failed to send KYC email: ${result.error.message}`);
      }

      console.log(`KYC ${status} email sent to ${user.email} for business ${business.businessName}`);
    } catch (error) {
      console.error(`Error in kycWorker for job ${job.id}:`, error);
      throw error;
    }
  },
  { connection: redisConnection }
);

module.exports = kycWorker;
