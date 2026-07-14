// controllers/emailCampaignController.js
"use strict";

const mongoose = require("mongoose");
const moment   = require("moment-timezone");
const ExcelJS  = require("exceljs");
const path     = require("path");
const fs       = require("fs");

const EmailTemplate  = require("../models/EmailTemplate");
const EmailCampaign  = require("../models/EmailCampaign");
const SenderEmail    = require("../models/SenderEmail");
const User           = require("../models/User");
const Business       = require("../models/Business");
const { sendMail }   = require("../utils/nodemailer");
const { emailQueue, addJob } = require("../utils/queue");
const {
  applyEmailPlaceholders,
  getBusinessPlaceholderData,
} = require("../utils/emailPlaceholders");

// ── Helpers ────────────────────────────────────────────────────────────────────

const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/** Allowed attachment MIME types */
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "text/plain",
]);
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB per file

/**
 * Validate and normalise the new campaign/template fields present in req.body.
 * Returns { ok: true, data } or { ok: false, message }.
 */
function validateCompositionFields(body) {
  const {
    subject, previewText, senderName,
    replyTo, cc, bcc, tags, customVariables,
  } = body;

  if (subject !== undefined && subject.length > 200)
    return { ok: false, message: "Subject must not exceed 200 characters" };

  if (previewText !== undefined && previewText.length > 200)
    return { ok: false, message: "Preview text must not exceed 200 characters" };

  if (senderName !== undefined && senderName.length > 100)
    return { ok: false, message: "Sender name must not exceed 100 characters" };

  if (replyTo && !validateEmail(replyTo))
    return { ok: false, message: "Reply-To must be a valid email address" };

  const ccArr  = cc  ? (Array.isArray(cc)  ? cc  : [cc])  : [];
  const bccArr = bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [];

  if (ccArr.length > 10)  return { ok: false, message: "CC: max 10 addresses allowed" };
  if (bccArr.length > 10) return { ok: false, message: "BCC: max 10 addresses allowed" };

  for (const e of ccArr)  if (!validateEmail(e)) return { ok: false, message: `CC contains invalid email: ${e}` };
  for (const e of bccArr) if (!validateEmail(e)) return { ok: false, message: `BCC contains invalid email: ${e}` };

  const tagsArr = tags ? (Array.isArray(tags) ? tags : [tags]) : [];
  if (tagsArr.length > 20)                   return { ok: false, message: "Max 20 tags allowed" };
  if (tagsArr.some(t => t.length > 50))      return { ok: false, message: "Each tag must be ≤ 50 characters" };

  const vars = customVariables
    ? (Array.isArray(customVariables) ? customVariables : JSON.parse(customVariables))
    : [];

  for (const v of vars) {
    if (!v.key || !/^[a-zA-Z0-9_]+$/.test(v.key))
      return { ok: false, message: `Custom variable key "${v.key}" is invalid (alphanumeric + underscore only)` };
  }
  const keys = vars.map(v => v.key);
  if (keys.length !== new Set(keys).size)
    return { ok: false, message: "Custom variable keys must be unique" };

  return {
    ok: true,
    data: {
      subject:         subject || "",
      previewText:     previewText || "",
      senderName:      senderName || "",
      replyTo:         replyTo || "",
      cc:              ccArr,
      bcc:             bccArr,
      tags:            tagsArr,
      customVariables: vars,
    },
  };
}

/**
 * Convert multer file objects into the attachment sub-document shape.
 * Validates MIME type and file size.
 */
function processUploadedAttachments(files = []) {
  const attachments = [];
  for (const file of files) {
    if (!ALLOWED_ATTACHMENT_TYPES.has(file.mimetype)) {
      throw new Error(
        `Attachment "${file.originalname}" has unsupported type: ${file.mimetype}. ` +
        "Allowed: pdf, doc, docx, jpg, png, txt"
      );
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
      throw new Error(
        `Attachment "${file.originalname}" exceeds the 10 MB size limit`
      );
    }
    attachments.push({
      originalName: file.originalname,
      storedPath:   file.path,
      mimeType:     file.mimetype,
      size:         file.size,
    });
  }
  return attachments;
}

// ── Excel helpers ──────────────────────────────────────────────────────────────

/**
 * Process uploaded Excel for campaign recipients.
 * Cross-references emails with Business model to find business names.
 */
const processCampaignExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const workbook  = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const worksheet = workbook.getWorksheet(1) || workbook.worksheets[0];

    if (!worksheet) {
      return res.status(400).json({ message: "No worksheet found in Excel file" });
    }

    const extractText = (val) => {
      if (!val) return "";
      if (typeof val === "string") return val;
      if (typeof val === "object") {
        if (val.text)    return extractText(val.text);
        if (val.richText && Array.isArray(val.richText))
          return val.richText.map(rt => rt.text || "").join("");
        return val.toString();
      }
      return String(val);
    };

    const emails = [];
    worksheet.eachRow((row, rowNumber) => {
      const emailValue = extractText(row.getCell(1).value).trim().toLowerCase();
      if (rowNumber === 1) {
        if (validateEmail(emailValue)) emails.push(emailValue);
      } else {
        if (validateEmail(emailValue)) emails.push(emailValue);
      }
    });

    const uniqueEmails = [...new Set(emails)];
    const matches = await Business.find({
      $or: [
        { "contact.email": { $in: uniqueEmails } },
        { "contact.contactDetails.emails": { $in: uniqueEmails } },
      ],
    })
      .populate("category", "name")
      .populate("subCategory", "name")
      .select("businessName address website contact category subCategory");

    const emailToBusiness = {};
    matches.forEach(biz => {
      const primaryEmails   = Array.isArray(biz.contact?.email) ? biz.contact.email : (biz.contact?.email ? [biz.contact.email] : []);
      const contactEmails   = biz.contact?.contactDetails?.flatMap(cd => cd.emails || []) || [];
      const bizEmails       = [...primaryEmails, ...contactEmails].map(e => e.toLowerCase().trim());
      uniqueEmails.forEach(e => { if (bizEmails.includes(e)) emailToBusiness[e] = biz; });
    });

    const result = uniqueEmails.map(email => {
      const businessData = getBusinessPlaceholderData(emailToBusiness[email]);
      return {
        email,
        businessName: businessData.business_name,
        address:      businessData.address,
        website:      businessData.website,
        phone:        businessData.phone,
        category:     businessData.category,
        subcategory:  businessData.subcategory,
        country:      businessData.country,
        listingUrl:   businessData.listing_url,
      };
    });

    res.status(200).json({
      totalEmails: uniqueEmails.length,
      matchCount:  result.filter(r => r.businessName).length,
      recipients:  result,
    });
  } catch (error) {
    console.error("Error processing campaign excel:", error);
    res.status(500).json({ message: "Error processing file", error: error.message });
  }
};

/** Download sample Excel for campaign recipient upload */
const downloadCampaignSampleExcel = async (req, res) => {
  try {
    const workbook  = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Recipients");
    worksheet.columns = [{ header: "Email Address", key: "email", width: 30 }];
    worksheet.addRows([
      { email: "business@example.com" },
      { email: "contact@company.com" },
    ]);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=campaign_recipients_sample.xlsx");
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ message: "Error generating sample file" });
  }
};

// ── Template CRUD ──────────────────────────────────────────────────────────────

const createTemplate = async (req, res) => {
  try {
    const {
      name, subject, body,
      previewText, senderName, replyTo, customVariables,
    } = req.body;

    if (!name || !subject || !body) {
      return res.status(400).json({ message: "Name, subject, and body are required" });
    }
    if (subject.length > 200)
      return res.status(400).json({ message: "Subject must not exceed 200 characters" });
    if (previewText && previewText.length > 200)
      return res.status(400).json({ message: "Preview text must not exceed 200 characters" });
    if (senderName && senderName.length > 100)
      return res.status(400).json({ message: "Sender name must not exceed 100 characters" });
    if (replyTo && !validateEmail(replyTo))
      return res.status(400).json({ message: "Reply-To must be a valid email address" });

    let vars = [];
    if (customVariables) {
      vars = Array.isArray(customVariables) ? customVariables : JSON.parse(customVariables);
      for (const v of vars) {
        if (!v.key || !/^[a-zA-Z0-9_]+$/.test(v.key))
          return res.status(400).json({ message: `Invalid custom variable key: "${v.key}"` });
      }
      const keys = vars.map(v => v.key);
      if (keys.length !== new Set(keys).size)
        return res.status(400).json({ message: "Custom variable keys must be unique" });
    }

    const template = new EmailTemplate({
      name, subject, body,
      previewText:     previewText || "",
      senderName:      senderName || "",
      replyTo:         replyTo || "",
      customVariables: vars,
      createdBy:       req.user.id,
    });
    await template.save();
    res.status(201).json({ message: "Template created successfully", template });
  } catch (error) {
    res.status(500).json({ message: "Error creating template", error: error.message });
  }
};

