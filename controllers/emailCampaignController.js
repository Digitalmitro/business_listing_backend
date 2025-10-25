const mongoose = require("mongoose");
const moment = require("moment-timezone");
const EmailTemplate = require("../models/EmailTemplate");
const EmailCampaign = require("../models/EmailCampaign");
const SenderEmail = require("../models/SenderEmail");
const User = require("../models/User");
const { sendMail } = require("../utils/nodemailer");
const { emailQueue, addJob } = require("../utils/queue");

// Validate email format
const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Create a new email template
const createTemplate = async (req, res) => {
  try {
    const { name, subject, body } = req.body;
    if (!name || !subject || !body) {
      return res
        .status(400)
        .json({ message: "Name, subject, and body are required" });
    }
    const template = new EmailTemplate({
      name,
      subject,
      body,
      createdBy: req.user.id,
    });
    await template.save();
    res
      .status(201)
      .json({ message: "Template created successfully", template });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error creating template", error: error.message });
  }
};

// Get all email templates
const getTemplates = async (req, res) => {
  try {
    const templates = await EmailTemplate.find({ createdBy: req.user.id }).sort(
      { createdAt: -1 }
    );
    res.status(200).json(templates);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching templates", error: error.message });
  }
};

// Get a single email template by ID
const getTemplateById = async (req, res) => {
  try {
    const template = await EmailTemplate.findOne({
      _id: req.params.id,
      createdBy: req.user.id,
    });
    if (!template) {
      return res
        .status(404)
        .json({ message: "Template not found or unauthorized" });
    }
    res.status(200).json(template);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching template", error: error.message });
  }
};

// Update an email template
const updateTemplate = async (req, res) => {
  try {
    const { name, subject, body } = req.body;
    const template = await EmailTemplate.findOne({
      _id: req.params.id,
      createdBy: req.user.id,
    });
    if (!template) {
      return res
        .status(404)
        .json({ message: "Template not found or unauthorized" });
    }
    template.name = name || template.name;
    template.subject = subject || template.subject;
    template.body = body || template.body;
    await template.save();
    res
      .status(200)
      .json({ message: "Template updated successfully", template });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error updating template", error: error.message });
  }
};

// Delete an email template
const deleteTemplate = async (req, res) => {
  try {
    const template = await EmailTemplate.findOneAndDelete({
      _id: req.params.id,
      createdBy: req.user.id,
    });
    if (!template) {
      return res
        .status(404)
        .json({ message: "Template not found or unauthorized" });
    }
    res.status(200).json({ message: "Template deleted successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting template", error: error.message });
  }
};

// Add a new sender email
const addSenderEmail = async (req, res) => {
  try {
    const { email, displayName, smtpHost, smtpPort, smtpUser, smtpPass } =
      req.body;
    if (
      !validateEmail(email) ||
      !displayName ||
      !smtpHost ||
      !smtpPort ||
      !smtpUser ||
      !smtpPass
    ) {
      return res.status(400).json({
        message:
          "All fields (email, displayName, smtpHost, smtpPort, smtpUser, smtpPass) are required",
      });
    }
    const existingEmail = await SenderEmail.findOne({ email });
    if (existingEmail) {
      return res.status(400).json({ message: "Sender email already exists" });
    }
    const senderEmail = new SenderEmail({
      email,
      displayName,
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPass,
      isActive: true,
    });
    await senderEmail.save();
    res
      .status(201)
      .json({ message: "Sender email added successfully", senderEmail });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error adding sender email", error: error.message });
  }
};

// Get all sender emails
const getSenderEmails = async (req, res) => {
  try {
    const { includeInactive } = req.query; // Add query parameter to include inactive emails
    const query = includeInactive === "true" ? {} : { isActive: true };
    const senderEmails = await SenderEmail.find(query);
    res.status(200).json(senderEmails);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching sender emails", error: error.message });
  }
};

// Mark sender email as spam
const markSenderEmailAsSpam = async (req, res) => {
  try {
    const senderEmail = await SenderEmail.findById(req.params.id);
    if (!senderEmail) {
      return res.status(404).json({ message: "Sender email not found" });
    }
    senderEmail.isActive = false; // Changed from isMarkedSpam to isActive for consistency
    await senderEmail.save();
    res.status(200).json({ message: "Sender email marked as inactive" });
  } catch (error) {
    res.status(500).json({
      message: "Error marking sender email as inactive",
      error: error.message,
    });
  }
};

