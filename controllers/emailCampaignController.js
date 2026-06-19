const mongoose = require("mongoose");
const moment = require("moment-timezone");
const ExcelJS = require("exceljs");
const EmailTemplate = require("../models/EmailTemplate");
const EmailCampaign = require("../models/EmailCampaign");
const SenderEmail = require("../models/SenderEmail");
const User = require("../models/User");
const Business = require("../models/Business");
const { sendMail } = require("../utils/nodemailer");
const { emailQueue, addJob } = require("../utils/queue");
const { applyEmailPlaceholders, getBusinessPlaceholderData } = require("../utils/emailPlaceholders");

// Validate email format
const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/**
 * Process uploaded Excel for campaign recipients
 * Cross-references emails with Business model to find business names
 */
const processCampaignExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    
    // Attempt to get the first sheet reliably
    const worksheet = workbook.getWorksheet(1) || workbook.worksheets[0];
    
    if (!worksheet) {
      console.error("No worksheet found in file!");
      return res.status(400).json({ message: "No worksheet found in Excel file" });
    }

    console.log(`Worksheet: "${worksheet.name}", Row Count: ${worksheet.actualRowCount}`);

    const extractText = (val) => {
      if (!val) return "";
      if (typeof val === 'string') return val;
      if (typeof val === 'object') {
        // Handle Hyperlink object: { text: ..., hyperlink: ... }
        if (val.text) return extractText(val.text);
        // Handle RichText object: { richText: [...] }
        if (val.richText && Array.isArray(val.richText)) {
          return val.richText.map(rt => rt.text || "").join("");
        }
        return val.toString();
      }
      return String(val);
    };

    const emails = [];
    worksheet.eachRow((row, rowNumber) => {
      const cell = row.getCell(1);
      const rawValue = cell.value;
      console.log(`Row ${rowNumber} Raw Value:`, JSON.stringify(rawValue));

      const emailValue = extractText(rawValue).trim().toLowerCase();
      console.log(`Row ${rowNumber} Extracted: "${emailValue}" (Valid: ${validateEmail(emailValue)})`);

      if (rowNumber === 1) {
        if (validateEmail(emailValue)) {
           console.log("Row 1 is a valid email, including it.");
           emails.push(emailValue);
        } else {
           console.log("Row 1 skipped (treated as header).");
        }
      } else {
        if (validateEmail(emailValue)) {
          emails.push(emailValue);
        }
      }
    });

    const uniqueEmails = [...new Set(emails)];
    console.log("Emails extracted from Excel:", uniqueEmails);
    
    // Cross-reference with Business model
    const query = {
      $or: [
        { "contact.email": { $in: uniqueEmails } },
        { "contact.contactDetails.emails": { $in: uniqueEmails } }
      ]
    };
    console.log("Database Query:", JSON.stringify(query, null, 2));

    const matches = await Business.find(query)
      .populate("category", "name")
      .populate("subCategory", "name")
      .select("businessName address website contact category subCategory");
    console.log(`Found ${matches.length} businesses matching these emails.`);

    const emailToBusiness = {};
    matches.forEach(biz => {
      // Ensure email is treated as an array even if stored as string in legacy data
      const primaryEmails = Array.isArray(biz.contact?.email) 
        ? biz.contact.email 
        : (biz.contact?.email ? [biz.contact.email] : []);

      const contactEmails = biz.contact?.contactDetails?.flatMap(cd => cd.emails || []) || [];
      
      const bizEmails = [...primaryEmails, ...contactEmails].map(e => e.toLowerCase().trim());
      console.log(`Mapping emails for "${biz.businessName}":`, bizEmails);

      uniqueEmails.forEach(e => {
        if (bizEmails.includes(e)) {
          emailToBusiness[e] = biz;
        }
      });
    });

    const result = uniqueEmails.map(email => {
      const businessData = getBusinessPlaceholderData(emailToBusiness[email]);
      return {
        email,
        businessName: businessData.business_name,
        address: businessData.address,
        website: businessData.website,
        phone: businessData.phone,
        category: businessData.category,
        subcategory: businessData.subcategory,
        country: businessData.country,
        listingUrl: businessData.listing_url,
      };
    });

    const matchCount = result.filter(r => r.businessName).length;
    console.log("Final Mapping Result (Matches):", matchCount);

    res.status(200).json({
      totalEmails: uniqueEmails.length,
      matchCount,
      recipients: result
    });
  } catch (error) {
    console.error("Error processing campaign excel:", error);
    res.status(500).json({ message: "Error processing file", error: error.message });
  }
};