const getTemplates = async (req, res) => {
  try {
    const templates = await EmailTemplate.find({ createdBy: req.user.id }).sort({ createdAt: -1 });
    res.status(200).json(templates);
  } catch (error) {
    res.status(500).json({ message: "Error fetching templates", error: error.message });
  }
};

const getTemplateById = async (req, res) => {
  try {
    const template = await EmailTemplate.findOne({ _id: req.params.id, createdBy: req.user.id });
    if (!template) return res.status(404).json({ message: "Template not found or unauthorized" });
    res.status(200).json(template);
  } catch (error) {
    res.status(500).json({ message: "Error fetching template", error: error.message });
  }
};

const updateTemplate = async (req, res) => {
  try {
    const {
      name, subject, body,
      previewText, senderName, replyTo, customVariables,
    } = req.body;

    const template = await EmailTemplate.findOne({ _id: req.params.id, createdBy: req.user.id });
    if (!template) return res.status(404).json({ message: "Template not found or unauthorized" });

    if (subject    && subject.length    > 200) return res.status(400).json({ message: "Subject must not exceed 200 characters" });
    if (previewText && previewText.length > 200) return res.status(400).json({ message: "Preview text must not exceed 200 characters" });
    if (senderName  && senderName.length  > 100) return res.status(400).json({ message: "Sender name must not exceed 100 characters" });
    if (replyTo && !validateEmail(replyTo))    return res.status(400).json({ message: "Reply-To must be a valid email address" });

    if (name        !== undefined) template.name        = name;
    if (subject     !== undefined) template.subject     = subject;
    if (body        !== undefined) template.body        = body;
    if (previewText !== undefined) template.previewText = previewText;
    if (senderName  !== undefined) template.senderName  = senderName;
    if (replyTo     !== undefined) template.replyTo     = replyTo;

    if (customVariables !== undefined) {
      const vars = Array.isArray(customVariables) ? customVariables : JSON.parse(customVariables);
      for (const v of vars) {
        if (!v.key || !/^[a-zA-Z0-9_]+$/.test(v.key))
          return res.status(400).json({ message: `Invalid custom variable key: "${v.key}"` });
      }
      const keys = vars.map(v => v.key);
      if (keys.length !== new Set(keys).size)
        return res.status(400).json({ message: "Custom variable keys must be unique" });
      template.customVariables = vars;
    }

    await template.save();
    res.status(200).json({ message: "Template updated successfully", template });
  } catch (error) {
    res.status(500).json({ message: "Error updating template", error: error.message });
  }
};

const deleteTemplate = async (req, res) => {
  try {
    const template = await EmailTemplate.findOneAndDelete({ _id: req.params.id, createdBy: req.user.id });
    if (!template) return res.status(404).json({ message: "Template not found or unauthorized" });
    res.status(200).json({ message: "Template deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting template", error: error.message });
  }
};

const uploadTemplateImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "Please upload an image." });
    const host     = req.get("host");
    const protocol = req.protocol;
    res.status(200).json({ url: `${protocol}://${host}/uploads/${req.file.filename}` });
  } catch (error) {
    res.status(500).json({ message: "Failed to upload image", error: error.message });
  }
};

// ── Attachment upload (standalone) ─────────────────────────────────────────────

/**
 * POST /email/campaigns/attachments
 * Accepts up to 5 files and returns the stored metadata array.
 * Used when the client needs a separate upload step before campaign creation.
 */
const uploadCampaignAttachments = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ message: "No files uploaded" });
    if (req.files.length > 5)
      return res.status(400).json({ message: "A campaign may have at most 5 attachments" });

    const attachments = processUploadedAttachments(req.files);
    res.status(200).json({ attachments });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// ── Sender email management ────────────────────────────────────────────────────

const addSenderEmail = async (req, res) => {
  try {
    const { email, displayName, smtpHost, smtpPort, smtpUser, smtpPass } = req.body;
    if (!validateEmail(email) || !displayName || !smtpHost || !smtpPort || !smtpUser || !smtpPass) {
      return res.status(400).json({
        message: "All fields (email, displayName, smtpHost, smtpPort, smtpUser, smtpPass) are required",
      });
    }
    if (await SenderEmail.findOne({ email }))
      return res.status(400).json({ message: "Sender email already exists" });

    const senderEmail = await new SenderEmail({ email, displayName, smtpHost, smtpPort, smtpUser, smtpPass, isActive: true }).save();
    res.status(201).json({ message: "Sender email added successfully", senderEmail });
  } catch (error) {
    res.status(500).json({ message: "Error adding sender email", error: error.message });
  }
};