// Create a new campaign
const createCampaign = async (req, res) => {
  try {
    const { name, template, fromEmail, recipients, scheduledAt } = req.body;
    if (
      !name ||
      !template ||
      !fromEmail ||
      (!recipients.users.length && !recipients.customEmails.length)
    ) {
      return res
        .status(400)
        .json({
          message:
            "Name, template, sender email, and at least one recipient are required",
        });
    }

    const sender = await SenderEmail.findOne({ email: fromEmail });
    if (!sender || !sender.isActive) {
      return res
        .status(400)
        .json({ message: "Invalid or inactive sender email" });
    }

    const users = await User.find({ _id: { $in: recipients.users } });
    if (recipients.users.length && !users.length) {
      return res.status(400).json({ message: "No valid users selected" });
    }

    for (const email of recipients.customEmails || []) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res
          .status(400)
          .json({ message: `Invalid custom email: ${email}` });
      }
    }

    const templateDoc = await EmailTemplate.findById(template);
    if (!templateDoc) {
      return res.status(400).json({ message: "Invalid template" });
    }

    const campaign = new EmailCampaign({
      name,
      template,
      recipients,
      fromEmail,
      createdBy: req.user.id,
      scheduledAt: scheduledAt
        ? moment(scheduledAt, "YYYY-MM-DD HH:mm").toDate()
        : undefined,
      status: scheduledAt ? "scheduled" : "draft",
    });
    await campaign.save();

    if (scheduledAt) {
      const timeZones = [
        ...new Set(users.map((user) => user.timeZone || "UTC")),
      ];
      const jobs = timeZones.map((timeZone) => {
        const usersInTimeZone = users.filter(
          (user) => (user.timeZone || "UTC") === timeZone
        );
        const localScheduleTime = moment
          .tz(scheduledAt, "YYYY-MM-DD HH:mm", timeZone)
          .utc()
          .toDate();
        return {
          campaignId: campaign._id,
          timeZone,
          userIds: usersInTimeZone.map((user) => user._id),
          fromEmail,
          template, // Match emailWorker.js
          localScheduleTime,
        };
      });

      for (const job of jobs) {
        await addJob("email-campaigns", job, {
          jobId: `email-campaigns-${campaign._id}-${job.timeZone}`,
          delay: new Date(job.localScheduleTime) - new Date(),
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        });
      }
    }

    res
      .status(201)
      .json({ message: "Campaign created successfully", campaign });
  } catch (error) {
    console.error("Error creating campaign:", error);
    res
      .status(500)
      .json({ message: "Error creating campaign", error: error.message });
  }
};

// Get all campaigns
const getCampaigns = async (req, res) => {
  try {
    const campaigns = await EmailCampaign.find({ createdBy: req.user.id })
      .populate("template", "name subject")
      .populate("recipients.users", "email country timeZone")
      .sort({ createdAt: -1 });
    res.status(200).json(campaigns);
  } catch (error) {
    console.error("Error fetching campaigns:", error);
    res
      .status(500)
      .json({ message: "Error fetching campaigns", error: error.message });
  }
};

// Get a single campaign by ID
const getCampaignById = async (req, res) => {
  try {
    const campaign = await EmailCampaign.findOne({
      _id: req.params.id,
      createdBy: req.user.id,
    })
      .populate("templateId", "name subject")
      .populate("senderEmailId", "email displayName")
      .populate("userIds", "email");
    if (!campaign) {
      return res
        .status(404)
        .json({ message: "Campaign not found or unauthorized" });
    }
    res.status(200).json(campaign);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching campaign", error: error.message });
  }
};

