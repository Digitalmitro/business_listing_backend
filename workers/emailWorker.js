const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const EmailCampaign = require("../models/EmailCampaign");
const EmailTemplate = require("../models/EmailTemplate");
const SenderEmail = require("../models/SenderEmail");
const User = require("../models/User");
require("../models/Category");
require("../models/SubCategory");
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
      if (!campaign || !["scheduled", "processing", "failed"].includes(campaign.status)) {
        throw new Error("Campaign not found or invalid status");
      }

      const senderEmail = fromEmail || campaign.fromEmail;
      const sender = await SenderEmail.findOne({ email: senderEmail });
      if (!sender || !sender.isActive) {
        throw new Error("Sender email is invalid or inactive");
      }

      const templateId = template || campaign.template;
      const templateDoc = await EmailTemplate.findById(templateId);
      if (!templateDoc) {
        throw new Error("Template not found");
      }

      // Step 1: Gather all emails we might need to lookup
      const allEmails = new Set();
      const fallbackUserIds = campaign.recipients?.users || [];
      const effectiveUserIds = userIds?.length ? userIds : fallbackUserIds;
      const users = effectiveUserIds.length ? await User.find({ _id: { $in: effectiveUserIds } }) : [];
      users.forEach(u => { if (u.email) allEmails.add(u.email); });
      
      const shouldIncludeCustomEmails =
        typeof isRefTimeZone === "boolean" ? isRefTimeZone : true;
      const customEmailItems = shouldIncludeCustomEmails && campaign.recipients.customEmails
        ? campaign.recipients.customEmails
        : [];
      customEmailItems.forEach(item => {
        const email = typeof item === 'string' ? item : item.email;
        if (email) allEmails.add(email);
      });

      // Step 2: Batch fetch associated businesses once
      const emailArray = Array.from(allEmails);
      const businesses = await Business.find({
        $or: [
          { "contact.email": { $in: emailArray } },
          { "contact.contactDetails.emails": { $in: emailArray } }
        ]
      })
      .populate("category", "name")
      .populate("subCategory", "name")
      .select("businessName address website contact category subCategory")
      .lean();

      // Create a quick lookup map by email
      const businessMap = new Map();
      for (const biz of businesses) {
        // Map top-level emails
        if (biz.contact && Array.isArray(biz.contact.email)) {
          for (const e of biz.contact.email) businessMap.set(e, biz);
        }
        // Map nested contact details emails
        if (biz.contact && Array.isArray(biz.contact.contactDetails)) {
          for (const cd of biz.contact.contactDetails) {
            if (Array.isArray(cd.emails)) {
              for (const e of cd.emails) businessMap.set(e, biz);
            }
          }
        }
      }

      let sentCount = 0;

      // Send emails to registered users
      for (const user of users) {
        if (!user.email) continue;
        const associatedBiz = businessMap.get(user.email);
        
        const html = applyEmailPlaceholders(templateDoc.body, {
          ...getBusinessPlaceholderData(associatedBiz),
          full_name: user.full_name || "User",
          email: user.email,
        });
        
        const unsubscribeLink = `${process.env.FRONTEND_URL}/unsubscribe?userId=${user._id}&campaignId=${campaign._id}`;
        const result = await sendMail(senderEmail, user.email, templateDoc.subject, html, unsubscribeLink);
        
        if (!result.success) {
          console.error(`Failed to send email to ${user.email}: ${result.error.message}`);
          continue; // Move to next user instead of failing the whole job
        }
        sentCount++;
      }

      // Send emails to customEmails
      for (const item of customEmailItems) {
        const email = typeof item === 'string' ? item : item.email;
        if (!email) continue;
        const associatedBiz = businessMap.get(email);
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
        const result = await sendMail(senderEmail, email, templateDoc.subject, html, unsubscribeLink);
        
        if (result.success) sentCount++;
      }

      // Update campaign status
      if (sentCount > 0) {
        campaign.status = "sent";
        campaign.sentAt = new Date();
      } else if ((campaign.recipients?.users?.length || 0) + (campaign.recipients?.customEmails?.length || 0) === 0) {
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