/**
 * Download sample Excel for campaign upload
 */
const downloadCampaignSampleExcel = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Recipients");

    worksheet.columns = [
      { header: "Email Address", key: "email", width: 30 },
    ];

    worksheet.addRows([
      { email: "business@example.com" },
      { email: "contact@company.com" },
    ]);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=" + "campaign_recipients_sample.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Error generating sample excel:", error);
    res.status(500).json({ message: "Error generating sample file" });
  }
};

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

// Upload an image for templates
const uploadTemplateImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Please upload an image." });
    }

    const host = req.get("host");
    const protocol = req.protocol;
    const imageUrl = `${protocol}://${host}/uploads/${req.file.filename}`;

    res.status(200).json({
      url: imageUrl,
    });
  } catch (error) {
    console.error("Error uploading template image:", error);
    res
      .status(500)
      .json({ message: "Failed to upload image", error: error.message });
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
      return res.status(400).json({
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

    for (const item of recipients.customEmails || []) {
      const email = typeof item === 'string' ? item : item.email;
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

    const refTimeZone = req.body.timeZone || (users && users.length > 0 ? (users[0].timeZone || "Asia/Kolkata") : "Asia/Kolkata");
    
    const campaign = new EmailCampaign({
      name,
      template,
      recipients,
      fromEmail,
      createdBy: req.user.id,
      timeZone: refTimeZone,
      scheduledAt: scheduledAt
        ? moment.tz(scheduledAt, "YYYY-MM-DD HH:mm", refTimeZone).toDate()
        : undefined,
      status: scheduledAt ? "scheduled" : "draft",
    });
    await campaign.save();

    if (scheduledAt) {
      const timeZones = [
        ...new Set(users.map((user) => user.timeZone || "UTC")),
      ];
      if (timeZones.length === 0 && recipients.customEmails && recipients.customEmails.length > 0) {
        timeZones.push(refTimeZone);
      }

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
          isRefTimeZone: timeZones.length === 1 || timeZone === refTimeZone,
        };
      });

      for (const job of jobs) {
        const delay = new Date(job.localScheduleTime) - new Date();
        
        await addJob("email-campaigns", job, {
          jobId: `email-campaigns-${campaign._id}-${job.timeZone}-${Date.now()}`,
          delay: Math.max(0, delay),
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
      .populate("template", "name subject")
      .populate("recipients.users", "email country timeZone");
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
    const { name, template, fromEmail, recipients, scheduledAt } = req.body;
    const campaign = await EmailCampaign.findOne({
      _id: req.params.id,
      createdBy: req.user.id,
    });
    if (!campaign) {
      return res
        .status(404)
        .json({ message: "Campaign not found or unauthorized" });
    }
    if (campaign.status === "sent") {
      return res.status(400).json({ message: "Cannot update a sent campaign" });
    }

    if (name) campaign.name = name;
    if (template) {
      const templateDoc = await EmailTemplate.findById(template);
      if (!templateDoc) {
        return res.status(404).json({ message: "Template not found" });
      }
      campaign.template = template;
    }
    if (fromEmail) {
      const sender = await SenderEmail.findOne({ email: fromEmail });
      if (!sender || !sender.isActive) {
        return res
          .status(400)
          .json({ message: "Invalid or inactive sender email" });
      }
      campaign.fromEmail = fromEmail;
    }
    if (recipients) {
      if (recipients.users) {
        const users = await User.find({
          _id: { $in: recipients.users },
        });
        if (recipients.users.length && !users.length) {
          return res.status(400).json({ message: "No valid users selected" });
        }
        campaign.recipients.users = recipients.users;
      }
      if (recipients.customEmails) {
        for (const item of recipients.customEmails) {
          const email = typeof item === 'string' ? item : item.email;
          if (!validateEmail(email)) {
            return res
              .status(400)
              .json({ message: `Invalid custom email: ${email}` });
          }
        }
        campaign.recipients.customEmails = recipients.customEmails;
      }
    }

    // Fetch users for timezone and scheduling
    const recipientsUserIds = campaign.recipients.users || [];
    const users = await User.find({ _id: { $in: recipientsUserIds } });

    const refTimeZone = req.body.timeZone || (users && users.length > 0 ? (users[0].timeZone || "Asia/Kolkata") : "Asia/Kolkata");
    campaign.timeZone = refTimeZone;

    if (scheduledAt) {
      const timeZones = [
        ...new Set(users.map((user) => user.timeZone || "UTC")),
      ];
      if (timeZones.length === 0 && campaign.recipients.customEmails && campaign.recipients.customEmails.length > 0) {
        timeZones.push(refTimeZone);
      }

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
          fromEmail: campaign.fromEmail,
          template: campaign.template,
          localScheduleTime,
          isRefTimeZone: timeZones.length === 1 || timeZone === refTimeZone,
        };
      });

      // Remove ALL existing jobs for this campaign (even completed/failed ones)
      const existingJobs = await emailQueue.getJobs([
        "waiting",
        "active",
        "delayed",
        "completed",
        "failed",
      ]);
      for (const job of existingJobs) {
        if (job.id.startsWith(`email-campaigns-${campaign._id}-`)) {
          await job.remove();
        }
      }

      for (const job of jobs) {
        const delay = new Date(job.localScheduleTime) - new Date();
        const absoluteRunAt = new Date(job.localScheduleTime).toISOString();
        if (delay <= -60000) { // Allow 1 minute grace for immediate-ish scheduling
          return res.status(400).json({
            message: `Scheduled time for ${job.timeZone} must be in the future`,
          });
        }
        await addJob("email-campaigns", job, {
          jobId: `email-campaigns-${campaign._id}-${job.timeZone}-${Date.now()}`,
          delay: Math.max(0, delay),
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        });
      }
      campaign.scheduledAt = moment.tz(scheduledAt, "YYYY-MM-DD HH:mm", refTimeZone).toDate();
      campaign.status = "scheduled";
    } else if (scheduledAt === null) {
      const existingJobs = await emailQueue.getJobs([
        "waiting",
        "active",
        "delayed",
      ]);
      for (const job of existingJobs) {
        if (job.id.startsWith(`email-campaigns-${campaign._id}-`)) {
          await job.remove();
          console.log(`Removed job ${job.id}`);
        }
      }
      campaign.scheduledAt = null;
      campaign.status = "draft";
    }

    await campaign.save();
    res
      .status(200)
      .json({ message: "Campaign updated successfully", campaign });
  } catch (error) {
    console.error("Error updating campaign:", error.stack);
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
    const existingJobs = await emailQueue.getJobs([
      "waiting",
      "active",
      "delayed",
    ]);
    for (const job of existingJobs) {
      if (job.id.startsWith(`email-campaigns-${campaign._id}-`)) {
        await job.remove();
        console.log(`Removed job ${job.id}`);
      }
    }
    campaign.status = "draft";
    campaign.scheduledAt = null;
    await campaign.save();
    res.status(200).json({ message: "Scheduled campaign cancelled" });
  } catch (error) {
    console.error("Error cancelling campaign:", error.stack);
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
      .populate("template")
      .populate("recipients.users", "email subscribedToEmails full_name");

    if (!campaign) {
      return res
        .status(404)
        .json({ message: "Campaign not found or unauthorized" });
    }
    if (campaign.status === "sent") {
      return res.status(400).json({ message: "Campaign already sent" });
    }

    const sender = await SenderEmail.findOne({ email: campaign.fromEmail });
    if (!sender || !sender.isActive) {
      return res
        .status(400)
        .json({ message: "Sender email is invalid or inactive" });
    }

    const validRecipients = (campaign.recipients.users || [])
      .filter((user) => user.subscribedToEmails);

    if (validRecipients.length === 0 && (!campaign.recipients.customEmails || campaign.recipients.customEmails.length === 0)) {
      return res.status(400).json({ message: "No valid recipients found (they may have unsubscribed)" });
    }

    try {
      // Send to registered users
      for (const user of campaign.recipients.users || []) {
        const fullUser = await User.findById(user);
        if (!fullUser || !fullUser.subscribedToEmails) continue;

        // Look up associated business for CSV-field placeholders
        const associatedBiz = await Business.findOne({
          $or: [
            { "contact.email": fullUser.email },
            { "contact.contactDetails.emails": fullUser.email }
          ]
        })
          .populate("category", "name")
          .populate("subCategory", "name")
          .select("businessName address website contact category subCategory");

        const data = {
          ...getBusinessPlaceholderData(associatedBiz),
          full_name:     fullUser.full_name || "User",
          email:         fullUser.email,
        };

        const html = applyEmailPlaceholders(campaign.template.body, data);

        const unsubscribeLink = `${process.env.FRONTEND_URL}/unsubscribe?userId=${fullUser._id}&campaignId=${campaign._id}`;
        
        const result = await sendMail(
          campaign.fromEmail,
          fullUser.email,
          campaign.template.subject,
          html,
          unsubscribeLink
        );
        if (!result.success) throw result.error;
      }

      // Send to custom emails
      // Custom email items may carry CSV-field values if they were imported via the business CSV flow
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
        const data = {
          full_name:     typeof item === 'string' ? "User" : (item.full_name     || "User"),
          email,
          business_name: typeof item === 'string' ? businessData.business_name : (item.businessName || item.business_name || businessData.business_name),
          address:       typeof item === 'string' ? businessData.address       : (item.address       || businessData.address),
          website:       typeof item === 'string' ? businessData.website       : (item.website       || businessData.website),
          phone:         typeof item === 'string' ? businessData.phone         : (item.phone         || businessData.phone),
          category:      typeof item === 'string' ? businessData.category      : (item.category      || businessData.category),
          subcategory:   typeof item === 'string' ? businessData.subcategory   : (item.subcategory   || businessData.subcategory),
          country:       typeof item === 'string' ? businessData.country       : (item.country       || businessData.country),
          listing_url:   typeof item === 'string' ? businessData.listing_url   : (item.listingUrl || item.listing_url || businessData.listing_url),
        };

        const html = applyEmailPlaceholders(campaign.template.body, data);

        const unsubscribeLink = `${process.env.FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(email)}&campaignId=${campaign._id}`;
        
        const result = await sendMail(
          campaign.fromEmail,
          email,
          campaign.template.subject,
          html,
          unsubscribeLink
        );
        if (!result.success) throw result.error;
      }

      campaign.status = "sent";
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
      return res
        .status(404)
        .json({ message: "Campaign not found or unauthorized" });
    }
    if (campaign.status === "sent") {
      return res.status(400).json({ message: "Cannot delete a sent campaign" });
    }
    if (campaign.status === "scheduled") {
      const existingJobs = await emailQueue.getJobs([
        "waiting",
        "active",
        "delayed",
      ]);
      for (const job of existingJobs) {
        if (job.id.startsWith(`email-campaigns-${campaign._id}-`)) {
          await job.remove();
          console.log(`Removed job ${job.id}`);
        }
      }
    }
    await EmailCampaign.findOneAndDelete({
      _id: req.params.id,
      createdBy: req.user.id,
    });
    res.status(200).json({ message: "Campaign deleted successfully" });
  } catch (error) {
    console.error("Error deleting campaign:", error.stack);
    res
      .status(500)
      .json({ message: "Error deleting campaign", error: error.message });
  }
};

