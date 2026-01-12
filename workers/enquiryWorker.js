const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const { sendMail } = require("../utils/nodemailer");
const Business = require("../models/Business");
const User = require("../models/User");
const SenderEmail = require("../models/SenderEmail");
const { getTemplate } = require("../helpers/emailHelper");

const enquiryWorker = new Worker(
  "enquiry-email",
  async (job) => {
    const { enquiry, businessId } = job.data;
    try {
      const business = await Business.findById(businessId).populate("userId");
      if (!business) {
        throw new Error("Business not found");
      }

      const owner = business.userId;
      if (!owner || !owner.email) {
        throw new Error("Business owner not found or missing email");
      }

      const sender = await SenderEmail.findOne({ isActive: true });
      if (!sender) {
        throw new Error("No active sender email found");
      }

      const { subject, html } = await getTemplate(
        "enquiry_received",
        {
          "{{owner_name}}": owner.full_name,
          "{{business_name}}": business.businessName,
          "{{business_id}}": business._id,
          "{{customer_name}}": enquiry.name,
          "{{customer_phone}}": enquiry.phone,
          "{{customer_interest}}": enquiry.interest.join(", "),
          "{{customer_location}}": enquiry.location,
        },
        {
          subject: `New Lead for ${business.businessName} - UrbanCitations`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
              <h2 style="color: #4CAF50;">New Customer Enquiry!</h2>
              <p>Hi {{owner_name}},</p>
              <p>You have received a new lead for your business <strong>{{business_name}}</strong>.</p>
              
              <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p style="margin: 5px 0;"><strong>Name:</strong> {{customer_name}}</p>
                <p style="margin: 5px 0;"><strong>Phone:</strong> {{customer_phone}}</p>
                <p style="margin: 5px 0;"><strong>Interest:</strong> {{customer_interest}}</p>
                <p style="margin: 5px 0;"><strong>Location:</strong> {{customer_location}}</p>
              </div>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="{{frontend_url}}/dashboard" style="background-color: #2196F3; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">View Lead in Dashboard</a>
              </div>
              
              <p>Best Regards,<br>The UrbanCitations Team</p>
            </div>
          `,
        }
      );

      const unsubscribeLink = `${process.env.FRONTEND_URL}/unsubscribe?userId=${owner._id}`;
      
      const result = await sendMail(
        sender.email,
        owner.email,
        subject,
        html,
        unsubscribeLink
      );

      if (!result.success) {
        throw new Error(`Failed to send enquiry email: ${result.error.message}`);
      }

      console.log(`Enquiry email sent to ${owner.email} for business ${business.businessName}`);
    } catch (error) {
      console.error(`Error in enquiryWorker for job ${job.id}:`, error);
      throw error;
    }
  },
  { connection: redisConnection }
);

module.exports = enquiryWorker;