const getSenderEmails = async (req, res) => {
  try {
    const query = req.query.includeInactive === "true" ? {} : { isActive: true };
    res.status(200).json(await SenderEmail.find(query));
  } catch (error) {
    res.status(500).json({ message: "Error fetching sender emails", error: error.message });
  }
};

const markSenderEmailAsSpam = async (req, res) => {
  try {
    const senderEmail = await SenderEmail.findById(req.params.id);
    if (!senderEmail) return res.status(404).json({ message: "Sender email not found" });
    senderEmail.isActive = false;
    await senderEmail.save();
    res.status(200).json({ message: "Sender email marked as inactive" });
  } catch (error) {
    res.status(500).json({ message: "Error marking sender email as inactive", error: error.message });
  }
};

const toggleSenderEmailStatus = async (req, res) => {
  try {
    const senderEmail = await SenderEmail.findById(req.params.id);
    if (!senderEmail) return res.status(404).json({ message: "Sender email not found" });
    senderEmail.isActive = !senderEmail.isActive;
    await senderEmail.save();
    res.status(200).json({ message: `Sender email marked as ${senderEmail.isActive ? "active" : "inactive"}` });
  } catch (error) {
    res.status(500).json({ message: "Error toggling sender email status", error: error.message });
  }
};

// ── Campaign CRUD ──────────────────────────────────────────────────────────────

const createCampaign = async (req, res) => {
  try {
    const { name, template, fromEmail, recipients, scheduledAt } = req.body;

    let parsedRecipients = recipients;
    if (typeof recipients === "string") {
      try { parsedRecipients = JSON.parse(recipients); }
      catch { return res.status(400).json({ message: "Invalid recipients format" }); }
    }

    if (!name || !template || !fromEmail ||
        (!parsedRecipients?.users?.length && !parsedRecipients?.customEmails?.length)) {
      return res.status(400).json({
        message: "Name, template, sender email, and at least one recipient are required",
      });
    }

    // Validate composition fields
    const comp = validateCompositionFields(req.body);
    if (!comp.ok) return res.status(400).json({ message: comp.message });

    const sender = await SenderEmail.findOne({ email: fromEmail });
    if (!sender || !sender.isActive)
      return res.status(400).json({ message: "Invalid or inactive sender email" });

    const users = await User.find({ _id: { $in: parsedRecipients.users || [] } });
    if (parsedRecipients.users?.length && !users.length)
      return res.status(400).json({ message: "No valid users selected" });

    for (const item of parsedRecipients.customEmails || []) {
      const email = typeof item === "string" ? item : item.email;
      if (!validateEmail(email))
        return res.status(400).json({ message: `Invalid custom email: ${email}` });
    }

    const templateDoc = await EmailTemplate.findById(template);
    if (!templateDoc) return res.status(400).json({ message: "Invalid template" });

    // Process attachments from multipart upload
    let attachments = [];
    if (req.files && req.files.length) {
      try { attachments = processUploadedAttachments(req.files); }
      catch (e) { return res.status(400).json({ message: e.message }); }
    }
    // Also accept pre-uploaded attachment metadata as JSON string
    if (req.body.attachments && typeof req.body.attachments === "string") {
      try {
        const preUploaded = JSON.parse(req.body.attachments);
        attachments = [...attachments, ...preUploaded];
      } catch { /* ignore parse errors — files take precedence */ }
    }
    if (attachments.length > 5)
      return res.status(400).json({ message: "A campaign may have at most 5 attachments" });

    const refTimeZone = req.body.timeZone ||
      (users.length > 0 ? (users[0].timeZone || "Asia/Kolkata") : "Asia/Kolkata");

    const campaign = new EmailCampaign({
      name,
      template,
      recipients: parsedRecipients,
      fromEmail,
      createdBy: req.user.id,
      timeZone:  refTimeZone,
      scheduledAt: scheduledAt
        ? moment.tz(scheduledAt, "YYYY-MM-DD HH:mm", refTimeZone).toDate()
        : undefined,
      status: scheduledAt ? "scheduled" : "draft",
      ...comp.data,
      attachments,
    });
    await campaign.save();

    if (scheduledAt) {
      const timeZones = [...new Set(users.map(u => u.timeZone || "UTC"))];
      if (!timeZones.length && parsedRecipients.customEmails?.length) timeZones.push(refTimeZone);

      for (const tz of timeZones) {
        const usersInTz = users.filter(u => (u.timeZone || "UTC") === tz);
        const localScheduleTime = moment.tz(scheduledAt, "YYYY-MM-DD HH:mm", tz).utc().toDate();
        const delay = Math.max(0, new Date(localScheduleTime) - new Date());
        await addJob("email-campaigns", {
          campaignId: campaign._id, timeZone: tz,
          userIds: usersInTz.map(u => u._id), fromEmail, template,
          localScheduleTime,
          isRefTimeZone: timeZones.length === 1 || tz === refTimeZone,
        }, {
          jobId: `email-campaigns-${campaign._id}-${tz}-${Date.now()}`,
          delay, attempts: 3, backoff: { type: "exponential", delay: 5000 },
        });
      }
    }

    res.status(201).json({ message: "Campaign created successfully", campaign });
  } catch (error) {
    console.error("Error creating campaign:", error);
    res.status(500).json({ message: "Error creating campaign", error: error.message });
  }
};

