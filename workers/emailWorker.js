const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const EmailCampaign = require("../models/EmailCampaign");
const EmailTemplate = require("../models/EmailTemplate");
const SenderEmail = require("../models/SenderEmail");
const User = require("../models/User");
const Business = require("../models/Business");
const { sendMail } = require("../utils/nodemailer");

const emailWorker = new Worker(
  "email-campaigns",
  async (job) => {
    const {
      campaignId,
      timeZone,
      userIds,
      fromEmail,
      template,
      localScheduleTime,
    } = job.data;
    try {
      console.log("Processing job:", {
        campaignId,
        timeZone,
        userIds,
        fromEmail,
        template,
        localScheduleTime,
      });
      const campaign = await EmailCampaign.findById(campaignId);
      if (!campaign) {
        throw new Error("Campaign not found");
      }
      console.log("Campaign loaded:", campaign);
      if (campaign.status !== "scheduled" && campaign.status !== "failed") {
        throw new Error("Campaign is not in scheduled state");
      }

      const sender = await SenderEmail.findOne({ email: fromEmail });
      console.log("Sender email lookup:", {
        fromEmail,
        sender: sender
          ? { email: sender.email, isActive: sender.isActive }
          : null,
      }); // Debug log
      if (!sender || !sender.isActive) {
        throw new Error("Sender email is invalid or inactive");
      }

      const templateDoc = await EmailTemplate.findById(campaign.template);
      if (!templateDoc) {
        throw new Error("Template not found");
      }

      // Send emails to registered users
      let sentCount = 0;
      const users = await User.find({
        _id: { $in: userIds },
      });
      console.log(
        "Users found:",
        users.map((u) => ({
          id: u._id.toString(),
          email: u.email,
          subscribed: u.subscribedToEmails,
        }))
      );
      for (const user of users) {
        // Skip unsubscribed users
        if (!user.subscribedToEmails) {
          console.log(`Skipping unsubscribed user: ${user.email}`);
          continue;
        }

        // Find associated business name if exists for registered user
        let bizName = "User";
        const associatedBiz = await Business.findOne({
          $or: [
            { "contact.email": user.email },
            { "contact.contactDetails.emails": user.email }
          ]
        }).select("businessName");
        
        if (associatedBiz) {
          bizName = associatedBiz.businessName;
        }

        const html = templateDoc.body
          .replace(/{{full_name}}/g, user.full_name || "User")
          .replace(/{{email}}/g, user.email)
          .replace(/{{business_name}}/g, bizName);
        
        const unsubscribeLink = `${process.env.FRONTEND_URL}/unsubscribe?userId=${user._id}&campaignId=${campaign._id}`;
        const result = await sendMail(
          fromEmail,
          user.email,
          templateDoc.subject,
          html,
          unsubscribeLink
        );
        console.log("Send mail result for user:", {
          email: user.email,
          success: result.success,
          error: result.error?.message,
        });
        if (!result.success) {
          throw new Error(
            `Failed to send email to ${user.email}: ${result.error.message}`
          );
        }
        sentCount++;
      }

      // Send emails to customEmails
      for (const item of campaign.recipients.customEmails || []) {
        const email = typeof item === 'string' ? item : item.email;
        const bizName = typeof item === 'string' ? "User" : (item.businessName || "User");

        const html = templateDoc.body
          .replace(/{{full_name}}/g, "User")
          .replace(/{{email}}/g, email)
          .replace(/{{business_name}}/g, bizName);
        
        const unsubscribeLink = `${
          process.env.FRONTEND_URL
        }/unsubscribe?email=${encodeURIComponent(email)}&campaignId=${
          campaign._id
        }`;
        const result = await sendMail(
          fromEmail,
          email,
          templateDoc.subject,
          html,
          unsubscribeLink
        );
        console.log("Send mail result for custom email:", {
          email,
          success: result.success,
          error: result.error?.message,
        });
        if (!result.success) {
          throw new Error(
            `Failed to send email to ${email}: ${result.error.message}`
          );
        }
        sentCount++;
      }

      // Update campaign status
      const totalRecipients =
        campaign.recipients.users.length +
        campaign.recipients.customEmails.length;
      console.log("Status update:", { sentCount, totalRecipients });
      if (totalRecipients === 0) {
        campaign.status = "draft";
      } else if (sentCount > 0) {
        campaign.status = "sent";
        campaign.sentAt = new Date();
      } else {
        campaign.status = "failed";
      }
      try {
        await campaign.save();
        console.log(
          `Campaign ${campaignId} for time zone ${timeZone} saved with status: ${campaign.status}`
        );
      } catch (saveError) {
        console.error("Error saving campaign:", saveError.stack);
        throw new Error(`Failed to save campaign: ${saveError.message}`);
      }
      console.log(
        `Campaign ${campaignId} for time zone ${timeZone} sent successfully`
      );
    } catch (error) {
      console.error(
        `Error processing campaign ${campaignId} for time zone ${timeZone}:`,
        error.stack
      );
      await EmailCampaign.findByIdAndUpdate(
        campaignId,
        { status: "failed" },
        { runValidators: true }
      );
      throw error;
    }
  },
  { connection: redisConnection }
);

emailWorker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

emailWorker.on("failed", (job, err) => {
  console.error(`Job ${job.id} failed:`, err.stack);
});

module.exports = emailWorker;