// Send a test email for a template
const sendTestEmail = async (req, res) => {
  try {
    const { template, to } = req.body;
    if (!template || !to) {
      return res.status(400).json({ message: "Template and recipient email are required" });
    }

    // Find the first active sender email
    const sender = await SenderEmail.findOne({ isActive: true });
    if (!sender) {
      return res.status(400).json({ message: "No active sender email found. Please add one in Settings." });
    }

    const html = applyEmailPlaceholders(template.body, {
      full_name: "Test User",
      frontend_url: process.env.FRONTEND_URL || "http://localhost:3000",
      package_name: "Premium Package",
      start_date: new Date().toLocaleDateString(),
      business_id: "12345",
      status: "Approved",
      rejection_reason: "Test Rejection Reason",
      business_name: "DigitalMitro (Sample)",
      address: "123 Tech St, Salt Lake, Kolkata, West Bengal, 700091, India",
      website: "https://digitalmitro.com",
      email: to,
      phone: "9876543210",
      category: "Marketing Agency",
      subcategory: "Digital Marketing",
      country: "India",
      listing_url: `${(process.env.FRONTEND_URL || "https://urbancitations.com").replace(/\/+$/, "")}/digital-mitro-pvt-ltd/69c22f65bbcdf3b5f6f8dcbb`,
    });

    const result = await sendMail(
      sender.email,
      to,
      `[TEST] ${template.subject}`,
      html,
      `${process.env.FRONTEND_URL}/unsubscribe?test=true`
    );

    if (result.success) {
      res.status(200).json({ message: "Test email sent successfully" });
    } else {
      throw result.error;
    }
  } catch (error) {
    console.error("Error in sendTestEmail:", error);
    res.status(500).json({ message: "Error sending test email", error: error.message });
  }
};

module.exports = {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
  uploadTemplateImage,
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
  processCampaignExcel,
  downloadCampaignSampleExcel,
  sendTestEmail,
};
