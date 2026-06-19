const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const EmailCampaign = require("../models/EmailCampaign");
const EmailTemplate = require("../models/EmailTemplate");
const SenderEmail = require("../models/SenderEmail");
const User = require("../models/User");
const Business = require("../models/Business");
const { sendMail } = require("../utils/nodemailer");
const { applyEmailPlaceholders, getBusinessPlaceholderData } = require("../utils/emailPlaceholders");

const emailWorker = new Worker(
  "email-campaigns",
  async (job) => {
    const {
      campaignId,
      timeZone,
      userIds,
      fromEmail,
      template,
      isRefTimeZone,
    } = job.data;
    try {
      const campaign = await EmailCampaign.findById(campaignId);
      if (!campaign || (campaign.status !== "scheduled" && campaign.status !== "failed")) {
        throw new Error("Campaign not found or invalid status");
      }

      const sender = await SenderEmail.findOne({ email: fromEmail });
      if (!sender || !sender.isActive) {
        throw new Error("Sender email is invalid or inactive");
      }

      const templateDoc = await EmailTemplate.findById(campaign.template);
      if (!templateDoc) {
        throw new Error("Template not found");
      }

      // Send emails to registered users
      let sentCount = 0;
      const users = await User.find({ _id: { $in: userIds } });

      for (const user of users) {


        const associatedBiz = await Business.findOne({
          $or: [
            { "contact.email": user.email },
            { "contact.contactDetails.emails": user.email }
          ]
        })
          .populate("category", "name")
          .populate("subCategory", "name")
          .select("businessName address website contact category subCategory");

        const html = applyEmailPlaceholders(templateDoc.body, {
          ...getBusinessPlaceholderData(associatedBiz),
          full_name: user.full_name || "User",
          email: user.email,
        });
        
        const unsubscribeLink = `${process.env.FRONTEND_URL}/unsubscribe?userId=${user._id}&campaignId=${campaign._id}`;
        const result = await sendMail(fromEmail, user.email, templateDoc.subject, html, unsubscribeLink);
        
        if (!result.success) {
          console.error(`Failed to send email to ${user.email}: ${result.error.message}`);
          continue; // Move to next user instead of failing the whole job
        }
        sentCount++;
      }

      // Send emails to customEmails
      if (isRefTimeZone) {
        for (const item of campaign.recipients.customEmails || []) {
          const email = typeof item === 'string' ? item : item.email;
          const associatedBiz = await Business.findOne({
            $or: [
              { "contact.email": email },
              { "contact.contactDetails.emails": email },
            ],
          })
            .populate("category", "name")
            .populate("subCategory", "name")
            .select("businessName address website contact category subCategory");
          const businessData = getBusinessPlaceholderData(associatedBiz);

          const html = applyEmailPlaceholders(templateDoc.body, {
            full_name: "User",
            email,
            business_name: typeof item === 'string' ? businessData.business_name : (item.businessName || businessData.business_name),
            address: typeof item === 'string' ? businessData.address : (item.address || businessData.address),
            website: typeof item === 'string' ? businessData.website : (item.website || businessData.website),
            phone: typeof item === 'string' ? businessData.phone : (item.phone || businessData.phone),
            category: typeof item === 'string' ? businessData.category : (item.category || businessData.category),
            subcategory: typeof item === 'string' ? businessData.subcategory : (item.subcategory || businessData.subcategory),
            country: typeof item === 'string' ? businessData.country : (item.country || businessData.country),
            listing_url: typeof item === 'string' ? businessData.listing_url : (item.listingUrl || item.listing_url || businessData.listing_url),
          });
          
          const unsubscribeLink = `${process.env.FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(email)}&campaignId=${campaign._id}`;
          const result = await sendMail(fromEmail, email, templateDoc.subject, html, unsubscribeLink);
          
          if (result.success) sentCount++;
        }
      }

      // Update campaign status
      if (sentCount > 0) {
        campaign.status = "sent";
        campaign.sentAt = new Date();
      } else if (campaign.recipients.users.length + campaign.recipients.customEmails.length === 0) {
        campaign.status = "draft";
      } else {
        campaign.status = "failed";
      }
      await campaign.save();
      console.log(`Campaign ${campaignId} processed (sent: ${sentCount})`);
    } catch (error) {
      console.error(`Error processing campaign ${campaignId}:`, error.message);
      await EmailCampaign.findByIdAndUpdate(campaignId, { status: "failed" });
      throw error;
    }
  },
  { 
    connection: redisConnection
  }
);





module.exports = emailWorker;