const getCampaigns = async (req, res) => {
  try {
    const campaigns = await EmailCampaign.find({ createdBy: req.user.id })
      .populate("template", "name subject")
      .populate("recipients.users", "email country timeZone")
      .sort({ createdAt: -1 });
    res.status(200).json(campaigns);
  } catch (error) {
    res.status(500).json({ message: "Error fetching campaigns", error: error.message });
  }
};

const getCampaignById = async (req, res) => {
  try {
    const campaign = await EmailCampaign.findOne({ _id: req.params.id, createdBy: req.user.id })
      .populate("template", "name subject previewText senderName replyTo customVariables")
      .populate("recipients.users", "email country timeZone");
    if (!campaign) return res.status(404).json({ message: "Campaign not found or unauthorized" });
    res.status(200).json(campaign);
  } catch (error) {
    res.status(500).json({ message: "Error fetching campaign", error: error.message });
  }
};

const updateCampaign = async (req, res) => {
  try {
    const { name, template, fromEmail, recipients, scheduledAt } = req.body;

    const campaign = await EmailCampaign.findOne({ _id: req.params.id, createdBy: req.user.id });
    if (!campaign) return res.status(404).json({ message: "Campaign not found or unauthorized" });
    if (campaign.status === "sent") return res.status(400).json({ message: "Cannot update a sent campaign" });

    // Validate composition fields
    const comp = validateCompositionFields(req.body);
    if (!comp.ok) return res.status(400).json({ message: comp.message });

    if (name) campaign.name = name;
    Object.assign(campaign, comp.data);

    if (template) {
      const templateDoc = await EmailTemplate.findById(template);
      if (!templateDoc) return res.status(404).json({ message: "Template not found" });
      campaign.template = template;
    }
    if (fromEmail) {
      const sender = await SenderEmail.findOne({ email: fromEmail });
      if (!sender || !sender.isActive) return res.status(400).json({ message: "Invalid or inactive sender email" });
      campaign.fromEmail = fromEmail;
    }

    let parsedRecipients = recipients;
    if (typeof recipients === "string") {
      try { parsedRecipients = JSON.parse(recipients); } catch { /* ignore */ }
    }
    if (parsedRecipients) {
      if (parsedRecipients.users) {
        const users = await User.find({ _id: { $in: parsedRecipients.users } });
        if (parsedRecipients.users.length && !users.length)
          return res.status(400).json({ message: "No valid users selected" });
        campaign.recipients.users = parsedRecipients.users;
      }
      if (parsedRecipients.customEmails) {
        for (const item of parsedRecipients.customEmails) {
          const email = typeof item === "string" ? item : item.email;
          if (!validateEmail(email)) return res.status(400).json({ message: `Invalid custom email: ${email}` });
        }
        campaign.recipients.customEmails = parsedRecipients.customEmails;
      }
    }

    // Handle new / replacement attachments
    if (req.files && req.files.length) {
      try {
        const newAttachments = processUploadedAttachments(req.files);
        campaign.attachments = [...(campaign.attachments || []), ...newAttachments].slice(0, 5);
      } catch (e) { return res.status(400).json({ message: e.message }); }
    }

    // Scheduling logic (unchanged from original)
    const recipientUserIds = campaign.recipients.users || [];
    const users = await User.find({ _id: { $in: recipientUserIds } });
    const refTimeZone = req.body.timeZone ||
      (users.length > 0 ? (users[0].timeZone || "Asia/Kolkata") : "Asia/Kolkata");
    campaign.timeZone = refTimeZone;

    if (scheduledAt) {
      const timeZones = [...new Set(users.map(u => u.timeZone || "UTC"))];
      if (!timeZones.length && campaign.recipients.customEmails?.length) timeZones.push(refTimeZone);

      const existingJobs = await emailQueue.getJobs(["waiting", "active", "delayed", "completed", "failed"]);
      for (const job of existingJobs) {
        if (job.id.startsWith(`email-campaigns-${campaign._id}-`)) await job.remove();
      }

      for (const tz of timeZones) {
        const usersInTz = users.filter(u => (u.timeZone || "UTC") === tz);
        const localScheduleTime = moment.tz(scheduledAt, "YYYY-MM-DD HH:mm", tz).utc().toDate();
        const delay = new Date(localScheduleTime) - new Date();
        if (delay <= -60000) {
          return res.status(400).json({ message: `Scheduled time for ${tz} must be in the future` });
        }
        await addJob("email-campaigns", {
          campaignId: campaign._id, timeZone: tz,
          userIds: usersInTz.map(u => u._id),
          fromEmail: campaign.fromEmail, template: campaign.template,
          localScheduleTime, isRefTimeZone: timeZones.length === 1 || tz === refTimeZone,
        }, {
          jobId: `email-campaigns-${campaign._id}-${tz}-${Date.now()}`,
          delay: Math.max(0, delay), attempts: 3, backoff: { type: "exponential", delay: 5000 },
        });
      }
      campaign.scheduledAt = moment.tz(scheduledAt, "YYYY-MM-DD HH:mm", refTimeZone).toDate();
      campaign.status = "scheduled";
    } else if (scheduledAt === null) {
      const existingJobs = await emailQueue.getJobs(["waiting", "active", "delayed"]);
      for (const job of existingJobs) {
        if (job.id.startsWith(`email-campaigns-${campaign._id}-`)) await job.remove();
      }
      campaign.scheduledAt = null;
      campaign.status = "draft";
    }

    await campaign.save();
    res.status(200).json({ message: "Campaign updated successfully", campaign });
  } catch (error) {
    console.error("Error updating campaign:", error.stack);
    res.status(500).json({ message: "Error updating campaign", error: error.message });
  }
};

