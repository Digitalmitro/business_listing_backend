// utils/nodemailer.js
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const path = require('path');
const logger = require('./logger');

/**
 * Sends an email using NodeMailer with dynamic SMTP settings.
 *
 * @param {string} senderEmailId   - Sender email address (looked up in SenderEmail collection).
 * @param {string} to              - Primary recipient email address.
 * @param {string} subject         - Email subject line.
 * @param {string} html            - HTML body content.
 * @param {string} unsubscribeLink - URL appended as an unsubscribe footer link.
 * @param {object} [options]       - Optional enhanced delivery options:
 *   @param {string}   [options.senderName]  - Override "From" display name.
 *   @param {string}   [options.replyTo]     - Reply-To header address.
 *   @param {string[]} [options.cc]          - CC recipient addresses.
 *   @param {string[]} [options.bcc]         - BCC recipient addresses.
 *   @param {Array}    [options.attachments] - Nodemailer-formatted attachment objects:
 *                                            [{ filename, path|content, contentType }]
 * @returns {Promise<{success: boolean, info?: object, error?: Error}>}
 */
async function sendMail(senderEmailId, to, subject, html, unsubscribeLink, options = {}) {
  try {
    const SenderEmail = mongoose.model('SenderEmail');
    const sender = await SenderEmail.findOne({ email: senderEmailId });
    if (!sender || !sender.isActive) {
      throw new Error('Invalid or inactive sender email');
    }

    const transporter = nodemailer.createTransport({
      host: sender.smtpHost,
      port: sender.smtpPort,
      secure: sender.smtpPort === 465,
      auth: {
        user: sender.smtpUser,
        pass: sender.smtpPass,
      },
    });

    // Resolve "From" display name: caller option → sender record → bare address
    const displayName = options.senderName || sender.displayName || sender.email;

    const mailOptions = {
      from:    `"${displayName}" <${sender.email}>`,
      to,
      subject,
      html: unsubscribeLink
        ? `${html}<br><br><a href="${unsubscribeLink}" style="color:#888;font-size:12px;">Unsubscribe</a>`
        : html,
    };

    // Optional headers
    if (options.replyTo) mailOptions.replyTo = options.replyTo;
    if (options.cc  && options.cc.length)  mailOptions.cc  = options.cc.join(', ');
    if (options.bcc && options.bcc.length) mailOptions.bcc = options.bcc.join(', ');

    // Attachments — resolve to absolute paths when a relative storedPath is given
    if (options.attachments && options.attachments.length) {
      mailOptions.attachments = options.attachments.map(att => ({
        filename: att.filename || att.originalName || path.basename(att.path || att.storedPath || ''),
        path:     att.path || (att.storedPath ? path.resolve(process.cwd(), att.storedPath) : undefined),
        contentType: att.contentType || att.mimeType || 'application/octet-stream',
      }));
    }

    const info = await transporter.sendMail(mailOptions);
    return { success: true, info };
  } catch (error) {
    logger.error('nodemailer.send_failed', 'Error sending email', { error: error.message, to });
    return { success: false, error };
  }
}

module.exports = { sendMail };