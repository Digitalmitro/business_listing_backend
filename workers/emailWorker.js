// workers/emailWorker.js
const { Worker } = require("bullmq");
const { redisConnection } = require("../utils/queue");
const path = require("path");
const logger = require("../utils/logger");
const EmailCampaign = require("../models/EmailCampaign");
const EmailTemplate = require("../models/EmailTemplate");
const SenderEmail = require("../models/SenderEmail");
const User = require("../models/User");
require("../models/Category");
require("../models/SubCategory");
const Business = require("../models/Business");
const { sendMail } = require("../utils/nodemailer");
const { applyEmailPlaceholders, getBusinessPlaceholderData } = require("../utils/emailPlaceholders");

/**
 * Build a flat custom-variables map from an array of { key, value } pairs.
 * Template-level defaultValues are used when the campaign overrides are absent.
 */
function buildCustomVarsMap(templateVars = [], campaignVars = []) {
  const map = {};
  for (const v of templateVars) map[v.key] = v.defaultValue || '';
  for (const v of campaignVars)  map[v.key] = v.value || '';
  return map;
}

/**
 * Resolve attachment objects from the campaign document into nodemailer format.
 * storedPath may be relative (e.g. "public/uploads/attachments/...") or absolute.
 */
function resolveAttachments(attachments = []) {
  return attachments.map(att => ({
    filename:    att.originalName,
    path:        path.isAbsolute(att.storedPath)
                   ? att.storedPath
                   : path.resolve(process.cwd(), att.storedPath),
    contentType: att.mimeType || 'application/octet-stream',
  }));
}

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

      // ── Resolve effective campaign-level composition values ──────────
      const effectiveSubject   = campaign.subject    || templateDoc.subject;
      const effectiveSenderName = campaign.senderName || templateDoc.senderName || sender.displayName;
      const effectiveReplyTo   = campaign.replyTo    || templateDoc.replyTo    || '';
      const effectiveCc        = campaign.cc  || [];
      const effectiveBcc       = campaign.bcc || [];
      const effectiveAttachments = resolveAttachments(campaign.attachments || []);

      // ── Build custom variable map (template defaults → campaign overrides) ──
      const customVars = buildCustomVarsMap(
        templateDoc.customVariables || [],
        campaign.customVariables    || []
      );

      // ── Step 1: Gather all emails to look up ───────────────────────
      const allEmails = new Set();
      const fallbackUserIds  = campaign.recipients?.users || [];
      const effectiveUserIds = userIds?.length ? userIds : fallbackUserIds;
      const users = effectiveUserIds.length
        ? await User.find({ _id: { $in: effectiveUserIds } })
        : [];
      users.forEach(u => { if (u.email) allEmails.add(u.email); });

      const shouldIncludeCustomEmails =
        typeof isRefTimeZone === "boolean" ? isRefTimeZone : true;
      const customEmailItems = shouldIncludeCustomEmails && campaign.recipients.customEmails
        ? campaign.recipients.customEmails
        : [];
      customEmailItems.forEach(item => {
        const email = typeof item === "string" ? item : item.email;
        if (email) allEmails.add(email);
      });

      // ── Step 2: Batch-fetch associated businesses ──────────────────
      const emailArray = Array.from(allEmails);
      const businesses = await Business.find({
        $or: [
          { "contact.email": { $in: emailArray } },
          { "contact.contactDetails.emails": { $in: emailArray } },
        ],
      })
        .populate("category", "name")
        .populate("subCategory", "name")
        .select("businessName address website contact category subCategory")
        .lean();

      const businessMap = new Map();
      for (const biz of businesses) {
        if (biz.contact && Array.isArray(biz.contact.email)) {
          for (const e of biz.contact.email) businessMap.set(e, biz);
        }
        if (biz.contact && Array.isArray(biz.contact.contactDetails)) {
          for (const cd of biz.contact.contactDetails) {
            if (Array.isArray(cd.emails)) {
              for (const e of cd.emails) businessMap.set(e, biz);
            }
          }
        }
      }

      // ── Build send options (shared across all recipients) ──────────
      const sharedSendOptions = {
        senderName:  effectiveSenderName,
        replyTo:     effectiveReplyTo,
        cc:          effectiveCc,
        bcc:         effectiveBcc,
        attachments: effectiveAttachments,
      };

      let sentCount = 0;

      // ── Send to registered users ───────────────────────────────────
      for (const user of users) {
        if (!user.email) continue;
        const associatedBiz = businessMap.get(user.email);

        const html = applyEmailPlaceholders(templateDoc.body, {
          ...getBusinessPlaceholderData(associatedBiz),
          full_name: user.full_name || "User",
          email:     user.email,
          ...customVars,
        });

        const unsubscribeLink = `${process.env.FRONTEND_URL}/unsubscribe?userId=${user._id}&campaignId=${campaign._id}`;
        const result = await sendMail(
          senderEmail,
          user.email,
          effectiveSubject,
          html,
          unsubscribeLink,
          sharedSendOptions
        );

        if (!result.success) {
          logger.error("emailWorker.recipient_failed", `Failed to send to ${user.email}`, {
            campaignId,
            recipientEmail: user.email,
            error: result.error?.message,
          });
          continue;
        }
        sentCount++;
      }

      // ── Send to custom email list ──────────────────────────────────
      for (const item of customEmailItems) {
        const email = typeof item === "string" ? item : item.email;
        if (!email) continue;

        const associatedBiz  = businessMap.get(email);
        const businessData   = getBusinessPlaceholderData(associatedBiz);

        const html = applyEmailPlaceholders(templateDoc.body, {
          full_name:    "User",
          email,
          business_name: typeof item === "string" ? businessData.business_name : (item.businessName || businessData.business_name),
          address:       typeof item === "string" ? businessData.address  : (item.address  || businessData.address),
          website:       typeof item === "string" ? businessData.website  : (item.website  || businessData.website),
          phone:         typeof item === "string" ? businessData.phone    : (item.phone    || businessData.phone),
          category:      typeof item === "string" ? businessData.category : (item.category || businessData.category),
          subcategory:   typeof item === "string" ? businessData.subcategory : (item.subcategory || businessData.subcategory),
          country:       typeof item === "string" ? businessData.country  : (item.country  || businessData.country),
          listing_url:   typeof item === "string" ? businessData.listing_url : (item.listingUrl || item.listing_url || businessData.listing_url),
          ...customVars,
        });

        const unsubscribeLink = `${process.env.FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(email)}&campaignId=${campaign._id}`;
        const result = await sendMail(
          senderEmail,
          email,
          effectiveSubject,
          html,
          unsubscribeLink,
          sharedSendOptions
        );

        if (result.success) sentCount++;
      }

      // ── Update campaign status ─────────────────────────────────────
      if (sentCount > 0) {
        campaign.status = "sent";
        campaign.sentAt = new Date();
      } else if (
        (campaign.recipients?.users?.length || 0) +
        (campaign.recipients?.customEmails?.length || 0) === 0
      ) {
        campaign.status = "draft";
      } else {
        campaign.status = "failed";
      }
      await campaign.save();
      logger.info("emailWorker.campaign_processed", `Campaign ${campaignId} processed`, { campaignId, sentCount });
    } catch (error) {
      logger.error("emailWorker.campaign_error", `Error processing campaign ${campaignId}`, { campaignId, error: error.message });
      await EmailCampaign.findByIdAndUpdate(campaignId, { status: "failed" });
      throw error;
    }
  },
  {
    connection: redisConnection,
  }
);

module.exports = emailWorker;