const cancelScheduledCampaign = async (req, res) => {
  try {
    const campaign = await EmailCampaign.findOne({ _id: req.params.id, createdBy: req.user.id });
    if (!campaign) return res.status(404).json({ message: "Campaign not found or unauthorized" });
    if (campaign.status !== "scheduled") return res.status(400).json({ message: "Campaign is not scheduled" });

    const existingJobs = await emailQueue.getJobs(["waiting", "active", "delayed"]);
    for (const job of existingJobs) {
      if (job.id.startsWith(`email-campaigns-${campaign._id}-`)) await job.remove();
    }
    campaign.status = "draft";
    campaign.scheduledAt = null;
    await campaign.save();
    res.status(200).json({ message: "Scheduled campaign cancelled" });
  } catch (error) {
    res.status(500).json({ message: "Error cancelling campaign", error: error.message });
  }
};

const sendCampaign = async (req, res) => {
  try {
    const campaign = await EmailCampaign.findOne({ _id: req.params.id, createdBy: req.user.id })
      .populate("template")
      .populate("recipients.users", "email subscribedToEmails full_name");

    if (!campaign) return res.status(404).json({ message: "Campaign not found or unauthorized" });
    if (campaign.status === "sent") return res.status(400).json({ message: "Campaign already sent" });

    const sender = await SenderEmail.findOne({ email: campaign.fromEmail });
    if (!sender || !sender.isActive)
      return res.status(400).json({ message: "Sender email is invalid or inactive" });

    const validRecipients = (campaign.recipients.users || []).filter(u => u.subscribedToEmails);
    if (!validRecipients.length && !campaign.recipients.customEmails?.length)
      return res.status(400).json({ message: "No valid recipients found (they may have unsubscribed)" });

    try {
      await addJob("email-campaigns", { campaignId: campaign._id });
      campaign.status = "processing";
      await campaign.save();
      res.status(200).json({ message: "Campaign queued for sending successfully" });
    } catch (emailError) {
      campaign.status = "failed";
      await campaign.save();
      res.status(500).json({ message: "Error queueing campaign", error: emailError.message });
    }
  } catch (error) {
    res.status(500).json({ message: "Error processing campaign", error: error.message });
  }
};