// Update a campaign
const updateCampaign = async (req, res) => {
  try {
    const { name, templateId, senderEmailId, userIds, scheduleTime } = req.body;
    const campaign = await EmailCampaign.findOne({
      _id: req.params.id,
      createdBy: req.user.id,
    });
    if (!campaign) {
      return res
        .status(404)
        .json({ message: "Campaign not found or unauthorized" });
    }
    if (campaign.status === "sent" || campaign.status === "completed") {
      return res.status(400).json({ message: "Cannot update a sent campaign" });
    }

    if (name) campaign.name = name;
    if (templateId) {
      const template = await EmailTemplate.findById(templateId);
      if (!template) {
        return res.status(404).json({ message: "Template not found" });
      }
      campaign.templateId = templateId;
    }
    if (senderEmailId) {
      const sender = await SenderEmail.findById(senderEmailId);
      if (!sender || !sender.isActive) {
        return res
          .status(400)
          .json({ message: "Invalid or inactive sender email" });
      }
      campaign.senderEmailId = senderEmailId;
    }
    if (userIds) {
      const users = await User.find({
        _id: { $in: userIds },
        subscribedToEmails: true,
      });
      if (!users.length) {
        return res.status(400).json({ message: "No valid users selected" });
      }
      campaign.userIds = userIds;
    }
    if (scheduleTime) {
      const timeZones = [
        ...new Set(
          campaign.userIds.map((id) => {
            const user = users.find(
              (u) => u._id.toString() === id.toString()
            ) || { timeZone: "UTC" };
            return user.timeZone || "UTC";
          })
        ),
      ];
      const jobs = timeZones.map((timeZone) => {
        const usersInTimeZone = users.filter(
          (user) => (user.timeZone || "UTC") === timeZone
        );
        const localScheduleTime = moment
          .tz(scheduleTime, "HH:mm", timeZone)
          .utc()
          .toDate();
        return {
          campaignId: campaign._id,
          timeZone,
          userIds: usersInTimeZone.map((user) => user._id),
          senderEmailId: campaign.senderEmailId,
          localScheduleTime,
        };
      });

      await emailQueue.removeJobs(`email-campaigns-${campaign._id}-*`);
      for (const job of jobs) {
        const delay = new Date(job.localScheduleTime) - new Date();
        if (delay <= 0) {
          return res.status(400).json({
            message: `Scheduled time for ${job.timeZone} must be in the future`,
          });
        }
        await addJob("email-campaigns", job, {
          jobId: `email-campaigns-${campaign._id}-${job.timeZone}`,
          delay,
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        });
      }
      campaign.scheduleTime = scheduleTime;
      campaign.status = "scheduled";
    } else if (scheduleTime === null) {
      await emailQueue.removeJobs(`email-campaigns-${campaign._id}-*`);
      campaign.scheduleTime = null;
      campaign.status = "draft";
    }

    await campaign.save();
    res
      .status(200)
      .json({ message: "Campaign updated successfully", campaign });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error updating campaign", error: error.message });
  }
};

