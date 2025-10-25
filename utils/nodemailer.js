const nodemailer = require('nodemailer');
const mongoose = require('mongoose');

/**
 * Sends an email using NodeMailer with dynamic SMTP settings.
 * @param {string} senderEmailId - ID of the sender email from the database.
 * @param {string} to - Recipient email address.
 * @param {string} subject - Subject of the email.
 * @param {string} html - HTML body of the email.
 * @param {string} unsubscribeLink - URL for the unsubscribe link.
 * @returns {Promise<object>} - Promise resolving to email send status.
 */
async function sendMail(senderEmailId, to, subject, html, unsubscribeLink) {
  try {
    const SenderEmail = mongoose.model('SenderEmail');
    const sender = await SenderEmail.findOne({email: senderEmailId});
    if (!sender || !sender.isActive) {
      throw new Error('Invalid or inactive sender email');
    }

    const transporter = nodemailer.createTransport({
      host: sender.smtpHost,
      port: sender.smtpPort,
      secure: sender.smtpPort === 465, // true for SSL, false for TLS
      auth: {
        user: sender.smtpUser,
        pass: sender.smtpPass,
      },
    });

    const mailOptions = {
      from: `"${sender.displayName}" <${sender.email}>`,
      to,
      subject,
      html: `${html}<br><br><a href="${unsubscribeLink}">Unsubscribe</a>`,
    };

    const info = await transporter.sendMail(mailOptions);
    return { success: true, info };
  } catch (error) {
    console.error('Error sending email:', error);
    return { success: false, error };
  }
}

module.exports = { sendMail };