const deleteCampaign = async (req, res) => {
  try {
    const campaign = await EmailCampaign.findOne({ _id: req.params.id, createdBy: req.user.id });
    if (!campaign) return res.status(404).json({ message: "Campaign not found or unauthorized" });
    if (campaign.status === "sent") return res.status(400).json({ message: "Cannot delete a sent campaign" });

    if (campaign.status === "scheduled") {
      const existingJobs = await emailQueue.getJobs(["waiting", "active", "delayed"]);
      for (const job of existingJobs) {
        if (job.id.startsWith(`email-campaigns-${campaign._id}-`)) await job.remove();
      }
    }

    // Delete stored attachment files
    for (const att of campaign.attachments || []) {
      try {
        const absPath = path.isAbsolute(att.storedPath)
          ? att.storedPath
          : path.resolve(process.cwd(), att.storedPath);
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      } catch (e) {
        console.warn(`Could not delete attachment file: ${att.storedPath}`, e.message);
      }
    }

    await EmailCampaign.findOneAndDelete({ _id: req.params.id, createdBy: req.user.id });
    res.status(200).json({ message: "Campaign deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting campaign", error: error.message });
  }
};

// ── Misc ───────────────────────────────────────────────────────────────────────

const getUsers = async (req, res) => {
  try {
    const { search = "", page = 1, limit = 10 } = req.query;
    const skip  = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const query = {
      subscribedToEmails: true,
      $or: [
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ],
    };
    const [users, totalUsers] = await Promise.all([
      User.find(query).select("email _id timeZone country").skip(skip).limit(parseInt(limit, 10)),
      User.countDocuments(query),
    ]);
    res.json({ users, totalUsers });
  } catch (error) {
    res.status(500).json({ message: "Error fetching users", error: error.message });
  }
};

const unsubscribe = async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ message: "Invalid user ID" });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    user.subscribedToEmails = false;
    await user.save();
    res.status(200).json({ message: "Successfully unsubscribed" });
  } catch (error) {
    res.status(500).json({ message: "Error unsubscribing", error: error.message });
  }
};

const sendTestEmail = async (req, res) => {
  try {
    const { template, to, senderName, replyTo } = req.body;
    if (!template || !to)
      return res.status(400).json({ message: "Template and recipient email are required" });
    if (!validateEmail(to))
      return res.status(400).json({ message: "Recipient must be a valid email address" });
    if (replyTo && !validateEmail(replyTo))
      return res.status(400).json({ message: "Reply-To must be a valid email address" });

    const sender = await SenderEmail.findOne({ isActive: true });
    if (!sender)
      return res.status(400).json({ message: "No active sender email found. Please add one in Settings." });

    const html = applyEmailPlaceholders(template.body, {
      full_name:        "Test User",
      frontend_url:     process.env.FRONTEND_URL || "http://localhost:3000",
      package_name:     "Premium Package",
      start_date:       new Date().toLocaleDateString(),
      business_id:      "12345",
      status:           "Approved",
      rejection_reason: "Test Rejection Reason",
      business_name:    "DigitalMitro (Sample)",
      address:          "123 Tech St, Salt Lake, Kolkata, West Bengal, 700091, India",
      website:          "https://digitalmitro.com",
      email:            to,
      phone:            "9876543210",
      category:         "Marketing Agency",
      subcategory:      "Digital Marketing",
      country:          "India",
      listing_url:      `${(process.env.FRONTEND_URL || "https://urbancitations.com").replace(/\/+$/, "")}/digital-mitro-pvt-ltd/69c22f65bbcdf3b5f6f8dcbb`,
    });

    const result = await sendMail(
      sender.email,
      to,
      `[TEST] ${template.subject}`,
      html,
      `${process.env.FRONTEND_URL}/unsubscribe?test=true`,
      {
        senderName: senderName || template.senderName || sender.displayName,
        replyTo:    replyTo    || template.replyTo    || "",
      }
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

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
  uploadTemplateImage,
  uploadCampaignAttachments,
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