// Cancel a scheduled campaign
const cancelScheduledCampaign = async (req, res) => {
  try {
    const campaign = await EmailCampaign.findOne({
      _id: req.params.id,
      createdBy: req.user.id,
    });
    if (!campaign) {
      return res
        .status(404)
        .json({ message: "Campaign not found or unauthorized" });
    }
    if (campaign.status !== "scheduled") {
      return res.status(400).json({ message: "Campaign is not scheduled" });
    }
    await emailQueue.removeJobs(`email-campaigns-${campaign._id}-*`);
    campaign.status = "draft";
    campaign.scheduleTime = null;
    await campaign.save();
    res.status(200).json({ message: "Scheduled campaign cancelled" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error cancelling campaign", error: error.message });
  }
};

// Send a campaign immediately
const sendCampaign = async (req, res) => {
  try {
    const campaign = await EmailCampaign.findOne({
      _id: req.params.id,
      createdBy: req.user.id,
    })
      .populate("templateId")
      .populate("userIds", "email subscribedToEmails");
    if (!campaign) {
      return res
        .status(404)
        .json({ message: "Campaign not found or unauthorized" });
    }
    if (campaign.status === "sent" || campaign.status === "completed") {
      return res.status(400).json({ message: "Campaign already sent" });
    }
    if (
      campaign.status === "scheduled" &&
      new Date(campaign.scheduleTime) > new Date()
    ) {
      return res
        .status(400)
        .json({ message: "Campaign is scheduled for future sending" });
    }

    const sender = await SenderEmail.findById(campaign.senderEmailId);
    if (!sender || !sender.isActive) {
      return res
        .status(400)
        .json({ message: "Sender email is invalid or inactive" });
    }

    const recipients = campaign.userIds
      .filter((user) => user.subscribedToEmails)
      .map((user) => user.email);

    if (recipients.length === 0) {
      return res.status(400).json({ message: "No valid recipients found" });
    }

    try {
      for (const recipient of recipients) {
        const html = campaign.templateId.body
          .replace(
            "{{full_name}}",
            (await User.findOne({ email: recipient })).full_name || "User"
          )
          .replace("{{email}}", recipient);
        const unsubscribeLink = `${
          process.env.FRONTEND_URL
        }/unsubscribe?userId=${
          (await User.findOne({ email: recipient }))._id
        }&campaignId=${campaign._id}`;
        const result = await sendMail(
          campaign.senderEmailId,
          recipient,
          campaign.templateId.subject,
          html,
          unsubscribeLink
        );
        if (!result.success) {
          throw result.error;
        }
      }
      campaign.status = "completed";
      campaign.sentAt = new Date();
      await campaign.save();
      res.status(200).json({ message: "Campaign sent successfully" });
    } catch (emailError) {
      campaign.status = "failed";
      await campaign.save();
      res
        .status(500)
        .json({ message: "Error sending emails", error: emailError.message });
    }
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error processing campaign", error: error.message });
  }
};

// Get all users for campaign selection
const getUsers = async (req, res) => {
  try {
    const { search = "", page = 1, limit = 10 } = req.query;
    const pageNumber = parseInt(page, 10);
    const pageLimit = parseInt(limit, 10);
    const skip = (pageNumber - 1) * pageLimit;
    const searchQuery = {
      subscribedToEmails: true,
      $or: [
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ],
    };
    const users = await User.find(searchQuery)
      .select("email _id timeZone country")
      .skip(skip)
      .limit(pageLimit);
    const totalUsers = await User.countDocuments(searchQuery);
    res.json({
      users,
      totalUsers,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching users", error: error.message });
  }
};

// Unsubscribe user
const unsubscribe = async (req, res) => {
  try {
    const { userId, campaignId } = req.query;
    if (!userId) {
      return res.status(400).json({ message: "Invalid user ID" });
    }
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    user.subscribedToEmails = false;
    await user.save();
    res.status(200).json({ message: "Successfully unsubscribed" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error unsubscribing", error: error.message });
  }
};

// Toggle sender email active/inactive status
const toggleSenderEmailStatus = async (req, res) => {
  try {
    const senderEmail = await SenderEmail.findById(req.params.id);
    if (!senderEmail) {
      return res.status(404).json({ message: "Sender email not found" });
    }
    senderEmail.isActive = !senderEmail.isActive; // Toggle isActive
    await senderEmail.save();
    res.status(200).json({
      message: `Sender email marked as ${
        senderEmail.isActive ? "active" : "inactive"
      }`,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error toggling sender email status",
      error: error.message,
    });
  }
};

// Delete a campaign
const deleteCampaign = async (req, res) => {
    try {
      const campaign = await EmailCampaign.findOne({
        _id: req.params.id,
        createdBy: req.user.id,
      });
      if (!campaign) {
        return res.status(404).json({ message: "Campaign not found or unauthorized" });
      }
    //   if (campaign.status === "sent") {
    //     return res.status(400).json({ message: "Cannot delete a sent campaign" });
    //   }
      if (campaign.status === "scheduled") {
        await emailQueue.removeJobs(`email-campaigns-${campaign._id}-*`);
      }
      await EmailCampaign.findOneAndDelete({ _id: req.params.id, createdBy: req.user.id });
      res.status(200).json({ message: "Campaign deleted successfully" });
    } catch (error) {
      console.error("Error deleting campaign:", error.stack);
      res.status(500).json({ message: "Error deleting campaign", error: error.message });
    }
  };

module.exports = {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
  addSenderEmail,
  getSenderEmails,
  markSenderEmailAsSpam,
  createCampaign,
  getCampaigns,
  getCampaignById,
  updateCampaign,
  cancelScheduledCampaign,
  sendCampaign,
  deleteCampaign,
  getUsers,
  unsubscribe,
  toggleSenderEmailStatus,
};
